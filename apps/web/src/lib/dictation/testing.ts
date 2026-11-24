import type { DictationTranscription, ProviderRef } from '@parlante/shared';
import type {
  RecognitionErrorEvent,
  RecognitionEvent,
  SpeechRecognitionLike,
} from './browser-engine';
import type { MicrophoneHandlers, OpenMicrophone } from './microphone';

/* Fixtures for the dictation tests: synthetic "speech" (a tone), room noise and engine doubles. */

export function tone(ms: number, sampleRate = 16_000, amplitude = 0.2, hz = 220): Float32Array {
  const out = new Float32Array(Math.round((ms / 1000) * sampleRate));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

/**
 * Speech-like signal: a tone whose loudness rises and falls four times a second, the way
 * syllables do (it dips to a tenth of its peak, never to silence).
 */
export function voice(ms: number, sampleRate = 16_000, amplitude = 0.2, hz = 220): Float32Array {
  const out = tone(ms, sampleRate, amplitude, hz);
  for (let i = 0; i < out.length; i += 1) {
    const envelope = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / sampleRate);
    out[i] = (out[i] ?? 0) * envelope;
  }
  return out;
}

/** Deterministic low-level noise (a tiny LCG: tests never use Math.random for signals). */
export function noise(ms: number, sampleRate = 16_000, amplitude = 0.0005): Float32Array {
  const out = new Float32Array(Math.round((ms / 1000) * sampleRate));
  let state = 12345;
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out[i] = (state / 2147483648 - 0.5) * 2 * amplitude;
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Split a signal into blocks of `size` samples (the last one may be shorter). */
export function blocks(signal: Float32Array, size: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let at = 0; at < signal.length; at += size) out.push(signal.slice(at, at + size));
  return out;
}

/** A promise with its resolvers, to finish fake requests in a chosen order. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/* ---------- engine doubles ---------- */

export const WHISPER: ProviderRef = {
  id: 'local-whisper',
  name: 'Whisper base (local)',
  quality: 'basic',
  local: true,
};

export function transcription(text: string): DictationTranscription {
  return { text, language: text ? 'es' : null, provider: WHISPER, audioMs: 1000, processingMs: 50 };
}

/** A microphone the test feeds by hand. */
export function fakeMicrophone(sampleRate = 16_000) {
  let handlers: MicrophoneHandlers | null = null;
  const state = { opened: 0, stopped: 0 };
  const open: OpenMicrophone = (given) => {
    handlers = given;
    state.opened += 1;
    return Promise.resolve({
      sampleRate,
      stop: () => {
        state.stopped += 1;
      },
    });
  };
  return {
    open,
    state,
    /** Deliver audio in worklet-sized blocks. */
    feed(samples: Float32Array) {
      for (const block of blocks(samples, 2048)) handlers?.onSamples(block);
    },
    lose() {
      handlers?.onLost();
    },
  };
}

/** Double of the browser's `SpeechRecognition`: the test plays the part of the service. */
export class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  static last(): FakeRecognition {
    const instance = FakeRecognition.instances.at(-1);
    if (!instance) throw new Error('No recognition was created');
    return instance;
  }
  static reset(): void {
    FakeRecognition.instances = [];
  }

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionEvent) => void) | null = null;
  onerror: ((event: RecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  stopped = false;
  aborted = false;

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {
    this.started = true;
    this.onstart?.();
  }
  stop(): void {
    this.stopped = true;
    this.onend?.();
  }
  abort(): void {
    this.aborted = true;
  }
  /** The service recognised something: provisional (`final: false`) or definitive text. */
  say(text: string, final: boolean): void {
    this.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: final, length: 1, 0: { transcript: text } } },
    });
  }
  fail(error: string): void {
    this.onerror?.({ error });
  }
  /** The service closed the session by itself (Chrome does after a silence). */
  end(): void {
    this.onend?.();
  }
}
