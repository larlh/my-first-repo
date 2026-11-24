import type { DictationReasonCode, ProviderRef } from '@parlante/shared';

/** The two ways of turning speech into text (see README, «Dictado por micrófono»). */
export type DictationEngineId = 'local' | 'browser';
/** What the user picked in the preferences. `auto` never selects the browser engine. */
export type EnginePreference = 'auto' | 'local' | 'browser';

/** Every failure the UI can explain; each one has a translated sentence. */
export type DictationErrorCode =
  /** The browser (or the person) refused access to the microphone. */
  | 'permission_denied'
  | 'no_microphone'
  /** The microphone exists but could not be opened (another app holds it, driver error). */
  | 'microphone_busy'
  /** The microphone stopped delivering audio (unplugged, revoked). */
  | 'microphone_lost'
  /** Page not served over HTTPS / localhost: browsers hide the microphone. */
  | 'insecure_context'
  /** This browser cannot capture audio the way the local engine needs. */
  | 'unsupported'
  /** The chosen engine cannot run; `reasonCode` says why for the local one. */
  | 'engine_unavailable'
  /** Neither engine exists on this server / browser. */
  | 'no_engine'
  /** The chosen browser engine does not exist in this browser. */
  | 'browser_unsupported'
  /** The field reached its `maxLength`. */
  | 'limit_reached'
  | 'network'
  /** Too many phrases per minute for this user. */
  | 'rate_limited'
  /** The server is transcribing for others and stayed busy after retrying. */
  | 'busy'
  | 'session_expired'
  /** The server refused the audio (format / length). */
  | 'audio_rejected'
  /** The model failed on a phrase. */
  | 'service_failed'
  /** The speech service of the browser refused or could not be reached. */
  | 'browser_service'
  | 'language_unsupported';

export interface DictationError {
  code: DictationErrorCode;
  /** Engine the error belongs to, when one had been chosen. */
  engine?: DictationEngineId | undefined;
  /** Why the local engine is unavailable (`engine_unavailable`). */
  reasonCode?: DictationReasonCode | undefined;
  /** `limit_reached`: the limit of the field. */
  maxLength?: number | undefined;
  /** The browser engine exists and can be offered as the way out. */
  offerBrowser?: boolean | undefined;
  /** The local engine is available and can be offered as the way out. */
  offerLocal?: boolean | undefined;
}

/** Thrown inside the engines; the controller turns it into the state of the field. */
export class DictationFailure extends Error {
  readonly detail: DictationError;
  constructor(detail: DictationError) {
    super(`Dictation failed: ${detail.code}`);
    this.name = 'DictationFailure';
    this.detail = detail;
  }
}

export function toDictationError(error: unknown, engine: DictationEngineId): DictationError {
  if (error instanceof DictationFailure) return { engine, ...error.detail };
  return { code: 'service_failed', engine };
}

/** What an engine reports while it runs. All calls happen on the main thread. */
export interface EngineCallbacks {
  /** The microphone is open and speech is being listened to. */
  onListening: () => void;
  /** Input level 0..1, or null when the engine cannot measure it. */
  onLevel: (level: number | null) => void;
  /** Provisional text of the phrase being spoken (browser engine only). */
  onInterim: (text: string) => void;
  /** A finished phrase, in the order it was spoken. */
  onText: (text: string, provider: ProviderRef | null) => void;
  /** Phrases recorded and still being transcribed. */
  onPending: (count: number) => void;
  /** Fatal: the engine has already released the microphone. Nothing else follows. */
  onError: (error: DictationError) => void;
  /** After `stop()`: everything that was spoken has been delivered. */
  onEnd: () => void;
}

export interface EngineSession {
  /** Release the microphone; phrases already spoken are still transcribed and delivered. */
  stop: () => void;
  /** Release everything now; nothing else is delivered. */
  abort: () => void;
}
