import type { LipSyncProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { createExternalLipSyncProvider } from './external';
import { createLocalNeuralLipSyncProvider } from './local-neural';

export { createExternalLipSyncProvider } from './external';
export { createLocalNeuralLipSyncProvider } from './local-neural';

/** Owner: providers-ai. Selected by LIPSYNC_PROVIDER (`local-neural` default, `external`). */
export function createLipSyncProvider(env: ProviderEnv): LipSyncProvider {
  return env.LIPSYNC_PROVIDER === 'external'
    ? createExternalLipSyncProvider(env)
    : createLocalNeuralLipSyncProvider(env);
}
