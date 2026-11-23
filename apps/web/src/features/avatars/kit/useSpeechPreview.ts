import type { SynthesizedSpeech } from '@parlante/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, toApiError, toAppUrl } from '@/lib/api';
import type { ApiError } from '@/lib/api';

/* Voice preview: text → `POST /api/tts/synthesize` → play the WAV. One sound at a time per
 * hook instance; starting another request stops the previous one. The synthesis result is
 * kept so the caller can show WHICH provider produced the audio (honesty rule) and drive an
 * avatar with its viseme timeline. */

export interface SpeechRequest {
  text: string;
  voiceId: string;
  language: string;
  speed?: number;
  pitch?: number;
}

export type SpeechStatus = 'idle' | 'loading' | 'playing' | 'error';

export interface SpeechPreview {
  status: SpeechStatus;
  /** Caller-chosen id of what is loading / playing (a voice id, a row key…). */
  activeKey: string | null;
  /** Result of the last successful synthesis. */
  result: SynthesizedSpeech | null;
  /** Key the last result belongs to. */
  resultKey: string | null;
  error: ApiError | null;
  play: (key: string, request: SpeechRequest) => Promise<void>;
  stop: () => void;
  /** Position of the audio in ms while playing, else null. Safe to call every frame. */
  clock: () => number | null;
}

interface State {
  status: SpeechStatus;
  activeKey: string | null;
  result: SynthesizedSpeech | null;
  resultKey: string | null;
  error: ApiError | null;
}

const INITIAL: State = {
  status: 'idle',
  activeKey: null,
  result: null,
  resultKey: null,
  error: null,
};

export function useSpeechPreview(): SpeechPreview {
  const [state, setState] = useState<State>(INITIAL);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Increases with every play/stop: a late answer of an older request is ignored. */
  const turn = useRef(0);

  const silence = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    turn.current += 1;
    silence();
    setState((previous) =>
      previous.status === 'idle' ? previous : { ...previous, status: 'idle', activeKey: null },
    );
  }, [silence]);

  const play = useCallback(
    async (key: string, request: SpeechRequest) => {
      turn.current += 1;
      const mine = turn.current;
      silence();
      const controller = new AbortController();
      abortRef.current = controller;
      setState((previous) => ({ ...previous, status: 'loading', activeKey: key, error: null }));
      try {
        const result = await apiClient.voices.synthesize(
          {
            body: {
              text: request.text,
              voiceId: request.voiceId,
              language: request.language,
              speed: request.speed ?? 1,
              pitch: request.pitch ?? 0,
            },
          },
          { signal: controller.signal },
        );
        if (turn.current !== mine) return;
        const audio = new Audio(toAppUrl(result.audioUrl));
        audioRef.current = audio;
        const finish = () => {
          if (turn.current !== mine) return;
          audioRef.current = null;
          setState((previous) => ({ ...previous, status: 'idle', activeKey: null }));
        };
        audio.onended = finish;
        audio.onerror = () => {
          if (turn.current !== mine) return;
          audioRef.current = null;
          setState((previous) => ({
            ...previous,
            status: 'error',
            activeKey: key,
            error: toApiError(new Error('The audio could not be played')),
          }));
        };
        setState({ status: 'playing', activeKey: key, result, resultKey: key, error: null });
        await audio.play();
      } catch (err) {
        if (turn.current !== mine) return;
        const error = toApiError(err);
        if (error.code === 'ABORTED') return;
        audioRef.current = null;
        setState((previous) => ({ ...previous, status: 'error', activeKey: key, error }));
      }
    },
    [silence],
  );

  const clock = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || audio.paused || audio.ended) return null;
    return audio.currentTime * 1000;
  }, []);

  // Leaving the page stops the sound.
  useEffect(
    () => () => {
      turn.current += 1;
      silence();
    },
    [silence],
  );

  return { ...state, play, stop, clock };
}
