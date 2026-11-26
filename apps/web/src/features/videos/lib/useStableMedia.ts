import { useRef } from 'react';

/** Signed URLs live for hours; refresh the frozen copy well before that. */
const MAX_AGE_MS = 4 * 3600 * 1000;

/**
 * Signed file URLs change whenever the API re-signs them (every refetch across an hour
 * boundary), and a new `src` restarts a `<video>`. This keeps the first set of URLs seen for
 * one render (`key`) so background refetches never interrupt playback.
 */
export function useStableMedia<T>(key: string, media: T): T {
  const frozen = useRef<{ key: string; media: T; at: number } | null>(null);
  const now = Date.now();
  if (
    frozen.current === null ||
    frozen.current.key !== key ||
    now - frozen.current.at > MAX_AGE_MS
  ) {
    frozen.current = { key, media, at: now };
  }
  return frozen.current.media;
}
