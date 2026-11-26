import { LANGUAGE_CODES } from '@parlante/shared';
import type { LanguageCode } from '@parlante/shared';
import type { EnginePreference } from './types';

/* Dictation preferences. Like the theme, they belong to this device (the choice of engine
 * depends on the browser in use) and are kept per user in localStorage, so two people sharing
 * a browser do not inherit each other's consent to the browser engine. */

export interface DictationPreferences {
  /** Engine: `auto` = the local one when this installation has it. */
  engine: EnginePreference;
  /** Language spoken by default: the interface language (`ui`) or a fixed one. */
  language: 'ui' | LanguageCode;
  /** Show the microphone buttons in text fields. */
  showButtons: boolean;
  /**
   * When the notice of the browser engine ("in Chrome the audio is sent to Google") was
   * accepted, as an ISO date; null = never. The browser engine does not start without it.
   */
  browserConsentAt: string | null;
}

export const DEFAULT_DICTATION_PREFERENCES: DictationPreferences = {
  engine: 'auto',
  language: 'ui',
  showButtons: true,
  browserConsentAt: null,
};

const STORAGE_PREFIX = 'parlante.dictation.v1.';

export function dictationStorageKey(userId: string): string {
  return STORAGE_PREFIX + userId;
}

/** Anything unexpected in storage falls back to the default of that field. */
export function parseDictationPreferences(raw: unknown): DictationPreferences {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const engine =
    value.engine === 'local' || value.engine === 'browser' || value.engine === 'auto'
      ? value.engine
      : DEFAULT_DICTATION_PREFERENCES.engine;
  const language =
    typeof value.language === 'string' && (LANGUAGE_CODES as string[]).includes(value.language)
      ? (value.language as LanguageCode)
      : 'ui';
  const consent =
    typeof value.browserConsentAt === 'string' && !Number.isNaN(Date.parse(value.browserConsentAt))
      ? value.browserConsentAt
      : null;
  return {
    engine,
    language,
    showButtons: typeof value.showButtons === 'boolean' ? value.showButtons : true,
    browserConsentAt: consent,
  };
}

export function loadDictationPreferences(userId: string): DictationPreferences {
  try {
    const stored = window.localStorage.getItem(dictationStorageKey(userId));
    return parseDictationPreferences(stored ? (JSON.parse(stored) as unknown) : null);
  } catch {
    return { ...DEFAULT_DICTATION_PREFERENCES };
  }
}

/** Returns false when the browser refused to store (private mode, quota). */
export function saveDictationPreferences(
  userId: string,
  preferences: DictationPreferences,
): boolean {
  try {
    window.localStorage.setItem(dictationStorageKey(userId), JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}
