import { describe, expect, it } from 'vitest';
import { analyzeVoice, median, semitonesBetween } from './analysis';

type Wave = (phase: number) => number;

const sine: Wave = (phase) => Math.sin(2 * Math.PI * phase);
const sawtooth: Wave = (phase) => 2 * (phase % 1) - 1;
/** Harmonics 2…6 only: the fundamental itself is absent, as on a telephone line. */
const missingFundamental: Wave = (phase) =>
  [2, 3, 4, 5, 6].reduce((sum, h) => sum + Math.sin(2 * Math.PI * h * phase) / h, 0);
/** Voice-like: decaying harmonics, strong fundamental. */
const voiced: Wave = (phase) =>
  [1, 2, 3, 4, 5, 6, 7, 8].reduce(
    (sum, h) => sum + Math.sin(2 * Math.PI * h * phase) / h ** 1.2,
    0,
  );

interface ToneOptions {
  hz: number | ((tSec: number) => number);
  seconds: number;
  sampleRate: number;
  wave?: Wave;
  /** Amplitude envelope 0..1 over time. */
  envelope?: (tSec: number) => number;
  amplitude?: number;
  int16?: boolean;
}

function tone(options: ToneOptions): Float32Array | Int16Array {
  const { seconds, sampleRate } = options;
  const count = Math.round(seconds * sampleRate);
  const wave = options.wave ?? sine;
  const amplitude = options.amplitude ?? 0.5;
  const out = options.int16 ? new Int16Array(count) : new Float32Array(count);
  let phase = 0;
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRate;
    const hz = typeof options.hz === 'function' ? options.hz(t) : options.hz;
    phase += hz / sampleRate;
    const value = amplitude * (options.envelope?.(t) ?? 1) * wave(phase);
    out[i] = options.int16 ? Math.round(value * 32767) : value;
  }
  return out;
}

/** Deterministic white noise (LCG), -1..1. */
function noise(seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let state = 12345;
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state / 2 ** 31 - 1;
  }
  return out;
}

/** "Syllables": raised-cosine bursts at `rate` per second. */
const syllables = (rate: number) => (t: number) => 0.5 - 0.5 * Math.cos(2 * Math.PI * rate * t);

