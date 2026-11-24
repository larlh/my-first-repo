import { DICTATION_SAMPLE_RATE } from '@parlante/shared';
import type { DictationTranscription, LanguageCode } from '@parlante/shared';
import { isApiError } from '../api/errors';
import type { MicrophoneCapture, OpenMicrophone } from './microphone';
import { StreamingResampler, encodeWav, levelOf, normalizeSegment, rms } from './pcm';
import { OrderedQueue } from './queue';
import { PhraseSegmenter } from './segmenter';
import { DictationFailure, toDictationError } from './types';
import type { DictationError, EngineCallbacks, EngineSession } from './types';

/* Local engine: the microphone is captured here, cut into phrases and each phrase is posted to
 * `POST /api/dictation/transcribe`, where the open model on the Parlante server turns it into
 * text. Nothing is sent anywhere else and nothing is stored. */

export type TranscribeSegment = (
  wav: Blob,
  language: LanguageCode | undefined,
  signal: AbortSignal,
) => Promise<DictationTranscription>;

export interface LocalEngineOptions {
  openMicrophone: OpenMicrophone;
  transcribe: TranscribeSegment;
  /** Language hint; undefined lets the server detect it. */
  language: LanguageCode | undefined;
  /** `capabilities.dictation.maxSegmentMs`. */
  maxSegmentMs: number;
  /** Requests in flight at once (the results are delivered in spoken order all the same). */
  concurrency?: number;
  /** Waits between retries of a 429; tests pass a fake. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_SEC = 10;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function reasonOf(details: unknown): string | undefined {
  const reason = (details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

function retryAfterOf(details: unknown): number {
  const value = (details as { retryAfterSec?: unknown } | undefined)?.retryAfterSec;
  return typeof value === 'number' && value > 0 ? Math.min(value, MAX_RETRY_WAIT_SEC) : 2;
}

/** Translate an API failure into what the UI can explain. */
export function errorOfTranscription(error: unknown): DictationError {
  if (error instanceof DictationFailure) return { engine: 'local', ...error.detail };
  if (!isApiError(error)) return { code: 'service_failed', engine: 'local' };
  const reason = reasonOf(error.details);
  if (error.code === 'NETWORK_ERROR') return { code: 'network', engine: 'local' };
  if (error.status === 401) return { code: 'session_expired', engine: 'local' };
  if (error.status === 429) {
    return { code: reason === 'busy' ? 'busy' : 'rate_limited', engine: 'local' };
  }
  if (error.status === 503) {
    const known = [
      'model_not_installed',
      'model_incomplete',
      'runtime_unavailable',
      'not_configured',
      'unknown',
    ] as const;
    const reasonCode = known.find((code) => code === reason) ?? 'unknown';
    return { code: 'engine_unavailable', engine: 'local', reasonCode };
  }
  if (error.status === 400 || error.status === 413 || error.status === 415) {
    return { code: 'audio_rejected', engine: 'local' };
  }
  return { code: 'service_failed', engine: 'local' };
}

export async function startLocalEngine(
  options: LocalEngineOptions,
  callbacks: EngineCallbacks,
): Promise<EngineSession> {
  const sleep = options.sleep ?? defaultSleep;
  let finished = false;
  let stopping = false;
  let lastLevel = -1;
  let capture: MicrophoneCapture | null = null;

  /** Close the microphone exactly once, whoever gets there first. */
  const release = () => {
    const open = capture;
    capture = null;
    open?.stop();
  };

  const finish = (error?: DictationError) => {
    if (finished) return;
    finished = true;
    release();
    queue.abort();
    if (error) callbacks.onError(error);
    else callbacks.onEnd();
  };

  const queue = new OrderedQueue<Float32Array, DictationTranscription>({
    concurrency: options.concurrency ?? 2,
    run: async (samples, signal) => {
      const wav = new Blob([encodeWav(normalizeSegment(samples), DICTATION_SAMPLE_RATE)], {
        type: 'audio/wav',
      });
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await options.transcribe(wav, options.language, signal);
        } catch (error) {
          const retryable = isApiError(error) && error.status === 429 && attempt < MAX_RETRIES;
          if (!retryable || signal.aborted) throw error;
          await sleep(retryAfterOf(error.details) * 1000, signal);
        }
      }
    },
    onResult: (result) => {
      if (finished) return;
      if (result.text.trim() !== '') callbacks.onText(result.text, result.provider);
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'ABORTED') return;
      finish(errorOfTranscription(error));
    },
    onPendingChange: (pending) => {
      if (!finished) callbacks.onPending(pending);
    },
  });

  let resampler: StreamingResampler | null = null;
  const segmenter = new PhraseSegmenter({
    sampleRate: DICTATION_SAMPLE_RATE,
    maxSegmentMs: options.maxSegmentMs,
  });

  try {
    capture = await options.openMicrophone({
      onSamples: (samples) => {
        if (finished || stopping || !resampler) return;
        const level = Math.round(levelOf(rms(samples)) * 20) / 20;
        if (level !== lastLevel) {
          lastLevel = level;
          callbacks.onLevel(level);
        }
        for (const segment of segmenter.push(resampler.process(samples))) {
          queue.push(segment.samples);
        }
      },
      onLost: () => finish({ code: 'microphone_lost', engine: 'local' }),
    });
  } catch (error) {
    finished = true;
    queue.abort();
    throw new DictationFailure(toDictationError(error, 'local'));
  }
  resampler = new StreamingResampler(capture.sampleRate, DICTATION_SAMPLE_RATE);
  // This engine measures the input level; it starts at silence.
  callbacks.onLevel(0);
  callbacks.onListening();

  return {
    stop: () => {
      if (finished || stopping) return;
      stopping = true;
      release();
      const last = segmenter.flush();
      if (last) queue.push(last.samples);
      void queue.whenIdle().then(() => finish());
    },
    abort: () => {
      if (finished) return;
      finished = true;
      release();
      queue.abort();
    },
  };
}
