import { describe, expect, it } from 'vitest';
import { chooseEngine, noEngineAtAll } from './engine-choice';
import type { EngineChoiceInput } from './engine-choice';
import {
  DEFAULT_DICTATION_PREFERENCES,
  dictationStorageKey,
  loadDictationPreferences,
  parseDictationPreferences,
  saveDictationPreferences,
} from './preferences';

const LOCAL_OK = { available: true, reasonCode: null } as const;
const LOCAL_MISSING = { available: false, reasonCode: 'model_not_installed' } as const;

function choose(patch: Partial<EngineChoiceInput>) {
  return chooseEngine({
    preference: 'auto',
    local: LOCAL_OK,
    browserSupported: true,
    browserConsent: false,
    ...patch,
  });
}

describe('chooseEngine', () => {
  it('automatic means the local engine when this installation has it', () => {
    expect(choose({})).toEqual({ engine: 'local' });
    expect(choose({ browserConsent: true })).toEqual({ engine: 'local' });
  });

  it('automatic never falls back to the browser by itself — it explains and offers it', () => {
    expect(choose({ local: LOCAL_MISSING })).toEqual({
      engine: null,
      blocked: 'local_unavailable',
      reasonCode: 'model_not_installed',
      offerBrowser: true,
    });
    // Not even when the notice was accepted in the past.
    expect(choose({ local: LOCAL_MISSING, browserConsent: true })).toMatchObject({
      engine: null,
      blocked: 'local_unavailable',
    });
    expect(choose({ local: LOCAL_MISSING, browserSupported: false })).toMatchObject({
      offerBrowser: false,
    });
  });

  it('an explicit "local" behaves the same and keeps the reason of the server', () => {
    expect(choose({ preference: 'local' })).toEqual({ engine: 'local' });
    expect(
      choose({ preference: 'local', local: { available: false, reasonCode: 'model_incomplete' } }),
    ).toMatchObject({ blocked: 'local_unavailable', reasonCode: 'model_incomplete' });
    // Capabilities unknown (request failed): unknown reason, nothing is assumed.
    expect(choose({ preference: 'local', local: null })).toMatchObject({
      blocked: 'local_unavailable',
      reasonCode: 'unknown',
    });
  });

  it('the browser engine needs both the choice and the accepted notice', () => {
    expect(choose({ preference: 'browser' })).toEqual({
      engine: null,
      blocked: 'browser_needs_consent',
    });
    expect(choose({ preference: 'browser', browserConsent: true })).toEqual({ engine: 'browser' });
  });

  it('a browser without Web Speech cannot use it; the local one is offered if it works', () => {
    expect(
      choose({ preference: 'browser', browserSupported: false, browserConsent: true }),
    ).toEqual({ engine: null, blocked: 'browser_unsupported', offerLocal: true });
    expect(
      choose({ preference: 'browser', browserSupported: false, local: LOCAL_MISSING }),
    ).toEqual({ engine: null, blocked: 'browser_unsupported', offerLocal: false });
  });

  it('knows when there is no engine at all', () => {
    expect(noEngineAtAll({ local: LOCAL_MISSING, browserSupported: false })).toBe(true);
    expect(noEngineAtAll({ local: null, browserSupported: false })).toBe(true);
    expect(noEngineAtAll({ local: LOCAL_MISSING, browserSupported: true })).toBe(false);
    expect(noEngineAtAll({ local: LOCAL_OK, browserSupported: false })).toBe(false);
  });
});

describe('dictation preferences', () => {
  it('default to the local engine, the interface language and visible buttons', () => {
    expect(DEFAULT_DICTATION_PREFERENCES).toEqual({
      engine: 'auto',
      language: 'ui',
      showButtons: true,
      browserConsentAt: null,
    });
    expect(loadDictationPreferences('usr_nobody')).toEqual(DEFAULT_DICTATION_PREFERENCES);
  });

  it('are stored per user, so nobody inherits the consent of somebody else', () => {
    const accepted = '2026-11-24T10:00:00.000Z';
    expect(
      saveDictationPreferences('usr_a', {
        engine: 'browser',
        language: 'en',
        showButtons: false,
        browserConsentAt: accepted,
      }),
    ).toBe(true);
    expect(loadDictationPreferences('usr_a')).toEqual({
      engine: 'browser',
      language: 'en',
      showButtons: false,
      browserConsentAt: accepted,
    });
    expect(loadDictationPreferences('usr_b')).toEqual(DEFAULT_DICTATION_PREFERENCES);
    window.localStorage.removeItem(dictationStorageKey('usr_a'));
  });

  it('ignore anything unexpected in storage', () => {
    expect(
      parseDictationPreferences({
        engine: 'cloud',
        language: 'xx',
        showButtons: 'yes',
        browserConsentAt: 'never',
      }),
    ).toEqual(DEFAULT_DICTATION_PREFERENCES);
    expect(parseDictationPreferences(null)).toEqual(DEFAULT_DICTATION_PREFERENCES);
    window.localStorage.setItem(dictationStorageKey('usr_c'), '{not json');
    expect(loadDictationPreferences('usr_c')).toEqual(DEFAULT_DICTATION_PREFERENCES);
    window.localStorage.removeItem(dictationStorageKey('usr_c'));
  });
});
