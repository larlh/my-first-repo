import type { DictationCapabilities } from '@parlante/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { DictationController } from './controller';
import type { DictationRuntimeDeps } from './controller';
import { dictationStorageKey } from './preferences';
import {
  FakeRecognition,
  WHISPER,
  concat,
  deferred,
  fakeMicrophone,
  flush,
  noise,
  transcription,
  voice,
} from './testing';
import { DictationFailure } from './types';

const USER = 'usr_controller_test';

function capabilities(patch: Partial<DictationCapabilities['local']> = {}): DictationCapabilities {
  return {
    local: {
      available: true,
      provider: WHISPER,
      reason: null,
      reasonCode: null,
      languages: ['es', 'en', 'fr'],
      ...patch,
    },
    maxSegmentMs: 30_000,
  };
}

const MISSING = capabilities({
  available: false,
  provider: null,
  reason: 'Model not installed',
  reasonCode: 'model_not_installed',
});

function field(
  tag: 'input' | 'textarea' = 'textarea',
  value = '',
): HTMLInputElement | HTMLTextAreaElement {
  const element = document.createElement(tag);
  element.value = value;
  document.body.append(element);
  return element;
}

function setup(
  options: { caps?: DictationCapabilities; browser?: boolean; uiLanguage?: string } = {},
) {
  const mic = fakeMicrophone();
  const requests: {
    language: string | undefined;
    done: ReturnType<typeof deferred<ReturnType<typeof transcription>>>;
  }[] = [];
  let caps = options.caps ?? capabilities();
  const loadCapabilities = vi.fn((_fresh: boolean) => Promise.resolve(caps));
  const deps: DictationRuntimeDeps = {
    userId: USER,
    uiLanguage: () => options.uiLanguage ?? 'es',
    loadCapabilities,
    transcribe: (_wav, language) => {
      const done = deferred<ReturnType<typeof transcription>>();
      requests.push({ language, done });
      return done.promise;
    },
    openMicrophone: mic.open,
    ...(options.browser === false ? {} : { Recognition: FakeRecognition }),
  };
  const controller = new DictationController();
  controller.connect(deps);
  controller.setCapabilities(caps);
  const say = () => mic.feed(concat(noise(300), voice(900), noise(1000)));
  return {
    controller,
    mic,
    requests,
    loadCapabilities,
    say,
    setServerCapabilities: (next: DictationCapabilities) => {
      caps = next;
    },
  };
}

