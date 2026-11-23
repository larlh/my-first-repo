import { defaultVoiceId } from '@parlante/shared';
import type { Avatar, LanguageCode, Voice } from '@parlante/shared';
import { api, useApiQuery } from '@/lib/api';

/* Read-only access to the avatar and voice catalogues for the pickers of the AI tools. */

/** Every avatar the workspace can use (stock 2D, stock photoreal and its own). */
export function useAvatars() {
  return useApiQuery(api.avatars.list, { query: {} }, { staleTime: 60_000 });
}

/** Voices that can speak `language` (its own voices plus every multilingual one). */
export function useVoices(language: LanguageCode, enabled = true) {
  return useApiQuery(api.voices.list, { query: { language } }, { staleTime: 60_000, enabled });
}

/** Avatars that can be used right now, instant (2D) ones first. */
export function usableAvatars(avatars: readonly Avatar[]): Avatar[] {
  const ready = avatars.filter((avatar) => avatar.status === 'ready');
  return [
    ...ready.filter((avatar) => avatar.rendering === 'instant'),
    ...ready.filter((avatar) => avatar.rendering !== 'instant'),
  ];
}

export function usableVoices(voices: readonly Voice[]): Voice[] {
  return voices.filter((voice) => voice.status === 'ready');
}

/**
 * The voice a picker starts with for a language: the stock default of that language when the
 * server offers it, else a voice whose own language matches, else the first one.
 */
export function defaultVoiceOf(voices: readonly Voice[], language: string): Voice | null {
  const ready = usableVoices(voices);
  const base = language.slice(0, 2);
  return (
    ready.find((voice) => voice.id === defaultVoiceId(base)) ??
    ready.find((voice) => voice.language.slice(0, 2) === base) ??
    ready[0] ??
    null
  );
}
