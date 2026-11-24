import { describe, expect, it } from 'vitest';
import type { ProviderRef } from '@parlante/shared';
import { getEspeakEngine } from './espeak-engine';
import type { ChunkSymbol, VoiceAlphabet } from './neural-chunks';
import { closingPause } from './neural-phonemes';
import {
  MIN_SENTENCE_PAUSE_MS,
  snapWordsToSound,
  stretchSentencePauses,
  synthesizeNeural,
  toPcm16,
} from './neural-synth';
import type { ChunkAudio, VoiceBackend } from './neural-synth';
import { decodeWav } from './wav';

/*
 * The assembly of neural speech with a DOUBLE of the model: every symbol lasts a known time
 * and is rendered as a tone (speech) or as silence (spaces and marks). Phonemes come from the
 * real eSpeak NG. What is checked is everything around the model: chunking, trimming, pauses,
 * and that the timeline points at the audio that was really produced.
 */

const INFO: ProviderRef = { id: 'kokoro', name: 'Test voice', quality: 'premium', local: true };
const RATE = 16_000;
const SPEECH_MS = 60;
const SILENT_MS = 100;
const EDGE_MS = 200; // silence the fake model adds before and after, like the real ones

const alphabet: VoiceAlphabet = {
  // One symbol per sound: stress and length marks are left out of the double.
  word: (phonemes) => phonemes.flatMap((ipa) => [...ipa].filter((ch) => /\p{Ll}/u.test(ch))),
  marks: (marks, position) => {
    if (position === 'leading') return [];
    const closing = closingPause(marks);
    return closing === '' ? [] : [closing];
  },
  space: ' ',
};

interface Call {
  symbols: string;
  speed: number;
}

function fakeBackend(calls: Call[] = [], policy = { targetSymbols: 1, maxSymbols: 400 }) {
  const backend: VoiceBackend = {
    sampleRate: RATE,
    alphabet,
    policy,
    async speak(symbols: readonly ChunkSymbol[], speed: number): Promise<ChunkAudio> {
      calls.push({ symbols: symbols.map((symbol) => symbol.text).join(''), speed });
      const samplesOf = (ms: number) => Math.round((ms / speed) * (RATE / 1000));
      const bounds = new Float64Array(symbols.length + 1);
      let at = samplesOf(EDGE_MS);
      symbols.forEach((symbol, i) => {
        bounds[i] = at;
        at += samplesOf(symbol.role === 'speech' ? SPEECH_MS : SILENT_MS);
      });
      bounds[symbols.length] = at;
      const waveform = new Float32Array(at + samplesOf(EDGE_MS));
      symbols.forEach((symbol, i) => {
        if (symbol.role !== 'speech') return;
        for (let s = bounds[i] ?? 0; s < (bounds[i + 1] ?? 0); s += 1) {
          waveform[s] = 0.5 * Math.sin((2 * Math.PI * 220 * s) / RATE);
        }
      });
      return { waveform, bounds };
    },
  };
  return backend;
}

async function speak(
  text: string,
  options: { speed?: number; pitch?: number; calls?: Call[]; policy?: VoiceBackend['policy'] } = {},
) {
  const espeak = await getEspeakEngine();
  return synthesizeNeural(
    {
      text,
      espeakVoice: 'es',
      speed: options.speed ?? 1,
      pitchSemitones: options.pitch ?? 0,
      provider: INFO,
    },
    fakeBackend(options.calls, options.policy),
    espeak,
  );
}

/** True when the audio is silent in [fromMs, toMs). */
function silent(audio: Uint8Array, fromMs: number, toMs: number): boolean {
  const pcm = decodeWav(audio);
  const from = Math.round((fromMs * pcm.sampleRate) / 1000);
  const to = Math.round((toMs * pcm.sampleRate) / 1000);
  for (let i = from; i < Math.min(to, pcm.samples.length); i += 1) {
    if (Math.abs(pcm.samples[i] ?? 0) > 200) return false;
  }
  return true;
}

