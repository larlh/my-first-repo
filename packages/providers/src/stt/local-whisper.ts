import fs from 'node:fs/promises';
import { AppError, LANGUAGE_CODES } from '@parlante/shared';
import type {
  DictationProvider,
  DictationReasonCode,
  DictationRequest,
  DictationResult,
  DictationStatus,
  LanguageCode,
  ProviderRef,
  STTProvider,
  STTRequest,
  STTResult,
  TimedText,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { decodeWav, resampleLinear } from '../tts/wav';
import { planAudioChunks } from './chunking';
import { WhisperEngineError, resolveWhisperThreads, sharedWhisperEngine } from './whisper-engine';
import type { WhisperJob, WhisperOutput } from './whisper-engine';
import {
  inspectWhisperInstall,
  resolveDictationModelDir,
  whisperModel,
  whisperModelFolder,
} from './whisper-models';
import type { WhisperInstallState, WhisperModelDef } from './whisper-models';

/* -------------------------------------------------------------------------------------------
 * Local speech recognition: OpenAI's open Whisper model (multilingual, ONNX) run on the CPU of
 * this machine by @huggingface/transformers + onnxruntime-node, inside a worker thread
 * (whisper-engine.ts). No key, no network: the model is installed once with
 * `pnpm dictation:setup` and the audio never leaves the process.
 *
 * Two faces over the same engine:
 *   - `createLocalWhisperDictation` → DictationProvider: one short phrase in, its text out
 *   - `createLocalWhisperStt`       → STTProvider: a whole recording in, timed segments out
 *     (video translation). Long audio is cut at quiet moments into windows the model accepts.
 *
 * Honesty: this is a small model on a CPU. It is labelled `quality: 'basic'` and named with
 * its size, so nobody mistakes it for a large hosted recogniser.
 * ----------------------------------------------------------------------------------------- */

export const LOCAL_WHISPER_ID = 'local-whisper';
export const WHISPER_SAMPLE_RATE = 16_000;
/** Whisper sees 30 s at a time; chunks stay just under it. */
const MAX_WINDOW_SEC = 29;
/** After a failed load, do not retry (and report unavailable) for this long. */
const FAILURE_COOLDOWN_MS = 60_000;
/** `inspectWhisperInstall` touches the disk: reuse its answer for a moment. */
const INSTALL_CACHE_MS = 2000;

/** The 13 product languages are all Whisper languages, with the same ISO 639-1 codes. */
export const LOCAL_WHISPER_LANGUAGES: LanguageCode[] = [...LANGUAGE_CODES];

export function localWhisperInfo(model: WhisperModelDef): ProviderRef {
  return { id: LOCAL_WHISPER_ID, name: `${model.label} (local)`, quality: 'basic', local: true };
}

/* ---------- pure helpers (exported for tests) ---------- */

/** PCM 16-bit → -1..1 floats in a buffer of their own (it is transferred to the worker). */
export function pcm16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] ?? 0) / 32768;
  return out;
}

const FRAME_SEC = 0.02;
/** -40 dBFS: quieter frames are background, not speech. */
const VOICED_RMS = 0.01;
const MIN_VOICED_SEC = 0.12;

/**
 * True when the audio holds something loud enough, for long enough, to be speech. Whisper
 * invents sentences when it is given silence, so quiet segments never reach the model.
 */
export function hasSpeechEnergy(samples: Int16Array, sampleRate: number): boolean {
  const frame = Math.max(1, Math.floor(FRAME_SEC * sampleRate));
  const needed = Math.ceil(MIN_VOICED_SEC / FRAME_SEC);
  const threshold = VOICED_RMS * 32768;
  let voiced = 0;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let energy = 0;
    for (let i = start; i < start + frame; i += 1) {
      const v = samples[i] ?? 0;
      energy += v * v;
    }
    if (Math.sqrt(energy / frame) >= threshold) {
      voiced += 1;
      if (voiced >= needed) return true;
    }
  }
  return false;
}

/**
 * A decoder that gets stuck repeats the same few words until it runs out of tokens. Runs of
 * four or more identical groups of 1–4 words are reduced to a single one.
 */
export function collapseRepetitions(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const key = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    for (let n = 1; n <= 4 && !collapsed; n += 1) {
      if (i + n * 4 > words.length) break;
      let repeats = 1;
      while (i + (repeats + 1) * n <= words.length) {
        let same = true;
        for (let k = 0; k < n; k += 1) {
          const a = key(words[i + k] ?? '');
          if (a === '' || a !== key(words[i + repeats * n + k] ?? '')) {
            same = false;
            break;
          }
        }
        if (!same) break;
        repeats += 1;
      }
      if (repeats >= 4) {
        out.push(...words.slice(i, i + n));
        i += repeats * n;
        collapsed = true;
      }
    }
    if (!collapsed) {
      out.push(words[i] ?? '');
      i += 1;
    }
  }
  return out.join(' ');
}

