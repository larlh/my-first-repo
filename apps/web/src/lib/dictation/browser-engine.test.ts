import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recognitionLocale, startBrowserEngine } from './browser-engine';
import { FakeRecognition } from './testing';
import type { DictationError, EngineCallbacks } from './types';

/* The Web Speech API cannot be exercised for real in tests (it needs the speech service of the
 * browser vendor), so the engine runs against a double of `SpeechRecognition`. */

function harness() {
  const events: string[] = [];
  const errors: DictationError[] = [];
  let clock = 0;
  const callbacks: EngineCallbacks = {
    onListening: () => events.push('listening'),
    onLevel: (level) => events.push(`level:${String(level)}`),
    onInterim: (text) => events.push(`interim:${text}`),
    onText: (text, provider) => events.push(`text:${text}:${provider === null ? 'no-ref' : 'ref'}`),
    onPending: () => undefined,
    onError: (error) => {
      errors.push(error);
      events.push(`error:${error.code}`);
    },
    onEnd: () => events.push('end'),
  };
  const engine = startBrowserEngine(
    { Recognition: FakeRecognition, locale: 'es-ES', now: () => clock },
    callbacks,
  );
  return {
    engine,
    events,
    errors,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('browser dictation engine (with a SpeechRecognition double)', () => {
  beforeEach(() => FakeRecognition.reset());

  it('configures a continuous recognition with interim results in the field language', () => {
    const h = harness();
    const recognition = FakeRecognition.last();
    expect(recognition).toMatchObject({
      lang: 'es-ES',
      continuous: true,
      interimResults: true,
      started: true,
    });
    // It cannot measure the input level, and says so.
    expect(h.events).toEqual(['level:null', 'listening']);
  });

  it('shows provisional text live and writes only the final text', () => {
    const h = harness();
    const recognition = FakeRecognition.last();
    recognition.say('hola', false);
    recognition.say('hola a to', false);
    recognition.say('hola a todos', true);
    expect(h.events.slice(2)).toEqual([
      'interim:hola',
      'interim:hola a to',
      'text:hola a todos:no-ref',
      'interim:',
    ]);
  });

  it('keeps listening when the service closes the session after a silence', () => {
    const h = harness();
    h.advance(20_000);
    FakeRecognition.last().end();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(FakeRecognition.last().started).toBe(true);
    FakeRecognition.last().say('sigo aquí', true);
    expect(h.events).toContain('text:sigo aquí:no-ref');
    // "listening" is announced once, not on every restart.
    expect(h.events.filter((event) => event === 'listening')).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it('gives up when the service keeps closing straight away', () => {
    const h = harness();
    FakeRecognition.last().end();
    FakeRecognition.last().end();
    FakeRecognition.last().end();
    expect(h.errors).toEqual([{ code: 'browser_service', engine: 'browser' }]);
    expect(FakeRecognition.instances).toHaveLength(3);
  });

  it('stop() lets the last result arrive and then ends', () => {
    const h = harness();
    const recognition = FakeRecognition.last();
    recognition.say('casi termino', false);
    h.engine.stop();
    expect(recognition.stopped).toBe(true);
    expect(h.events.at(-1)).toBe('end');
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it('stop() does not wait for ever for a recognition that never reports its end', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      // A service still waiting for the permission prompt: stop() gets no `end` event.
      FakeRecognition.last().stop = () => undefined;
      h.engine.stop();
      expect(h.events).not.toContain('end');
      vi.advanceTimersByTime(3000);
      expect(h.events.at(-1)).toBe('end');
    } finally {
      vi.useRealTimers();
    }
  });

  it('abort() silences the recognition for good', () => {
    const h = harness();
    const recognition = FakeRecognition.last();
    h.engine.abort();
    expect(recognition.aborted).toBe(true);
    expect(recognition.onresult).toBeNull();
    expect(h.events).not.toContain('end');
  });

  it.each([
    ['not-allowed', 'permission_denied'],
    ['audio-capture', 'no_microphone'],
    ['network', 'browser_service'],
    ['service-not-allowed', 'browser_service'],
    ['language-not-supported', 'language_unsupported'],
  ])('explains the "%s" error of the service', (code, expected) => {
    const h = harness();
    FakeRecognition.last().fail(code);
    expect(h.errors).toEqual([{ code: expected, engine: 'browser' }]);
    expect(FakeRecognition.last().aborted).toBe(true);
  });

  it('does not treat "no speech yet" as a failure', () => {
    const h = harness();
    FakeRecognition.last().fail('no-speech');
    expect(h.errors).toEqual([]);
  });

  it('fails clearly in a browser without the Web Speech API', () => {
    expect(() =>
      startBrowserEngine(
        { locale: 'es-ES' },
        {
          onListening: () => undefined,
          onLevel: () => undefined,
          onInterim: () => undefined,
          onText: () => undefined,
          onPending: () => undefined,
          onError: () => undefined,
          onEnd: () => undefined,
        },
      ),
    ).toThrowError(/browser_unsupported/);
  });

  it('picks a recognition locale: the field one, the region of the browser, or a default', () => {
    expect(recognitionLocale('es-MX', ['en-US'])).toBe('es-MX');
    expect(recognitionLocale('es', ['en-US', 'es-AR'])).toBe('es-AR');
    expect(recognitionLocale('es', ['en-US'])).toBe('es-ES');
    expect(recognitionLocale('en', ['es-ES', 'en'])).toBe('en-US');
    expect(recognitionLocale('pt', [])).toBe('pt-PT');
  });
});
