import type { PortraitProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { createLocalNeuralPortraitProvider } from './local-neural';

export { createLocalNeuralPortraitProvider } from './local-neural';

/** Owner: providers-ai. Selected by PORTRAIT_PROVIDER (only `local-neural` exists). */
export function createPortraitProvider(env: ProviderEnv): PortraitProvider {
  return createLocalNeuralPortraitProvider(env);
}
