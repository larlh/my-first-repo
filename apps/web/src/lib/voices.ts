import { pickDefaultVoiceId } from '@parlante/shared';
import type { Voice } from '@parlante/shared';
import { useCallback } from 'react';
import { api, useApiQuery } from '@/lib/api';

/* The default voice of NEW content.
 *
 * Which voice a new video, an avatar's greeting or a fresh narration starts with is decided by
 * the server (`Voice.isDefault`: an installed local neural voice when there is one, otherwise
 * the always-available eSpeak voice) and read here from the voice catalogue. Until the
 * catalogue has loaded — or if it cannot be loaded — the local voice is used: it always
 * exists, so nothing waits on this. */

const STALE = 60_000;

/** The usable voices of the workspace (the same cached list the Studio uses). */
export function useVoiceCatalogue() {
  return useApiQuery(api.voices.list, undefined, { staleTime: STALE });
}

export type DefaultVoicePicker = (language: string, gender?: 'female' | 'male') => string;

/** `(language, gender?) => voiceId` for new content. */
export function useDefaultVoice(): DefaultVoicePicker {
  const catalogue = useVoiceCatalogue();
  const voices: readonly Voice[] | undefined = catalogue.data?.items;
  return useCallback(
    (language, gender) => pickDefaultVoiceId(voices ?? [], language, gender),
    [voices],
  );
}
