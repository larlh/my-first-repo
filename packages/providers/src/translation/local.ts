import type {
  LanguageCode,
  ProviderRef,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
} from '@parlante/shared';
import { glossaryMaxWords, lookupGlossary } from './glossary';
import type { GlossaryEntry } from './glossary';

/* -------------------------------------------------------------------------------------------
 * Local translation ("modo básico"): glossary substitution plus a few rules. It is NOT a
 * translator — no grammar, agreement or word order — and it says so: `info.quality` is
 * `basic` and every result reports `coverage`, the share of words it could translate.
 * Words outside the glossary stay in the source language.
 *
 * What it guarantees (the pipeline depends on it):
 *  - one output per input, same order, so segment timings stay valid;
 *  - `{{variables}}`, numbers, time codes, URLs and e-mail addresses come out untouched;
 *  - punctuation and spacing are kept; Spanish opening marks (¿ ¡) are added or removed.
 * ----------------------------------------------------------------------------------------- */

const INFO: ProviderRef = {
  id: 'local',
  name: 'Traducción básica por glosario (local)',
  quality: 'basic',
  local: true,
};

type TokenKind = 'word' | 'protected' | 'other';
interface Token {
  kind: TokenKind;
  value: string;
}

/**
 * Order matters: placeholders, addresses, time codes and numbers are claimed before words.
 * Group 1 = protected, group 2 = word; anything else is copied character by character.
 */
const TOKEN = new RegExp(
  [
    '(\\{\\{[^{}]*\\}\\}', // {{variable}}
    '|https?:\\/\\/[^\\s<>"]+|www\\.[^\\s<>"]+', // URLs
    '|[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.\\p{L}{2,}', // e-mail
    '|\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,3})?', // 1:23, 00:01:02,500
    '|\\d+(?:[.,]\\d+)*(?:\\s?%)?[ºª°]?)', // 1.234,5  20 %  3º
    "|(\\p{L}+(?:['’-]\\p{L}+)*)", // words, with inner apostrophes and hyphens
  ].join(''),
  'gu',
);

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) tokens.push({ kind: 'other', value: text.slice(last, match.index) });
    tokens.push({ kind: match[1] !== undefined ? 'protected' : 'word', value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'other', value: text.slice(last) });
  return tokens;
}

function isUpper(text: string): boolean {
  return text.length > 1 && text === text.toUpperCase() && text !== text.toLowerCase();
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

interface Counts {
  words: number;
  translated: number;
}

function translateText(
  text: string,
  source: LanguageCode,
  target: LanguageCode,
  counts: Counts,
): string {
  const tokens = tokenize(text);
  const maxWords = glossaryMaxWords(source);
  let out = '';
  let sentenceStart = true;

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i]!;
    if (token.kind !== 'word') {
      out += token.value;
      if (token.kind === 'other') {
        // A sentence ends at . ! ? … followed by a space (and optional opening marks).
        if (/[.!?…]["'»”)\]]*\s+[¿¡"'«“([]*$/u.test(token.value)) sentenceStart = true;
      } else {
        sentenceStart = false;
      }
      i += 1;
      continue;
    }

    // Longest phrase first: words separated by exactly one space.
    let matched: { entry: GlossaryEntry; span: number; words: string[] } | null = null;
    const words: string[] = [token.value];
    const spans: number[] = [1];
    for (let j = i + 1; words.length < maxWords && j + 1 < tokens.length; j += 2) {
      const gap = tokens[j]!;
      const next = tokens[j + 1]!;
      if (gap.kind !== 'other' || gap.value !== ' ' || next.kind !== 'word') break;
      words.push(next.value);
      spans.push(j + 2 - i);
    }
    for (let n = words.length; n >= 1 && !matched; n -= 1) {
      const entry = lookupGlossary(source, words.slice(0, n).join(' '));
      if (entry?.target[target] !== undefined) {
        matched = { entry, span: spans[n - 1]!, words: words.slice(0, n) };
      }
    }

    if (!matched) {
      counts.words += 1;
      out += token.value;
      sentenceStart = false;
      i += 1;
      continue;
    }

    counts.words += matched.words.length;
    counts.translated += matched.words.length;
    let replacement = matched.entry.target[target]!;
    if (matched.words.every(isUpper)) replacement = replacement.toUpperCase();
    else if (sentenceStart && /^\p{Lu}/u.test(matched.words[0]!)) {
      // A sentence that started with a capital still does; lower-case input stays lower-case.
      replacement = capitalizeFirst(replacement);
    }
    out += replacement;
    sentenceStart = false;
    i += matched.span;
  }
  return fixSpanishMarks(out, source, target);
}

/** Spanish opens questions and exclamations with ¿ ¡; the other languages do not. */
function fixSpanishMarks(text: string, source: LanguageCode, target: LanguageCode): string {
  if (source === 'es' && target !== 'es') return text.replace(/[¿¡]/g, '');
  if (target !== 'es' || source === 'es') return text;
  const open = (sentence: string): string => {
    const ending = /[.!?…]+$/u.exec(sentence)?.[0] ?? '';
    const mark = ending.includes('?') ? '¿' : ending.includes('!') ? '¡' : null;
    if (!mark || /[¿¡]/u.test(sentence) || sentence.trim() === ending) return sentence;
    return sentence.replace(/^(\s*)/u, `$1${mark}`);
  };
  let out = '';
  let start = 0;
  // Sentence ends: punctuation followed by a space or the end ("1.299,50" is not one).
  for (const match of text.matchAll(/[.!?…]+(?=\s|$)/gu)) {
    const end = match.index + match[0].length;
    out += open(text.slice(start, end));
    start = end;
  }
  return out + text.slice(start);
}

/**
 * Local translation provider. See the header of this file for what "basic" means here.
 * `coverage` in the result is the share of words found in the glossary (1 when source and
 * target are the same language, or when there was nothing to translate).
 */
export function createLocalTranslationProvider(): TranslationProvider {
  return {
    info: INFO,
    async translate(request: TranslationRequest): Promise<TranslationResult> {
      if (request.sourceLanguage === request.targetLanguage) {
        return { texts: [...request.texts], provider: INFO, coverage: 1 };
      }
      const counts: Counts = { words: 0, translated: 0 };
      const texts = request.texts.map((text) =>
        translateText(text, request.sourceLanguage, request.targetLanguage, counts),
      );
      const coverage =
        counts.words === 0 ? 1 : Math.round((counts.translated / counts.words) * 1000) / 1000;
      return { texts, provider: INFO, coverage };
    },
  };
}
