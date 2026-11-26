import { AppError } from '@parlante/shared';
import type {
  ProviderRef,
  ProviderVoice,
  TTSProvider,
  TTSRequest,
  TTSResult,
  VoicePitchRange,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { getEspeakEngine } from './espeak-engine';
import type { EspeakEngine } from './espeak-engine';
import {
  createKokoroBackend,
  createPiperBackend,
  piperModelSpec,
  readKokoroStyles,
  readKokoroVocab,
  readPiperConfig,
} from './neural-backends';
import type { PiperConfig } from './neural-backends';
import { NeuralEngineError, resolveVoiceThreads, sharedNeuralEngine } from './neural-engine';
import type { NeuralEngine } from './neural-engine';
import {
  KOKORO_SOURCE,
  KOKORO_TOKENIZER,
  KOKORO_VARIANTS,
  KOKORO_VOICE_FILES,
  PIPER_SOURCE,
  PIPER_VOICE_FILES,
  inspectVoiceFiles,
  readVoiceMarker,
  resolveVoiceModelDir,
  voiceFilePath,
} from './neural-models';
import type { VoiceInstallState, VoiceModelFile } from './neural-models';
import {
  NEURAL_PITCH_MAX_SEMITONES,
  NEURAL_PITCH_MIN_SEMITONES,
  synthesizeNeural,
} from './neural-synth';
import type { VoiceBackend } from './neural-synth';
import {
  KOKORO_VOICES,
  PIPER_VOICES,
  findKokoroVoice,
  findPiperVoice,
  kokoroPhonemeRules,
} from './neural-voices';
import type { KokoroVoiceDef, NeuralVoiceDef, PiperVoiceDef } from './neural-voices';

/* -------------------------------------------------------------------------------------------
 * Local NEURAL voices: two TTS providers over one engine thread.
 *
 *   kokoro   Kokoro-82M: Spanish, English, French, Italian, Portuguese
 *   piper    Piper voices for the other product languages
 *
 * Both run on the CPU of this machine with ONNX Runtime, need no key and no network, and are
 * labelled as what they are: `local: true`, and `quality: 'premium'` — a neural voice, not
 * the formant synthesiser of the basic mode. They only work once their files are installed
 * (`pnpm voices:setup`): until then every voice is listed as unavailable with a translatable
 * reason and the command that installs it, and eSpeak keeps the product talking.
 *
 * What they return that no cloud voice does: the time of every phoneme as the model itself
 * placed it, so lip-sync and word-by-word subtitles follow the real audio (neural-synth.ts).
 * ----------------------------------------------------------------------------------------- */

export const KOKORO_INFO: ProviderRef = {
  id: 'kokoro',
  name: 'Kokoro (neuronal local)',
  quality: 'premium',
  local: true,
};

export const PIPER_INFO: ProviderRef = {
  id: 'piper',
  name: 'Piper (neuronal local)',
  quality: 'premium',
  local: true,
};

/** How the pitch control of every neural voice works (see neural-synth.ts). */
export const NEURAL_PITCH_RANGE: VoicePitchRange = {
  minSemitones: NEURAL_PITCH_MIN_SEMITONES,
  maxSemitones: NEURAL_PITCH_MAX_SEMITONES,
  resampled: true,
};

export type NeuralVoiceEnv = Pick<
  ProviderEnv,
  | 'VOICE_MODEL_DIR'
  | 'VOICE_KOKORO_VARIANT'
  | 'VOICE_THREADS'
  | 'VOICE_IDLE_UNLOAD_SEC'
  | 'VOICE_DEVICE'
>;

/** What the providers need from the outside; tests replace them. */
export interface NeuralVoiceDeps {
  engine?: Pick<NeuralEngine, 'run'>;
  espeak?: () => Promise<EspeakEngine>;
  /** Install state of a voice (default: what is on the disk, `inspectNeuralVoice`). */
  inspect?: (def: NeuralVoiceDef) => VoiceInstallState;
}

/** Files a Kokoro voice needs: the model in the configured precision, its symbols, its style. */
export function kokoroVoiceFiles(env: NeuralVoiceEnv, def: KokoroVoiceDef): VoiceModelFile[] {
  return [
    KOKORO_TOKENIZER,
    KOKORO_VARIANTS[env.VOICE_KOKORO_VARIANT],
    KOKORO_VOICE_FILES[def.file],
  ];
}

export function piperVoiceFiles(def: PiperVoiceDef): VoiceModelFile[] {
  const files = PIPER_VOICE_FILES[def.files];
  return [files.onnx, files.config];
}

/** Install command that gets one voice. */
export function voiceInstallCommand(def: NeuralVoiceDef): string {
  return def.engine === 'kokoro'
    ? 'pnpm voices:setup'
    : `pnpm voices:setup --voices ${def.providerVoiceId}`;
}

/** Install state of one voice of the catalogue (a few `stat` calls). */
export function inspectNeuralVoice(env: NeuralVoiceEnv, def: NeuralVoiceDef): VoiceInstallState {
  const modelsDir = resolveVoiceModelDir(env);
  return def.engine === 'kokoro'
    ? inspectVoiceFiles(modelsDir, KOKORO_SOURCE, kokoroVoiceFiles(env, def))
    : inspectVoiceFiles(modelsDir, PIPER_SOURCE, piperVoiceFiles(def));
}

/** True when at least one voice of the given engine can speak right now. */
export function hasInstalledNeuralVoice(
  env: NeuralVoiceEnv,
  engine: 'kokoro' | 'piper',
  deps: Pick<NeuralVoiceDeps, 'inspect'> = {},
): boolean {
  const voices: readonly NeuralVoiceDef[] = engine === 'kokoro' ? KOKORO_VOICES : PIPER_VOICES;
  const inspect = deps.inspect ?? ((def: NeuralVoiceDef) => inspectNeuralVoice(env, def));
  return voices.some((def) => inspect(def).installed);
}

/** The install state of a whole catalogue, remembered for a moment (listings are frequent). */
const STATE_TTL_MS = 2000;

function stateCache<T extends NeuralVoiceDef>(
  env: NeuralVoiceEnv,
  voices: readonly T[],
  deps: NeuralVoiceDeps,
) {
  if (deps.inspect) return deps.inspect;
  let at = -Infinity;
  let states = new Map<string, VoiceInstallState>();
  return (def: T): VoiceInstallState => {
    const now = Date.now();
    if (now - at > STATE_TTL_MS) {
      const modelsDir = resolveVoiceModelDir(env);
      const source = voices[0]?.engine === 'piper' ? PIPER_SOURCE : KOKORO_SOURCE;
      const marker = readVoiceMarker(modelsDir, source);
      states = new Map(
        voices.map((voice) => [
          voice.providerVoiceId,
          inspectVoiceFiles(
            modelsDir,
            source,
            voice.engine === 'kokoro' ? kokoroVoiceFiles(env, voice) : piperVoiceFiles(voice),
            marker,
          ),
        ]),
      );
      at = now;
    }
    return states.get(def.providerVoiceId) ?? inspectNeuralVoice(env, def);
  };
}

function publicVoice(def: NeuralVoiceDef, state: VoiceInstallState): ProviderVoice {
  return {
    providerVoiceId: def.providerVoiceId,
    name: def.name,
    language: def.language,
    gender: def.gender,
    description: def.description,
    tags: [...def.tags],
    pitchRange: NEURAL_PITCH_RANGE,
    ...(state.installed || state.reasonCode === null
      ? {}
      : { unavailable: { reasonCode: state.reasonCode, command: voiceInstallCommand(def) } }),
  };
}

function notInstalled(info: ProviderRef, def: NeuralVoiceDef, state: VoiceInstallState): AppError {
  const command = voiceInstallCommand(def);
  return new AppError(
    'SERVICE_UNAVAILABLE',
    `The voice "${def.name}" (${info.name}) is not installed on this server: run "${command}"`,
    {
      reason: state.reasonCode ?? 'voice_not_installed',
      provider: info.id,
      providerVoiceId: def.providerVoiceId,
      command,
    },
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function engineOf(env: NeuralVoiceEnv, deps: NeuralVoiceDeps): Pick<NeuralEngine, 'run'> {
  return (
    deps.engine ??
    sharedNeuralEngine({
      threads: resolveVoiceThreads(env.VOICE_THREADS),
      idleUnloadMs: env.VOICE_IDLE_UNLOAD_SEC * 1000,
      device: env.VOICE_DEVICE,
    })
  );
}

/** Small files read once per process: a failed read is not remembered. */
function remember<T>(cache: Map<string, Promise<T>>, key: string, read: () => Promise<T>) {
  let value = cache.get(key);
  if (!value) {
    value = read();
    cache.set(key, value);
    value.catch(() => {
      if (cache.get(key) === value) cache.delete(key);
    });
  }
  return value;
}

async function speak(
  info: ProviderRef,
  request: TTSRequest,
  espeakVoice: string,
  backend: VoiceBackend,
  deps: NeuralVoiceDeps,
): Promise<TTSResult> {
  const espeak = await (deps.espeak ?? getEspeakEngine)();
  const speed =
    clamp(finiteOr(request.speed, 1), 0.5, 2) *
    clamp(finiteOr(request.profile?.speed ?? 1, 1), 0.5, 2);
  const pitchSemitones =
    clamp(finiteOr(request.pitch, 0), -12, 12) +
    clamp(finiteOr(request.profile?.pitchSemitones ?? 0, 0), -12, 12);
  try {
    return await synthesizeNeural(
      { text: request.text, espeakVoice, speed, pitchSemitones, provider: info },
      backend,
      espeak,
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof NeuralEngineError && err.phase === 'load') {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `The voice model could not be loaded: ${err.message}`,
        { reason: 'voice_runtime_unavailable', provider: info.id },
      );
    }
    throw new AppError('PROVIDER_ERROR', `${info.name} could not synthesize this text`, {
      provider: info.id,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/* ---------- Kokoro ---------- */

export function createKokoroProvider(env: NeuralVoiceEnv, deps: NeuralVoiceDeps = {}): TTSProvider {
  const stateOf = stateCache(env, KOKORO_VOICES, deps);
  const inspect = deps.inspect ?? ((def: NeuralVoiceDef) => inspectNeuralVoice(env, def));
  const vocabs = new Map<string, Promise<Map<string, number>>>();
  const styles = new Map<string, Promise<Float32Array>>();
  const modelsDir = () => resolveVoiceModelDir(env);

  async function synthesize(request: TTSRequest): Promise<TTSResult> {
    // A local voice profile names the neural voice it is built on.
    const def =
      findKokoroVoice(request.profile?.baseVoiceId ?? request.providerVoiceId) ??
      findKokoroVoice(request.providerVoiceId);
    if (!def) {
      throw new AppError('NOT_FOUND', 'Voice not found', {
        provider: KOKORO_INFO.id,
        providerVoiceId: request.providerVoiceId,
      });
    }
    const state = inspect(def);
    if (!state.installed) throw notInstalled(KOKORO_INFO, def, state);
    const dir = modelsDir();
    const variant = env.VOICE_KOKORO_VARIANT;
    const tokenizerPath = voiceFilePath(dir, KOKORO_SOURCE, KOKORO_TOKENIZER);
    const voicePath = voiceFilePath(dir, KOKORO_SOURCE, KOKORO_VOICE_FILES[def.file]);
    const modelPath = voiceFilePath(dir, KOKORO_SOURCE, KOKORO_VARIANTS[variant]);
    const [vocab, style] = await Promise.all([
      remember(vocabs, tokenizerPath, () => readKokoroVocab(tokenizerPath)),
      remember(styles, voicePath, () => readKokoroStyles(voicePath)),
    ]);
    const rules = kokoroPhonemeRules(def, request.language);
    const backend = createKokoroBackend({
      engine: engineOf(env, deps),
      model: { key: `kokoro:${variant}:${modelPath}`, path: modelPath },
      vocab,
      styles: style,
      dialect: rules.dialect,
    });
    return speak(KOKORO_INFO, request, rules.espeak, backend, deps);
  }

  return {
    info: KOKORO_INFO,
    volatileVoices: true,
    listVoices: async () => KOKORO_VOICES.map((def) => publicVoice(def, stateOf(def))),
    synthesize,
  };
}

/* ---------- Piper ---------- */

export function createPiperProvider(env: NeuralVoiceEnv, deps: NeuralVoiceDeps = {}): TTSProvider {
  const stateOf = stateCache(env, PIPER_VOICES, deps);
  const inspect = deps.inspect ?? ((def: NeuralVoiceDef) => inspectNeuralVoice(env, def));
  const configs = new Map<string, Promise<PiperConfig>>();

  async function synthesize(request: TTSRequest): Promise<TTSResult> {
    const def =
      findPiperVoice(request.profile?.baseVoiceId ?? request.providerVoiceId) ??
      findPiperVoice(request.providerVoiceId);
    if (!def) {
      throw new AppError('NOT_FOUND', 'Voice not found', {
        provider: PIPER_INFO.id,
        providerVoiceId: request.providerVoiceId,
      });
    }
    const state = inspect(def);
    if (!state.installed) throw notInstalled(PIPER_INFO, def, state);
    const dir = resolveVoiceModelDir(env);
    const files = PIPER_VOICE_FILES[def.files];
    const configPath = voiceFilePath(dir, PIPER_SOURCE, files.config);
    const modelPath = voiceFilePath(dir, PIPER_SOURCE, files.onnx);
    const config = await remember(configs, configPath, () => readPiperConfig(configPath));
    const backend = createPiperBackend({
      engine: engineOf(env, deps),
      model: piperModelSpec(`piper:${modelPath}`, modelPath),
      config,
      speaker: def.speaker,
    });
    // A Piper voice only knows the sounds of its own language: its rules always apply.
    return speak(PIPER_INFO, request, def.espeakVoice, backend, deps);
  }

  return {
    info: PIPER_INFO,
    volatileVoices: true,
    listVoices: async () => PIPER_VOICES.map((def) => publicVoice(def, stateOf(def))),
    synthesize,
  };
}
