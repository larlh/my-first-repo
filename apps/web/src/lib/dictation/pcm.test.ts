import { describe, expect, it } from 'vitest';
import { StreamingResampler, encodeWav, floatToPcm16, levelOf, normalizeSegment, rms } from './pcm';
import { blocks, concat, tone } from './testing';

/** Amplitude of a sine at `hz` in a signal (single-bin DFT). */
function amplitudeAt(signal: Float32Array, hz: number, sampleRate: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i += 1) {
    const phase = (2 * Math.PI * hz * i) / sampleRate;
    re += (signal[i] ?? 0) * Math.cos(phase);
    im += (signal[i] ?? 0) * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / signal.length;
}

describe('StreamingResampler', () => {
  it('keeps a speech-band tone at the same level and frequency (48 kHz → 16 kHz)', () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    const output = resampler.process(tone(1000, 48_000, 0.5, 1000));
    // One second in → about one second out (minus the filter tail it still holds).
    expect(output.length).toBeGreaterThan(15_900);
    expect(output.length).toBeLessThanOrEqual(16_000);
    const steady = output.slice(800, 15_200);
    expect(amplitudeAt(steady, 1000, 16_000)).toBeCloseTo(0.5, 2);
    expect(amplitudeAt(steady, 3000, 16_000)).toBeLessThan(0.005);
  });

  it('removes what would alias: a 12 kHz tone does not survive into 16 kHz audio', () => {
    const resampler = new StreamingResampler(48_000, 16_000);
    const output = resampler.process(tone(500, 48_000, 0.5, 12_000));
    expect(rms(output.slice(400))).toBeLessThan(0.005);
  });

  it('gives the same samples whatever the size of the input blocks', () => {
    const signal = tone(300, 44_100, 0.4, 700);
    const whole = new StreamingResampler(44_100, 16_000).process(signal);
    const chunked = new StreamingResampler(44_100, 16_000);
    const pieces = blocks(signal, 2048).map((block) => chunked.process(block));
    const joined = concat(...pieces);
    expect(joined.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i += 97) {
      expect(joined[i]).toBeCloseTo(whole[i] ?? 0, 6);
    }
  });

  it('handles a non-integer ratio (44.1 kHz) with the right duration', () => {
    const output = new StreamingResampler(44_100, 16_000).process(tone(2000, 44_100));
    expect(Math.abs(output.length - 32_000)).toBeLessThan(40);
  });

  it('passes audio through untouched when the rates already match', () => {
    const signal = tone(50);
    const output = new StreamingResampler(16_000, 16_000).process(signal);
    expect(Array.from(output)).toEqual(Array.from(signal));
  });
});

describe('WAV encoding', () => {
  it('writes the canonical PCM 16-bit mono header the server expects', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
    const view = new DataView(encodeWav(samples, 16_000));
    const text = (at: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(text(12)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.byteLength).toBe(44 + 12);
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
    expect(view.getInt16(44 + 2, true)).toBe(16384);
    expect(view.getInt16(44 + 6, true)).toBe(32767);
    // Out-of-range input is clipped, not wrapped.
    expect(view.getInt16(44 + 10, true)).toBe(32767);
  });

  it('converts floats to signed 16-bit symmetrically', () => {
    expect(Array.from(floatToPcm16(new Float32Array([-1, 0, 1])))).toEqual([-32768, 0, 32767]);
  });
});

describe('levels', () => {
  it('measures RMS and maps speech levels onto a usable meter', () => {
    expect(rms(tone(100, 16_000, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(levelOf(0)).toBe(0);
    expect(levelOf(1)).toBe(1);
    expect(levelOf(0.001)).toBeLessThan(0.05);
    const quietVoice = levelOf(0.02);
    const loudVoice = levelOf(0.2);
    expect(quietVoice).toBeGreaterThan(0.3);
    expect(loudVoice).toBeGreaterThan(quietVoice);
  });

  it('raises a quiet phrase with a bounded gain and leaves a loud one alone', () => {
    const quiet = tone(100, 16_000, 0.05);
    const raised = normalizeSegment(quiet);
    expect(Math.max(...raised)).toBeCloseTo(0.2, 2); // capped at 4×
    const medium = normalizeSegment(tone(100, 16_000, 0.4));
    expect(Math.max(...medium)).toBeCloseTo(0.89, 2);
    const loud = tone(100, 16_000, 0.95);
    expect(normalizeSegment(loud)).toBe(loud);
    const silent = new Float32Array(100);
    expect(normalizeSegment(silent)).toBe(silent);
  });
});
