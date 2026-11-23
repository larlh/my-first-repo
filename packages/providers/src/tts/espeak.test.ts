import { beforeAll, describe, expect, it } from 'vitest';
import {
  LANGUAGE_CODES,
  LOCAL_VOICES,
  LocaleSchema,
  VISEMES,
  VOICE_PREVIEW_TEXTS,
  VoiceIdSchema,
  makeStockVoiceId,
} from '@parlante/shared';
import type { TTSRequest, TTSResult } from '@parlante/shared';
import { analyzeVoice } from '../voice-clone/analysis';
import { providerEnvSchema } from '../env';
import { createEspeakProvider, phonemeShapes, planPitch } from './espeak';
import { getEspeakEngine } from './espeak-engine';
import { ESPEAK_VOICES } from './espeak-voices';
import { decodeWav } from './wav';

const tts = createEspeakProvider(providerEnvSchema.parse({}));

function say(text: string, overrides: Partial<TTSRequest> = {}): Promise<TTSResult> {
  return tts.synthesize({
    text,
    providerVoiceId: 'es-f1',
    language: 'es',
    speed: 1,
    pitch: 0,
    ...overrides,
  });
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function medianF0(result: TTSResult): number {
  const pcm = decodeWav(result.audio);
  const f0 = analyzeVoice(pcm.samples, pcm.sampleRate).medianF0Hz;
  expect(f0).not.toBeNull();
  return f0 ?? 0;
}

const semitones = (from: number, to: number) => 12 * Math.log2(to / from);

/** Every guarantee of `TTSResult`, plus audio / visemes / words agreeing with each other. */
function expectConsistent(result: TTSResult, text: string) {
  // ---- audio: a real PCM16 mono WAV whose length is `durationMs`
  expect(result.format).toBe('wav');
  expect(result.provider).toEqual({
    id: 'espeak',
    name: 'eSpeak NG (local)',
    quality: 'basic',
    local: true,
  });
  const view = new DataView(result.audio.buffer, result.audio.byteOffset, result.audio.byteLength);
  expect(new TextDecoder().decode(result.audio.subarray(0, 4))).toBe('RIFF');
  expect(view.getUint16(20, true)).toBe(1); // PCM
  expect(view.getUint16(22, true)).toBe(1); // mono
  expect(view.getUint16(34, true)).toBe(16); // bits
  expect(view.getUint32(24, true)).toBe(result.sampleRate);
  const pcm = decodeWav(result.audio);
  expect(pcm.sampleRate).toBe(result.sampleRate);
  expect(result.audio.byteLength).toBe(44 + pcm.samples.length * 2);
  expect(result.durationMs).toBe(Math.round((pcm.samples.length * 1000) / pcm.sampleRate));
  expect(rms(pcm.samples)).toBeGreaterThan(300); // not silence

  // ---- visemes: sorted, strictly increasing, inside the audio, rest at both ends
  const { visemes, words, durationMs } = result;
  expect(visemes.length).toBeGreaterThan(2);
  expect(visemes[0]).toEqual({ tMs: 0, viseme: 'rest' });
  expect(visemes.at(-1)?.viseme).toBe('rest');
  visemes.forEach((cue, i) => {
    expect(VISEMES).toContain(cue.viseme);
    expect(Number.isInteger(cue.tMs)).toBe(true);
    expect(cue.tMs).toBeGreaterThanOrEqual(0);
    expect(cue.tMs).toBeLessThanOrEqual(durationMs);
    const previous = visemes[i - 1];
    if (previous) {
      expect(cue.tMs).toBeGreaterThan(previous.tMs);
      expect(cue.viseme).not.toBe(previous.viseme);
    }
  });

  // ---- words: sorted, inside the audio, spelling the whole text
  expect(words.length).toBeGreaterThan(0);
  expect(words.map((w) => w.text).join(' ')).toBe(text.replace(/\s+/g, ' ').trim());
  words.forEach((word, i) => {
    expect(Number.isInteger(word.tMs)).toBe(true);
    expect(Number.isInteger(word.durMs)).toBe(true);
    expect(word.durMs).toBeGreaterThan(0);
    expect(word.tMs + word.durMs).toBeLessThanOrEqual(durationMs);
    const previous = words[i - 1];
    if (previous) expect(word.tMs).toBeGreaterThanOrEqual(previous.tMs + previous.durMs);
  });

  // ---- they agree: the mouth moves during every word, is closed before the first one and
  // after the last one, and the audio ends shortly after the speech does.
  const firstWord = words[0];
  const lastWord = words.at(-1);
  if (!firstWord || !lastWord) return;
  for (const word of words) {
    const during = visemes.filter(
      (cue) => cue.viseme !== 'rest' && cue.tMs >= word.tMs - 30 && cue.tMs < word.tMs + word.durMs,
    );
    expect(during.length, `no mouth shape during "${word.text}"`).toBeGreaterThan(0);
  }
  const firstShape = visemes.find((cue) => cue.viseme !== 'rest');
  expect(firstShape?.tMs).toBeGreaterThanOrEqual(firstWord.tMs - 1);
  const speechEnd = lastWord.tMs + lastWord.durMs;
  const finalRest = visemes.at(-1)?.tMs ?? 0;
  expect(Math.abs(finalRest - speechEnd)).toBeLessThanOrEqual(120);
  expect(durationMs - speechEnd).toBeGreaterThanOrEqual(100);
  expect(durationMs - speechEnd).toBeLessThanOrEqual(400);
  // The audio really is quiet after the last word and loud inside the words.
  const at = (ms: number) => Math.round((ms * pcm.sampleRate) / 1000);
  expect(rms(pcm.samples.subarray(at(speechEnd + 60)))).toBeLessThan(120);
  expect(rms(pcm.samples.subarray(at(firstWord.tMs), at(speechEnd)))).toBeGreaterThan(800);
}

/**
 * Same speech, allowing for eSpeak's run-to-run jitter (it keeps oscillator state between
 * utterances, so identical requests differ by a few milliseconds — see espeak-engine.ts).
 */
function expectSameSpeech(a: TTSResult, b: TTSResult) {
  expect(a.words.map((w) => w.text)).toEqual(b.words.map((w) => w.text));
  expect(Math.abs(a.durationMs - b.durationMs)).toBeLessThanOrEqual(
    Math.max(40, b.durationMs * 0.015),
  );
  expect(Math.abs(a.visemes.length - b.visemes.length)).toBeLessThanOrEqual(3);
  a.words.forEach((word, i) => {
    expect(Math.abs(word.tMs - (b.words[i]?.tMs ?? 0))).toBeLessThanOrEqual(
      Math.max(40, b.durationMs * 0.015),
    );
  });
}

beforeAll(async () => {
  await getEspeakEngine(); // load the WebAssembly module once (≈ 0.5 s)
});

describe('eSpeak voices', () => {
  it('lists the frozen contract voices first, unchanged', async () => {
    const voices = await tts.listVoices();
    expect(voices.slice(0, LOCAL_VOICES.length).map((v) => v.providerVoiceId)).toEqual(
      LOCAL_VOICES.map((v) => v.providerVoiceId),
    );
    for (const def of LOCAL_VOICES) {
      const voice = voices.find((v) => v.providerVoiceId === def.providerVoiceId);
      expect(voice).toMatchObject({ name: def.name, language: def.language, gender: def.gender });
    }
  });

  it('covers every product language with a female and a male voice, plus accents', async () => {
    const voices = await tts.listVoices();
    const ids = voices.map((v) => v.providerVoiceId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const code of LANGUAGE_CODES) {
      const own = voices.filter((v) => v.language.slice(0, 2) === code);
      expect(
        own.some((v) => v.gender === 'female'),
        code,
      ).toBe(true);
      expect(
        own.some((v) => v.gender === 'male'),
        code,
      ).toBe(true);
    }
    expect(new Set(voices.map((v) => v.language.slice(0, 2))).size).toBeGreaterThanOrEqual(8);
    expect(voices.map((v) => v.language)).toEqual(
      expect.arrayContaining(['es-MX', 'en-GB', 'pt-BR']),
    );
    for (const voice of voices) {
      expect(LocaleSchema.safeParse(voice.language).success).toBe(true);
      expect(
        VoiceIdSchema.safeParse(makeStockVoiceId('espeak', voice.providerVoiceId)).success,
      ).toBe(true);
      expect(voice.languages).toBeUndefined(); // a local voice is one language
      expect(voice.description).toMatch(/local/i);
      expect(voice.tags).toContain('local');
      expect(voice.name.length).toBeGreaterThan(1);
    }
  });

  it('every voice exists in the engine and speaks', async () => {
    const engine = await getEspeakEngine();
    expect(engine.hasVoice('en-gb')).toBe(false); // a language tag, not a loadable voice
    for (const def of ESPEAK_VOICES) {
      expect(engine.hasVoice(def.espeakVoice), def.espeakVoice).toBe(true);
      const result = await say('Uno, dos, tres.', {
        providerVoiceId: def.providerVoiceId,
        language: def.language,
      });
      expect(result.durationMs, def.providerVoiceId).toBeGreaterThan(600);
      expect(result.words).toHaveLength(3);
    }
  });

  it('female voices are higher than male voices, and second timbres differ', async () => {
    const text = VOICE_PREVIEW_TEXTS.es ?? '';
    const f0 = async (id: string) => medianF0(await say(text, { providerVoiceId: id }));
    const [f1, m1, f2, m2] = [
      await f0('es-f1'),
      await f0('es-m1'),
      await f0('es-f2'),
      await f0('es-m2'),
    ];
    expect(f1).toBeGreaterThan(175);
    expect(f1).toBeLessThan(240);
    expect(m1).toBeGreaterThan(90);
    expect(m1).toBeLessThan(135);
    expect(f2).toBeLessThan(f1 - 8);
    expect(f2).toBeGreaterThan(150);
    expect(m2).toBeLessThan(m1 - 5);
  });

  it('rejects unknown voices with NOT_FOUND', async () => {
    await expect(say('Hola', { providerVoiceId: 'xx-f9' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('eSpeak synthesis', () => {
  it.each(LANGUAGE_CODES.map((code) => [code] as const))(
    'speaks %s: valid WAV, plausible length, consistent timelines',
    async (code) => {
      const text = VOICE_PREVIEW_TEXTS[code] ?? '';
      expect(text.length).toBeGreaterThan(20);
      for (const gender of ['f1', 'm1']) {
        const result = await say(text, { providerVoiceId: `${code}-${gender}`, language: code });
        expectConsistent(result, text);
        expect(result.sampleRate).toBe(22_050);
        // Natural speech runs at roughly 12–20 characters per second.
        const msPerChar = result.durationMs / text.length;
        expect(msPerChar).toBeGreaterThan(40);
        expect(msPerChar).toBeLessThan(95);
        // Measured, not estimated: about one mouth shape per phoneme.
        expect(result.visemes.length).toBeGreaterThan(text.replace(/\s/g, '').length * 0.5);
      }
    },
  );

  it('produces the phonetically right mouth shapes for Spanish', async () => {
    const shapes = async (text: string) => (await say(text)).visemes.map((cue) => cue.viseme);
    expect(await shapes('Hola mundo')).toEqual([
      'rest',
      'O',
      'NL',
      'A',
      'MBP',
      'U',
      'NL',
      'DT',
      'O',
      'rest',
    ]);
    expect(await shapes('mamá')).toEqual(['rest', 'MBP', 'A', 'MBP', 'A', 'rest']);
    expect(await shapes('fe')).toEqual(['rest', 'FV', 'E', 'rest']);
    // Castilian "z" is dental (θ); "ch" is postalveolar; "rr" a trill.
    expect(await shapes('zapato chico')).toEqual([
      'rest',
      'TH',
      'A',
      'MBP',
      'A',
      'DT',
      'O',
      'CHJ',
      'I',
      'KG',
      'O',
      'rest',
    ]);
    const perro = await shapes('perro');
    expect(perro).toEqual(['rest', 'MBP', 'E', 'R', 'O', 'rest']);
  });

  it('splits diphthongs and skips language markers', () => {
    expect(phonemeShapes('')).toEqual(['rest']);
    expect(phonemeShapes('(en)')).toEqual([]);
    expect(phonemeShapes('ˈa')).toEqual(['A']);
    expect(phonemeShapes('aɪ')).toEqual(['A', 'I']);
    expect(phonemeShapes('ˈɔɪ')).toEqual(['O', 'I']);
    expect(phonemeShapes('tʃ')).toEqual(['CHJ']);
    expect(phonemeShapes('tɕ')).toEqual(['CHJ']);
    expect(phonemeShapes('ts')).toEqual(['SZ']);
    expect(phonemeShapes('pf')).toEqual(['MBP', 'FV']);
    expect(phonemeShapes('ɑːɹ')).toEqual(['A', 'R']);
    expect(phonemeShapes('ɔ̃')).toEqual(['O']);
    expect(phonemeShapes('tʲ')).toEqual(['DT']);
    expect(phonemeShapes('ʋ')).toEqual(['FV']);
    expect(phonemeShapes('ɯ')).toEqual(['I']);
    expect(phonemeShapes('ʲ')).toEqual([]);
  });

  it('times the words: pauses at punctuation separate them, the mouth rests in the pause', async () => {
    const result = await say('Hola mundo, ¿qué tal estás hoy?');
    expectConsistent(result, 'Hola mundo, ¿qué tal estás hoy?');
    const [hola, mundo, que] = result.words;
    expect(result.words.map((w) => w.text)).toEqual([
      'Hola',
      'mundo,',
      '¿qué',
      'tal',
      'estás',
      'hoy?',
    ]);
    expect(hola?.tMs).toBe(40); // the lead-in
    expect(mundo && hola && mundo.tMs).toBe((hola?.tMs ?? 0) + (hola?.durMs ?? 0));
    // The comma: a gap of silence between "mundo," and "¿qué", with a rest cue inside it.
    const gapStart = (mundo?.tMs ?? 0) + (mundo?.durMs ?? 0);
    const gapEnd = que?.tMs ?? 0;
    expect(gapEnd - gapStart).toBeGreaterThan(80);
    expect(
      result.visemes.some(
        (cue) => cue.viseme === 'rest' && cue.tMs >= gapStart - 5 && cue.tMs < gapEnd,
      ),
    ).toBe(true);
  });

  it('honours speed', async () => {
    const text = VOICE_PREVIEW_TEXTS.es ?? '';
    const normal = await say(text);
    const fast = await say(text, { speed: 2 });
    const slow = await say(text, { speed: 0.5 });
    expectConsistent(fast, text);
    expectConsistent(slow, text);
    expect(fast.durationMs / normal.durationMs).toBeGreaterThan(0.45);
    expect(fast.durationMs / normal.durationMs).toBeLessThan(0.65);
    expect(slow.durationMs / normal.durationMs).toBeGreaterThan(1.8);
    expect(slow.durationMs / normal.durationMs).toBeLessThan(2.2);
    // Out-of-range and invalid values are clamped, not errors.
    const clamped = await say(text, { speed: 50 });
    expect(Math.abs(clamped.durationMs - fast.durationMs)).toBeLessThan(40);
    expect((await say(text, { speed: Number.NaN })).durationMs).toBe(normal.durationMs);
  });

  it('honours pitch over the whole -12…+12 range without changing the pace', async () => {
    const text = VOICE_PREVIEW_TEXTS.es ?? '';
    const base = await say(text);
    const baseF0 = medianF0(base);
    for (const pitch of [-12, -8, -4, 4, 8, 12]) {
      const shifted = await say(text, { pitch });
      expectConsistent(shifted, text);
      expect(semitones(baseF0, medianF0(shifted)), `pitch ${pitch}`).toBeGreaterThan(pitch - 0.8);
      expect(semitones(baseF0, medianF0(shifted)), `pitch ${pitch}`).toBeLessThan(pitch + 0.8);
      expect(shifted.durationMs / base.durationMs).toBeGreaterThan(0.93);
      expect(shifted.durationMs / base.durationMs).toBeLessThan(1.07);
      expect(shifted.words).toHaveLength(base.words.length);
    }
  });

  it('plans pitch: native parameter inside its range, resampling for the rest', () => {
    expect(planPitch(0)).toEqual({ parameter: 50, resample: 1 });
    expect(planPitch(4).resample).toBe(1);
    expect(planPitch(4).parameter).toBeGreaterThan(70);
    expect(planPitch(-5).resample).toBe(1);
    expect(planPitch(12).resample).toBeCloseTo(2 ** (4 / 12), 6);
    expect(planPitch(-12).resample).toBeCloseTo(2 ** (-6 / 12), 6);
    expect(planPitch(Number.NaN)).toEqual({ parameter: 50, resample: 1 });
    expect(planPitch(99)).toEqual(planPitch(16));
  });

  it('applies a local voice profile on top of speed and pitch', async () => {
    const text = VOICE_PREVIEW_TEXTS.es ?? '';
    const base = await say(text, { providerVoiceId: 'es-m1' });
    const profiled = await say(text, {
      providerVoiceId: 'es-m1',
      profile: { baseVoiceId: 'es-m1', pitchSemitones: 5, speed: 1.25, meanF0Hz: 150 },
    });
    expectConsistent(profiled, text);
    expect(semitones(medianF0(base), medianF0(profiled))).toBeGreaterThan(4.2);
    expect(semitones(medianF0(base), medianF0(profiled))).toBeLessThan(5.8);
    expect(profiled.durationMs / base.durationMs).toBeGreaterThan(0.74);
    expect(profiled.durationMs / base.durationMs).toBeLessThan(0.88);
    // The profile names the base voice even when the row's provider voice id is stale.
    const viaProfile = await say(text, {
      providerVoiceId: 'gone',
      profile: { baseVoiceId: 'es-m1', pitchSemitones: 0, speed: 1, meanF0Hz: null },
    });
    expectSameSpeech(viaProfile, base);
  });

  it('reads numbers, symbols and abbreviations as words of the language', async () => {
    const result = await say('Tengo 1.234 euros y el 50 % de descuento.');
    expectConsistent(result, 'Tengo 1.234 euros y el 50 % de descuento.');
    expect(result.words.map((w) => w.text)).toEqual([
      'Tengo',
      '1.234',
      'euros',
      'y',
      'el',
      '50',
      '%',
      'de',
      'descuento.',
    ]);
    const number = result.words[1];
    const short = result.words[3];
    // "mil doscientos treinta y cuatro" takes far longer than "y".
    expect(number?.durMs).toBeGreaterThan(1200);
    expect(short?.durMs).toBeLessThan(200);
    const german = await say('Am 3. Mai kostete es 15 €.', {
      providerVoiceId: 'de-m1',
      language: 'de',
    });
    expect(german.words.map((w) => w.text).join(' ')).toBe('Am 3. Mai kostete es 15 €.');
  });

  it('keeps unspoken tokens (emoji, dashes, markdown) in the word texts', async () => {
    const text = 'Hola 🙂 — **mundo** 🎉';
    const result = await say(text);
    expectConsistent(result, text);
    expect(result.words.map((w) => w.text)).toEqual(['Hola 🙂 —', '**mundo** 🎉']);
    // Markdown markers and emoji are not read aloud: as long as the clean text (the dash is
    // punctuation: it makes the same pause in both).
    const clean = await say('Hola — mundo');
    expect(Math.abs(result.durationMs - clean.durationMs)).toBeLessThan(60);
  });

  it('honours basic SSML and ignores unsafe markup', async () => {
    const plain = await say('Hola mundo.');
    const withBreak = await say('Hola <break time="700ms"/> mundo.');
    expect(withBreak.words.map((w) => w.text)).toEqual(['Hola', 'mundo.']);
    const extra = withBreak.durationMs - plain.durationMs;
    expect(extra).toBeGreaterThan(550);
    expect(extra).toBeLessThan(850);
    const gap =
      (withBreak.words[1]?.tMs ?? 0) -
      ((withBreak.words[0]?.tMs ?? 0) + (withBreak.words[0]?.durMs ?? 0));
    expect(gap).toBeGreaterThan(550);
    expectConsistent(withBreak, 'Hola mundo.');

    const unsafe = await say(
      'Hola <audio src="/etc/passwd"/><voice name="en">mundo</voice><script>alert(1)</script>.',
    );
    expect(unsafe.words.map((w) => w.text)).toEqual(['Hola', 'mundo.']);
    expect(Math.abs(unsafe.durationMs - plain.durationMs)).toBeLessThan(80);

    const spelled = await say('<say-as interpret-as="characters">ONU</say-as>');
    const read = await say('ONU');
    expect(spelled.words.map((w) => w.text)).toEqual(['ONU']);
    expect(spelled.durationMs).toBeGreaterThan(read.durationMs + 150);

    const literal = await say('5 < 7 & 7 > 5');
    expect(literal.words.map((w) => w.text).join(' ')).toBe('5 < 7 & 7 > 5');
  });

  it('handles long scripts: paragraphs, hundreds of words, strictly ordered cues', async () => {
    const paragraph = Array.from(
      { length: 25 },
      (_, i) => `Esta es la frase número ${i + 1} del guion, con sus pausas y sus cifras.`,
    ).join(' ');
    const text = [paragraph, paragraph, paragraph].join('\n\n');
    const started = performance.now();
    const result = await say(text);
    const elapsed = performance.now() - started;
    expectConsistent(result, text);
    expect(result.words).toHaveLength(text.split(/\s+/).length);
    expect(result.durationMs).toBeGreaterThan(200_000);
    expect(result.durationMs / text.length).toBeGreaterThan(45);
    expect(result.durationMs / text.length).toBeLessThan(95);
    // Hundreds of times faster than real time (generous bound for a loaded CI machine).
    expect(elapsed).toBeLessThan(result.durationMs / 10);
    // Paragraph breaks are longer pauses than sentence breaks.
    const index = paragraph.split(/\s+/).length; // first word of the second paragraph
    const before = result.words[index - 1];
    const after = result.words[index];
    const paragraphGap = (after?.tMs ?? 0) - ((before?.tMs ?? 0) + (before?.durMs ?? 0));
    expect(paragraphGap).toBeGreaterThan(450);
    expect(paragraphGap).toBeLessThan(900);
  });

  it('pronounces a text in its own language whatever the voice, keeping the timbre', async () => {
    const text = 'Three thieves think about that.';
    const viaSpanishVoice = await say(text, { providerVoiceId: 'es-f1', language: 'en-US' });
    const english = await say(text, { providerVoiceId: 'en-f1', language: 'en' });
    const wrong = await say(text, { providerVoiceId: 'es-f1', language: 'es' });
    expectSameSpeech(viaSpanishVoice, english);
    expect(Math.abs(semitones(medianF0(english), medianF0(viaSpanishVoice)))).toBeLessThan(0.5);
    // English rules say "th" with a dental; Spanish rules read a plain "t".
    expect(viaSpanishVoice.visemes.some((cue) => cue.viseme === 'TH')).toBe(true);
    expect(wrong.visemes.some((cue) => cue.viseme === 'TH')).toBe(false);
    // Regional accents: the voice's own accent when the language matches.
    const mexico = await say('Gracias por la cena', {
      providerVoiceId: 'es-mx-f1',
      language: 'es',
    });
    const spain = await say('Gracias por la cena', { providerVoiceId: 'es-f1', language: 'es' });
    expect(spain.visemes.some((cue) => cue.viseme === 'TH')).toBe(true); // "c" = θ
    expect(mexico.visemes.some((cue) => cue.viseme === 'TH')).toBe(false); // seseo
  });

  it('never makes a cue of a token during which nothing is pronounced', async () => {
    // eSpeak reports "words" for bare punctuation with no sound: they join a neighbour.
    const english = await say('? quick fox …… jumps', { providerVoiceId: 'en-f2', language: 'en' });
    expectConsistent(english, '? quick fox …… jumps');
    expect(english.words.map((w) => w.text)).toEqual(['? quick', 'fox ……', 'jumps']);
    const french = await say('Bonjour — ! … le monde', {
      providerVoiceId: 'fr-m1',
      language: 'fr',
    });
    expectConsistent(french, 'Bonjour — ! … le monde');
    expect(french.words[0]?.text).toBe('Bonjour — ! …');
  });

  it('returns an empty, valid result for text with nothing to say', async () => {
    for (const text of [
      ...['', '   ', '…', '— ¿? !', '<break time="2s"/>', '🙂'],
      '<say-as interpret-as="digits">……</say-as> .',
    ]) {
      const result = await say(text);
      expect(result.durationMs).toBe(0);
      expect(result.visemes).toEqual([]);
      expect(result.words).toEqual([]);
      expect(result.audio.byteLength).toBe(44);
      expect(decodeWav(result.audio).samples.length).toBe(0);
      expect(result.provider.id).toBe('espeak');
    }
  });

  it('is safe under concurrent calls: each request gets its own voice, speed and pitch', async () => {
    const requests: [string, Partial<TTSRequest>][] = [
      ['Hola, esto es una prueba de concurrencia.', { providerVoiceId: 'es-m1' }],
      [
        'This is a concurrency test, with numbers: 1, 2, 3.',
        { providerVoiceId: 'en-f1', language: 'en', speed: 1.3 },
      ],
      [
        'Ceci est un test.\n\nAvec deux paragraphes.',
        { providerVoiceId: 'fr-m1', language: 'fr', pitch: 10 },
      ],
      ['Das ist ein Test.', { providerVoiceId: 'de-f1', language: 'de', pitch: -3 }],
    ];
    const sequential: TTSResult[] = [];
    for (const [text, overrides] of requests) sequential.push(await say(text, overrides));
    const parallel = await Promise.all(requests.map(([text, overrides]) => say(text, overrides)));
    parallel.forEach((result, i) => {
      const reference = sequential[i];
      expect(reference).toBeDefined();
      if (reference) expectSameSpeech(result, reference);
      expectConsistent(result, requests[i]?.[0] ?? '');
    });
  });
});
