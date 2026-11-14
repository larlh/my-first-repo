import type { ModerationProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notImplemented } from '../errors';

/**
 * Local moderation: basic blocklist (plus MODERATION_EXTRA_BLOCKLIST), invoked before rendering
 * and on chat/script inputs. Context `avatar_prompt` additionally blocks descriptions that
 * name or point at real, identifiable people and minors (see `ModerationContext`).
 * STUB — owner: providers-ai.
 */
export function createLocalModerationProvider(_env: ProviderEnv): ModerationProvider {
  return {
    info: { id: 'local', name: 'Lista de bloqueo (local)', quality: 'basic', local: true },
    check: () => notImplemented('moderation', 'local', 'check'),
  };
}

/** Owner: providers-ai. Selected by MODERATION_PROVIDER. */
export function createModerationProvider(env: ProviderEnv): ModerationProvider {
  return createLocalModerationProvider(env);
}
