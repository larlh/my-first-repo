import { describe, expect, it } from 'vitest';
import { getEspeakEngine } from './espeak-engine';
import {
  closingPause,
  kokoroMarks,
  kokoroPhonemes,
  phonemizeSegment,
  piperSymbols,
  symbolShapes,
  tiePhoneme,
  tokenMarks,
} from './neural-phonemes';
import type { SpokenWord } from './neural-phonemes';
import { prepareSpeech } from './text';

/** Spoken words of a whole text with the REAL eSpeak NG (WebAssembly; no model involved). */
async function phonemize(text: string, voice: string) {
  const engine = await getEspeakEngine();
  const prepared = prepareSpeech(text);
  const words: SpokenWord[] = prepared.segments.flatMap((segment) =>
    phonemizeSegment(engine, prepared, segment, voice),
  );
  return { prepared, words };
}

const tokenText = (prepared: { tokens: { text: string }[] }, word: SpokenWord) =>
  prepared.tokens[word.token]?.text;

describe('eSpeak phonemes per display word', () => {
  it('gives every Spanish word its phonemes, stress marks included', async () => {
    const { prepared, words } = await phonemize('Hola, ¿qué tal?', 'es');
    expect(words.map((word) => tokenText(prepared, word))).toEqual(['Hola,', '¿qué', 'tal?']);
    expect(words.map((word) => word.phonemes.join(''))).toEqual(['ˈola', 'kˈe', 'tˈal']);
    // eSpeak pauses at the comma and at the end, not between "qué" and "tal".
    expect(words[0]?.pauseAfterMs).toBeGreaterThan(0);
    expect(words[1]?.pauseAfterMs).toBe(0);
    expect(words[2]?.pauseAfterMs).toBeGreaterThan(0);
  });

  it('keeps expanded numbers, signs and acronyms on the token that wrote them', async () => {
    const { prepared, words } = await phonemize(
      'El 23 de abril de 2024 la ONU aprobó el 15,5 % del plan (según la OTAN).',
      'es',
    );
    const spoken = new Map<string, string[]>();
    for (const word of words) {
      const key = tokenText(prepared, word) ?? '';
      spoken.set(key, [...(spoken.get(key) ?? []), word.phonemes.join('')]);
    }
    expect(spoken.get('23')).toEqual(['βˌeɪntitɾˈes']);
    expect(spoken.get('2024')).toEqual(['ðˈos', 'mˈil', 'βeɪntikwˈatɾo']);
    expect(spoken.get('ONU')).toEqual(['ˌoˌeneˈu']); // spelled out
    expect(spoken.get('15,5')).toEqual(['kˈinθe', 'kˌoma', 'θˈinko']);
    expect(spoken.get('%')).toEqual(['poɾθjˈɛnto']);
    expect(spoken.get('OTAN).')).toEqual(['ˈotan']); // read as a word
    expect(spoken.get('aprobó')).toEqual(['ˌapɾoβˈo']); // the written accent moves the stress
    // Every token that is pronounced appears, in order.
    const tokens = words.map((word) => word.token);
    expect(tokens).toEqual([...tokens].sort((a, b) => a - b));
    expect(new Set(tokens).size).toBe(prepared.tokens.length);
  });

  it('reads English abbreviations, currency and ordinals the way eSpeak expands them', async () => {
    const { prepared, words } = await phonemize('Dr. Smith paid $1,250 on May 3rd.', 'en-us');
    const of = (token: string) =>
      words.filter((word) => tokenText(prepared, word) === token).map((w) => w.phonemes.join(''));
    expect(of('Dr.')).toEqual(['dˈɑːktɚ']);
    expect(of('$1,250').join(' ')).toMatch(/dˈɑːlɚ/);
    expect(of('$1,250').join(' ')).toMatch(/θˈaʊzənd/);
    expect(of('3rd.')).toEqual(['θˈɜːd']);
  });

  it('reports a long explicit pause and drops language flags', async () => {
    const { words } = await phonemize('Uno <break time="1500ms"/> dos.', 'es');
    // After a pause the d is a stop again (no lenition): eSpeak's own rule.
    expect(words.map((word) => word.phonemes.join(''))).toEqual(['ˈuno', 'dˈos']);
    expect(words[0]?.pauseAfterMs).toBeGreaterThanOrEqual(1200);
    const mixed = await phonemize('El software funciona.', 'es');
    expect(mixed.words.flatMap((word) => word.phonemes).some((p) => p.startsWith('('))).toBe(false);
  });
});

