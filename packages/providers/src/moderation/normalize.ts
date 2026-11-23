/* -------------------------------------------------------------------------------------------
 * Text normalisation for the local blocklist. The goal is to defeat the cheap evasions
 * (accents, case, leetspeak, stretched letters, letters separated by dots or spaces) without
 * turning innocent words into matches: terms are always compared as WHOLE words or phrases.
 * ----------------------------------------------------------------------------------------- */

/** `ñ` must survive diacritic stripping: "año" (year) is not "ano", "coño" is not "cono". */
const ENYE_PLACEHOLDER = '\u0001';

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
};

const LEET_CHARS = /[0134578@$!]/u;

function stripDiacritics(text: string): string {
  return text
    .replace(/ñ/g, ENYE_PLACEHOLDER)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replaceAll(ENYE_PLACEHOLDER, 'ñ')
    .replace(/ß/g, 'ss');
}

/**
 * Replace leetspeak characters, but only inside tokens that MIX letters with them ("p0rn",
 * "sh1t", "@ss"): plain numbers ("2024", "18") and trailing punctuation ("hola!") stay as they
 * are.
 */
function unleet(text: string): string {
  return text.replace(/[\p{L}\p{N}@$!]+/gu, (token) => {
    if (!LEET_CHARS.test(token) || !/\p{L}/u.test(token)) return token;
    // Trailing "!" / "$" are punctuation, not letters ("hola!!", "100$").
    const body = token.replace(/[!$]+$/u, '');
    if (!LEET_CHARS.test(body)) return body;
    // A token that is mostly digits is a quantity with a unit ("1080p", "4k"), not a word.
    const letters = body.replace(/[^\p{L}]/gu, '').length;
    if (letters * 2 < body.length) return body;
    return [...body].map((ch) => LEET[ch] ?? ch).join('');
  });
}

/** Lowercase, accent-free, punctuation-free text with single spaces. */
function baseNormalize(text: string, leet: boolean): string {
  const lowered = stripDiacritics(text.toLowerCase());
  const mapped = leet ? unleet(lowered) : lowered;
  return mapped
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "f u c k" / "f.u.c.k" → "fuck": joins runs of three or more single-letter tokens. */
function joinSpelledOut(text: string): string {
  return text.replace(/(?:^| )((?:\p{L} ){2,}\p{L})(?= |$)/gu, (match, run: string) => {
    const lead = match.startsWith(' ') ? ' ' : '';
    return lead + run.replace(/ /g, '');
  });
}

/** "fuuuuck" → "fuck" (`keep` = 1) or "asss" → "ass" (`keep` = 2). Only runs of 3+ change. */
function squeezeRuns(text: string, keep: 1 | 2): string {
  return text.replace(/(\p{L})\1{2,}/gu, (_run, ch: string) => ch.repeat(keep));
}

/**
 * Every variant of `text` a blocklist term is searched in. All of them are lowercase,
 * accent-free and space separated; duplicates are removed.
 */
export function normalizedVariants(text: string): string[] {
  const variants = new Set<string>();
  for (const leet of [false, true]) {
    const base = baseNormalize(text, leet);
    if (base === '') continue;
    variants.add(base);
    const joined = joinSpelledOut(base);
    variants.add(joined);
    for (const keep of [1, 2] as const) {
      variants.add(squeezeRuns(base, keep));
      variants.add(squeezeRuns(joined, keep));
    }
  }
  return [...variants];
}

/** Normalise ONE blocklist term the same way as the text it is compared with. */
export function normalizeTerm(term: string): string {
  return baseNormalize(term, false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile terms into one whole-word matcher over normalised text.
 *  - `porn*`        prefix: matches "porn", "porno", "pornography"
 *  - `kill yourself` phrase: the words in sequence
 * Returns null when the list is empty.
 */
export function compileTerms(terms: readonly string[]): RegExp | null {
  const alternatives: string[] = [];
  for (const raw of terms) {
    const prefix = raw.endsWith('*');
    const term = normalizeTerm(prefix ? raw.slice(0, -1) : raw);
    if (term === '') continue;
    // The space inside a phrase is optional: "killyourself" (also what a spelled-out
    // "k i l l  y o u r s e l f" collapses to) still matches `kill yourself`.
    const body = term.split(' ').map(escapeRegExp).join(' ?');
    alternatives.push(body + (prefix ? '[\\p{L}\\p{N}]*' : ''));
  }
  if (alternatives.length === 0) return null;
  // Longest first so that phrases win over their first word.
  alternatives.sort((a, b) => b.length - a.length);
  return new RegExp(`(?:^| )(?:${alternatives.join('|')})(?= |$)`, 'u');
}

/** True when any variant of the text contains a term of the compiled list. */
export function matchesAny(variants: readonly string[], matcher: RegExp | null): boolean {
  if (!matcher) return false;
  return variants.some((variant) => matcher.test(variant));
}