describe('neural speech assembly', () => {
  it('returns a WAV whose word cues spell the script and sit on the audio', async () => {
    const text = 'Hola, ¿qué tal? Muy bien.';
    const result = await speak(text);
    expect(result.provider).toEqual(INFO);
    expect(result.format).toBe('wav');
    expect(result.sampleRate).toBe(RATE);
    const pcm = decodeWav(result.audio);
    expect(Math.abs(result.durationMs - (pcm.samples.length * 1000) / RATE)).toBeLessThan(1);

    expect(result.words.map((word) => word.text).join(' ')).toBe(text);
    let previousEnd = 0;
    for (const word of result.words) {
      expect(word.tMs).toBeGreaterThanOrEqual(previousEnd);
      expect(word.durMs).toBeGreaterThan(0);
      previousEnd = word.tMs + word.durMs;
      // The word starts where sound starts: silence just before, sound just after.
      expect(silent(result.audio, word.tMs + 5, word.tMs + 25)).toBe(false);
    }
    expect(previousEnd).toBeLessThanOrEqual(result.durationMs);
    // "Hola," = three phonemes (the h is silent) of 60 ms.
    expect(result.words[0]).toMatchObject({ text: 'Hola,', durMs: 3 * SPEECH_MS });
  });

  it('gives each phoneme its mouth shape at the time the model pronounces it', async () => {
    const result = await speak('Mamá.');
    const first = result.words[0]?.tMs ?? 0;
    expect(result.visemes[0]).toEqual({ tMs: 0, viseme: 'rest' });
    const spoken = result.visemes.filter((cue) => cue.viseme !== 'rest');
    expect(spoken.map((cue) => cue.viseme)).toEqual(['MBP', 'A', 'MBP', 'A']);
    expect(spoken.map((cue) => cue.tMs - first)).toEqual([0, 60, 120, 180]);
    expect(result.visemes[result.visemes.length - 1]?.viseme).toBe('rest');
    for (let i = 1; i < result.visemes.length; i += 1) {
      expect(result.visemes[i]?.tMs).toBeGreaterThan(result.visemes[i - 1]?.tMs ?? 0);
    }
  });

  it('closes the mouth in the pauses the model makes inside a chunk', async () => {
    // One chunk (comma + space = 200 ms of silence in the double).
    const result = await speak('Sí, no.', { policy: { targetSymbols: 200, maxSymbols: 400 } });
    const [yes, no] = result.words;
    const rest = result.visemes.find(
      (cue) => cue.viseme === 'rest' && cue.tMs > (yes?.tMs ?? 0) && cue.tMs < (no?.tMs ?? 0),
    );
    expect(rest?.tMs).toBe((yes?.tMs ?? 0) + (yes?.durMs ?? 0));
    expect((no?.tMs ?? 0) - (rest?.tMs ?? 0)).toBe(2 * SILENT_MS);
  });

  it('trims the silence of the model at chunk edges and inserts its own pauses', async () => {
    const calls: Call[] = [];
    const result = await speak('Uno.\n\nDos.', { calls });
    expect(calls.map((call) => call.symbols)).toEqual(['uno.', 'dos.']);
    const [one, two] = result.words;
    const gap = (two?.tMs ?? 0) - ((one?.tMs ?? 0) + (one?.durMs ?? 0));
    // 70 ms kept after the last phoneme + the paragraph pause + 12 ms kept before the next:
    // not the 200 + 200 ms of silence the model put around each chunk.
    expect(gap).toBeGreaterThan(500);
    expect(gap).toBeLessThan(700);
    expect(silent(result.audio, (one?.tMs ?? 0) + (one?.durMs ?? 0) + 5, (two?.tMs ?? 0) - 5)).toBe(
      true,
    );
    // 40 ms of lead-in before the first word (plus the 12 ms kept).
    expect(one?.tMs).toBeGreaterThanOrEqual(40);
    expect(one?.tMs).toBeLessThanOrEqual(60);
  });

  it('asks the model for the speed and scales its own pauses with it', async () => {
    const normal = await speak('Uno.\n\nDos.');
    const calls: Call[] = [];
    const fast = await speak('Uno.\n\nDos.', { speed: 2, calls });
    expect(calls.every((call) => call.speed === 2)).toBe(true);
    expect(fast.durationMs).toBeLessThan(normal.durationMs * 0.7);
    expect(fast.words[0]?.durMs).toBe((normal.words[0]?.durMs ?? 0) / 2);
  });

  it('changes pitch by resampling and keeps the tempo and the timeline', async () => {
    const calls: Call[] = [];
    const flat = await speak('Hola mundo.');
    const high = await speak('Hola mundo.', { pitch: 4, calls });
    const k = 2 ** (4 / 12);
    // The model is asked to speak k times slower; resampling makes it k times shorter again.
    expect(calls[0]?.speed).toBeCloseTo(1 / k, 5);
    // (Only the few milliseconds kept around each chunk shrink with the resampling.)
    expect(Math.abs(high.durationMs - flat.durationMs)).toBeLessThan(25);
    expect(Math.abs((high.words[1]?.tMs ?? 0) - (flat.words[1]?.tMs ?? 0))).toBeLessThan(8);
    expect(silent(high.audio, (high.words[1]?.tMs ?? 0) + 5, (high.words[1]?.tMs ?? 0) + 25)).toBe(
      false,
    );
    // Beyond what resampling does cleanly the request is clamped (to 4 semitones).
    const calls12: Call[] = [];
    await speak('Hola mundo.', { pitch: 12, calls: calls12 });
    expect(calls12[0]?.speed).toBeCloseTo(1 / k, 5);
  });

  it('keeps an explicit break at its own length whatever the speed', async () => {
    const result = await speak('Uno <break time="1500ms"/> dos.', { speed: 2 });
    const [one, two] = result.words;
    const gap = (two?.tMs ?? 0) - ((one?.tMs ?? 0) + (one?.durMs ?? 0));
    expect(gap).toBeGreaterThan(1300);
  });

  it('returns a valid empty result for nothing pronounceable', async () => {
    for (const text of ['', '   ', '…', '—']) {
      const result = await speak(text);
      expect(result.durationMs).toBe(0);
      expect(result.words).toEqual([]);
      expect(result.visemes).toEqual([]);
      expect(decodeWav(result.audio).samples.length).toBe(0);
    }
  });

  it('keeps unspoken tokens (emoji, a lone dash) in the word cues', async () => {
    const text = 'Hola 👋 mundo — fin.';
    const result = await speak(text);
    expect(result.words.map((word) => word.text).join(' ')).toBe(text);
  });
});