describe('Kokoro alphabet (misaki symbols)', () => {
  it('ties the letters of one phoneme, as eSpeak --tie does', () => {
    expect(tiePhoneme('ˌeɪ')).toBe('ˌe^ɪ');
    expect(tiePhoneme('tʃ')).toBe('t^ʃ');
    expect(tiePhoneme('ɜː')).toBe('ɜː');
    expect(tiePhoneme('ɔ̃')).toBe('ɔ̃');
    expect(tiePhoneme('a')).toBe('a');
  });

  it('turns diphthongs and affricates of Spanish into single symbols', () => {
    expect(kokoroPhonemes(['β', 'ˌeɪ', 'n', 't', 'i'], 'other')).toBe('βˌAnti');
    expect(kokoroPhonemes(['m', 'u', 'tʃ', 'o'], 'other')).toBe('muʧo');
    expect(kokoroPhonemes(['ˈaɪ', 'ɾ', 'e'], 'other')).toBe('ˈIɾe');
    // Two separate vowels are NOT a diphthong.
    expect(kokoroPhonemes(['l', 'e', 'ˈi', 'ð', 'o'], 'other')).toBe('leˈiðo');
    // French liaison hyphen is dropped.
    expect(kokoroPhonemes(['l', 'e-', 'z'], 'other')).toBe('lez');
  });

  it('applies the English fallback table of misaki', () => {
    expect(kokoroPhonemes(['h', 'ə', 'l', 'ˈoʊ'], 'en-us')).toBe('həlˈO');
    expect(kokoroPhonemes(['ð', 'ˈɛɹ'], 'en-us')).toBe('ðˈɛɹ');
    expect(kokoroPhonemes(['p', 'ˈeɪ', 'd'], 'en-us')).toBe('pˈAd');
    expect(kokoroPhonemes(['d', 'ˈɑː', 'k', 't', 'ɚ'], 'en-us')).toBe('dˈɑktəɹ');
    expect(kokoroPhonemes(['θ', 'ˈɜː', 'd'], 'en-us')).toBe('θˈɜɹd');
    expect(kokoroPhonemes(['tʃ', 'ˈɜː', 'tʃ'], 'en-us')).toBe('ʧˈɜɹʧ');
    expect(kokoroPhonemes(['dʒ', 'ˈɔɪ'], 'en-us')).toBe('ʤˈY');
    expect(kokoroPhonemes(['n', 'ˈaʊ'], 'en-us')).toBe('nˈW');
    // British keeps length marks and has its own "go" diphthong.
    expect(kokoroPhonemes(['ɡ', 'ˈəʊ'], 'en-gb')).toBe('ɡˈQ');
    expect(kokoroPhonemes(['k', 'ˈɑː'], 'en-gb')).toBe('kˈɑː');
  });

  it('keeps only the punctuation Kokoro has symbols for', () => {
    expect(kokoroMarks('¿')).toBe('');
    expect(kokoroMarks('?»')).toBe('?”');
    expect(kokoroMarks('«')).toBe('“');
    expect(kokoroMarks(').')).toBe(').');
    expect(kokoroMarks('–')).toBe('—');
  });

  it('gives its own letters the right mouth shapes', () => {
    expect(symbolShapes('A')).toEqual(['E', 'I']);
    expect(symbolShapes('O')).toEqual(['O', 'U']);
    expect(symbolShapes('ʧ')).toEqual(['CHJ']);
    expect(symbolShapes('m')).toEqual(['MBP']);
    expect(symbolShapes('ˈ')).toEqual([]);
    expect(symbolShapes('aɪ')).toEqual(['A', 'I']); // a Piper diphthong symbol
  });
});

describe('Piper alphabet', () => {
  const known = new Set(['a', 'ɪ', 'aɪ', 'eɪ', 'e', 'ɔ', '̃', 'ˈ', 'ˌ', 'ː', 't', 'ʃ', ' ']);

  it('prefers the longest symbol a voice knows and decomposes accents', () => {
    expect(piperSymbols('ˈaɪ', known, 2)).toEqual(['ˈ', 'aɪ']);
    expect(piperSymbols('tʃ', known, 2)).toEqual(['t', 'ʃ']);
    expect(piperSymbols('ɔ̃', known, 2)).toEqual(['ɔ', '̃']);
    expect(piperSymbols('ã', new Set(['a', '̃']), 1)).toEqual(['a', '̃']);
  });

  it('drops what the voice has no symbol for', () => {
    expect(piperSymbols('ʘa', known, 2)).toEqual(['a']);
    // An older voice without diphthong symbols gets the two vowels.
    expect(piperSymbols('aɪ', new Set(['a', 'ɪ']), 1)).toEqual(['a', 'ɪ']);
  });
});

describe('marks of a display token', () => {
  it('separates opening and closing marks from the word', () => {
    expect(tokenMarks('¿qué')).toMatchObject({ leading: '¿', trailing: '' });
    expect(tokenMarks('OTAN).')).toMatchObject({ leading: '', trailing: ').' });
    expect(tokenMarks('«Hola»,')).toMatchObject({ leading: '«', trailing: '»,' });
    expect(tokenMarks('fin...')).toMatchObject({ trailing: '…' });
    expect(tokenMarks('15,5')).toMatchObject({ leading: '', trailing: '', onlyMarks: false });
    expect(tokenMarks('—')).toMatchObject({ onlyMarks: true });
  });

  it('names the strongest pause of a run of marks', () => {
    expect(closingPause(').')).toBe('.');
    expect(closingPause('»,')).toBe(',');
    expect(closingPause('?!')).toBe('?');
    expect(closingPause('…')).toBe('…');
    expect(closingPause('–')).toBe('—');
    expect(closingPause(')')).toBe('');
  });
});
