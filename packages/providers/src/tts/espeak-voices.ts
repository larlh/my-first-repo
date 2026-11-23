import { LOCAL_VOICES, languageName } from '@parlante/shared';
import type { ProviderVoice } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Catalogue of the local eSpeak NG voices.
 *
 * An eSpeak "voice" is two independent things: the LANGUAGE rules (pronunciation, numbers,
 * prosody) and a VARIANT (timbre: `+f2`, `+m7`…). A Parlante local voice is one language plus
 * one variant plus a small pitch / pace trim. The ids of `LOCAL_VOICES` (@parlante/shared) are
 * frozen: `<lang>-f1` and `<lang>-m1` for the 13 product languages. This file maps them to
 * eSpeak and adds second timbres and regional accents.
 * ----------------------------------------------------------------------------------------- */

export interface EspeakVoiceDef extends ProviderVoice {
  /** eSpeak language voice (`es`, `en-us`, `pt-br`…). */
  espeakVoice: string;
  /** eSpeak variant (`f2`, `m7`…) or null for the plain (male) voice. */
  variant: string | null;
  /** Pitch trim in semitones that is part of the voice's identity. */
  pitchSemitones: number;
  /** Pace trim (multiplier) that is part of the voice's identity. */
  rate: number;
}

interface Timbre {
  variant: string | null;
  pitchSemitones: number;
  rate: number;
  /** Spanish description fragment (the default UI language). */
  label: string;
  tags: string[];
}

/** Measured medians with these settings: f1 ≈ 205 Hz, m1 ≈ 110 Hz, f2 ≈ 185 Hz, m2 ≈ 97 Hz. */
const TIMBRES: Readonly<Record<'f1' | 'm1' | 'f2' | 'm2', Timbre>> = {
  f1: { variant: 'f2', pitchSemitones: 1, rate: 1, label: 'femenina, clara', tags: ['clara'] },
  m1: { variant: null, pitchSemitones: 1.5, rate: 1, label: 'masculina, neutra', tags: ['neutra'] },
  f2: {
    variant: 'f4',
    pitchSemitones: 0.75,
    rate: 0.96,
    label: 'femenina, grave y serena',
    tags: ['serena'],
  },
  m2: {
    variant: 'm7',
    pitchSemitones: -1.25,
    rate: 0.96,
    label: 'masculina, grave y pausada',
    tags: ['grave'],
  },
};

/** eSpeak language voice of each product language (the frozen `<lang>-f1/m1` voices). */
const LANGUAGE_VOICE: Readonly<Record<string, string>> = {
  es: 'es',
  en: 'en-us',
  fr: 'fr',
  de: 'de',
  it: 'it',
  pt: 'pt',
  ca: 'ca',
  nl: 'nl',
  pl: 'pl',
  sv: 'sv',
  tr: 'tr',
  ru: 'ru',
  el: 'el',
};

/** Regional accents eSpeak offers for the product languages: locale → eSpeak voice. */
const REGIONAL_VOICE: Readonly<Record<string, string>> = {
  'es-MX': 'es-419',
  // British English is eSpeak's plain `en` voice (`en-gb` is only a language tag of it).
  'en-GB': 'en',
  'en-US': 'en-us',
  'pt-BR': 'pt-br',
  'pt-PT': 'pt',
  'es-ES': 'es',
  'fr-FR': 'fr',
};

const REGION_LABEL: Readonly<Record<string, string>> = {
  'es-MX': 'español (Latinoamérica)',
  'en-GB': 'inglés (Reino Unido)',
  'pt-BR': 'portugués (Brasil)',
};

function describe(languageLabel: string, timbre: Timbre): string {
  return `Voz sintética local (eSpeak NG) · ${languageLabel} · ${timbre.label}`;
}

