import type { Viseme } from '@parlante/shared';
import { displayIndex, phonemeShapes, tokenAt } from './espeak';
import { ESPEAK_NORMAL_WPM } from './espeak-engine';
import type { EspeakEngine } from './espeak-engine';
import type { PreparedSpeech, SpeechSegment } from './text';

/* -------------------------------------------------------------------------------------------
 * Text → phonemes for the local neural voices.
 *
 * Kokoro and Piper were both trained on the IPA that eSpeak NG writes, so the phonemes come
 * from the eSpeak NG the repository already ships (WebAssembly): one synthesis pass whose
 * audio is thrown away and whose EVENTS are kept. An event stream gives, for free, what the
 * plain "text to IPA" call of the library does not:
 *
 *   - the phonemes of each spoken word separately (eSpeak expands "2024", "15,5 %", "Dr."),
 *   - where in the text each spoken word comes from, so every phoneme belongs to a display
 *     token (the word cue the subtitles will show),
 *   - the pauses eSpeak makes, which is how an explicit `<break time="2s"/>` is found.
 *
 * Each model then needs its own alphabet:
 *   Kokoro   the symbols of misaki, its G2P library: diphthongs and affricates are single
 *            letters (eɪ → A, aɪ → I, tʃ → ʧ…). The tables below follow misaki 0.7.4
 *            (`misaki/espeak.py`, Apache-2.0): `EspeakG2P` for Spanish, French, Italian and
 *            Portuguese, `EspeakFallback` for English.
 *   Piper    eSpeak's IPA as it is, decomposed (NFD) into the symbols of the voice's own
 *            `phoneme_id_map`.
 * ----------------------------------------------------------------------------------------- */

export interface SpokenWord {
  /** Index of the display token (word cue) this spoken word belongs to. */
  token: number;
  /** eSpeak phonemes in IPA, stress marks included, one entry per phoneme event. */
  phonemes: string[];
  /** Silence eSpeak makes after this word at normal speed, in ms (0 = none). */
  pauseAfterMs: number;
}

/**
 * The spoken words of one prepared segment. `voice` is an eSpeak language voice (`es`,
 * `en-us`, `pt-br`…): it decides pronunciation, numbers and abbreviations.
 */
export function phonemizeSegment(
  engine: EspeakEngine,
  prepared: PreparedSpeech,
  segment: SpeechSegment,
  voice: string,
): SpokenWord[] {
  const utterance = engine.synthesize(segment.markup, {
    voice,
    rateWpm: ESPEAK_NORMAL_WPM,
    pitch: 50,
  });
  const endMs = (utterance.samples.length * 1000) / engine.sampleRate;
  const phonemeEvents = utterance.events.filter((event) => event.type === 'phoneme');
  const firstToken = firstTokenOf(prepared, segment);
  const words: SpokenWord[] = [];
  let current: SpokenWord | null = null;
  let phonemeIndex = 0;
  for (const event of utterance.events) {
    if (event.type === 'word') {
      const at = displayIndex(segment, event.textIndex);
      const previous: number = current?.token ?? firstToken;
      // Tokens never go backwards; a word inside markup only stays with its neighbour.
      const token = at >= 0 ? Math.max(previous, tokenAt(prepared, at)) : previous;
      current = { token, phonemes: [], pauseAfterMs: 0 };
      words.push(current);
      continue;
    }
    if (event.type !== 'phoneme') continue;
    const next = phonemeEvents[phonemeIndex + 1];
    phonemeIndex += 1;
    if (event.phoneme.startsWith('(')) continue; // language-switch flag such as "(en)"
    if (!current) {
      current = { token: firstToken, phonemes: [], pauseAfterMs: 0 };
      words.push(current);
    }
    if (event.phoneme === '') {
      current.pauseAfterMs += Math.max(0, (next?.tMs ?? endMs) - event.tMs);
    } else {
      current.phonemes.push(event.phoneme);
    }
  }
  // A "word" in which nothing is pronounced (a lone dash, "…") only passes its pause on.
  const spoken: SpokenWord[] = [];
  for (const word of words) {
    if (word.phonemes.length > 0) {
      spoken.push(word);
      continue;
    }
    const last = spoken[spoken.length - 1];
    if (last) last.pauseAfterMs += word.pauseAfterMs;
  }
  return spoken.map((word) => ({ ...word, pauseAfterMs: Math.round(word.pauseAfterMs) }));
}

