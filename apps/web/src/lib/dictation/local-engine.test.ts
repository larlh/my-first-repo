import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { startLocalEngine } from './local-engine';
import type { LocalEngineOptions } from './local-engine';
import { concat, deferred, fakeMicrophone, flush, noise, transcription, voice } from './testing';
import { DictationFailure } from './types';
import type { DictationError, EngineCallbacks } from './types';

type Transcription = ReturnType<typeof transcription>;

function harness(overrides: Partial<LocalEngineOptions> = {}, sampleRate = 16_000) {
  const mic = fakeMicrophone(sampleRate);
  const requests: {
    wav: Blob;
    language: string | undefined;
    signal: AbortSignal;
    done: ReturnType<typeof deferred<Transcription>>;
  }[] = [];
  const events: string[] = [];
  const texts: string[] = [];
  const errors: DictationError[] = [];
  const callbacks: EngineCallbacks = {
    onListening: () => events.push('listening'),
    onLevel: () => undefined,
    onInterim: () => undefined,
    onText: (text) => {
      texts.push(text);
      events.push(`text:${text}`);
    },
    onPending: (count) => events.push(`pending:${count}`),
    onError: (error) => {
      errors.push(error);
      events.push(`error:${error.code}`);
    },
    onEnd: () => events.push('end'),
  };
  const sleeps: number[] = [];
  const start = () =>
    startLocalEngine(
      {
        openMicrophone: mic.open,
        transcribe: (wav, language, signal) => {
          const done = deferred<Transcription>();
          requests.push({ wav, language, signal, done });
          return done.promise;
        },
        language: 'es',
        maxSegmentMs: 30_000,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        ...overrides,
      },
      callbacks,
    );
  /** One spoken phrase followed by the pause that closes it. */
  const say = (ms = 1000) => mic.feed(concat(voice(ms, sampleRate), noise(1000, sampleRate)));
  return { mic, requests, events, texts, errors, sleeps, start, say };
}

