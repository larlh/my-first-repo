import type { DictationReasonCode } from '@parlante/shared';
import type { DictationEngineId, EnginePreference } from './types';

/* Which engine a dictation starts with. The rule that matters: the browser engine sends the
 * audio outside the machine (in Chrome, to Google), so it is NEVER picked on the user's
 * behalf — only when they chose it and accepted the notice. */

export interface EngineChoiceInput {
  preference: EnginePreference;
  /** `capabilities.dictation.local`; null when the capabilities could not be read. */
  local: { available: boolean; reasonCode: DictationReasonCode | null } | null;
  /** This browser has `SpeechRecognition`. */
  browserSupported: boolean;
  /** The person accepted the notice of the browser engine. */
  browserConsent: boolean;
}

export type EngineChoice =
  | { engine: DictationEngineId }
  /** The browser engine was chosen but its notice has not been accepted yet. */
  | { engine: null; blocked: 'browser_needs_consent' }
  /** The local engine cannot run; the browser one may be offered (never started by itself). */
  | {
      engine: null;
      blocked: 'local_unavailable';
      reasonCode: DictationReasonCode;
      offerBrowser: boolean;
    }
  /** The browser engine was chosen but this browser has none; the local one may be offered. */
  | { engine: null; blocked: 'browser_unsupported'; offerLocal: boolean };

export function chooseEngine(input: EngineChoiceInput): EngineChoice {
  const localAvailable = input.local?.available === true;
  if (input.preference === 'browser') {
    if (!input.browserSupported) {
      return { engine: null, blocked: 'browser_unsupported', offerLocal: localAvailable };
    }
    return input.browserConsent
      ? { engine: 'browser' }
      : { engine: null, blocked: 'browser_needs_consent' };
  }
  // `auto` and `local` both mean the local engine; `auto` only differs in name for the user
  // ("use what this installation offers") and in never being a reason to leave the machine.
  if (localAvailable) return { engine: 'local' };
  return {
    engine: null,
    blocked: 'local_unavailable',
    reasonCode: input.local?.reasonCode ?? 'unknown',
    offerBrowser: input.browserSupported,
  };
}

/** True when no engine can run at all, whatever the preference. */
export function noEngineAtAll(
  input: Pick<EngineChoiceInput, 'local' | 'browserSupported'>,
): boolean {
  return input.local?.available !== true && !input.browserSupported;
}
