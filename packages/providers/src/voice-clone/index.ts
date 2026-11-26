import type { LanguageCode, ProviderRef, VoiceCloneProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { createChatterboxVoiceCloneProvider } from './chatterbox';
import { createElevenLabsVoiceCloneProvider } from './elevenlabs';
import { LOCAL_VOICE_CLONE_INFO, createLocalVoiceCloneProvider } from './local';
import type { LocalVoiceCloneOptions } from './local';
import {
  CHATTERBOX_INFO,
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_VOICE_ID,
  createVoiceEngineClient,
} from './voice-engine';
import type { VoiceEngineClient } from './voice-engine';

export { analyzeVoice } from './analysis';
export type { VoiceAnalysis } from './analysis';
export { createChatterboxVoiceCloneProvider } from './chatterbox';
export { createElevenLabsVoiceCloneProvider } from './elevenlabs';
export { createLocalVoiceCloneProvider } from './local';
export {
  CHATTERBOX_INFO,
  CHATTERBOX_LANGUAGES,
  WATERMARK_THRESHOLD,
  createVoiceEngineClient,
} from './voice-engine';
export type { VoiceEngineClient, VoiceEngineHealth, VoiceEngineSpeech } from './voice-engine';

export interface VoiceCloneDeps {
  /** Client of services/voice-engine (tests inject a double). */
  engine?: VoiceEngineClient;
  /** Options of the basic local profile provider (tests inject TTS doubles). */
  local?: LocalVoiceCloneOptions;
}

/**
 * Owner: providers-speech. Selected by VOICE_CLONE_PROVIDER:
 *   elevenlabs   ElevenLabs instant cloning (key required)
 *   chatterbox   the local voice engine (Chatterbox es-ES); Spanish only
 *   local        the basic voice profile (pitch and pace over a local synthetic voice)
 *   auto         ElevenLabs when its key is set; otherwise, for Spanish, the local voice
 *                engine WHEN IT ANSWERS at clone time; otherwise the basic voice profile
 *
 * Whatever the choice, a voice created by the local voice engine (`cbx_…`) is always deleted
 * there: deleting a voice or revoking its consent must leave nothing behind.
 */
export function createVoiceCloneProvider(
  env: ProviderEnv,
  deps: VoiceCloneDeps = {},
): VoiceCloneProvider {
  const engine = deps.engine ?? createVoiceEngineClient(env);
  const chatterbox = createChatterboxVoiceCloneProvider(env, engine);
  const choice = env.VOICE_CLONE_PROVIDER;
  const fixed: VoiceCloneProvider | null =
    choice === 'chatterbox'
      ? chatterbox
      : choice === 'elevenlabs' || (choice === 'auto' && env.ELEVENLABS_API_KEY)
        ? createElevenLabsVoiceCloneProvider(env)
        : choice === 'local'
          ? createLocalVoiceCloneProvider(env, deps.local)
          : null;
  const local = fixed ?? createLocalVoiceCloneProvider(env, deps.local);

  async function pick(language: LanguageCode): Promise<VoiceCloneProvider> {
    if (fixed) return fixed;
    if (CHATTERBOX_LANGUAGES.includes(language) && (await engine.usable())) return chatterbox;
    return local;
  }

  // `info` is the provider picked last (a plain property: it follows the engine going up or down).
  const router: Omit<VoiceCloneProvider, 'info'> & { info: ProviderRef } = {
    info: local.info,
    async current(language = 'es') {
      router.info = (await pick(language)).info;
      return router.info;
    },
    async createVoice(request) {
      const provider = await pick(request.language);
      router.info = provider.info;
      return provider.createVoice(request);
    },
    deleteVoice(providerVoiceId) {
      if (CHATTERBOX_VOICE_ID.test(providerVoiceId)) return chatterbox.deleteVoice(providerVoiceId);
      return local.deleteVoice(providerVoiceId);
    },
    // Providers that keep the voice somewhere: the voice engine and an external service. A
    // basic voice profile (local, not the engine) is only its database row.
    handles: (providerId) =>
      providerId === CHATTERBOX_INFO.id ||
      (providerId !== LOCAL_VOICE_CLONE_INFO.id &&
        (providerId === local.info.id || providerId === router.info.id)),
  };
  return router;
}
