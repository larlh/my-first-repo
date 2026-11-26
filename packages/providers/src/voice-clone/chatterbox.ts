import { AppError } from '@parlante/shared';
import type { VoiceCloneProvider, VoiceCloneRequest, VoiceCloneResult } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { encodeWav, isWav, pcm16FromBytes } from '../tts/wav';
import {
  CHATTERBOX_INFO,
  CHATTERBOX_LANGUAGES,
  CHATTERBOX_VOICE_ID,
  createVoiceEngineClient,
} from './voice-engine';
import type { VoiceEngineClient } from './voice-engine';

/* -------------------------------------------------------------------------------------------
 * Realistic LOCAL voice cloning with services/voice-engine (Chatterbox Multilingual, T3
 * es-ES). The sample never leaves this machine: the engine derives the voice's conditionals
 * from it (timbre, prosody prompt) and keeps only those, under a `cbx_…` id. The voice is
 * spoken with the `chatterbox` TTS provider. `deleteVoice` removes the conditionals from the
 * engine (voice deletion and consent revocation go through it).
 * ----------------------------------------------------------------------------------------- */

export function createChatterboxVoiceCloneProvider(
  env: Pick<ProviderEnv, 'VOICE_ENGINE_URL' | 'VOICE_ENGINE_TOKEN'>,
  client: VoiceEngineClient = createVoiceEngineClient(env),
): VoiceCloneProvider {
  async function createVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    if (!CHATTERBOX_LANGUAGES.includes(request.language)) {
      throw new AppError(
        'UNPROCESSABLE',
        'The local voice engine clones voices in Spanish (Spain) only',
        { language: request.language },
      );
    }
    const sampleWav = isWav(request.sample)
      ? request.sample
      : encodeWav(pcm16FromBytes(request.sample), request.sampleRate);
    const { voiceId } = await client.registerVoice({
      sampleWav,
      language: request.language,
      consentId: request.consentId,
    });
    return {
      ttsProviderId: CHATTERBOX_INFO.id,
      providerVoiceId: voiceId,
      profile: null,
      provider: CHATTERBOX_INFO,
    };
  }

  return {
    info: CHATTERBOX_INFO,
    createVoice,
    // Only ids the engine handed out ever reach it.
    deleteVoice: (providerVoiceId) =>
      CHATTERBOX_VOICE_ID.test(providerVoiceId)
        ? client.deleteVoice(providerVoiceId)
        : Promise.resolve(),
    current: () => Promise.resolve(CHATTERBOX_INFO),
    handles: (providerId) => providerId === CHATTERBOX_INFO.id,
  };
}
