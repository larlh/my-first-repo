import type { TTSProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/** OpenAI TTS adapter. STUB — owner: providers-speech. Requires OPENAI_API_KEY. */
export function createOpenAiTtsProvider(env: ProviderEnv): TTSProvider {
  if (!env.OPENAI_API_KEY) throw notConfigured('openai', 'OPENAI_API_KEY');
  return {
    info: { id: 'openai', name: 'OpenAI TTS', quality: 'premium', local: false },
    listVoices: () => notImplemented('tts', 'openai', 'listVoices'),
    synthesize: () => notImplemented('tts', 'openai', 'synthesize'),
  };
}
