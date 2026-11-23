import type { STTProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { createManualSttProvider } from './manual';
import { createOpenAiSttProvider } from './openai';

export { planAudioChunks } from './chunking';
export { createManualSttProvider, detectTranscriptFormat, parseUserTranscript } from './manual';
export type { ParsedTranscript, UserTranscriptInput } from './manual';
export { createOpenAiSttProvider } from './openai';

/** Owner: providers-speech. Selected by STT_PROVIDER (`auto` → openai when keyed, else manual). */
export function createSttProvider(env: ProviderEnv): STTProvider {
  const id = resolveChoice(
    env.STT_PROVIDER,
    [{ id: 'openai', available: Boolean(env.OPENAI_API_KEY) }],
    'manual',
  );
  return id === 'openai' ? createOpenAiSttProvider(env) : createManualSttProvider();
}