describe('DictationController', () => {
  beforeEach(() => {
    FakeRecognition.reset();
    window.localStorage.removeItem(dictationStorageKey(USER));
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('offers nothing until somebody is signed in', () => {
    const controller = new DictationController();
    expect(controller.getGlobal().ready).toBe(false);
    const element = field();
    void controller.start({ id: 'a', element });
    expect(controller.getField('a').phase).toBe('idle');
  });

  it('dictates with the local engine: asks for the microphone, listens and writes the phrase', async () => {
    const h = setup();
    const element = field('textarea', 'Hola.');
    element.setSelectionRange(5, 5);
    const started = h.controller.start({ id: 'a', element });
    expect(h.controller.getField('a').phase).toBe('requesting');
    await started;
    expect(h.controller.getField('a')).toMatchObject({
      phase: 'listening',
      engine: 'local',
      provider: WHISPER,
    });
    expect(h.controller.getGlobal().activeFieldId).toBe('a');
    expect(h.controller.getGlobal().announcement).toMatchObject({
      kind: 'listening',
      engine: 'local',
    });
    h.say();
    expect(h.controller.getField('a').pending).toBe(1);
    h.requests[0]?.done.resolve(transcription('esto es una prueba.'));
    await flush();
    expect(element.value).toBe('Hola. Esto es una prueba.');
    expect(h.controller.getField('a').pending).toBe(0);
  });

  it('speaks the language of the field, else the preferred one, else the interface language', async () => {
    const h = setup();
    const element = field();
    await h.controller.start({ id: 'a', element });
    h.say();
    expect(h.requests.at(-1)?.language).toBe('es');
    h.controller.stop();

    h.controller.setPreferences({ language: 'fr' });
    await h.controller.start({ id: 'a', element });
    h.say();
    expect(h.requests.at(-1)?.language).toBe('fr');
    h.controller.stop();

    await h.controller.start({ id: 'a', element, language: 'en-GB' });
    h.say();
    expect(h.requests.at(-1)?.language).toBe('en');
    h.controller.stop();

    // A language the model does not know is not sent as a hint: the server detects it.
    await h.controller.start({ id: 'a', element, language: 'el' });
    h.say();
    expect(h.requests.at(-1)?.language).toBeUndefined();
  });

  it('only one field dictates at a time: starting in another stops the first', async () => {
    const h = setup();
    const first = field();
    const second = field();
    await h.controller.start({ id: 'a', element: first });
    h.mic.feed(concat(noise(300), voice(900)));
    await h.controller.start({ id: 'b', element: second });
    expect(h.mic.state.opened).toBe(2);
    expect(h.mic.state.stopped).toBe(1);
    expect(h.controller.getField('a').phase).toBe('transcribing');
    expect(h.controller.getField('b').phase).toBe('listening');
    expect(h.controller.getGlobal().activeFieldId).toBe('b');
    // What was said into the first field still lands in the first field.
    h.requests[0]?.done.resolve(transcription('Para el primero.'));
    await flush();
    expect(first.value).toBe('Para el primero.');
    expect(second.value).toBe('');
    expect(h.controller.getField('a').phase).toBe('idle');
    // The second field is the one listening: nobody is told that dictation "stopped".
    expect(h.controller.getGlobal().announcement).toMatchObject({ kind: 'listening' });
  });

  it('toggle() stops when the same field is dictating', async () => {
    const h = setup();
    const element = field();
    h.controller.toggle({ id: 'a', element });
    await flush();
    expect(h.controller.getField('a').phase).toBe('listening');
    h.controller.toggle({ id: 'a', element });
    await flush();
    expect(h.controller.getField('a').phase).toBe('idle');
    expect(h.mic.state.stopped).toBe(1);
    expect(h.controller.getGlobal().announcement?.kind).toBe('stopped');
  });

  it('Escape stops the dictation and does not reach whatever else listens for it', async () => {
    const h = setup();
    await h.controller.start({ id: 'a', element: field() });
    const elsewhere = vi.fn();
    document.addEventListener('keydown', elsewhere);
    try {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(elsewhere).not.toHaveBeenCalled();
      await flush();
      expect(h.controller.getField('a').phase).toBe('idle');
      expect(h.mic.state.stopped).toBe(1);
      // With nothing dictating, Escape is nobody's business again.
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(elsewhere).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', elsewhere);
    }
  });

  it('stops when the tab is hidden or loses the focus, and when the page goes away', async () => {
    const h = setup();
    const element = field();
    await h.controller.start({ id: 'a', element });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();
    expect(h.mic.state.stopped).toBe(1);

    await h.controller.start({ id: 'a', element });
    window.dispatchEvent(new Event('blur'));
    expect(h.mic.state.stopped).toBe(2);

    await h.controller.start({ id: 'a', element });
    h.say();
    window.dispatchEvent(new Event('pagehide'));
    expect(h.mic.state.stopped).toBe(3);
    h.requests.at(-1)?.done.resolve(transcription('Demasiado tarde.'));
    await flush();
    expect(element.value).toBe('');
    expect(h.controller.getField('a').phase).toBe('idle');
  });

  it('does not close the microphone just because the permission prompt took the focus', async () => {
    const mic = fakeMicrophone();
    const gate = deferred<void>();
    const controller = new DictationController();
    controller.connect({
      userId: USER,
      uiLanguage: () => 'es',
      loadCapabilities: () => Promise.resolve(capabilities()),
      transcribe: () => new Promise(() => undefined),
      openMicrophone: async (handlers) => {
        await gate.promise;
        return mic.open(handlers);
      },
    });
    controller.setCapabilities(capabilities());
    const started = controller.start({ id: 'a', element: field() });
    await flush();
    window.dispatchEvent(new Event('blur'));
    expect(controller.getField('a').phase).toBe('requesting');
    gate.resolve();
    await started;
    expect(controller.getField('a').phase).toBe('listening');
  });

  it('nor the browser engine while its own permission prompt is up', async () => {
    window.localStorage.setItem(
      dictationStorageKey(USER),
      JSON.stringify({ engine: 'browser', browserConsentAt: '2026-11-24T10:00:00.000Z' }),
    );
    // A recognition that has not started yet: the browser is still asking for the microphone.
    class Waiting extends FakeRecognition {
      override start(): void {
        this.started = true;
      }
    }
    const controller = new DictationController();
    controller.connect({
      userId: USER,
      uiLanguage: () => 'es',
      loadCapabilities: () => Promise.resolve(capabilities()),
      transcribe: () => new Promise(() => undefined),
      Recognition: Waiting,
    });
    controller.setCapabilities(capabilities());
    await controller.start({ id: 'a', element: field() });
    expect(controller.getField('a')).toMatchObject({ phase: 'requesting', engine: 'browser' });
    window.dispatchEvent(new Event('blur'));
    expect(controller.getField('a').phase).toBe('requesting');
    FakeRecognition.last().onstart?.();
    expect(controller.getField('a').phase).toBe('listening');
    window.dispatchEvent(new Event('blur'));
    expect(controller.getField('a').phase).toBe('idle');
  });

  it('stopping while the browser still asks for permission never opens a session', async () => {
    const mic = fakeMicrophone();
    const gate = deferred<void>();
    const controller = new DictationController();
    controller.connect({
      userId: USER,
      uiLanguage: () => 'es',
      loadCapabilities: () => Promise.resolve(capabilities()),
      transcribe: () => new Promise(() => undefined),
      openMicrophone: async (handlers) => {
        await gate.promise;
        return mic.open(handlers);
      },
    });
    controller.setCapabilities(capabilities());
    const started = controller.start({ id: 'a', element: field() });
    await flush();
    controller.stop();
    expect(controller.getField('a').phase).toBe('idle');
    gate.resolve();
    await started;
    expect(controller.getField('a').phase).toBe('idle');
    expect(mic.state.stopped).toBe(1);
  });

  it('explains a refused microphone permission', async () => {
    const h = setup();
    const controller = new DictationController();
    controller.connect({
      userId: USER,
      uiLanguage: () => 'es',
      loadCapabilities: () => Promise.resolve(capabilities()),
      transcribe: () => new Promise(() => undefined),
      openMicrophone: () => Promise.reject(new DictationFailure({ code: 'permission_denied' })),
    });
    controller.setCapabilities(capabilities());
    await controller.start({ id: 'a', element: field() });
    expect(controller.getField('a')).toMatchObject({
      phase: 'idle',
      error: { code: 'permission_denied', engine: 'local' },
    });
    expect(controller.getGlobal().announcement).toMatchObject({ kind: 'error' });
    expect(controller.getGlobal().activeFieldId).toBeNull();
    controller.dismiss('a');
    expect(controller.getField('a').error).toBeNull();
    expect(h.mic.state.opened).toBe(0);
  });

  it('when the local model is missing it says why and offers the browser — it never starts it', async () => {
    const h = setup({ caps: MISSING });
    await h.controller.start({ id: 'a', element: field() });
    expect(h.loadCapabilities).toHaveBeenCalledWith(true);
    expect(h.controller.getField('a')).toMatchObject({
      phase: 'idle',
      error: {
        code: 'engine_unavailable',
        engine: 'local',
        reasonCode: 'model_not_installed',
        offerBrowser: true,
      },
    });
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(h.mic.state.opened).toBe(0);
  });

  it('notices that the model was installed meanwhile (capabilities are read live)', async () => {
    const h = setup({ caps: MISSING });
    h.setServerCapabilities(capabilities());
    await h.controller.start({ id: 'a', element: field() });
    expect(h.controller.getField('a').phase).toBe('listening');
    expect(h.controller.getGlobal().capabilities?.local.available).toBe(true);
  });

  it('with no engine at all the error says so', async () => {
    const h = setup({ caps: MISSING, browser: false });
    // jsdom has no Web Speech API, so without the double there is no browser engine.
    expect(h.controller.getGlobal().browserSupported).toBe(false);
    await h.controller.start({ id: 'a', element: field() });
    expect(h.controller.getField('a').error).toEqual({
      code: 'no_engine',
      reasonCode: 'model_not_installed',
    });
  });

  it('the browser engine needs the notice accepted once, per user', async () => {
    const h = setup({ caps: MISSING });
    const element = field('input');
    const target = { id: 'a', element };
    await h.controller.start(target);
    // Asking for it from the error shows the notice; nothing starts and nothing is stored.
    h.controller.requestBrowserEngine(target);
    expect(h.controller.getField('a')).toMatchObject({ consentPrompt: true, error: null });
    expect(h.controller.getGlobal().preferences).toMatchObject({
      engine: 'auto',
      browserConsentAt: null,
    });
    expect(FakeRecognition.instances).toHaveLength(0);
    // Declining leaves everything as it was.
    h.controller.dismiss('a');
    expect(h.controller.getField('a').consentPrompt).toBe(false);
    expect(window.localStorage.getItem(dictationStorageKey(USER))).toBeNull();

    h.controller.requestBrowserEngine(target);
    h.controller.acceptBrowserEngine(target);
    await flush();
    const stored = h.controller.getGlobal().preferences;
    expect(stored.engine).toBe('browser');
    expect(stored.browserConsentAt).not.toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem(dictationStorageKey(USER)) ?? '{}'),
    ).toMatchObject({
      engine: 'browser',
    });
    expect(h.controller.getField('a')).toMatchObject({ phase: 'listening', engine: 'browser' });
    expect(FakeRecognition.last().lang).toBe('es-ES');

    FakeRecognition.last().say('título de prueba', false);
    expect(h.controller.getField('a').interim).toBe('título de prueba');
    expect(element.value).toBe('');
    FakeRecognition.last().say('título de prueba', true);
    expect(element.value).toBe('Título de prueba');
    // The local server took no part.
    expect(h.requests).toHaveLength(0);
    expect(h.mic.state.opened).toBe(0);

    h.controller.stop();
    expect(h.controller.getField('a').phase).toBe('idle');
    // Next time it starts directly: the notice was accepted.
    await h.controller.start(target);
    expect(h.controller.getField('a')).toMatchObject({ phase: 'listening', consentPrompt: false });
  });

  it('a stored "browser" choice without acceptance asks again instead of starting', async () => {
    window.localStorage.setItem(
      dictationStorageKey(USER),
      JSON.stringify({ engine: 'browser', browserConsentAt: null }),
    );
    const h = setup();
    await h.controller.start({ id: 'a', element: field() });
    expect(h.controller.getField('a')).toMatchObject({ phase: 'idle', consentPrompt: true });
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('where the browser has no Web Speech, a "browser" choice offers the local engine', async () => {
    window.localStorage.setItem(
      dictationStorageKey(USER),
      JSON.stringify({ engine: 'browser', browserConsentAt: '2026-11-24T10:00:00.000Z' }),
    );
    const h = setup({ browser: false });
    const target = { id: 'a', element: field() };
    await h.controller.start(target);
    expect(h.controller.getField('a').error).toEqual({
      code: 'browser_unsupported',
      engine: 'browser',
      offerLocal: true,
    });
    h.controller.useLocalEngine(target);
    await flush();
    expect(h.controller.getField('a')).toMatchObject({ phase: 'listening', engine: 'local' });
    expect(h.controller.getGlobal().preferences.engine).toBe('auto');
  });

  it('stops with a clear notice when the field reaches its maxLength', async () => {
    const h = setup();
    const element = field('input', '') as HTMLInputElement;
    element.maxLength = 12;
    await h.controller.start({ id: 'a', element });
    h.say();
    h.requests[0]?.done.resolve(transcription('uno dos tres cuatro cinco'));
    await flush();
    expect(element.value).toBe('Uno dos tres');
    expect(h.controller.getField('a')).toMatchObject({
      phase: 'idle',
      error: { code: 'limit_reached', maxLength: 12 },
    });
    expect(h.mic.state.stopped).toBe(1);
  });

  it('reports a failure of the server and releases the microphone', async () => {
    const h = setup();
    await h.controller.start({ id: 'a', element: field() });
    h.say();
    h.requests[0]?.done.reject(new ApiError('NETWORK_ERROR', 'offline'));
    await flush();
    expect(h.controller.getField('a')).toMatchObject({
      phase: 'idle',
      error: { code: 'network', engine: 'local' },
    });
    expect(h.mic.state.stopped).toBe(1);
    expect(h.controller.getGlobal().activeFieldId).toBeNull();
  });

  it('never writes into a field that went away or stopped accepting text', async () => {
    const h = setup();
    const gone = field();
    await h.controller.start({ id: 'a', element: gone });
    h.say();
    gone.remove();
    h.requests[0]?.done.resolve(transcription('Para nadie.'));
    await flush();
    expect(gone.value).toBe('');
    expect(h.controller.getField('a').phase).toBe('idle');
    expect(h.mic.state.stopped).toBe(1);

    const locked = field();
    await h.controller.start({ id: 'b', element: locked });
    h.say();
    locked.readOnly = true;
    h.requests[1]?.done.resolve(transcription('Tampoco.'));
    await flush();
    expect(locked.value).toBe('');
  });

  it('refuses to start in a field that must not be dictated', async () => {
    const h = setup();
    const password = field('input') as HTMLInputElement;
    password.type = 'password';
    await h.controller.start({ id: 'a', element: password });
    const secret = field('input');
    secret.dataset.secret = '';
    await h.controller.start({ id: 'b', element: secret });
    expect(h.mic.state.opened).toBe(0);
    expect(h.controller.getField('a').phase).toBe('idle');
  });

  it('release() forgets a field that unmounted: nothing else is written into it', async () => {
    const h = setup();
    const element = field();
    await h.controller.start({ id: 'a', element });
    h.say();
    h.controller.release('a');
    expect(h.mic.state.stopped).toBe(1);
    h.requests[0]?.done.resolve(transcription('Ya no.'));
    await flush();
    expect(element.value).toBe('');
    expect(h.controller.getGlobal().activeFieldId).toBeNull();
  });

  it('hiding the buttons in the preferences stops and disables dictation', async () => {
    const h = setup();
    const element = field();
    await h.controller.start({ id: 'a', element });
    h.controller.setPreferences({ showButtons: false });
    expect(h.mic.state.stopped).toBe(1);
    expect(h.controller.getField('a').phase).toBe('idle');
    await h.controller.start({ id: 'a', element });
    expect(h.mic.state.opened).toBe(1);
  });

  it('signing out disconnects everything', async () => {
    const h = setup();
    await h.controller.start({ id: 'a', element: field() });
    h.controller.disconnect();
    expect(h.mic.state.stopped).toBe(1);
    expect(h.controller.getGlobal()).toMatchObject({ ready: false, activeFieldId: null });
  });

  it('notifies subscribers and keeps field snapshots stable between changes', async () => {
    const h = setup();
    const listener = vi.fn();
    const unsubscribe = h.controller.subscribe(listener);
    const before = h.controller.getField('a');
    expect(h.controller.getField('a')).toBe(before);
    await h.controller.start({ id: 'a', element: field() });
    expect(listener).toHaveBeenCalled();
    const listening = h.controller.getField('a');
    expect(h.controller.getField('a')).toBe(listening);
    unsubscribe();
    listener.mockClear();
    h.controller.stop();
    expect(listener).not.toHaveBeenCalled();
  });
});
