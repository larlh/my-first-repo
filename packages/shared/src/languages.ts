import { z } from 'zod';

/**
 * Languages supported across the product (voices, scripts, translation, subtitles).
 * All of them are covered by the Latin / Latin-ext / Cyrillic / Greek subsets of the bundled
 * fonts, so subtitles always render. CJK/RTL scripts are intentionally out of scope (no bundled
 * font coverage).
 */
export const LANGUAGES = [
  { code: 'es', name: 'Español', englishName: 'Spanish' },
  { code: 'en', name: 'English', englishName: 'English' },
  { code: 'fr', name: 'Français', englishName: 'French' },
  { code: 'de', name: 'Deutsch', englishName: 'German' },
  { code: 'it', name: 'Italiano', englishName: 'Italian' },
  { code: 'pt', name: 'Português', englishName: 'Portuguese' },
  { code: 'ca', name: 'Català', englishName: 'Catalan' },
  { code: 'nl', name: 'Nederlands', englishName: 'Dutch' },
  { code: 'pl', name: 'Polski', englishName: 'Polish' },
  { code: 'sv', name: 'Svenska', englishName: 'Swedish' },
  { code: 'tr', name: 'Türkçe', englishName: 'Turkish' },
  { code: 'ru', name: 'Русский', englishName: 'Russian' },
  { code: 'el', name: 'Ελληνικά', englishName: 'Greek' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [LanguageCode, ...LanguageCode[]];

/** Base language code (`es`). */
export const LanguageCodeSchema = z.enum(LANGUAGE_CODES);

/**
 * Locale tag as reported by voices: base code with optional region (`es`, `es-MX`, `pt-BR`).
 * The base part must be a supported language.
 */
export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
  .refine((v) => (LANGUAGE_CODES as string[]).includes(v.slice(0, 2)), 'Unsupported language');

export function baseLanguage(locale: string): LanguageCode | null {
  const base = locale.slice(0, 2).toLowerCase();
  return (LANGUAGE_CODES as string[]).includes(base) ? (base as LanguageCode) : null;
}

export function languageName(code: string, uiLocale: 'es' | 'en' = 'es'): string {
  const lang = LANGUAGES.find((l) => l.code === code.slice(0, 2));
  if (!lang) return code;
  return uiLocale === 'en' ? lang.englishName : lang.name;
}

/** UI locales of the web app. */
export const UiLocaleSchema = z.enum(['es', 'en']);
export type UiLocale = z.infer<typeof UiLocaleSchema>;
