import type { ModerationProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { createLocalModerationProvider } from './local';

export { createLocalModerationProvider, parseExtraBlocklist } from './local';
export type { BlockCategory } from './lists';

/** Owner: providers-ai. Selected by MODERATION_PROVIDER (only `local` exists). */
export function createModerationProvider(env: ProviderEnv): ModerationProvider {
  return createLocalModerationProvider(env);
}
