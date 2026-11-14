import type { TranslationProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/**
 * Local translation ("modo básico"): glossary/phrase-based best effort that must clearly mark
 * its output as basic through `info.quality`. STUB — owner: providers-ai.
 */
export function createLocalTranslationProvider(_env: ProviderEnv): TranslationProvider {
  return {
    info: { id: 'local', name: 'Modo básico (local)', quality: 'basic', local: true },
    translate: () => notImplemented('translation', 'local', 'translate'),
  };
}

/** Anthropic Claude translation. STUB — owner: providers-ai. */
export function createAnthropicTranslationProvider(env: ProviderEnv): TranslationProvider {
  if (!env.ANTHROPIC_API_KEY) throw notConfigured('anthropic', 'ANTHROPIC_API_KEY');
  return {
    info: { id: 'anthropic', name: 'Anthropic Claude', quality: 'premium', local: false },
    translate: () => notImplemented('translation', 'anthropic', 'translate'),
  };
}

/** Owner: providers-ai. Selected by TRANSLATION_PROVIDER. */
export function createTranslationProvider(env: ProviderEnv): TranslationProvider {
  const id = resolveChoice(
    env.TRANSLATION_PROVIDER,
    [{ id: 'anthropic', available: Boolean(env.ANTHROPIC_API_KEY) }],
    'local',
  );
  return id === 'anthropic'
    ? createAnthropicTranslationProvider(env)
    : createLocalTranslationProvider(env);
}
