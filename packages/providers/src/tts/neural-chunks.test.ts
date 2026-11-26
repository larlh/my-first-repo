import { describe, expect, it } from 'vitest';
import { planChunks, segmentUnits } from './neural-chunks';
import type { SpeechChunk, TokenUnit, VoiceAlphabet } from './neural-chunks';
import type { SpokenWord } from './neural-phonemes';
import { PARAGRAPH_PAUSE_MS, SENTENCE_PAUSE_MS, prepareSpeech } from './text';

/** A transparent alphabet: one symbol per phoneme, marks kept as they are. */
const alphabet: VoiceAlphabet = {
  word: (phonemes) => [...phonemes],
  marks: (marks) => [...marks].filter((mark) => ',.;:!?…—'.includes(mark)),
  space: ' ',
};

/**
 * Spoken words of a text as if eSpeak had pronounced one phoneme per letter, pausing after
 * every token that ends in punctuation (`pauses` overrides it per token index).
 */
function unitsOf(text: string, pauses: Record<number, number> = {}): TokenUnit[] {
  const prepared = prepareSpeech(text);
  const units: TokenUnit[] = [];
  for (const segment of prepared.segments) {
    const tokens = new Set<number>();
    for (const index of segment.map) {
      if (index < 0) continue;
      const token = prepared.tokens.findIndex((t) => t.start <= index && index < t.end);
      if (token >= 0) tokens.add(token);
    }
    const words: SpokenWord[] = [...tokens].map((token) => {
      const written = prepared.tokens[token]?.text ?? '';
      return {
        token,
        phonemes: [...written.replace(/[^\p{L}\p{N}]/gu, '')],
        pauseAfterMs: pauses[token] ?? (/[.,;:!?…]$/.test(written) ? 250 : 0),
      };
    });
    units.push(...segmentUnits(prepared, words, alphabet, segment.pauseAfterMs));
  }
  return units;
}

const said = (chunk: SpeechChunk) => chunk.symbols.map((symbol) => symbol.text).join('');

describe('token units', () => {
  it('lays a token out as its phonemes plus the marks eSpeak paused at', () => {
    const units = unitsOf('Hola, mundo.');
    expect(units.map((unit) => unit.symbols.map((s) => s.text).join(''))).toEqual([
      'Hola,',
      'mundo.',
    ]);
    expect(units.map((unit) => unit.boundary)).toEqual(['clause', 'sentence']);
    expect(units[0]?.symbols.map((symbol) => symbol.role)).toEqual([
      'speech',
      'speech',
      'speech',
      'speech',
      'silent',
    ]);
  });

  it('does not turn the dot of an abbreviation into a pause', () => {
    // eSpeak makes no pause after "Dr." (token 0): its dot must not reach the model.
    const units = unitsOf('Dr. Ana vino.', { 0: 0 });
    expect(units[0]?.symbols.map((s) => s.text).join('')).toBe('Dr');
    expect(units[0]?.boundary).toBe('');
    expect(units[2]?.boundary).toBe('sentence');
  });

  it('marks an explicit break as a pause that does not follow the speed', () => {
    const units = unitsOf('Uno dos tres.', { 0: 1500 });
    expect(units[0]).toMatchObject({ hardPauseMs: 1500, hardPauseScales: false });
    expect(units[1]).toMatchObject({ hardPauseMs: 0 });
  });

  it('carries the paragraph pause on the last token of the segment', () => {
    const units = unitsOf('Primero.\n\nSegundo.');
    expect(units.map((unit) => unit.hardPauseMs)).toEqual([PARAGRAPH_PAUSE_MS, 0]);
  });
});

