import { useCallback, useEffect, useRef, useState } from 'react';
import { RECORDING_MAX_MS, encodeWav, mixToMono, samplesDurationMs } from './sample';

export type RecorderState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'encoding'
  /** The person (or the browser policy) refused the microphone. */
  | 'denied'
  /** No microphone API in this browser / context. */
  | 'unsupported'
  | 'error';

export interface Recording {
  file: File;
  durationMs: number;
}

export function recordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder === 'function' &&
    typeof AudioContext === 'function'
  );
}

/**
 * Record the microphone and hand back a mono 16-bit WAV file. The browser records
 * WebM/Opus; it is decoded and re-encoded here so the upload has a real duration and a
 * format the whole pipeline reads. Nothing is uploaded by this hook.
 */
export function useRecorder(options: {
  fileName: string;
  onRecorded: (recording: Recording) => void;
}): {
  state: RecorderState;
  /** Time recorded so far (ms). */
  elapsedMs: number;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
} {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const keep = useRef(true);
  const latest = useRef(options);
  latest.current = options;

  const release = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    recorder.current = null;
  }, []);

  const finish = useCallback(async (chunks: Blob[], mimeType: string) => {
    setState('encoding');
    const context = new AudioContext();
    try {
      const encoded = await new Blob(chunks, { type: mimeType }).arrayBuffer();
      const audio = await context.decodeAudioData(encoded);
      const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
        audio.getChannelData(index),
      );
      const mono = mixToMono(channels);
      const wav = encodeWav(mono, audio.sampleRate);
      const file = new File([wav as BlobPart], latest.current.fileName, { type: 'audio/wav' });
      setState('idle');
      latest.current.onRecorded({
        file,
        durationMs: samplesDurationMs(mono.length, audio.sampleRate),
      });
    } catch {
      setState('error');
    } finally {
      void context.close().catch(() => undefined);
    }
  }, []);

  const start = useCallback(async () => {
    if (!recordingSupported()) return setState('unsupported');
    setState('requesting');
    setElapsedMs(0);
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = media;
      const chunks: Blob[] = [];
      const instance = new MediaRecorder(media);
      recorder.current = instance;
      keep.current = true;
      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      instance.onstop = () => {
        const mimeType = instance.mimeType;
        const wanted = keep.current;
        release();
        if (wanted && chunks.length > 0) void finish(chunks, mimeType);
        else setState('idle');
      };
      instance.onerror = () => {
        release();
        setState('error');
      };
      const startedAt = performance.now();
      instance.start(250);
      setState('recording');
      timer.current = window.setInterval(() => {
        const elapsed = performance.now() - startedAt;
        setElapsedMs(elapsed);
        if (elapsed >= RECORDING_MAX_MS && instance.state === 'recording') instance.stop();
      }, 200);
    } catch (err) {
      release();
      const name = err instanceof DOMException ? err.name : '';
      setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
    }
  }, [finish, release]);

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);

  const cancel = useCallback(() => {
    keep.current = false;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else {
      release();
      setState('idle');
    }
  }, [release]);

  useEffect(
    () => () => {
      keep.current = false;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      release();
    },
    [release],
  );

  return { state, elapsedMs, start, stop, cancel };
}
