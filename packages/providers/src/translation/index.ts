import type { TranslationProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { createAnthropicTranslationProvider } from './anthropic';
import { createLocalTranslationProvider } from './local';

export { createAnthropicTranslationProvider } from './anthropic';
export { createLocalTranslationProvider } from './local';

/**
 * Owner: providers-ai. Selected by TRANSLATION_PROVIDER: `local` (glossary substitution,
 * "modo básico" — see ./local.ts), `anthropic` (needs ANTHROPIC_API_KEY) or `auto`.
 */
export function createTranslationProvider(env: ProviderEnv): TranslationProvider {
  const id = resolveChoice(
    env.TRANSLATION_PROVIDER,
    [{ id: 'anthropic', available: Boolean(env.ANTHROPIC_API_KEY) }],
    'local',
  );
  return id === 'anthropic'
    ? createAnthropicTranslationProvider(env)
    : createLocalTranslationProvider();
}
