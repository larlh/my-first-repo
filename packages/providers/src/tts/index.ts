import type { Providers, TTSProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { createElevenLabsProvider } from './elevenlabs';
import { createEspeakProvider } from './espeak';
import { createOpenAiTtsProvider } from './openai';

/**
 * Owner: providers-speech.
 * Every TTS provider whose requirements are met is ACTIVE at the same time (their stock voices
 * are all listed; a voice id names its provider). `TTS_PROVIDER` only chooses the default one.
 * eSpeak is always active, so the product always has voices.
 */
export function createTtsProviders(env: ProviderEnv): Providers['tts'] {
  const active = new Map<string, TTSProvider>();
  const espeak = createEspeakProvider(env);
  active.set(espeak.info.id, espeak);
  if (env.ELEVENLABS_API_KEY) {
    const p = createElevenLabsProvider(env);
    active.set(p.info.id, p);
  }
  if (env.OPENAI_API_KEY) {
    const p = createOpenAiTtsProvider(env);
    active.set(p.info.id, p);
  }
  const defaultId = resolveChoice(
    env.TTS_PROVIDER,
    [
      { id: 'elevenlabs', available: Boolean(env.ELEVENLABS_API_KEY) },
      { id: 'openai', available: Boolean(env.OPENAI_API_KEY) },
    ],
    'espeak',
  );
  // An explicit choice without its key fails loudly here (PROVIDER_NOT_CONFIGURED).
  const fallback =
    active.get(defaultId) ??
    (defaultId === 'elevenlabs' ? createElevenLabsProvider(env) : createOpenAiTtsProvider(env));
  return {
    default: fallback,
    get: (providerId) => active.get(providerId) ?? null,
    all: () => [...active.values()],
  };
}
