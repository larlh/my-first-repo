import { DictationFailure } from './types';
import type { DictationError, EngineCallbacks, EngineSession } from './types';

/* Browser engine: the Web Speech API (`SpeechRecognition`). The browser captures the
 * microphone itself and decides where the audio is recognised — in Chrome it is sent to
 * Google's servers. It is therefore opt-in: the controller only starts it after the person
 * chose it and accepted the notice. Parlante's server takes no part in it. */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative | undefined;
}
interface RecognitionResultList {
  readonly length: number;
  [index: number]: RecognitionResult | undefined;
}
export interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}
export interface RecognitionErrorEvent {
  readonly error: string;
}
/** The part of `SpeechRecognition` the engine uses (typed here: not in every DOM lib). */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The recognition constructor of this browser, if it has one. */
export function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export function browserEngineSupported(): boolean {
  return speechRecognitionCtor() !== undefined;
}

const REGIONS: Readonly<Record<string, string>> = {
  es: 'es-ES',
  en: 'en-US',
  fr: 'fr-FR',
  de: 'de-DE',
  it: 'it-IT',
  pt: 'pt-PT',
  ca: 'ca-ES',
  nl: 'nl-NL',
  pl: 'pl-PL',
  sv: 'sv-SE',
  tr: 'tr-TR',
  ru: 'ru-RU',
  el: 'el-GR',
};

/**
 * BCP-47 tag for the recogniser. A full locale (`es-MX`) is kept; a bare language takes the
 * region of the browser when it speaks that language, else a default region.
 */
export function recognitionLocale(language: string, navigatorLanguages: readonly string[]): string {
  if (/^[a-z]{2}-[A-Za-z]{2,4}$/.test(language)) return language;
  const base = language.slice(0, 2).toLowerCase();
  const own = navigatorLanguages.find(
    (tag) => tag.toLowerCase().startsWith(`${base}-`) && tag.length > 3,
  );
  return own ?? REGIONS[base] ?? base;
}

function errorOf(code: string): DictationError | null {
  switch (code) {
    case 'no-speech':
    case 'aborted':
      return null;
    case 'not-allowed':
      return { code: 'permission_denied', engine: 'browser' };
    case 'audio-capture':
      return { code: 'no_microphone', engine: 'browser' };
    case 'language-not-supported':
      return { code: 'language_unsupported', engine: 'browser' };
    case 'network':
    case 'service-not-allowed':
    default:
      return { code: 'browser_service', engine: 'browser' };
  }
}

export interface BrowserEngineOptions {
  /** Injected in tests; defaults to the constructor of this browser. */
  Recognition?: SpeechRecognitionCtor | undefined;
  /** BCP-47 tag (see `recognitionLocale`). */
  locale: string;
  now?: () => number;
}

/** Restarts closer together than this, several times in a row, mean the service is failing. */
const QUICK_END_MS = 1000;
const MAX_QUICK_ENDS = 3;
/** How long `stop()` waits for the last result before ending on its own. */
const STOP_GRACE_MS = 3000;

export function startBrowserEngine(
  options: BrowserEngineOptions,
  callbacks: EngineCallbacks,
): EngineSession {
  const Recognition = options.Recognition ?? speechRecognitionCtor();
  if (!Recognition) throw new DictationFailure({ code: 'browser_unsupported', engine: 'browser' });
  const now = options.now ?? (() => Date.now());

  let finished = false;
  let stopping = false;
  let announced = false;
  let startedAt = 0;
  let quickEnds = 0;
  let recognition: SpeechRecognitionLike | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  const finish = (error?: DictationError) => {
    if (finished) return;
    finished = true;
    clearTimeout(stopTimer);
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
    }
    if (error) {
      try {
        recognition?.abort();
      } catch {
        // Already stopped.
      }
      callbacks.onError(error);
    } else {
      callbacks.onEnd();
    }
  };

  const begin = () => {
    const instance = new Recognition();
    recognition = instance;
    instance.lang = options.locale;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.onstart = () => {
      startedAt = now();
      if (!announced) {
        announced = true;
        callbacks.onLevel(null);
        callbacks.onListening();
      }
    };
    instance.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript ?? '';
        if (!result) continue;
        if (result.isFinal) {
          if (text.trim() !== '') callbacks.onText(text, null);
        } else {
          interim += text;
        }
      }
      callbacks.onInterim(interim.trim());
    };
    instance.onerror = (event) => {
      const error = errorOf(event.error);
      if (error) finish(error);
    };
    instance.onend = () => {
      if (finished) return;
      callbacks.onInterim('');
      if (stopping) {
        finish();
        return;
      }
      // Chrome ends a "continuous" session after a stretch of silence: keep listening until
      // the person stops it, unless the service keeps closing straight away.
      quickEnds = now() - startedAt < QUICK_END_MS ? quickEnds + 1 : 0;
      if (quickEnds >= MAX_QUICK_ENDS) {
        finish({ code: 'browser_service', engine: 'browser' });
        return;
      }
      try {
        begin();
      } catch {
        finish({ code: 'browser_service', engine: 'browser' });
      }
    };
    instance.start();
  };

  try {
    begin();
  } catch {
    finished = true;
    throw new DictationFailure({ code: 'browser_service', engine: 'browser' });
  }

  return {
    stop: () => {
      if (finished || stopping) return;
      stopping = true;
      try {
        recognition?.stop();
      } catch {
        finish();
      }
      // A recognition that never got going (still waiting for the permission prompt) may not
      // report its end: do not leave the field waiting for it.
      if (!finished) stopTimer = setTimeout(() => finish(), STOP_GRACE_MS);
    },
    abort: () => {
      if (finished) return;
      finished = true;
      clearTimeout(stopTimer);
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.onstart = null;
        try {
          recognition.abort();
        } catch {
          // Already stopped.
        }
      }
    },
  };
}
