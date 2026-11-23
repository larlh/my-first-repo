import type { VoiceCloneProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { createElevenLabsVoiceCloneProvider } from './elevenlabs';
import { createLocalVoiceCloneProvider } from './local';

export { analyzeVoice } from './analysis';
export type { VoiceAnalysis } from './analysis';
export { createElevenLabsVoiceCloneProvider } from './elevenlabs';
export { createLocalVoiceCloneProvider } from './local';

/** Owner: providers-speech. Selected by VOICE_CLONE_PROVIDER. */
export function createVoiceCloneProvider(env: ProviderEnv): VoiceCloneProvider {
  const id = resolveChoice(
    env.VOICE_CLONE_PROVIDER,
    [{ id: 'elevenlabs', available: Boolean(env.ELEVENLABS_API_KEY) }],
    'local',
  );
  return id === 'elevenlabs'
    ? createElevenLabsVoiceCloneProvider(env)
    : createLocalVoiceCloneProvider(env);
}
