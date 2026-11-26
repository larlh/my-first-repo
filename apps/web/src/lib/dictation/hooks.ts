import { useCallback, useSyncExternalStore } from 'react';
import { dictation } from './controller';
import type { DictationFieldState, DictationGlobalState } from './controller';

/** Application-wide dictation state (preferences, capabilities, who holds the microphone). */
export function useDictationState(): DictationGlobalState {
  return useSyncExternalStore(dictation.subscribe, dictation.getGlobal, dictation.getGlobal);
}

/** State of one field; only changes when that field's dictation changes. */
export function useDictationField(id: string): DictationFieldState {
  const get = useCallback(() => dictation.getField(id), [id]);
  return useSyncExternalStore(dictation.subscribe, get, get);
}
