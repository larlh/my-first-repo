import type { Providers, TTSProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { createChatterboxTtsProvider } from './chatterbox';
import { createElevenLabsProvider } from './elevenlabs';
import { createEspeakProvider } from './espeak';
import { createKokoroProvider, createPiperProvider, hasInstalledNeuralVoice } from './neural';
import type { NeuralVoiceDeps } from './neural';
import { createOpenAiTtsProvider } from './openai';

export { createChatterboxTtsProvider } from './chatterbox';
export { createElevenLabsProvider } from './elevenlabs';
export { createEspeakProvider } from './espeak';
export { ESPEAK_VOICES } from './espeak-voices';
export {
  KOKORO_INFO,
  NEURAL_PITCH_RANGE,
  PIPER_INFO,
  createKokoroProvider,
  createPiperProvider,
  hasInstalledNeuralVoice,
  inspectNeuralVoice,
  kokoroVoiceFiles,
  piperVoiceFiles,
  voiceInstallCommand,
} from './neural';
export type { NeuralVoiceDeps, NeuralVoiceEnv } from './neural';
export { NeuralEngine, NeuralEngineError, disposeNeuralEngines } from './neural-engine';
export {
  DEFAULT_KOKORO_VARIANT,
  KOKORO_SOURCE,
  KOKORO_VARIANTS,
  KOKORO_VARIANT_IDS,
  PIPER_SOURCE,
  resolveVoiceModelDir,
} from './neural-models';
export type { KokoroVariant } from './neural-models';
export { VoiceIntegrityError, installVoiceFiles, removeVoiceFiles } from './neural-setup';
export {
  KOKORO_VOICES,
  NEURAL_VOICES,
  PIPER_VOICES,
  findKokoroVoice,
  findPiperVoice,
} from './neural-voices';
export type { KokoroVoiceDef, NeuralVoiceDef, PiperVoiceDef } from './neural-voices';
export { createOpenAiTtsProvider } from './openai';
export { prepareSpeech } from './text';
export { decodeWav, encodeWav } from './wav';

/** How long the "is a neural voice installed" answer is reused (the default is asked often). */
const INSTALLED_TTL_MS = 2000;

/**
 * Owner: providers-speech / voice-neural.
 * Every TTS provider whose requirements are met is ACTIVE at the same time (their stock voices
 * are all listed; a voice id names its provider). eSpeak is always active, so the product
 * always has voices; the local neural providers (Kokoro, Piper) are always active too and list
 * the voices whose files are missing as unavailable.
 *
 * `TTS_PROVIDER` only decides whose voices are the DEFAULT of new content (`ranked()`, best
 * first):
 *   auto         external with a key → neural voices that are installed → eSpeak
 *   neural       neural voices that are installed → eSpeak (even when a key is set)
 *   espeak       eSpeak only
 *   elevenlabs / openai   that provider (its key is required) → neural installed → eSpeak
 * The answer follows the disk: installing the voices changes the default without a restart.
 */
export function createTtsProviders(env: ProviderEnv, deps: NeuralVoiceDeps = {}): Providers['tts'] {
  const active = new Map<string, TTSProvider>();
  const espeak = createEspeakProvider(env);
  const kokoro = createKokoroProvider(env, deps);
  const piper = createPiperProvider(env, deps);
  for (const provider of [espeak, kokoro, piper]) active.set(provider.info.id, provider);
  // Speaks the voices cloned by the local voice engine. Always active so those voices resolve;
  // it has no stock voices, so it never becomes the default (it is not in `ranked()`).
  const chatterbox = createChatterboxTtsProvider(env);
  active.set(chatterbox.info.id, chatterbox);
  if (env.ELEVENLABS_API_KEY) {
    const p = createElevenLabsProvider(env);
    active.set(p.info.id, p);
  }
  if (env.OPENAI_API_KEY) {
    const p = createOpenAiTtsProvider(env);
    active.set(p.info.id, p);
  }

  const choice = env.TTS_PROVIDER;
  let external: TTSProvider | null = null;
  if (choice === 'elevenlabs' || choice === 'openai') {
    // An explicit choice without its key fails loudly here (PROVIDER_NOT_CONFIGURED).
    external =
      active.get(choice) ??
      (choice === 'elevenlabs' ? createElevenLabsProvider(env) : createOpenAiTtsProvider(env));
  } else if (choice === 'auto') {
    external = active.get('elevenlabs') ?? active.get('openai') ?? null;
  }

  let installedAt = -Infinity;
  let installed: TTSProvider[] = [];
  const installedNeural = (): TTSProvider[] => {
    const now = Date.now();
    // An injected inspector (tests) is always asked afresh.
    if (deps.inspect || now - installedAt > INSTALLED_TTL_MS) {
      installed = [
        ...(hasInstalledNeuralVoice(env, 'kokoro', deps) ? [kokoro] : []),
        ...(hasInstalledNeuralVoice(env, 'piper', deps) ? [piper] : []),
      ];
      installedAt = now;
    }
    return installed;
  };
  const ranked = (): TTSProvider[] => {
    if (choice === 'espeak') return [espeak];
    return [...(external ? [external] : []), ...installedNeural(), espeak];
  };

  return {
    get default() {
      return ranked()[0] ?? espeak;
    },
    get: (providerId) => active.get(providerId) ?? null,
    all: () => [...active.values()],
    ranked,
  };
}
