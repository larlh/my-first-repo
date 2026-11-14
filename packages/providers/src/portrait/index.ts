import type { PortraitProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notImplemented } from '../errors';
import { ENGINE_UNAVAILABLE } from '../lipsync/index';

/**
 * `local-neural`: generates photorealistic portraits of synthetic people from text and
 * prepares portraits (face detection, crop, background matte) with the local engine.
 * STUB — owner: providers-ai. Same HTTP contract and rules as the lip-sync provider
 * (POST /v1/portraits/generate, POST /v1/portraits/prepare).
 */
export function createLocalNeuralPortraitProvider(_env: ProviderEnv): PortraitProvider {
  return {
    info: { id: 'local-neural', name: 'Motor neuronal local', quality: 'premium', local: true },
    status: async () => ENGINE_UNAVAILABLE,
    generate: () => notImplemented('portrait', 'local-neural', 'generate'),
    prepare: () => notImplemented('portrait', 'local-neural', 'prepare'),
  };
}

/** Owner: providers-ai. Selected by PORTRAIT_PROVIDER. */
export function createPortraitProvider(env: ProviderEnv): PortraitProvider {
  return createLocalNeuralPortraitProvider(env);
}