/** Whisper marks non-speech as `[Music]`, `[BLANK_AUDIO]`, `♪`…: that is not dictated text. */
export function cleanTranscript(text: string): string {
  return collapseRepetitions(
    text
      .replace(/\[[^\]]{0,40}\]/g, ' ')
      .replace(/[♪♫]+/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

/* ---------- shared runtime ---------- */

/** What both providers need from the engine (tests pass a double). */
export interface WhisperRunner {
  run(job: WhisperJob): Promise<WhisperOutput>;
}

export interface LocalWhisperDeps {
  /** Replace the worker-thread engine (unit tests). */
  runner?: WhisperRunner;
  /** Replace the on-disk check (unit tests). */
  inspect?: () => WhisperInstallState;
  now?: () => number;
}

interface Runtime {
  model: WhisperModelDef;
  info: ProviderRef;
  install(): WhisperInstallState;
  /** Why the engine cannot be used right now, or null. */
  unavailable(): { reasonCode: DictationReasonCode; reason: string } | null;
  run(job: WhisperJob): Promise<WhisperOutput>;
}

function unavailableError(reasonCode: DictationReasonCode, reason: string): AppError {
  return new AppError('SERVICE_UNAVAILABLE', reason, { reason: reasonCode });
}

const runtimes = new Map<string, Runtime>();

function createRuntime(env: ProviderEnv, deps: LocalWhisperDeps): Runtime {
  const model = whisperModel(env.DICTATION_MODEL);
  const modelsDir = resolveDictationModelDir(env);
  const now = deps.now ?? Date.now;
  const inspect = deps.inspect ?? (() => inspectWhisperInstall(modelsDir, model));
  let cached: { at: number; state: WhisperInstallState } | null = null;
  let failure: { at: number; reason: string } | null = null;

  const install = (): WhisperInstallState => {
    if (!cached || now() - cached.at > INSTALL_CACHE_MS || !cached.state.installed) {
      cached = { at: now(), state: inspect() };
    }
    return cached.state;
  };
  const runner: WhisperRunner =
    deps.runner ??
    sharedWhisperEngine({
      modelsDir,
      modelFolder: whisperModelFolder(model),
      dtype: model.dtype,
      threads: resolveWhisperThreads(env.DICTATION_THREADS),
      languages: LOCAL_WHISPER_LANGUAGES,
      idleUnloadMs: env.DICTATION_IDLE_UNLOAD_SEC * 1000,
    });

  const unavailable: Runtime['unavailable'] = () => {
    const state = install();
    if (!state.installed) {
      return { reasonCode: state.reasonCode ?? 'unknown', reason: state.reason ?? 'Not installed' };
    }
    if (failure && now() - failure.at < FAILURE_COOLDOWN_MS) {
      return { reasonCode: 'runtime_unavailable', reason: failure.reason };
    }
    return null;
  };

  return {
    model,
    info: localWhisperInfo(model),
    install,
    unavailable,
    async run(job) {
      const blocked = unavailable();
      if (blocked) throw unavailableError(blocked.reasonCode, blocked.reason);
      try {
        const output = await runner.run(job);
        failure = null;
        return output;
      } catch (err) {
        if (err instanceof WhisperEngineError) {
          if (err.phase === 'aborted') {
            throw new AppError('BAD_REQUEST', 'The transcription was cancelled');
          }
          if (err.phase === 'load') {
            // Never the audio, never the text: only what the engine said about itself.
            failure = { at: now(), reason: `The speech model could not be loaded: ${err.message}` };
            throw unavailableError('runtime_unavailable', failure.reason);
          }
          throw new AppError('PROVIDER_ERROR', `Local speech recognition failed: ${err.message}`);
        }
        throw err;
      }
    },
  };
}

function runtimeFor(env: ProviderEnv, deps: LocalWhisperDeps): Runtime {
  // Doubles are per call site; the real runtime (and its failure memory) is shared.
  if (deps.runner || deps.inspect || deps.now) return createRuntime(env, deps);
  const key = JSON.stringify([
    env.DICTATION_MODEL,
    resolveDictationModelDir(env),
    env.DICTATION_THREADS,
    env.DICTATION_IDLE_UNLOAD_SEC,
  ]);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(env, deps);
    runtimes.set(key, runtime);
  }
  return runtime;
}

/** True when the configured model is installed (decides `STT_PROVIDER=auto`). */
export function isLocalWhisperInstalled(env: ProviderEnv): boolean {
  return inspectWhisperInstall(resolveDictationModelDir(env), whisperModel(env.DICTATION_MODEL))
    .installed;
}

/* ---------- dictation ---------- */

export function createLocalWhisperDictation(
  env: ProviderEnv,
  deps: LocalWhisperDeps = {},
): DictationProvider {
  const runtime = runtimeFor(env, deps);

  async function status(): Promise<DictationStatus> {
    const blocked = runtime.unavailable();
    return {
      available: blocked === null,
      reason: blocked?.reason ?? null,
      reasonCode: blocked?.reasonCode ?? null,
      languages: blocked?.reasonCode === 'model_not_installed' ? [] : LOCAL_WHISPER_LANGUAGES,
      model: runtime.install().installed ? runtime.model.id : null,
    };
  }

  async function transcribe(request: DictationRequest): Promise<DictationResult> {
    if (request.sampleRate !== WHISPER_SAMPLE_RATE) {
      throw AppError.validation('Dictation audio must be sampled at 16 kHz', [
        { path: 'sampleRate', message: `Expected ${WHISPER_SAMPLE_RATE}` },
      ]);
    }
    const blocked = runtime.unavailable();
    if (blocked) throw unavailableError(blocked.reasonCode, blocked.reason);
    if (!hasSpeechEnergy(request.samples, request.sampleRate)) {
      return { text: '', language: request.language ?? null, provider: runtime.info };
    }
    const output = await runtime.run({
      samples: pcm16ToFloat32(request.samples),
      language: request.language,
      // Decoding WITH timestamps is how Whisper keeps going across the pauses of a phrase and
      // punctuates it; without them it tends to stop at the first pause (measured). The
      // times themselves are not used here.
      timestamps: true,
      signal: request.signal,
    });
    const text = cleanTranscript(output.text);
    const language =
      request.language ?? LOCAL_WHISPER_LANGUAGES.find((code) => code === output.language) ?? null;
    return {
      text,
      language: text === '' ? (request.language ?? null) : language,
      provider: runtime.info,
    };
  }

  return { info: runtime.info, status, transcribe };
}

/* ---------- speech-to-text of whole recordings (video translation) ---------- */

async function readAudio(request: STTRequest): Promise<Uint8Array> {
  if (request.audio.byteLength > 0) return request.audio;
  if (request.audioPath) return new Uint8Array(await fs.readFile(request.audioPath));
  return request.audio;
}

export function createLocalWhisperStt(env: ProviderEnv, deps: LocalWhisperDeps = {}): STTProvider {
  const runtime = runtimeFor(env, deps);

  async function transcribe(request: STTRequest): Promise<STTResult> {
    if (!runtime.install().installed) {
      throw new AppError(
        'TRANSCRIPT_REQUIRED',
        'The local speech model is not installed: provide the transcript (SRT, VTT or text) or run "pnpm dictation:setup"',
        { sttProvider: LOCAL_WHISPER_ID },
      );
    }
    const pcm = decodeWav(await readAudio(request));
    const samples =
      pcm.sampleRate === WHISPER_SAMPLE_RATE
        ? pcm.samples
        : resampleLinear(pcm.samples, WHISPER_SAMPLE_RATE / pcm.sampleRate);
    const chunks = planAudioChunks(samples, WHISPER_SAMPLE_RATE, {
      maxChunkSec: MAX_WINDOW_SEC,
      searchSec: 8,
    });
    const segments: TimedText[] = [];
    let language: LanguageCode | null = request.language ?? null;
    for (const chunk of chunks) {
      const piece = samples.subarray(chunk.start, chunk.end);
      if (!hasSpeechEnergy(piece, WHISPER_SAMPLE_RATE)) continue;
      const offsetMs = (chunk.start * 1000) / WHISPER_SAMPLE_RATE;
      const durationMs = (piece.length * 1000) / WHISPER_SAMPLE_RATE;
      const output = await runtime.run({
        samples: pcm16ToFloat32(piece),
        language: language ?? undefined,
        timestamps: true,
      });
      // The language detected on the first spoken chunk holds for the whole recording.
      language ??= LOCAL_WHISPER_LANGUAGES.find((code) => code === output.language) ?? null;
      const timed =
        output.chunks.length > 0
          ? output.chunks
          : [{ startSec: 0, endSec: null, text: output.text }];
      for (const item of timed) {
        const text = cleanTranscript(item.text);
        const startMs = Math.min(durationMs, Math.max(0, item.startSec * 1000));
        const endMs = Math.min(durationMs, item.endSec === null ? durationMs : item.endSec * 1000);
        if (text === '' || endMs <= startMs) continue;
        segments.push({
          startMs: Math.round(offsetMs + startMs),
          endMs: Math.round(offsetMs + endMs),
          text,
        });
      }
    }
    return { segments, language, provider: runtime.info };
  }

  return {
    info: runtime.info,
    // Not installed ⇒ behave like the manual provider: ask for the transcript, never fail late.
    get requiresUserTranscript() {
      return !runtime.install().installed;
    },
    transcribe,
  };
}
