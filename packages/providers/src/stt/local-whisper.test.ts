import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitiesSchema, DICTATION_MAX_SEGMENT_MS } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createProviders, describeCapabilities, describeDictation } from '../registry';
import { encodeWav } from '../tts/wav';
import { createDictationProvider, createSttProvider } from './index';
import {
  LOCAL_WHISPER_LANGUAGES,
  cleanTranscript,
  collapseRepetitions,
  createLocalWhisperDictation,
  createLocalWhisperStt,
  hasSpeechEnergy,
  pcm16ToFloat32,
} from './local-whisper';
import type { WhisperRunner } from './local-whisper';
import { WhisperEngineError } from './whisper-engine';
import type { WhisperJob, WhisperOutput } from './whisper-engine';
import {
  WHISPER_INSTALL_MARKER,
  WHISPER_MODELS,
  whisperModelFolder,
} from './whisper-models';
import type { WhisperInstallState } from './whisper-models';

/*
 * The local Whisper providers with a DOUBLE in place of the worker-thread engine: selection,
 * availability, what reaches the model and what comes back. The real model is exercised in
 * local-whisper.real.test.ts (skipped when it is not installed).
 */

const RATE = 16_000;
const env = (overrides: Record<string, string> = {}) => providerEnvSchema.parse(overrides);
const INSTALLED: WhisperInstallState = { installed: true, reasonCode: null, reason: null, dir: '/m' };
const MISSING: WhisperInstallState = {
  installed: false,
  reasonCode: 'model_not_installed',
  reason: 'The speech model whisper-base is not installed: run "pnpm dictation:setup"',
  dir: '/m',
};

/** A tone loud enough to count as speech, `seconds` long. */
function tone(seconds: number, amplitude = 9000): Int16Array {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 180 * i) / RATE));
  }
  return samples;
}

