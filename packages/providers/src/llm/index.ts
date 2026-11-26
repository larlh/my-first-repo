import type { LLMProvider } from '@parlante/shared';
import { resolveChoice } from '../env';
import type { ProviderEnv } from '../env';
import { createAnthropicLlmProvider } from './anthropic';
import { createLocalLlmProvider } from './local';

export { createAnthropicLlmProvider } from './anthropic';
export type { AnthropicLlmProvider, StreamingChatRequest } from './anthropic';
export { createLocalLlmProvider } from './local';

/**
 * Owner: providers-ai. Selected by LLM_PROVIDER: `local` (deterministic heuristic, "modo
 * básico"), `anthropic` (needs ANTHROPIC_API_KEY) or `auto` (Anthropic when the key is set).
 */
export function createLlmProvider(env: ProviderEnv): LLMProvider {
  const id = resolveChoice(
    env.LLM_PROVIDER,
    [{ id: 'anthropic', available: Boolean(env.ANTHROPIC_API_KEY) }],
    'local',
  );
  return id === 'anthropic' ? createAnthropicLlmProvider(env) : createLocalLlmProvider();
}
