import type { SceneRuntime, SynthesizedSpeech } from '@parlante/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { toAppUrl } from '@/lib/api';

export type PlayOutcome = 'playing' | 'blocked' | 'failed';

export interface SpeechPlayer {
  /** Attach to the page's one `<audio>` element. */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Id of the message being spoken, null in silence. */
  playingId: string | null;
  /** Timeline of the speech being played (drives the avatar). */
  runtime: SceneRuntime | null;
  /** Position of the audio in ms while it plays, else null. Safe to call on every frame. */
  clock: () => number | null;
  /** Stop whatever plays and speak this. `blocked` = the browser wants a click first. */
  play: (id: string, speech: SynthesizedSpeech) => Promise<PlayOutcome>;
  stop: () => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
}

/**
 * Playback of the avatar's voice through ONE audio element. Starting a reply, sending another
 * message (the caller calls `stop`) or leaving the page always silences the previous audio:
 * a detached element would otherwise keep talking.
 */
export function useSpeechPlayer(): SpeechPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<{ id: string; runtime: SceneRuntime } | null>(null);
  const [muted, setMutedState] = useState(false);
  // Guards against a slow `play()` of a reply that was superseded meanwhile.
  const generation = useRef(0);

  const silence = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    if (audio.getAttribute('src')) {
      audio.removeAttribute('src');
      audio.load();
    }
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    silence();
    setCurrent(null);
  }, [silence]);

  const play = useCallback(
    async (id: string, speech: SynthesizedSpeech): Promise<PlayOutcome> => {
      const audio = audioRef.current;
      if (!audio) return 'failed';
      generation.current += 1;
      const mine = generation.current;
      silence();
      audio.src = toAppUrl(speech.audioUrl);
      audio.currentTime = 0;
      setCurrent({ id, runtime: speech.runtime });
      try {
        await audio.play();
        return 'playing';
      } catch (err) {
        if (generation.current !== mine) return 'failed';
        setCurrent(null);
        return (err as { name?: string }).name === 'NotAllowedError' ? 'blocked' : 'failed';
      }
    },
    [silence],
  );

  // The mouth closes when the audio ends or breaks.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const done = () => setCurrent(null);
    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    return () => {
      audio.removeEventListener('ended', done);
      audio.removeEventListener('error', done);
    };
  }, []);

  // Leaving the page silences the avatar.
  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      generation.current += 1;
      if (!audio) return;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, []);

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    if (audioRef.current) audioRef.current.muted = next;
  }, []);

  const clock = useCallback((): number | null => {
    const audio = audioRef.current;
    if (!audio || audio.paused || audio.ended || !audio.getAttribute('src')) return null;
    return audio.currentTime * 1000;
  }, []);

  return useMemo(
    () => ({
      audioRef,
      playingId: current?.id ?? null,
      runtime: current?.runtime ?? null,
      clock,
      play,
      stop,
      muted,
      setMuted,
    }),
    [current, clock, play, stop, muted, setMuted],
  );
}
