import {
  GenderSchema,
  LANGUAGES,
  LANGUAGE_CODES,
  VOICE_PREVIEW_TEXTS,
  baseLanguage,
} from '@parlante/shared';
import type { Gender, LanguageCode, ProviderRef, Voice } from '@parlante/shared';

/* Filters, grouping and preview settings of the voice library. Like the avatar catalogue,
 * the list is fetched once and narrowed here so counts stay visible and the search is
 * instant. State lives in the URL. */

export const VOICE_KINDS = ['all', 'stock', 'cloned'] as const;
export type VoiceKind = (typeof VOICE_KINDS)[number];

export interface VoiceFilters {
  kind: VoiceKind;
  language: LanguageCode | null;
  gender: Gender | null;
  /** Provider id (`espeak`, `elevenlabs`…). */
  provider: string | null;
  q: string;
}

export const NO_VOICE_FILTERS: VoiceFilters = {
  kind: 'all',
  language: null,
  gender: null,
  provider: null,
  q: '',
};

export function hasActiveVoiceFilters(filters: VoiceFilters): boolean {
  return (
    filters.language !== null ||
    filters.gender !== null ||
    filters.provider !== null ||
    filters.q.trim() !== ''
  );
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Base language of a voice (`es-MX` → `es`). */
export function voiceLanguage(voice: Pick<Voice, 'language'>): LanguageCode {
  return baseLanguage(voice.language) ?? 'es';
}

/**
 * A voice speaks `language` when it is its own, or when it is multilingual (the same rule as
 * `GET /api/voices?language=`: multilingual voices are always included).
 */
export function speaks(
  voice: Pick<Voice, 'language' | 'multilingual'>,
  language: LanguageCode,
): boolean {
  return voice.multilingual || voiceLanguage(voice) === language;
}

function matchesKind(voice: Voice, kind: VoiceKind): boolean {
  return kind === 'all' || voice.kind === kind;
}

function matchesRest(voice: Voice, filters: VoiceFilters): boolean {
  if (filters.language !== null && !speaks(voice, filters.language)) return false;
  if (filters.gender !== null && voice.gender !== filters.gender) return false;
  if (filters.provider !== null && voice.provider.id !== filters.provider) return false;
  const words = normalize(filters.q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const language = LANGUAGES.find((entry) => entry.code === voiceLanguage(voice));
  const haystack = normalize(
    [
      voice.name,
      voice.description,
      voice.provider.name,
      language?.name ?? '',
      language?.englishName ?? '',
      ...voice.tags,
    ].join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

export function filterVoices(voices: readonly Voice[], filters: VoiceFilters): Voice[] {
  return voices.filter((voice) => matchesKind(voice, filters.kind) && matchesRest(voice, filters));
}

export function countByKind(
  voices: readonly Voice[],
  filters: VoiceFilters,
): Record<VoiceKind, number> {
  const counts: Record<VoiceKind, number> = { all: 0, stock: 0, cloned: 0 };
  for (const voice of voices) {
    if (!matchesRest(voice, filters)) continue;
    counts.all += 1;
    counts[voice.kind] += 1;
  }
  return counts;
}

export interface VoiceGroup {
  /** `multi` gathers the voices that speak every language when no language is selected. */
  key: LanguageCode | 'multi' | 'cloned';
  voices: Voice[];
}

/**
 * Voices as the page lists them: the workspace's cloned voices first, then one group per
 * language in the product's language order, then the multilingual ones. With a language
 * filter the multilingual voices stay in their own group (they are not "Spanish voices").
 */
export function groupVoices(voices: readonly Voice[]): VoiceGroup[] {
  const cloned: Voice[] = [];
  const multi: Voice[] = [];
  const byLanguage = new Map<LanguageCode, Voice[]>();
  for (const voice of voices) {
    if (voice.kind === 'cloned') cloned.push(voice);
    else if (voice.multilingual) multi.push(voice);
    else {
      const language = voiceLanguage(voice);
      const list = byLanguage.get(language) ?? [];
      list.push(voice);
      byLanguage.set(language, list);
    }
  }
  const groups: VoiceGroup[] = [];
  if (cloned.length > 0) groups.push({ key: 'cloned', voices: cloned });
  for (const code of LANGUAGE_CODES) {
    const list = byLanguage.get(code);
    if (list && list.length > 0) groups.push({ key: code, voices: list });
  }
  if (multi.length > 0) groups.push({ key: 'multi', voices: multi });
  return groups;
}

/** Languages that have at least one voice (own or multilingual), with how many speak each. */
export function languageCounts(voices: readonly Voice[]): { code: LanguageCode; count: number }[] {
  return LANGUAGE_CODES.map((code) => ({
    code,
    count: voices.filter((voice) => speaks(voice, code)).length,
  })).filter((entry) => entry.count > 0);
}

/** Distinct providers of the voices, in first-seen order. */
export function providersOf(voices: readonly Voice[]): ProviderRef[] {
  const seen = new Map<string, ProviderRef>();
  for (const voice of voices)
    if (!seen.has(voice.provider.id)) seen.set(voice.provider.id, voice.provider);
  return [...seen.values()];
}

/* ---------- preview ---------- */

export const PREVIEW_TEXT_MAX = 400;
export const SPEED_RANGE = { min: 0.5, max: 2, step: 0.05 } as const;
export const PITCH_RANGE = { min: -12, max: 12, step: 1 } as const;

/**
 * Language a preview is spoken in: the voice's own, except for multilingual voices, which
 * follow the language the person is browsing (or asked for in the console).
 */
export function previewLanguage(
  voice: Pick<Voice, 'language' | 'multilingual'>,
  wanted: LanguageCode | null,
): LanguageCode {
  if (voice.multilingual && wanted !== null) return wanted;
  return voiceLanguage(voice);
}

/** Sample sentence of a language (Spanish when the language has none). */
export function sampleText(language: string): string {
  return VOICE_PREVIEW_TEXTS[language.slice(0, 2)] ?? (VOICE_PREVIEW_TEXTS.es as string);
}

/** `1.25` → "1,25×" in the UI language. */
export function formatSpeed(speed: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(speed)}×`;
}

/** `2` → "+2 st", `-3` → "−3 st", `0` → "0 st" (semitones). */
export function formatPitch(pitch: number): string {
  const rounded = Math.round(pitch);
  if (rounded === 0) return '0 st';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} st`;
}

/* ---------- URL ---------- */

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function voiceFiltersFromParams(params: URLSearchParams): VoiceFilters {
  const provider = params.get('provider');
  return {
    kind: pick(params.get('kind'), VOICE_KINDS) ?? 'all',
    language: pick(params.get('lang'), LANGUAGE_CODES),
    gender: pick(params.get('gender'), GenderSchema.options),
    provider: provider !== null && /^[a-z0-9_-]{1,24}$/i.test(provider) ? provider : null,
    q: params.get('q') ?? '',
  };
}

export function voiceFiltersToParams(
  filters: VoiceFilters,
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | null) => {
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
  };
  set('kind', filters.kind === 'all' ? null : filters.kind);
  set('lang', filters.language);
  set('gender', filters.gender);
  set('provider', filters.provider);
  set('q', filters.q.trim() === '' ? null : filters.q);
  return next;
}
