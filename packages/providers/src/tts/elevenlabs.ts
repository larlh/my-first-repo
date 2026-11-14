import type { TTSProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/** ElevenLabs adapter. STUB — owner: providers-speech. Requires ELEVENLABS_API_KEY. */
export function createElevenLabsProvider(env: ProviderEnv): TTSProvider {
  if (!env.ELEVENLABS_API_KEY) throw notConfigured('elevenlabs', 'ELEVENLABS_API_KEY');
  return {
    info: { id: 'elevenlabs', name: 'ElevenLabs', quality: 'premium', local: false },
    listVoices: () => notImplemented('tts', 'elevenlabs', 'listVoices'),
    synthesize: () => notImplemented('tts', 'elevenlabs', 'synthesize'),
  };
}