describe('local dictation engine', () => {
  it('opens the microphone, cuts the speech into phrases and posts each one as a WAV', async () => {
    const h = harness();
    await h.start();
    expect(h.events).toEqual(['listening']);
    h.mic.feed(noise(500));
    h.say(1200);
    expect(h.requests).toHaveLength(1);
    const [request] = h.requests;
    expect(request?.language).toBe('es');
    expect(request?.wav.type).toBe('audio/wav');
    // 44-byte header + 16-bit mono at 16 kHz: about 1.2 s of speech plus its margins.
    const seconds = ((request?.wav.size ?? 0) - 44) / 2 / 16_000;
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(1.9);
    request?.done.resolve(transcription('Hola a todos.'));
    await flush();
    expect(h.texts).toEqual(['Hola a todos.']);
  });

  it('writes the phrases in the order they were spoken, even when the second answer arrives first', async () => {
    const h = harness();
    await h.start();
    h.say();
    h.say();
    h.say();
    // Two requests in flight; the third waits for a slot.
    expect(h.requests).toHaveLength(2);
    h.requests[1]?.done.resolve(transcription('Segunda.'));
    await flush();
    expect(h.texts).toEqual([]);
    expect(h.requests).toHaveLength(3);
    h.requests[2]?.done.resolve(transcription('Tercera.'));
    await flush();
    expect(h.texts).toEqual([]);
    h.requests[0]?.done.resolve(transcription('Primera.'));
    await flush();
    expect(h.texts).toEqual(['Primera.', 'Segunda.', 'Tercera.']);
  });

  it('writes nothing for a phrase the server heard as silence', async () => {
    const h = harness();
    await h.start();
    h.say();
    h.say();
    h.requests[0]?.done.resolve(transcription(''));
    h.requests[1]?.done.resolve(transcription('Solo esta.'));
    await flush();
    expect(h.texts).toEqual(['Solo esta.']);
  });

  it('resamples a 48 kHz microphone to the 16 kHz the server expects', async () => {
    const h = harness({}, 48_000);
    await h.start();
    h.mic.feed(noise(500, 48_000));
    h.say(1000);
    expect(h.requests).toHaveLength(1);
    const view = new DataView(await (h.requests[0]?.wav as Blob).arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    const seconds = (view.byteLength - 44) / 2 / 16_000;
    expect(seconds).toBeGreaterThan(1.3);
    expect(seconds).toBeLessThan(1.7);
  });

  it('stop() releases the microphone at once, sends the phrase in progress and ends after writing it', async () => {
    const h = harness();
    const engine = await h.start();
    h.mic.feed(concat(noise(300), voice(900)));
    expect(h.requests).toHaveLength(0);
    engine.stop();
    expect(h.mic.state.stopped).toBe(1);
    expect(h.requests).toHaveLength(1);
    // Audio that arrives after stopping is ignored.
    h.say();
    expect(h.requests).toHaveLength(1);
    expect(h.events).not.toContain('end');
    h.requests[0]?.done.resolve(transcription('Lo último.'));
    await flush();
    expect(h.texts).toEqual(['Lo último.']);
    expect(h.events.at(-1)).toBe('end');
  });

  it('stop() with nothing pending ends straight away', async () => {
    const h = harness();
    const engine = await h.start();
    h.mic.feed(noise(800));
    engine.stop();
    await flush();
    expect(h.requests).toHaveLength(0);
    expect(h.events.at(-1)).toBe('end');
  });

  it('abort() drops everything: nothing else is written', async () => {
    const h = harness();
    const engine = await h.start();
    h.say();
    engine.abort();
    expect(h.mic.state.stopped).toBe(1);
    expect(h.requests[0]?.signal.aborted).toBe(true);
    h.requests[0]?.done.resolve(transcription('Tarde.'));
    await flush();
    expect(h.texts).toEqual([]);
    expect(h.events).not.toContain('end');
  });

  it('waits and retries when the server is busy (429), then carries on', async () => {
    const h = harness();
    await h.start();
    h.say();
    h.requests[0]?.done.reject(
      new ApiError('RATE_LIMITED', 'busy', 429, { reason: 'busy', retryAfterSec: 3 }),
    );
    await flush();
    expect(h.sleeps).toEqual([3000]);
    expect(h.requests).toHaveLength(2);
    h.requests[1]?.done.resolve(transcription('Al segundo intento.'));
    await flush();
    expect(h.texts).toEqual(['Al segundo intento.']);
    expect(h.errors).toEqual([]);
  });

  it('gives up after a few busy answers and says which limit it was', async () => {
    const h = harness();
    await h.start();
    h.say();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      h.requests[attempt]?.done.reject(
        new ApiError('RATE_LIMITED', 'slow down', 429, { reason: 'user_rate_limit' }),
      );
      await flush();
    }
    expect(h.requests).toHaveLength(4);
    expect(h.errors).toEqual([{ code: 'rate_limited', engine: 'local' }]);
    expect(h.mic.state.stopped).toBe(1);
  });

  it.each([
    [new ApiError('NETWORK_ERROR', 'offline'), { code: 'network' }],
    [new ApiError('UNAUTHENTICATED', 'no session', 401), { code: 'session_expired' }],
    [
      new ApiError('SERVICE_UNAVAILABLE', 'no model', 503, { reason: 'model_not_installed' }),
      { code: 'engine_unavailable', reasonCode: 'model_not_installed' },
    ],
    [
      new ApiError('SERVICE_UNAVAILABLE', 'odd', 503, { reason: 'something-new' }),
      { code: 'engine_unavailable', reasonCode: 'unknown' },
    ],
    [
      new ApiError('PAYLOAD_TOO_LARGE', 'long', 413, { reason: 'audio_too_long' }),
      { code: 'audio_rejected' },
    ],
    [new ApiError('PROVIDER_ERROR', 'model failed', 502), { code: 'service_failed' }],
    [new Error('unexpected'), { code: 'service_failed' }],
  ])('turns %s into an error the UI can explain', async (failure, expected) => {
    const h = harness();
    await h.start();
    h.say();
    h.requests[0]?.done.reject(failure);
    await flush();
    expect(h.errors).toEqual([{ engine: 'local', ...expected }]);
    expect(h.mic.state.stopped).toBe(1);
    expect(h.events).not.toContain('end');
  });

  it('delivers what was spoken before a failure, then reports it once', async () => {
    const h = harness();
    await h.start();
    h.say();
    h.say();
    h.requests[1]?.done.reject(new ApiError('NETWORK_ERROR', 'offline'));
    await flush();
    expect(h.errors).toEqual([]);
    h.requests[0]?.done.resolve(transcription('Esto sí llegó.'));
    await flush();
    expect(h.texts).toEqual(['Esto sí llegó.']);
    expect(h.errors).toEqual([{ code: 'network', engine: 'local' }]);
  });

  it('reports a refused permission (or a missing microphone) without starting', async () => {
    const h = harness({
      openMicrophone: () => Promise.reject(new DictationFailure({ code: 'permission_denied' })),
    });
    await expect(h.start()).rejects.toMatchObject({
      detail: { code: 'permission_denied', engine: 'local' },
    });
    expect(h.events).toEqual([]);
  });

  it('stops with an error when the microphone disappears', async () => {
    const h = harness();
    await h.start();
    h.mic.lose();
    expect(h.errors).toEqual([{ code: 'microphone_lost', engine: 'local' }]);
  });

  it('reports the input level while listening', async () => {
    const levels: (number | null)[] = [];
    const mic = fakeMicrophone();
    const noop = vi.fn();
    await startLocalEngine(
      {
        openMicrophone: mic.open,
        transcribe: () => new Promise(() => undefined),
        language: undefined,
        maxSegmentMs: 30_000,
      },
      {
        onListening: noop,
        onLevel: (level) => levels.push(level),
        onInterim: noop,
        onText: noop,
        onPending: noop,
        onError: noop,
        onEnd: noop,
      },
    );
    mic.feed(noise(200));
    mic.feed(voice(400, 16_000, 0.5));
    const quiet = levels[0] ?? 1;
    const loud = Math.max(...levels.map((level) => level ?? 0));
    expect(quiet).toBeLessThan(0.2);
    expect(loud).toBeGreaterThan(0.6);
  });
});