describe('pause between sentences of one chunk', () => {
  const packed = { targetSymbols: 200, maxSymbols: 400 };

  it('is stretched to a natural minimum when the model hurries past the full stop', async () => {
    // The double gives "." + " " 200 ms of silence: less than the minimum.
    const result = await speak('Sí. No.', { policy: packed });
    const [yes, no] = result.words;
    const gap = (no?.tMs ?? 0) - ((yes?.tMs ?? 0) + (yes?.durMs ?? 0));
    expect(gap).toBe(MIN_SENTENCE_PAUSE_MS);
    // The added part is silence, and the word after it still sits on its sound.
    expect(silent(result.audio, (yes?.tMs ?? 0) + (yes?.durMs ?? 0) + 5, (no?.tMs ?? 0) - 5)).toBe(
      true,
    );
    expect(silent(result.audio, (no?.tMs ?? 0) + 5, (no?.tMs ?? 0) + 25)).toBe(false);
    // The mouth rests for the whole pause.
    const rest = result.visemes.find(
      (cue) => cue.viseme === 'rest' && cue.tMs > (yes?.tMs ?? 0) && cue.tMs < (no?.tMs ?? 0),
    );
    expect((no?.tMs ?? 0) - (rest?.tMs ?? 0)).toBe(MIN_SENTENCE_PAUSE_MS);
  });

  it('follows the speed, and leaves commas and long pauses to the model', async () => {
    const fast = await speak('Sí. No.', { policy: packed, speed: 2 });
    const [yes, no] = fast.words;
    expect((no?.tMs ?? 0) - ((yes?.tMs ?? 0) + (yes?.durMs ?? 0))).toBe(MIN_SENTENCE_PAUSE_MS / 2);
    // A comma is not a sentence end: the 200 ms of the double stay.
    const comma = await speak('Sí, no.', { policy: packed });
    expect(
      (comma.words[1]?.tMs ?? 0) - ((comma.words[0]?.tMs ?? 0) + (comma.words[0]?.durMs ?? 0)),
    ).toBe(2 * SILENT_MS);
  });

  it('never inserts silence into a run that is not silent, and keeps positions exact', () => {
    const symbols: ChunkSymbol[] = [
      { text: 'a', token: 0, role: 'speech' },
      { text: '.', token: 0, role: 'silent' },
      { text: ' ', token: 1, role: 'silent' },
      { text: 'b', token: 1, role: 'speech' },
    ];
    const bounds = Float64Array.of(0, 1600, 2400, 3200, 4800);
    const tone = (silence: boolean) => {
      const waveform = new Float32Array(4800);
      for (let i = 0; i < waveform.length; i += 1) {
        const inPause = i >= 1600 && i < 3200;
        waveform[i] = inPause && silence ? 0 : 0.5 * Math.sin(i / 5);
      }
      return waveform;
    };
    // 100 ms of real silence, 260 ms wanted: 160 ms (2560 samples) go into the pause.
    const quiet = stretchSentencePauses({ waveform: tone(true), bounds }, symbols, 4160, RATE);
    expect(quiet.waveform.length).toBe(4800 + 2560);
    expect([...quiet.bounds]).toEqual([0, 1600, 4960, 5760, 7360]);
    expect(quiet.waveform[quiet.bounds[3] ?? 0]).toBeCloseTo(tone(true)[3200] ?? 0, 6);
    // The model kept making sound through the "pause": nothing is cut open.
    const loud = { waveform: tone(false), bounds };
    expect(stretchSentencePauses(loud, symbols, 4160, RATE)).toBe(loud);
    // Already long enough.
    const enough = { waveform: tone(true), bounds };
    expect(stretchSentencePauses(enough, symbols, 1600, RATE)).toBe(enough);
  });
});

