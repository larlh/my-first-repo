import type { LLMProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/**
 * Local LLM replacement: deterministic heuristics / templates ("modo básico"). Results must set
 * `basicMode: true`. STUB — owner: providers-ai.
 */
export function createLocalLlmProvider(_env: ProviderEnv): LLMProvider {
  return {
    info: { id: 'local', name: 'Modo básico (local)', quality: 'basic', local: true },
    generateScript: () => notImplemented('llm', 'local', 'generateScript'),
    chat: () => notImplemented('llm', 'local', 'chat'),
  };
}

/**
 * Anthropic Claude adapter via `@anthropic-ai/sdk` (already installed). STUB — owner:
 * providers-ai. Model from ANTHROPIC_MODEL (default `claude-opus-5-5`).
 */
export function createAnthropicLlmProvider(env: ProviderEnv): LLMProvider {
  if (!env.ANTHROPIC_API_KEY) throw notConfigured('anthropic', 'ANTHROPIC_API_KEY');
  return {
    info: { id: 'anthropic', name: 'Anthropic Claude', quality: 'premium', local: false },
    generateScript: () => notImplemented('llm', 'anthropic', 'generateScript'),
    chat: () => notImplemented('llm', 'anthropic', 'chat'),
  };
}

/** Owner: providers-ai. Selected by LLM_PROVIDER. */
export function createLlmProvider(env: ProviderEnv): LLMProvider {
  const id = resolveChoice(
    env.LLM_PROVIDER,
    [{ id: 'anthropic', available: Boolean(env.ANTHROPIC_API_KEY) }],
    'local',
  );
  return id === 'anthropic' ? createAnthropicLlmProvider(env) : createLocalLlmProvider(env);
}
