import { z } from 'zod';

/* -------------------------------------------------------------------------------------------
 * Viseme set (15). A viseme is a mouth shape; several phonemes share one.
 *
 *  id    mouth                                   phonemes (IPA examples)
 *  ----  --------------------------------------  ---------------------------------
 *  rest  neutral, lips together, relaxed          silence, pauses
 *  MBP   lips pressed together                    m b p
 *  FV    lower lip under upper teeth              f v
 *  TH    tongue between teeth                     θ ð
 *  DT    tongue behind upper teeth, slightly open t d
 *  KG    back of tongue raised, mid open          k g ŋ x h
 *  CHJ   lips pushed forward, teeth close         tʃ dʒ ʃ ʒ
 *  SZ    teeth together, lips spread              s z ts
 *  NL    tongue tip up, slightly open             n l ɲ ʎ
 *  R     lips slightly rounded, tongue curled     r ɾ ɹ ʁ
 *  A     wide open jaw                            a ɑ æ ʌ
 *  E     half open, lips spread                   e ɛ ə
 *  I     nearly closed, lips wide                 i ɪ j
 *  O     rounded, half open                       o ɔ
 *  U     rounded, small opening                   u ʊ w y
 * ----------------------------------------------------------------------------------------- */

export const VISEMES = [
  'rest',
  'MBP',
  'FV',
  'TH',
  'DT',
  'KG',
  'CHJ',
  'SZ',
  'NL',
  'R',
  'A',
  'E',
  'I',
  'O',
  'U',
] as const;

export type Viseme = (typeof VISEMES)[number];
export const VisemeSchema = z.enum(VISEMES);

/**
 * Canonical mouth parameters per viseme. Avatar rigs (drawn and photo-based) derive their mouth
 * geometry from these so every avatar articulates consistently. All values are 0..1 except
 * `width` (-1 = fully puckered, 0 = neutral, 1 = fully spread).
 */
export interface MouthShape {
  /** Jaw / mouth opening. */
  open: number;
  /** Horizontal stretch: negative = puckered, positive = spread. */
  width: number;
  /** Lip rounding / protrusion. */
  round: number;
  /** Visibility of the upper teeth. */
  teeth: number;
  /** Visibility of the tongue. */
  tongue: number;
}

export const VISEME_MOUTH_SHAPES: Record<Viseme, MouthShape> = {
  rest: { open: 0, width: 0, round: 0, teeth: 0, tongue: 0 },
  MBP: { open: 0, width: -0.05, round: 0.1, teeth: 0, tongue: 0 },
  FV: { open: 0.12, width: 0.1, round: 0, teeth: 0.9, tongue: 0 },
  TH: { open: 0.2, width: 0.1, round: 0, teeth: 0.5, tongue: 0.8 },
  DT: { open: 0.22, width: 0.2, round: 0, teeth: 0.6, tongue: 0.4 },
  KG: { open: 0.35, width: 0.1, round: 0, teeth: 0.3, tongue: 0.1 },
  CHJ: { open: 0.25, width: -0.35, round: 0.6, teeth: 0.6, tongue: 0 },
  SZ: { open: 0.1, width: 0.45, round: 0, teeth: 1, tongue: 0 },
  NL: { open: 0.25, width: 0.15, round: 0, teeth: 0.4, tongue: 0.6 },
  R: { open: 0.25, width: -0.2, round: 0.4, teeth: 0.2, tongue: 0.3 },
  A: { open: 1, width: 0.15, round: 0, teeth: 0.3, tongue: 0.3 },
  E: { open: 0.5, width: 0.5, round: 0, teeth: 0.5, tongue: 0.2 },
  I: { open: 0.25, width: 0.75, round: 0, teeth: 0.7, tongue: 0.1 },
  O: { open: 0.65, width: -0.45, round: 0.8, teeth: 0, tongue: 0.1 },
  U: { open: 0.3, width: -0.75, round: 1, teeth: 0, tongue: 0 },
};

/** Linear blend of two mouth shapes (`mix` 0 → a, 1 → b). */
export function blendMouthShapes(a: MouthShape, b: MouthShape, mix: number): MouthShape {
  const t = Math.min(1, Math.max(0, mix));
  return {
    open: a.open + (b.open - a.open) * t,
    width: a.width + (b.width - a.width) * t,
    round: a.round + (b.round - a.round) * t,
    teeth: a.teeth + (b.teeth - a.teeth) * t,
    tongue: a.tongue + (b.tongue - a.tongue) * t,
  };
}

/**
 * Phoneme → viseme, as data. Keys are IPA symbols plus the ASCII mnemonics eSpeak NG emits in
 * phoneme events. Extend ADDITIVELY. Multi-character keys win over single characters.
 * Diphthongs and affricates map to the shape of their most visible element.
 */