describe('word starts on the real sound', () => {
  // A model without a silence symbol: "a b" where the first phoneme of each word is said to
  // start at once, but the sound only comes `lead` ms later.
  const symbols: ChunkSymbol[] = [
    { text: 'a', token: 0, role: 'speech' },
    { text: 'a', token: 0, role: 'speech' },
    { text: ' ', token: 1, role: 'silent' },
    { text: 'b', token: 1, role: 'speech' },
  ];
  const ms = (value: number) => Math.round((value * RATE) / 1000);
  function chunk(leadMs: number, tailSilenceMs = 0): ChunkAudio {
    // a: 0–300 (sound from `lead`), a: 300–400, space: 400–450, b: 450–800 (sound from 450+lead)
    const bounds = Float64Array.from([0, 300, 400, 450, 800].map(ms));
    const waveform = new Float32Array(ms(800));
    const sound = (fromMs: number, toMs: number) => {
      for (let i = ms(fromMs); i < ms(toMs); i += 1) waveform[i] = 0.5 * Math.sin(i / 3);
    };
    sound(leadMs, 400);
    sound(450 + leadMs, 800 - tailSilenceMs);
    return { waveform, bounds };
  }
  const startsMs = (audio: ChunkAudio) =>
    [...audio.bounds].map((b) => Math.round((b * 1000) / RATE));

  it('moves a word that begins with a long silence to just before its first sound', () => {
    const snapped = snapWordsToSound(chunk(150), symbols, RATE);
    // Both words: 150 ms of silence, 40 ms of anticipation kept.
    expect(startsMs(snapped)).toEqual([110, 300, 400, 560, 800]);
    // The silence went to the pause before the second word: the space now lasts 160 ms.
    expect((snapped.bounds[3] ?? 0) - (snapped.bounds[2] ?? 0)).toBe(ms(160));
  });

  it('leaves alone what a stop closure explains, and audio that was already aligned', () => {
    const closure = chunk(50);
    expect(snapWordsToSound(closure, symbols, RATE)).toBe(closure);
    const aligned = chunk(0);
    expect(snapWordsToSound(aligned, symbols, RATE)).toBe(aligned);
  });

  it('never moves a start past the next phoneme of the word: the phonemes before it collapse', () => {
    // 340 ms of silence: longer than the whole first phoneme (300 ms).
    const snapped = snapWordsToSound(chunk(340), symbols, RATE);
    expect(startsMs(snapped).slice(0, 3)).toEqual([300, 300, 400]);
  });

  it('ends the last word where its sound ends', () => {
    const snapped = snapWordsToSound(chunk(0, 200), symbols, RATE);
    // Sound stops at 600 ms; 40 ms of release are kept.
    expect(startsMs(snapped)).toEqual([0, 300, 400, 450, 640]);
  });

  it('puts the cue of a sentence that starts late on its sound, through the whole pipeline', async () => {
    const calls: Call[] = [];
    const backend = fakeBackend(calls);
    const speak = backend.speak.bind(backend);
    // The double hides 150 ms of silence inside the first phoneme of every chunk.
    backend.speak = async (chunkSymbols, speed, signal) => {
      const audio = await speak(chunkSymbols, speed, signal);
      const first = chunkSymbols.findIndex((symbol) => symbol.role === 'speech');
      const from = Math.round(audio.bounds[first] ?? 0);
      audio.waveform.fill(0, from, from + ms(150));
      return audio;
    };
    const espeak = await getEspeakEngine();
    const result = await synthesizeNeural(
      { text: 'Aaaaa.', espeakVoice: 'es', speed: 1, pitchSemitones: 0, provider: INFO },
      backend,
      espeak,
    );
    const start = result.words[0]?.tMs ?? 0;
    // Silence right up to 40 ms before the sound, sound 40 ms after the cue.
    expect(silent(result.audio, start - 30, start + 30)).toBe(true);
    expect(silent(result.audio, start + 45, start + 65)).toBe(false);
    // The hidden silence was trimmed with the rest of the lead-in, not kept as a late start.
    expect(start).toBeLessThanOrEqual(60);
  });
});

describe('PCM conversion', () => {
  it('fades both ends so that a cut is never a click, and clips instead of wrapping', () => {
    const pcm = toPcm16(new Float32Array(1600).fill(0.5), RATE);
    expect(pcm[0]).toBe(0);
    expect(pcm[pcm.length - 1]).toBe(0);
    expect(pcm[800]).toBe(16384);
    // The level rises over 4 ms (64 samples here), not in one step.
    expect(Math.abs((pcm[10] ?? 0) - (pcm[9] ?? 0))).toBeLessThan(400);
    expect(pcm[32]).toBeLessThan(pcm[800] ?? 0);
    // Out-of-range samples are clipped, never wrapped around.
    const hot = toPcm16(
      Float32Array.of(0, 0, 0, 0, 5, -5, 0, 0, 0, 0).map((v, i) => (i < 1 ? 0 : v)),
      1000,
    );
    expect(Math.max(...hot)).toBeLessThanOrEqual(32767);
    expect(Math.min(...hot)).toBeGreaterThanOrEqual(-32767);
  });
});