function recorder(answer: (job: WhisperJob, index: number) => WhisperOutput | Error) {
  const jobs: WhisperJob[] = [];
  const runner: WhisperRunner = {
    async run(job) {
      jobs.push(job);
      const result = answer(job, jobs.length - 1);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { jobs, runner };
}

describe('audio and text helpers', () => {
  it('converts PCM 16-bit to floats in a buffer of its own', () => {
    const pcm = Int16Array.from([0, 16384, -32768, 32767]);
    const floats = pcm16ToFloat32(pcm);
    expect([...floats]).toEqual([0, 0.5, -1, 32767 / 32768]);
    expect(floats.buffer).not.toBe(pcm.buffer);
    expect(floats.byteOffset).toBe(0);
  });

  it('tells speech-level audio from silence, hiss and clicks', () => {
    expect(hasSpeechEnergy(new Int16Array(RATE * 3), RATE)).toBe(false);
    expect(hasSpeechEnergy(tone(1), RATE)).toBe(true);
    // Background hiss around -55 dBFS.
    expect(hasSpeechEnergy(tone(3, 60), RATE)).toBe(false);
    // A click: loud, but far too short to be a word.
    const click = new Int16Array(RATE);
    click.set(tone(0.03, 20_000), 4000);
    expect(hasSpeechEnergy(click, RATE)).toBe(false);
    // A short word inside a long silence.
    const word = new Int16Array(RATE * 5);
    word.set(tone(0.3), RATE * 2);
    expect(hasSpeechEnergy(word, RATE)).toBe(true);
    expect(hasSpeechEnergy(new Int16Array(0), RATE)).toBe(false);
  });

  it('collapses the loops of a stuck decoder and leaves normal repetition alone', () => {
    expect(collapseRepetitions('Oh, ya, ya, ya, ya, ya, ya, ya, ya, ya,')).toBe('Oh, ya,');
    expect(
      collapseRepetitions('y a las años, a las años, a las años, a las años, a las años, fin'),
    ).toBe('y a las años, fin');
    expect(collapseRepetitions('no, no, no, eso no')).toBe('no, no, no, eso no');
    expect(collapseRepetitions('muy muy bien')).toBe('muy muy bien');
    expect(collapseRepetitions('  uno   dos  ')).toBe('uno dos');
    expect(collapseRepetitions('')).toBe('');
  });

  it('removes non-speech markers', () => {
    expect(cleanTranscript(' [Música]  Hola a todos. [BLANK_AUDIO] ')).toBe('Hola a todos.');
    expect(cleanTranscript('♪ la la ♪')).toBe('la la');
    expect(cleanTranscript(' (entre paréntesis) se queda ')).toBe('(entre paréntesis) se queda');
  });
});

describe('local dictation provider (engine double)', () => {
  it('is honest about what it is', () => {
    const provider = createLocalWhisperDictation(env(), {
      runner: recorder(() => new Error('unused')).runner,
      inspect: () => INSTALLED,
    });
    expect(provider.info).toEqual({
      id: 'local-whisper',
      name: 'Whisper base (local)',
      quality: 'basic',
      local: true,
    });
    const small = createLocalWhisperDictation(env({ DICTATION_MODEL: 'whisper-small' }), {
      runner: recorder(() => new Error('unused')).runner,
      inspect: () => INSTALLED,
    });
    expect(small.info.name).toBe('Whisper small (local)');
  });

  it('reports itself unavailable, with a translatable code, while the model is not installed', async () => {
    const { jobs, runner } = recorder(() => new Error('must not run'));
    const provider = createLocalWhisperDictation(env(), { runner, inspect: () => MISSING });
    expect(await provider.status()).toEqual({
      available: false,
      reason: MISSING.reason,
      reasonCode: 'model_not_installed',
      languages: [],
      model: null,
    });
    await expect(
      provider.transcribe({ samples: tone(1), sampleRate: RATE }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      details: { reason: 'model_not_installed' },
    });
    expect(jobs).toHaveLength(0);
  });

  it('notices an install made while the process runs', async () => {
    let state = MISSING;
    const { runner } = recorder(() => ({ text: ' Hola.', language: 'es', chunks: [] }));
    const provider = createLocalWhisperDictation(env(), { runner, inspect: () => state });
    expect((await provider.status()).available).toBe(false);
    state = INSTALLED;
    expect(await provider.status()).toEqual({
      available: true,
      reason: null,
      reasonCode: null,
      languages: LOCAL_WHISPER_LANGUAGES,
      model: 'whisper-base',
    });
    expect((await provider.transcribe({ samples: tone(1), sampleRate: RATE })).text).toBe('Hola.');
  });

  it('sends the audio and the language hint to the engine and cleans what comes back', async () => {
    const { jobs, runner } = recorder(() => ({
      text: '  Hola,   bienvenidos a todos. [Música] ',
      language: 'es',
      chunks: [],
    }));
    const provider = createLocalWhisperDictation(env(), { runner, inspect: () => INSTALLED });
    const samples = tone(2);
    const signal = new AbortController().signal;
    const result = await provider.transcribe({ samples, sampleRate: RATE, language: 'es', signal });
    expect(result).toEqual({
      text: 'Hola, bienvenidos a todos.',
      language: 'es',
      provider: provider.info,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ language: 'es', timestamps: false, signal });
    expect(jobs[0]!.samples).toBeInstanceOf(Float32Array);
    expect(jobs[0]!.samples).toHaveLength(samples.length);
    expect(Math.max(...jobs[0]!.samples.subarray(0, 400))).toBeCloseTo(9000 / 32768, 2);
  });

  it('returns the detected language when no hint is given, and only product languages', async () => {
    let detected: string | null = 'en';
    const { jobs, runner } = recorder(() => ({ text: ' Hello there.', language: detected, chunks: [] }));
    const provider = createLocalWhisperDictation(env(), { runner, inspect: () => INSTALLED });
    const first = await provider.transcribe({ samples: tone(1), sampleRate: RATE });
    expect(first).toMatchObject({ text: 'Hello there.', language: 'en' });
    expect(jobs[0]!.language).toBeUndefined();
    detected = 'ja'; // not a language of the product
    expect((await provider.transcribe({ samples: tone(1), sampleRate: RATE })).language).toBeNull();
  });

  it('never sends silence to the model (it would invent a sentence)', async () => {
    const { jobs, runner } = recorder(() => ({ text: 'Gracias por ver el vídeo.', language: 'es', chunks: [] }));
    const provider = createLocalWhisperDictation(env(), { runner, inspect: () => INSTALLED });
    expect(await provider.transcribe({ samples: new Int16Array(RATE * 4), sampleRate: RATE })).toEqual({
      text: '',
      language: null,
      provider: provider.info,
    });
    expect(
      await provider.transcribe({ samples: tone(2, 40), sampleRate: RATE, language: 'es' }),
    ).toMatchObject({ text: '', language: 'es' });
    expect(jobs).toHaveLength(0);
  });

  it('rejects audio that is not sampled at 16 kHz', async () => {
    const { jobs, runner } = recorder(() => new Error('must not run'));
    const provider = createLocalWhisperDictation(env(), { runner, inspect: () => INSTALLED });
    await expect(
      provider.transcribe({ samples: tone(1), sampleRate: 44_100 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(jobs).toHaveLength(0);
  });

  it('turns a model that cannot load into 503 runtime_unavailable and backs off for a minute', async () => {
    let now = 1_000_000;
    let healthy = false;
    const { jobs, runner } = recorder(() =>
      healthy
        ? { text: 'ya funciona', language: 'es', chunks: [] }
        : new WhisperEngineError('Protobuf parsing failed', 'load'),
    );
    const provider = createLocalWhisperDictation(env(), {
      runner,
      inspect: () => INSTALLED,
      now: () => now,
    });
    const request = { samples: tone(1), sampleRate: RATE, language: 'es' as const };
    await expect(provider.transcribe(request)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'runtime_unavailable' },
    });
    expect(await provider.status()).toMatchObject({
      available: false,
      reasonCode: 'runtime_unavailable',
      reason: expect.stringContaining('Protobuf parsing failed'),
    });
    // During the back-off the engine is not asked again.
    await expect(provider.transcribe(request)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(jobs).toHaveLength(1);
    now += 61_000;
    healthy = true;
    expect((await provider.status()).available).toBe(true);
    expect((await provider.transcribe(request)).text).toBe('ya funciona');
  });

  it('maps a failed segment to PROVIDER_ERROR and an abort to a client error', async () => {
    const failing = createLocalWhisperDictation(env(), {
      runner: recorder(() => new WhisperEngineError('invalid tensor', 'run')).runner,
      inspect: () => INSTALLED,
    });
    await expect(
      failing.transcribe({ samples: tone(1), sampleRate: RATE }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 502 });
    // A failed segment says nothing about the model: still available.
    expect((await failing.status()).available).toBe(true);
    const aborted = createLocalWhisperDictation(env(), {
      runner: recorder(() => new WhisperEngineError('Aborted', 'aborted')).runner,
      inspect: () => INSTALLED,
    });
    await expect(
      aborted.transcribe({ samples: tone(1), sampleRate: RATE }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('local STT provider (engine double)', () => {
  it('asks for the transcript while the model is not installed, like the manual provider', async () => {
    let state = MISSING;
    const { runner } = recorder(() => ({ text: 'hola', language: 'es', chunks: [] }));
    const stt = createLocalWhisperStt(env(), { runner, inspect: () => state });
    expect(stt.requiresUserTranscript).toBe(true);
    await expect(stt.transcribe({ audio: encodeWav(tone(1), RATE) })).rejects.toMatchObject({
      code: 'TRANSCRIPT_REQUIRED',
      details: { sttProvider: 'local-whisper' },
    });
    state = INSTALLED;
    expect(stt.requiresUserTranscript).toBe(false);
  });

  it('cuts a long recording at silences and puts every phrase back on the timeline', async () => {
    // 70 s: 4 s of "speech" and 1 s of silence, repeated.
    const samples = new Int16Array(70 * RATE);
    for (let start = 0; start < 70; start += 5) samples.set(tone(4), start * RATE);
    const { jobs, runner } = recorder((job, index) => ({
      text: `texto ${index}`,
      language: 'es',
      chunks: [
        { startSec: 0.5, endSec: 3.5, text: ` Frase ${index} uno.` },
        { startSec: 5.2, endSec: null, text: ` Frase ${index} dos. [Música]` },
        { startSec: 1000, endSec: 1001, text: ' fuera del audio' },
        { startSec: 9, endSec: 9.5, text: ' [BLANK_AUDIO] ' },
      ],
    }));
    const stt = createLocalWhisperStt(env(), { runner, inspect: () => INSTALLED });
    const result = await stt.transcribe({ audio: encodeWav(samples, RATE) });

    expect(result.provider).toEqual(stt.info);
    expect(result.language).toBe('es');
    expect(jobs.length).toBeGreaterThanOrEqual(3);
    let cursor = 0;
    const offsets: number[] = [];
    for (const job of jobs) {
      expect(job.timestamps).toBe(true);
      expect(job.samples.length).toBeLessThanOrEqual(29 * RATE);
      offsets.push(cursor);
      cursor += job.samples.length;
    }
    expect(cursor).toBe(samples.length); // every sample was sent exactly once
    // The first chunk asked for detection; the following ones reuse the language it found.
    expect(jobs.map((job) => job.language)).toEqual([undefined, ...jobs.slice(1).map(() => 'es')]);

    expect(result.segments).toHaveLength(jobs.length * 2);
    jobs.forEach((job, index) => {
      const offsetMs = (offsets[index]! * 1000) / RATE;
      const durationMs = (job.samples.length * 1000) / RATE;
      expect(result.segments[index * 2]).toEqual({
        startMs: Math.round(offsetMs + 500),
        endMs: Math.round(offsetMs + 3500),
        text: `Frase ${index} uno.`,
      });
      // An open-ended phrase runs to the end of its chunk.
      expect(result.segments[index * 2 + 1]).toEqual({
        startMs: Math.round(offsetMs + 5200),
        endMs: Math.round(offsetMs + durationMs),
        text: `Frase ${index} dos.`,
      });
    });
    const starts = result.segments.map((segment) => segment.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('honours the language hint, skips silent chunks and reads the audio from a file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-stt-'));
    try {
      const samples = new Int16Array(40 * RATE);
      samples.set(tone(3), 0); // speech only at the very start: the second chunk is silence
      const audioPath = path.join(dir, 'speech.wav');
      await fs.writeFile(audioPath, encodeWav(samples, RATE));
      const { jobs, runner } = recorder(() => ({ text: ' Solo texto.', language: 'en', chunks: [] }));
      const stt = createLocalWhisperStt(env(), { runner, inspect: () => INSTALLED });
      const result = await stt.transcribe({ audio: new Uint8Array(), audioPath, language: 'es' });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.language).toBe('es');
      expect(result.language).toBe('es');
      // No timestamps from the engine: the text covers its chunk.
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]).toMatchObject({ startMs: 0, text: 'Solo texto.' });
      expect(result.segments[0]!.endMs).toBe(Math.round((jobs[0]!.samples.length * 1000) / RATE));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('resamples audio that is not at 16 kHz', async () => {
    const source = new Int16Array(2 * 48_000);
    for (let i = 0; i < source.length; i += 1) {
      source[i] = Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / 48_000));
    }
    const { jobs, runner } = recorder(() => ({ text: 'ok', language: 'es', chunks: [] }));
    const stt = createLocalWhisperStt(env(), { runner, inspect: () => INSTALLED });
    await stt.transcribe({ audio: encodeWav(source, 48_000), language: 'es' });
    expect(jobs[0]!.samples).toHaveLength(2 * RATE);
  });
});

describe('selection and capabilities', () => {
  let emptyDir: string;
  let installedDir: string;

  beforeAll(async () => {
    emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-nomodel-'));
    installedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-fakemodel-'));
    // The SHAPE of an install (marker + files of the right size, as sparse files): enough for
    // the cheap check that decides `auto`. Nothing in these tests loads it.
    const model = WHISPER_MODELS['whisper-base'];
    const dir = path.join(installedDir, whisperModelFolder(model));
    for (const file of model.files) {
      const target = path.join(dir, ...file.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const handle = await fs.open(target, 'w');
      await handle.truncate(file.sizeBytes);
      await handle.close();
    }
    await fs.writeFile(
      path.join(dir, WHISPER_INSTALL_MARKER),
      JSON.stringify({ model: model.id, repo: model.repo, revision: model.revision, files: model.files }),
    );
  });
  afterAll(async () => {
    await fs.rm(emptyDir, { recursive: true, force: true });
    await fs.rm(installedDir, { recursive: true, force: true });
  });

  it('auto → manual without the model, local-whisper with it, openai when keyed', () => {
    expect(createSttProvider(env({ DICTATION_MODEL_DIR: emptyDir })).info.id).toBe('manual');
    const local = createSttProvider(env({ DICTATION_MODEL_DIR: installedDir }));
    expect(local.info).toMatchObject({ id: 'local-whisper', quality: 'basic', local: true });
    expect(local.requiresUserTranscript).toBe(false);
    expect(
      createSttProvider(env({ DICTATION_MODEL_DIR: installedDir, OPENAI_API_KEY: 'sk-test' })).info
        .id,
    ).toBe('openai');
    // Explicit choices are honoured as they are.
    expect(
      createSttProvider(env({ DICTATION_MODEL_DIR: installedDir, STT_PROVIDER: 'manual' })).info.id,
    ).toBe('manual');
    const forced = createSttProvider(
      env({ DICTATION_MODEL_DIR: emptyDir, STT_PROVIDER: 'local-whisper' }),
    );
    expect(forced.info.id).toBe('local-whisper');
    expect(forced.requiresUserTranscript).toBe(true); // degrades to "supply the transcript"
    // The other model of the catalogue is not the one installed here.
    expect(
      createSttProvider(env({ DICTATION_MODEL_DIR: installedDir, DICTATION_MODEL: 'whisper-small' }))
        .info.id,
    ).toBe('manual');
  });

  it('dictation is always the local model, even when an OpenAI key selects another STT', async () => {
    const keyed = env({ DICTATION_MODEL_DIR: installedDir, OPENAI_API_KEY: 'sk-test' });
    expect(createSttProvider(keyed).info.id).toBe('openai');
    const dictation = createDictationProvider(keyed);
    expect(dictation.info).toMatchObject({ id: 'local-whisper', local: true });
    expect((await dictation.status()).available).toBe(true);
  });

  it('describes dictation in the capabilities, installed or not', async () => {
    const base = { AVATAR_ENGINE_URL: 'http://127.0.0.1:9', STORAGE_LOCAL_DIR: emptyDir };
    const without = await describeCapabilities(
      createProviders(env({ ...base, DICTATION_MODEL_DIR: emptyDir })),
    );
    expect(CapabilitiesSchema.parse(without)).toEqual(without);
    expect(without.sttRequiresTranscript).toBe(true);
    expect(without.dictation).toEqual({
      local: {
        available: false,
        provider: { id: 'local-whisper', name: 'Whisper base (local)', quality: 'basic', local: true },
        reason: expect.stringContaining('pnpm dictation:setup'),
        reasonCode: 'model_not_installed',
        languages: [],
      },
      maxSegmentMs: DICTATION_MAX_SEGMENT_MS,
    });

    const withModel = await describeCapabilities(
      createProviders(env({ ...base, DICTATION_MODEL_DIR: installedDir })),
    );
    expect(CapabilitiesSchema.parse(withModel)).toEqual(withModel);
    expect(withModel.active.stt.id).toBe('local-whisper');
    expect(withModel.sttRequiresTranscript).toBe(false);
    expect(withModel.dictation.local).toEqual({
      available: true,
      provider: { id: 'local-whisper', name: 'Whisper base (local)', quality: 'basic', local: true },
      reason: null,
      reasonCode: null,
      languages: LOCAL_WHISPER_LANGUAGES,
    });
  });

  it('never throws from the capabilities: a failing or missing provider is reported', async () => {
    expect(await describeDictation(undefined)).toMatchObject({
      local: { available: false, provider: null, reasonCode: 'not_configured', languages: [] },
      maxSegmentMs: 30_000,
    });
    const info = { id: 'local-whisper', name: 'x', quality: 'basic' as const, local: true };
    const broken = await describeDictation({
      info,
      status: async () => {
        throw new Error('disk on fire');
      },
      transcribe: async () => {
        throw new Error('unused');
      },
    });
    expect(broken.local).toEqual({
      available: false,
      provider: info,
      reason: 'disk on fire',
      reasonCode: 'unknown',
      languages: [],
    });
    // Consumers of an older producer still get the block.
    const legacy = CapabilitiesSchema.parse({
      active: {},
      ttsProviders: [],
      sttRequiresTranscript: true,
      avatarEngine: { available: false, reason: 'x', device: null, secondsPerVideoSecond: null },
    });
    expect(legacy.dictation.local).toMatchObject({ available: false, reasonCode: 'not_configured' });
    expect(legacy.dictation.maxSegmentMs).toBe(30_000);
  });
});
