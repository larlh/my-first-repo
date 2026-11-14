import { AppError } from '@parlante/shared';
import type { STTProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/**
 * Local "manual" STT: cannot transcribe. The user supplies the transcript (SRT / VTT / text —
 * parse it with `parseTranscript` from @parlante/shared). This behaviour is final, not a stub.
 */
export function createManualSttProvider(): STTProvider {
  return {
    info: {
      id: 'manual',
      name: 'Transcript provided by the user',
      quality: 'basic',
      local: true,
    },
    requiresUserTranscript: true,
    transcribe: async () => {
      throw new AppError(
        'TRANSCRIPT_REQUIRED',
        'Automatic transcription is not available in local mode: provide the transcript (SRT, VTT or text)',
      );
    },
  };
}

/** OpenAI Whisper adapter. STUB — owner: providers-speech. Requires OPENAI_API_KEY. */
export function createOpenAiSttProvider(env: ProviderEnv): STTProvider {
  if (!env.OPENAI_API_KEY) throw notConfigured('openai', 'OPENAI_API_KEY');
  return {
    info: { id: 'openai', name: 'OpenAI Whisper', quality: 'premium', local: false },
    requiresUserTranscript: false,
    transcribe: () => notImplemented('stt', 'openai', 'transcribe'),
  };
}

/** Owner: providers-speech. Selected by STT_PROVIDER (`auto` → openai when keyed, else manual). */
export function createSttProvider(env: ProviderEnv): STTProvider {
  const id = resolveChoice(
    env.STT_PROVIDER,
    [{ id: 'openai', available: Boolean(env.OPENAI_API_KEY) }],
    'manual',
  );
  return id === 'openai' ? createOpenAiSttProvider(env) : createManualSttProvider();
}
