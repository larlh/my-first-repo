import type { EngineStatus, LipSyncProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/** Status reported while the engine client is not implemented / the engine is unreachable. */
export const ENGINE_UNAVAILABLE: EngineStatus = {
  available: false,
  reason:
    'The local avatar engine is not available. Start it with `pnpm avatar-engine` (see services/avatar-engine/README.md).',
  device: null,
  secondsPerVideoSecond: null,
};

/**
 * `local-neural`: animates photorealistic portraits with the local engine
 * (services/avatar-engine — open-source models, no paid service). STUB — owner: providers-ai.
 *
 * Implement against the HTTP contract in @parlante/shared `avatar-engine.ts`
 * (POST /v1/animations → poll GET /v1/jobs/:id, files exchanged by path inside
 * AVATAR_ENGINE_WORK_DIR). `status()` must call GET /health and never throw: when the engine is
 * stopped or its weights are missing it returns `available: false` with a reason for the user.
 */
export function createLocalNeuralLipSyncProvider(_env: ProviderEnv): LipSyncProvider {
  return {
    info: { id: 'local-neural', name: 'Motor neuronal local', quality: 'premium', local: true },
    status: async () => ENGINE_UNAVAILABLE,
    animate: () => notImplemented('lipsync', 'local-neural', 'animate'),
  };
}

/**
 * Optional external lip-sync endpoint (LIPSYNC_ENDPOINT_URL + LIPSYNC_API_KEY).
 * STUB — owner: providers-ai. Document its HTTP contract next to the implementation.
 */
export function createExternalLipSyncProvider(env: ProviderEnv): LipSyncProvider {
  if (!env.LIPSYNC_ENDPOINT_URL) throw notConfigured('external', 'LIPSYNC_ENDPOINT_URL');
  return {
    info: { id: 'external', name: 'External lip-sync', quality: 'premium', local: false },
    status: async () => ({
      available: false,
      reason: 'The external lip-sync adapter is not implemented yet',
      device: null,
      secondsPerVideoSecond: null,
    }),
    animate: () => notImplemented('lipsync', 'external', 'animate'),
  };
}

/** Owner: providers-ai. Selected by LIPSYNC_PROVIDER (`local-neural` default, `external`). */
export function createLipSyncProvider(env: ProviderEnv): LipSyncProvider {
  return env.LIPSYNC_PROVIDER === 'external'
    ? createExternalLipSyncProvider(env)
    : createLocalNeuralLipSyncProvider(env);
}