/** First display token a segment speaks (0 when the segment maps to nothing). */
function firstTokenOf(prepared: PreparedSpeech, segment: SpeechSegment): number {
  for (const index of segment.map) {
    if (index >= 0) return tokenAt(prepared, index);
  }
  return 0;
}

/* ---------- punctuation of a display token ---------- */

const LEADING_MARKS = /^[¿¡"'«“”‘’([{<\-–—]+/u;
const TRAILING_MARKS = /[.,;:!?…"'»“”‘’)\]}>\-–—]+$/u;

export interface TokenMarks {
  /** Opening marks before the word (quotes, brackets, inverted marks), as written. */
  leading: string;
  /** Closing marks after it, as written (`...` already folded into `…`). */
  trailing: string;
  /** True when the token has no letter or digit at all (a lone dash, an ellipsis). */
  onlyMarks: boolean;
}

export function tokenMarks(text: string): TokenMarks {
  const folded = text.replace(/\.{3,}/g, '…');
  const onlyMarks = !/[\p{L}\p{N}]/u.test(folded);
  if (onlyMarks) return { leading: '', trailing: folded, onlyMarks };
  return {
    leading: LEADING_MARKS.exec(folded)?.[0] ?? '',
    trailing: TRAILING_MARKS.exec(folded)?.[0] ?? '',
    onlyMarks,
  };
}

/** The strongest pause mark of a run of closing marks: `.` `?` `!` `…` `:` `;` `,` `—` or ''. */
export function closingPause(trailing: string): '' | ',' | ';' | ':' | '.' | '?' | '!' | '…' | '—' {
  for (const mark of ['?', '!', '…', '.', ':', ';', ',', '—', '–'] as const) {
    if (trailing.includes(mark)) return mark === '–' ? '—' : mark;
  }
  return '';
}

/* ---------- Kokoro (misaki symbols) ---------- */

export type KokoroDialect = 'en-us' | 'en-gb' | 'other';

const byLongestKey = (a: readonly [string, string], b: readonly [string, string]) =>
  b[0].length - a[0].length;

/** misaki `EspeakG2P.E2M`: tied eSpeak phonemes → single misaki symbols. */
const KOKORO_GENERAL: readonly (readonly [string, string])[] = (
  [
    ['a^ɪ', 'I'],
    ['a^ʊ', 'W'],
    ['d^z', 'ʣ'],
    ['d^ʒ', 'ʤ'],
    ['e^ɪ', 'A'],
    ['o^ʊ', 'O'],
    ['ə^ʊ', 'Q'],
    ['s^s', 'S'],
    ['t^s', 'ʦ'],
    ['t^ʃ', 'ʧ'],
    ['ɔ^ɪ', 'Y'],
  ] as const
).toSorted(byLongestKey);

/** misaki `EspeakFallback.E2M` (English). */
const KOKORO_ENGLISH: readonly (readonly [string, string])[] = (
  [
    ['ʔˌn̩', 'tn'],
    ['ʔn̩', 'tn'],
    ['ʔn', 'tn'],
    ['ʔ', 't'],
    ['a^ɪ', 'I'],
    ['a^ʊ', 'W'],
    ['d^ʒ', 'ʤ'],
    ['e^ɪ', 'A'],
    ['e', 'A'],
    ['t^ʃ', 'ʧ'],
    ['ɔ^ɪ', 'Y'],
    ['ə^l', 'ᵊl'],
    ['ʲo', 'jo'],
    ['ʲə', 'jə'],
    ['ʲ', ''],
    ['ɚ', 'əɹ'],
    ['r', 'ɹ'],
    ['x', 'k'],
    ['ç', 'k'],
    ['ɐ', 'ə'],
    ['ɬ', 'l'],
    ['̃', ''],
  ] as const
).toSorted(byLongestKey);

const PLAIN_LETTER = /\p{L}/u;
const MODIFIER_LETTER = /\p{Lm}/u;

/**
 * eSpeak's `--tie` option, emulated on one phoneme: the letters of a multi-letter phoneme
 * (`tʃ`, `eɪ`) are joined with `^`, which is how misaki tells a diphthong from two vowels.
 */
export function tiePhoneme(ipa: string): string {
  let out = '';
  let previousLetter = false;
  for (const ch of ipa) {
    const letter = PLAIN_LETTER.test(ch) && !MODIFIER_LETTER.test(ch);
    if (letter && previousLetter) out += '^';
    out += ch;
    // Only two ADJACENT letters are tied: a length or stress mark between them breaks it.
    previousLetter = letter;
  }
  return out;
}

/** The phonemes of one spoken word in Kokoro's alphabet (not yet filtered by its vocabulary). */
export function kokoroPhonemes(phonemes: readonly string[], dialect: KokoroDialect): string {
  let ps = phonemes.map(tiePhoneme).join('');
  if (dialect === 'other') {
    for (const [from, to] of KOKORO_GENERAL) ps = ps.replaceAll(from, to);
    return ps.replaceAll('^', '').replaceAll('-', '');
  }
  for (const [from, to] of KOKORO_ENGLISH) ps = ps.replaceAll(from, to);
  // A syllabic consonant becomes a small schwa before it.
  ps = ps.replace(/(\S)̩/gu, 'ᵊ$1').replaceAll('̩', '');
  if (dialect === 'en-gb') {
    ps = ps.replaceAll('e^ə', 'ɛː').replaceAll('iə', 'ɪə').replaceAll('ə^ʊ', 'Q');
  } else {
    ps = ps
      .replaceAll('o^ʊ', 'O')
      .replaceAll('ɜːɹ', 'ɜɹ')
      .replaceAll('ɜː', 'ɜɹ')
      .replaceAll('ɪə', 'iə')
      .replaceAll('ː', '');
  }
  return ps.replaceAll('o', 'ɔ').replaceAll('^', '').replaceAll('-', '');
}

/** Marks of a display token Kokoro has symbols for. `«»` are folded into curly quotes. */
export function kokoroMarks(marks: string): string {
  let out = '';
  for (const ch of marks) {
    if (ch === '«') out += '“';
    else if (ch === '»') out += '”';
    else if (ch === '–') out += '—';
    else if (';:,.!?—…"()“”'.includes(ch)) out += ch;
  }
  return out;
}

/** Mouth shapes of the misaki letters the shared phoneme table does not know. */
const KOKORO_SHAPES: Readonly<Record<string, readonly Viseme[]>> = {
  A: ['E', 'I'],
  I: ['A', 'I'],
  O: ['O', 'U'],
  W: ['A', 'U'],
  Y: ['O', 'I'],
  Q: ['E', 'U'],
  S: ['SZ'],
  T: ['DT'],
  ʤ: ['CHJ'],
  ʧ: ['CHJ'],
  ʦ: ['SZ'],
  ʣ: ['SZ'],
  ᵊ: ['E'],
  ᵻ: ['I'],
};

/** Mouth shapes of one model symbol (a Kokoro letter or an IPA symbol of Piper). */
export function symbolShapes(symbol: string): Viseme[] {
  const own = KOKORO_SHAPES[symbol];
  return own ? [...own] : phonemeShapes(symbol);
}

/* ---------- Piper (eSpeak IPA, the voice's own symbol table) ---------- */

/**
 * Split the IPA of one eSpeak phoneme into symbols of a Piper voice: decomposed (NFD), longest
 * known symbol first (recent voices have one id for a whole diphthong), unknown symbols dropped.
 */
export function piperSymbols(ipa: string, known: ReadonlySet<string>, longest: number): string[] {
  const chars = [...ipa.normalize('NFD')];
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let matched = 0;
    for (let length = Math.min(longest, chars.length - i); length >= 1; length -= 1) {
      const candidate = chars.slice(i, i + length).join('');
      if (known.has(candidate)) {
        out.push(candidate);
        matched = length;
        break;
      }
    }
    i += Math.max(1, matched);
  }
  return out;
}