function voice(
  providerVoiceId: string,
  name: string,
  language: string,
  languageLabel: string,
  espeakVoice: string,
  timbreId: keyof typeof TIMBRES,
): EspeakVoiceDef {
  const timbre = TIMBRES[timbreId];
  return {
    providerVoiceId,
    name,
    language,
    gender: timbreId.startsWith('f') ? 'female' : 'male',
    description: describe(languageLabel, timbre),
    tags: ['local', 'sintética', ...timbre.tags],
    espeakVoice,
    variant: timbre.variant,
    pitchSemitones: timbre.pitchSemitones,
    rate: timbre.rate,
  };
}

/** Second timbres for the six most used languages: [female name, male name]. */
const SECOND_TIMBRE_NAMES: Readonly<Record<string, [string, string]>> = {
  es: ['Lucía', 'Mateo'],
  en: ['Olivia', 'Henry'],
  fr: ['Chloé', 'Hugo'],
  de: ['Lena', 'Jonas'],
  it: ['Sofia', 'Luca'],
  pt: ['Beatriz', 'Rafael'],
};

/** Regional accents: [locale, id prefix, female name, male name]. */
const REGIONAL_NAMES: readonly [string, string, string, string][] = [
  ['es-MX', 'es-mx', 'Valentina', 'Santiago'],
  ['en-GB', 'en-gb', 'Charlotte', 'Oliver'],
  ['pt-BR', 'pt-br', 'Camila', 'Gustavo'],
];

function buildCatalogue(): EspeakVoiceDef[] {
  const out: EspeakVoiceDef[] = [];
  // 1. The frozen contract voices, in catalogue order.
  for (const def of LOCAL_VOICES) {
    const espeakVoice = LANGUAGE_VOICE[def.language];
    if (!espeakVoice) continue;
    out.push(
      voice(
        def.providerVoiceId,
        def.name,
        def.language,
        languageName(def.language, 'es').toLowerCase(),
        espeakVoice,
        def.gender === 'female' ? 'f1' : 'm1',
      ),
    );
  }
  // 2. Second timbres.
  for (const [language, [female, male]] of Object.entries(SECOND_TIMBRE_NAMES)) {
    const espeakVoice = LANGUAGE_VOICE[language];
    if (!espeakVoice) continue;
    const label = languageName(language, 'es').toLowerCase();
    out.push(voice(`${language}-f2`, female, language, label, espeakVoice, 'f2'));
    out.push(voice(`${language}-m2`, male, language, label, espeakVoice, 'm2'));
  }
  // 3. Regional accents.
  for (const [locale, prefix, female, male] of REGIONAL_NAMES) {
    const espeakVoice = REGIONAL_VOICE[locale];
    if (!espeakVoice) continue;
    const label = REGION_LABEL[locale] ?? locale;
    out.push(voice(`${prefix}-f1`, female, locale, label, espeakVoice, 'f1'));
    out.push(voice(`${prefix}-m1`, male, locale, label, espeakVoice, 'm1'));
  }
  return out;
}

export const ESPEAK_VOICES: readonly EspeakVoiceDef[] = buildCatalogue();

const BY_ID = new Map(ESPEAK_VOICES.map((def) => [def.providerVoiceId, def]));

export function findEspeakVoice(providerVoiceId: string): EspeakVoiceDef | null {
  return BY_ID.get(providerVoiceId) ?? null;
}

/**
 * eSpeak language voice for a request: the voice's own accent when the text is in the voice's
 * language; otherwise the rules of the TEXT's language (so a script in another language is
 * still pronounced correctly — the timbre, which is what identifies the voice, is kept).
 */
export function espeakLanguageFor(def: EspeakVoiceDef, requestLanguage: string): string {
  const base = requestLanguage.slice(0, 2).toLowerCase();
  if (base === '' || base === def.language.slice(0, 2).toLowerCase()) return def.espeakVoice;
  const region = requestLanguage.length > 2 ? requestLanguage.slice(3).toUpperCase() : '';
  return REGIONAL_VOICE[`${base}-${region}`] ?? LANGUAGE_VOICE[base] ?? def.espeakVoice;
}