describe('analyzeVoice — fundamental frequency', () => {
  it.each([
    [70, 16_000],
    [110, 16_000],
    [147, 22_050],
    [220, 22_050],
    [220, 44_100],
    [330, 48_000],
    [440, 8000],
  ])('measures a %d Hz sine at %d Hz sampling within 1 %%', (hz, sampleRate) => {
    const analysis = analyzeVoice(tone({ hz, seconds: 3, sampleRate }), sampleRate);
    expect(analysis.medianF0Hz).not.toBeNull();
    expect(Math.abs((analysis.medianF0Hz ?? 0) / hz - 1)).toBeLessThan(0.01);
    expect(analysis.voicedSec).toBeGreaterThan(2.5);
    expect(analysis.durationSec).toBeCloseTo(3, 1);
  });

  it('finds the pitch of harmonically rich tones, not one of their harmonics', () => {
    for (const wave of [sawtooth, voiced, missingFundamental]) {
      for (const hz of [95, 130, 210, 280]) {
        const analysis = analyzeVoice(tone({ hz, seconds: 2, sampleRate: 22_050, wave }), 22_050);
        expect(Math.abs(semitonesBetween(hz, analysis.medianF0Hz ?? 1))).toBeLessThan(0.3);
      }
    }
  });

  it('is independent of level and sample format', () => {
    const quiet = analyzeVoice(
      tone({ hz: 180, seconds: 2, sampleRate: 16_000, amplitude: 0.01 }),
      16_000,
    );
    const loud = analyzeVoice(
      tone({ hz: 180, seconds: 2, sampleRate: 16_000, amplitude: 0.9, int16: true }),
      16_000,
    );
    expect(quiet.medianF0Hz).toBeCloseTo(180, 0);
    expect(loud.medianF0Hz).toBeCloseTo(180, 0);
  });

  it('takes the median of a moving pitch (glide and vibrato)', () => {
    const glide = analyzeVoice(
      tone({ hz: (t) => 120 + 20 * t, seconds: 4, sampleRate: 16_000, wave: voiced }), // 120 → 200 Hz
      16_000,
    );
    expect(glide.medianF0Hz).toBeGreaterThan(150);
    expect(glide.medianF0Hz).toBeLessThan(170);
    const vibrato = analyzeVoice(
      tone({
        hz: (t) => 200 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t)),
        seconds: 3,
        sampleRate: 16_000,
        wave: voiced,
      }),
      16_000,
    );
    expect(Math.abs(semitonesBetween(200, vibrato.medianF0Hz ?? 1))).toBeLessThan(0.35);
  });

  it('ignores silence around the voice and reports how much was voiced', () => {
    const samples = new Float32Array(16_000 * 6);
    samples.set(
      tone({ hz: 140, seconds: 2, sampleRate: 16_000, wave: voiced }) as Float32Array,
      16_000 * 2,
    );
    const analysis = analyzeVoice(samples, 16_000);
    expect(analysis.medianF0Hz).toBeCloseTo(140, 0);
    expect(analysis.voicedSec).toBeGreaterThan(1.7);
    expect(analysis.voicedSec).toBeLessThan(2.2);
    expect(analysis.speakingSec).toBeLessThan(2.4);
    expect(analysis.durationSec).toBeCloseTo(6, 1);
  });

  it('survives noise on top of the voice', () => {
    const clean = tone({
      hz: 125,
      seconds: 3,
      sampleRate: 16_000,
      wave: voiced,
      amplitude: 0.3,
    }) as Float32Array;
    const hiss = noise(3, 16_000);
    const noisy = clean.map((value, i) => value + 0.05 * (hiss[i] ?? 0));
    expect(
      Math.abs(semitonesBetween(125, analyzeVoice(noisy, 16_000).medianF0Hz ?? 1)),
    ).toBeLessThan(0.3);
  });

  it('finds no pitch in noise, silence or nothing', () => {
    expect(analyzeVoice(noise(3, 16_000), 16_000).medianF0Hz).toBeNull();
    const silence = analyzeVoice(new Int16Array(48_000), 16_000);
    expect(silence).toMatchObject({
      medianF0Hz: null,
      syllablesPerSec: null,
      voicedSec: 0,
      speakingSec: 0,
    });
    expect(silence.durationSec).toBeCloseTo(3, 5);
    expect(analyzeVoice(new Float32Array(0), 16_000)).toMatchObject({
      medianF0Hz: null,
      durationSec: 0,
    });
    expect(analyzeVoice(new Float32Array(100), 0).medianF0Hz).toBeNull();
    // Too short to be sure.
    expect(
      analyzeVoice(tone({ hz: 200, seconds: 0.15, sampleRate: 16_000 }), 16_000).medianF0Hz,
    ).toBeNull();
  });
});

describe('analyzeVoice — articulation rate', () => {
  it.each([3, 4, 5, 6])('counts %d syllable-like bursts per second', (rate) => {
    const analysis = analyzeVoice(
      tone({ hz: 150, seconds: 6, sampleRate: 16_000, wave: voiced, envelope: syllables(rate) }),
      16_000,
    );
    expect(analysis.syllablesPerSec).not.toBeNull();
    expect(Math.abs((analysis.syllablesPerSec ?? 0) - rate)).toBeLessThan(rate * 0.12);
    expect(analysis.medianF0Hz).toBeCloseTo(150, 0);
  });

  it('does not count pauses as speaking time', () => {
    // 2 s of speech at 4 syllables per second, 2 s of silence, 2 s of speech.
    const envelope = (t: number) => (t % 4 < 2 ? syllables(4)(t) : 0);
    const analysis = analyzeVoice(
      tone({ hz: 180, seconds: 8, sampleRate: 16_000, wave: voiced, envelope }),
      16_000,
    );
    expect(analysis.speakingSec).toBeGreaterThan(3.4);
    expect(analysis.speakingSec).toBeLessThan(4.6);
    expect(Math.abs((analysis.syllablesPerSec ?? 0) - 4)).toBeLessThan(0.6);
  });

  it('reports no rate for a steady tone or too little speech', () => {
    expect(
      analyzeVoice(
        tone({ hz: 150, seconds: 0.6, sampleRate: 16_000, envelope: syllables(4) }),
        16_000,
      ).syllablesPerSec,
    ).toBeNull();
    const steady = analyzeVoice(tone({ hz: 150, seconds: 4, sampleRate: 16_000 }), 16_000);
    expect(steady.syllablesPerSec === null || steady.syllablesPerSec < 0.6).toBe(true);
  });
});

describe('helpers', () => {
  it('semitonesBetween and median', () => {
    expect(semitonesBetween(110, 220)).toBeCloseTo(12, 9);
    expect(semitonesBetween(200, 100)).toBeCloseTo(-12, 9);
    expect(semitonesBetween(100, 100 * 2 ** (1 / 12))).toBeCloseTo(1, 9);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
