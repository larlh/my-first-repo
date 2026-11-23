import { describe, expect, it } from 'vitest';
import { clonedVoice, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import {
  SAMPLE_MAX_MS,
  SAMPLE_MIN_MS,
  countClonedVoices,
  durationProblem,
  encodeWav,
  mixToMono,
  samplesDurationMs,
} from './sample';

describe('voice sample', () => {
  it('applies the length rule of the API (10 s – 5 min)', () => {
    expect(durationProblem(null)).toBeNull();
    expect(durationProblem(SAMPLE_MIN_MS - 1)).toBe('tooShort');
    expect(durationProblem(SAMPLE_MIN_MS)).toBeNull();
    expect(durationProblem(SAMPLE_MAX_MS)).toBeNull();
    expect(durationProblem(SAMPLE_MAX_MS + 1)).toBe('tooLong');
  });

  it('mixes channels down to mono', () => {
    const left = new Float32Array([1, 0, -1, 0.5]);
    const right = new Float32Array([0, 0, -1, -0.5]);
    expect(Array.from(mixToMono([left, right]))).toEqual([0.5, 0, -1, 0]);
    expect(mixToMono([left])).toBe(left);
    expect(mixToMono([])).toHaveLength(0);
  });

  it('encodes a valid mono 16-bit PCM WAV', () => {
    const samples = new Float32Array([0, 1, -1, 0.5, 2, -2]);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav.buffer);
    const text = (offset: number, length: number) =>
      String.fromCharCode(...wav.slice(offset, offset + length));
    expect(wav.byteLength).toBe(44 + samples.length * 2);
    expect(text(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(text(8, 8)).toBe('WAVEfmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    const pcm = Array.from({ length: samples.length }, (_, i) => view.getInt16(44 + i * 2, true));
    // Full scale maps to the int16 limits and out-of-range input is clipped.
    expect(pcm).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
  });

  it('measures the length of PCM samples', () => {
    expect(samplesDurationMs(16000 * 12, 16000)).toBe(12_000);
    expect(samplesDurationMs(100, 0)).toBe(0);
  });

  it('counts cloned voices against the plan, ignoring failed and stock ones', () => {
    const voices = [
      stockVoice('es-f1', 'Carmen'),
      clonedVoice(1),
      clonedVoice(2, { status: 'processing' }),
      clonedVoice(3, { status: 'failed' }),
    ];
    expect(countClonedVoices(voices)).toBe(2);
  });
});
