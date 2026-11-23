import type { LLMProvider, ProviderRef } from '@parlante/shared';
import { localChatReply } from './local-chat';
import { generateLocalScript } from './local-script';

const INFO: ProviderRef = {
  id: 'local',
  name: 'Modo básico (local)',
  quality: 'basic',
  local: true,
};

/**
 * Local LLM replacement: deterministic heuristics, offline, no keys ("modo básico").
 *  - `generateScript`: see ./local-script.ts (structure + the user's own material).
 *  - `chat`:           see ./local-chat.ts (retrieval over the persona's knowledge).
 * Every result is stamped `quality: 'basic'`; scripts also carry `basicMode: true`.
 */
export function createLocalLlmProvider(): LLMProvider {
  return {
    info: INFO,
    generateScript: async (request) => generateLocalScript(request, INFO),
    chat: async (request) => localChatReply(request, INFO),
  };
}
