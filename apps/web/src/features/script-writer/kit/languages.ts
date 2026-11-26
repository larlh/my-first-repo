import { LANGUAGES, languageName } from '@parlante/shared';
import type { LanguageCode } from '@parlante/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SelectOption } from '@/ui';

export type UiLocale = 'es' | 'en';

/** UI language as the two-letter code the catalogue helpers expect. */
export function useUiLocale(): UiLocale {
  const { i18n } = useTranslation();
  return (i18n.resolvedLanguage ?? i18n.language ?? 'es').startsWith('en') ? 'en' : 'es';
}

/**
 * Name of a content language for the UI: its own name plus, when it differs, the name in the
 * UI language ("Deutsch · Alemán"), so nobody has to recognise "Ελληνικά".
 */
export function languageLabel(code: string, locale: UiLocale): string {
  const own = languageName(code, 'es');
  const english = languageName(code, 'en');
  if (locale === 'en') return own === english ? own : `${own} · ${english}`;
  const spanish = SPANISH_NAMES[code.slice(0, 2)] ?? own;
  return own === spanish ? own : `${own} · ${spanish}`;
}

/** Spanish names of the supported languages (the shared catalogue has native + English). */
const SPANISH_NAMES: Record<string, string> = {
  es: 'Español',
  en: 'Inglés',
  fr: 'Francés',
  de: 'Alemán',
  it: 'Italiano',
  pt: 'Portugués',
  ca: 'Catalán',
  nl: 'Neerlandés',
  pl: 'Polaco',
  sv: 'Sueco',
  tr: 'Turco',
  ru: 'Ruso',
  el: 'Griego',
};

/** Short name in the UI language only ("Alemán" / "German"). */
export function languageShortName(code: string, locale: UiLocale): string {
  return locale === 'en'
    ? languageName(code, 'en')
    : (SPANISH_NAMES[code.slice(0, 2)] ?? languageName(code, 'es'));
}

/** The short name as it reads inside a sentence (Spanish does not capitalise languages). */
export function languageInText(code: string, locale: UiLocale): string {
  const name = languageShortName(code, locale);
  return locale === 'es' ? name.toLowerCase() : name;
}

/** Options of a language `<Select>`, in catalogue order. */
export function useLanguageOptions(): SelectOption<LanguageCode>[] {
  const locale = useUiLocale();
  return useMemo(
    () =>
      LANGUAGES.map((language) => ({
        value: language.code,
        label: languageLabel(language.code, locale),
      })),
    [locale],
  );
}