export const PHONEME_TO_VISEME: Readonly<Record<string, Viseme>> = {
  // ---- silence / pauses
  _: 'rest',
  '_:': 'rest',
  '': 'rest',
  ' ': 'rest',
  // ---- bilabials
  m: 'MBP',
  b: 'MBP',
  p: 'MBP',
  β: 'MBP',
  B: 'MBP',
  // ---- labiodentals
  f: 'FV',
  v: 'FV',
  ɱ: 'FV',
  // ---- dentals
  θ: 'TH',
  ð: 'TH',
  T: 'TH',
  D: 'TH',
  // ---- alveolar stops
  t: 'DT',
  d: 'DT',
  ʈ: 'DT',
  ɖ: 'DT',
  // ---- velars / glottals
  k: 'KG',
  g: 'KG',
  ɡ: 'KG',
  ŋ: 'KG',
  N: 'KG',
  x: 'KG',
  ɣ: 'KG',
  Q: 'KG',
  h: 'KG',
  ɦ: 'KG',
  q: 'KG',
  χ: 'KG',
  '?': 'KG',
  ʔ: 'KG',
  // ---- postalveolars / affricates
  ʃ: 'CHJ',
  ʒ: 'CHJ',
  S: 'CHJ',
  Z: 'CHJ',
  tʃ: 'CHJ',
  dʒ: 'CHJ',
  tS: 'CHJ',
  dZ: 'CHJ',
  ɕ: 'CHJ',
  ʑ: 'CHJ',
  'S;': 'CHJ',
  'Z;': 'CHJ',
  // ---- sibilants
  s: 'SZ',
  z: 'SZ',
  ts: 'SZ',
  dz: 'SZ',
  // ---- nasals / laterals (tongue tip)
  n: 'NL',
  l: 'NL',
  ɲ: 'NL',
  ʎ: 'NL',
  ɫ: 'NL',
  'n^': 'NL',
  'l^': 'NL',
  L: 'NL',
  // ---- rhotics
  r: 'R',
  ɾ: 'R',
  ɹ: 'R',
  ʁ: 'R',
  ʀ: 'R',
  R: 'R',
  'r-': 'R',
  ɻ: 'R',
  ɚ: 'R',
  ɝ: 'R',
  '3': 'R',
  '3:': 'R',
  // ---- open vowels
  a: 'A',
  ɑ: 'A',
  æ: 'A',
  ʌ: 'A',
  ɐ: 'A',
  ɒ: 'A',
  A: 'A',
  'A:': 'A',
  V: 'A',
  'a#': 'A',
  aI: 'A',
  aU: 'A',
  aɪ: 'A',
  aʊ: 'A',
  // ---- mid front / central vowels
  e: 'E',
  ɛ: 'E',
  ə: 'E',
  ɜ: 'E',
  œ: 'E',
  ø: 'E',
  E: 'E',
  '@': 'E',
  eI: 'E',
  eɪ: 'E',
  'e@': 'E',
  W: 'E',
  Y: 'E',
  // ---- close front vowels / palatal glide
  i: 'I',
  ɪ: 'I',
  j: 'I',
  ɨ: 'I',
  I: 'I',
  'i:': 'I',
  'i@': 'I',
  J: 'I',
  ʝ: 'I',
  ç: 'I',
  C: 'I',
  // ---- mid back rounded vowels
  o: 'O',
  ɔ: 'O',
  O: 'O',
  'O:': 'O',
  oU: 'O',
  oʊ: 'O',
  əʊ: 'O',
  OI: 'O',
  ɔɪ: 'O',
  '0': 'O',
  // ---- close rounded vowels / labial glide
  u: 'U',
  ʊ: 'U',
  w: 'U',
  y: 'U',
  ʏ: 'U',
  ɥ: 'U',
  U: 'U',
  'u:': 'U',
  'U@': 'U',
  ʉ: 'U',
};

const STRIP_MARKS = /[ˈˌ'ˑ,!|.̀-ͯ]/g;
const LENGTH_MARKS = /[ːˑ]/g;

/**
 * Map one phoneme symbol to a viseme. Stress/length marks are ignored; unknown symbols fall
 * back to their first character and finally to `rest`.
 */
export function phonemeToViseme(phoneme: string): Viseme {
  const cleaned = phoneme.replace(STRIP_MARKS, '');
  const direct = PHONEME_TO_VISEME[cleaned];
  if (direct) return direct;
  const noLength = cleaned.replace(LENGTH_MARKS, '').replace(/:$/, '');
  const second = PHONEME_TO_VISEME[noLength];
  if (second) return second;
  for (let len = Math.min(2, noLength.length); len >= 1; len -= 1) {
    const prefix = PHONEME_TO_VISEME[noLength.slice(0, len)];
    if (prefix && noLength.length > 0) return prefix;
  }
  return 'rest';
}

/**
 * Grapheme-based fallback used when a TTS provider returns no phoneme timing: letter → viseme.
 * Deliberately coarse; language-specific digraphs can be handled by the caller before lookup.
 */
export const LETTER_TO_VISEME: Readonly<Record<string, Viseme>> = {
  a: 'A',
  á: 'A',
  à: 'A',
  â: 'A',
  ä: 'A',
  ã: 'A',
  e: 'E',
  é: 'E',
  è: 'E',
  ê: 'E',
  ë: 'E',
  i: 'I',
  í: 'I',
  î: 'I',
  ï: 'I',
  y: 'I',
  o: 'O',
  ó: 'O',
  ô: 'O',
  ö: 'O',
  õ: 'O',
  u: 'U',
  ú: 'U',
  û: 'U',
  ü: 'U',
  w: 'U',
  m: 'MBP',
  b: 'MBP',
  p: 'MBP',
  f: 'FV',
  v: 'FV',
  t: 'DT',
  d: 'DT',
  k: 'KG',
  g: 'KG',
  q: 'KG',
  c: 'KG',
  h: 'KG',
  x: 'KG',
  j: 'CHJ',
  s: 'SZ',
  z: 'SZ',
  ç: 'SZ',
  ß: 'SZ',
  n: 'NL',
  ñ: 'NL',
  l: 'NL',
  r: 'R',
};
