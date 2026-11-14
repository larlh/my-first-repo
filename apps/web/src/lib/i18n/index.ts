import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import type { UiLocale } from '@parlante/shared';
import { en } from './locales/en';
import { es } from './locales/es';

/* -------------------------------------------------------------------------------------------
 * i18n: Spanish (default / fallback) and English.
 *  - namespace `shell`: everything owned by the shell and the UI kit
 *  - one namespace per feature (= manifest id), registered from the manifests at start-up
 * The language is detected from the stored choice, then the browser, then falls back to `es`.
 * ----------------------------------------------------------------------------------------- */

export const UI_LOCALES = ['es', 'en'] as const satisfies readonly UiLocale[];
export const DEFAULT_LOCALE: UiLocale = 'es';
export const LOCALE_STORAGE_KEY = 'parlante.locale';
export const SHELL_NS = 'shell';

export const LOCALE_NAMES: Record<UiLocale, string> = { es: 'Español', en: 'English' };

/** Nested translation tree of one namespace in one language. */
export interface TranslationTree {
  [key: string]: string | TranslationTree;
}
/** Translations a feature contributes: both languages are mandatory. */
export type FeatureTranslations = Record<UiLocale, TranslationTree>;

export function toUiLocale(language: string | undefined): UiLocale {
  return language?.slice(0, 2).toLowerCase() === 'en' ? 'en' : DEFAULT_LOCALE;
}

if (!i18n.isInitialized) {
  void i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: { es: { [SHELL_NS]: es }, en: { [SHELL_NS]: en } },
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...UI_LOCALES],
      load: 'languageOnly',
      nonExplicitSupportedLngs: true,
      ns: [SHELL_NS],
      defaultNS: SHELL_NS,
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: LOCALE_STORAGE_KEY,
        caches: [],
      },
    });
}

function syncDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = toUiLocale(language);
}
syncDocumentLanguage(i18n.language);
i18n.on('languageChanged', syncDocumentLanguage);

/** Register (or extend) the namespace of a feature. Called by the shell for every manifest. */
export function registerTranslations(namespace: string, bundles: FeatureTranslations): void {
  for (const locale of UI_LOCALES) {
    i18n.addResourceBundle(locale, namespace, bundles[locale], true, true);
  }
}

/** Current UI language as a supported locale. */
export function currentLocale(): UiLocale {
  return toUiLocale(i18n.resolvedLanguage ?? i18n.language);
}

/** True when the user picked a language explicitly on this device. */
export function hasStoredLocale(): boolean {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Change the UI language. `persist: false` follows a profile without pinning the device. */
export async function changeLocale(
  locale: UiLocale,
  options: { persist?: boolean } = {},
): Promise<void> {
  if (options.persist !== false) {
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
  }
  await i18n.changeLanguage(locale);
}

export { i18n };