describe('chunk planning', () => {
  const text = 'Una frase corta. Otra frase corta. Y la tercera frase.';

  it('packs whole sentences up to the target size', () => {
    const chunks = planChunks(unitsOf(text), alphabet, { targetSymbols: 40, maxSymbols: 400 });
    expect(chunks.map(said)).toEqual(['Una frase corta. Otra frase corta.', 'Y la tercera frase.']);
    expect(chunks.map((chunk) => chunk.pauseAfterMs)).toEqual([SENTENCE_PAUSE_MS, 0]);
  });

  it('speaks one sentence per chunk when the voice wants that', () => {
    const chunks = planChunks(unitsOf(text), alphabet, { targetSymbols: 1, maxSymbols: 400 });
    expect(chunks.map(said)).toEqual([
      'Una frase corta.',
      'Otra frase corta.',
      'Y la tercera frase.',
    ]);
    expect(chunks.map((chunk) => chunk.pauseAfterMs)).toEqual([
      SENTENCE_PAUSE_MS,
      SENTENCE_PAUSE_MS,
      0,
    ]);
  });

  it('keeps a short text in a single inference', () => {
    const chunks = planChunks(unitsOf(text), alphabet, { targetSymbols: 200, maxSymbols: 400 });
    expect(chunks).toHaveLength(1);
    expect(said(chunks[0] as SpeechChunk)).toBe(text);
  });

  it('always cuts at a paragraph and keeps its longer pause', () => {
    const chunks = planChunks(unitsOf('Uno. Dos.\n\nTres.'), alphabet, {
      targetSymbols: 200,
      maxSymbols: 400,
    });
    expect(chunks.map(said)).toEqual(['Uno. Dos.', 'Tres.']);
    expect(chunks[0]).toMatchObject({ pauseAfterMs: PARAGRAPH_PAUSE_MS, pauseScales: true });
  });

  it('cuts at an explicit break with exactly that pause', () => {
    const chunks = planChunks(unitsOf('Uno dos tres.', { 0: 1500 }), alphabet, {
      targetSymbols: 200,
      maxSymbols: 400,
    });
    expect(chunks.map(said)).toEqual(['Uno', 'dos tres.']);
    expect(chunks[0]).toMatchObject({ pauseAfterMs: 1500, pauseScales: false });
  });

  it('splits a sentence that does not fit at a comma, else at a space', () => {
    const policy = { targetSymbols: 30, maxSymbols: 30 };
    const withComma = 'aaaa bbbb cccc dddd, eeee ffff gggg hhhh iiii jjjj.';
    const atComma = planChunks(unitsOf(withComma), alphabet, policy);
    expect(atComma.map(said)).toEqual(['aaaa bbbb cccc dddd,', 'eeee ffff gggg hhhh iiii jjjj.']);
    expect(atComma[0]?.pauseAfterMs).toBeGreaterThan(0);
    // No comma in the second half of what fits: cut at a space, and no silence is invented.
    const plain = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk.';
    const atSpace = planChunks(unitsOf(plain), alphabet, policy);
    expect(atSpace.map(said)).toEqual([
      'aaaa bbbb cccc dddd eeee ffff',
      'gggg hhhh iiii jjjj kkkk.',
    ]);
    expect(atSpace[0]?.pauseAfterMs).toBe(0);
    for (const chunk of [...atComma, ...atSpace]) {
      expect(chunk.symbols.length).toBeLessThanOrEqual(30);
    }
  });

  it('never loses or repeats a symbol, whatever the budget', () => {
    const script =
      'Primera frase, con una coma. Segunda frase; con punto y coma. Tercera.\n\nOtro párrafo aquí.';
    const all = unitsOf(script).flatMap((unit) => unit.symbols.filter((s) => s.role === 'speech'));
    for (const maxSymbols of [12, 25, 60, 400]) {
      const chunks = planChunks(unitsOf(script), alphabet, {
        targetSymbols: maxSymbols,
        maxSymbols,
      });
      const spoken = chunks.flatMap((chunk) => chunk.symbols.filter((s) => s.role === 'speech'));
      expect(spoken.map((s) => s.text).join('')).toBe(all.map((s) => s.text).join(''));
      expect(chunks[chunks.length - 1]?.pauseAfterMs).toBe(0);
    }
  });

  it('returns nothing for a text in which nothing is pronounced', () => {
    expect(planChunks([], alphabet, { targetSymbols: 200, maxSymbols: 400 })).toEqual([]);
  });
});
