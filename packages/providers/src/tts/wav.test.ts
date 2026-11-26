import { describe, expect, it } from 'vitest';
import {
  concatPcm,
  decodeWav,
  encodeWav,
  isWav,
  pcm16FromBytes,
  resampleLinear,
  samplesToMs,
} from './wav';

function header(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Hand-built WAV with arbitrary format, an extra LIST chunk and optional bogus sizes. */
function buildWav(options: {
  format: number;
  bits: number;
  channels: number;
  sampleRate: number;
  data: Uint8Array;
  streamed?: boolean;
}): Uint8Array {
  const list = 12; // "LIST" + size + 4 bytes
  const out = new Uint8Array(12 + 24 + list + 8 + options.data.length);
  const view = new DataView(out.buffer);
  header(view, 0, 'RIFF');
  view.setUint32(4, options.streamed ? 0xffffffff : out.length - 8, true);
  header(view, 8, 'WAVE');
  header(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, options.format, true);
  view.setUint16(22, options.channels, true);
  view.setUint32(24, options.sampleRate, true);
  view.setUint32(28, (options.sampleRate * options.channels * options.bits) / 8, true);
  view.setUint16(32, (options.channels * options.bits) / 8, true);
  view.setUint16(34, options.bits, true);
  header(view, 36, 'LIST');
  view.setUint32(40, 4, true);
  header(view, 44, 'INFO');
  header(view, 48, 'data');
  view.setUint32(52, options.streamed ? 0xffffffff : options.data.length, true);
  out.set(options.data, 56);
  return out;
}

describe('wav helpers', () => {
  it('encodes a canonical PCM16 mono file and decodes it back', () => {
    const samples = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const wav = encodeWav(samples, 22_050);
    expect(wav.length).toBe(44 + 10);
    expect(isWav(wav)).toBe(true);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(22_050);
    expect(view.getUint16(34, true)).toBe(16);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(22_050);
    expect([...decoded.samples]).toEqual([...samples]);
  });

  it('an empty recording is still a valid WAV', () => {
    const wav = encodeWav(new Int16Array(0), 24_000);
    expect(wav.length).toBe(44);
    expect(decodeWav(wav).samples.length).toBe(0);
  });

  it('mixes stereo down, skips unknown chunks and reads streamed headers', () => {
    const data = new Uint8Array(8);
    const view = new DataView(data.buffer);
    view.setInt16(0, 1000, true); // L
    view.setInt16(2, 3000, true); // R
    view.setInt16(4, -500, true);
    view.setInt16(6, -1500, true);
    const wav = buildWav({
      format: 1,
      bits: 16,
      channels: 2,
      sampleRate: 48_000,
      data,
      streamed: true,
    });
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(48_000);
    expect([...decoded.samples]).toEqual([2000, -1000]);
  });

  it('reads 8-bit, 24-bit and float samples', () => {
    expect([
      ...decodeWav(
        buildWav({
          format: 1,
          bits: 8,
          channels: 1,
          sampleRate: 8000,
          data: Uint8Array.from([128, 255, 0]),
        }),
      ).samples,
    ]).toEqual([0, 32512, -32768]);
    expect([
      ...decodeWav(
        buildWav({
          format: 1,
          bits: 24,
          channels: 1,
          sampleRate: 8000,
          data: Uint8Array.from([0xff, 0x34, 0x12]),
        }),
      ).samples,
    ]).toEqual([0x1234]);
    const floats = new Uint8Array(8);
    new DataView(floats.buffer).setFloat32(0, 0.5, true);
    new DataView(floats.buffer).setFloat32(4, -2, true); // clipped
    expect([
      ...decodeWav(buildWav({ format: 3, bits: 32, channels: 1, sampleRate: 8000, data: floats }))
        .samples,
    ]).toEqual([16384, -32767]);
  });

  it('rejects what is not PCM WAV with UNPROCESSABLE', () => {
    expect(() => decodeWav(new TextEncoder().encode('ID3 definitely an mp3 file'))).toThrowError(
      expect.objectContaining({ code: 'UNPROCESSABLE' }),
    );
    const adpcm = buildWav({
      format: 2,
      bits: 4,
      channels: 1,
      sampleRate: 8000,
      data: new Uint8Array(4),
    });
    expect(() => decodeWav(adpcm)).toThrowError(expect.objectContaining({ code: 'UNPROCESSABLE' }));
    expect(isWav(new Uint8Array(4))).toBe(false);
  });

  it('converts raw PCM bytes, concatenates and measures', () => {
    expect([...pcm16FromBytes(Uint8Array.from([0x01, 0x00, 0xff, 0xff, 0x7f]))]).toEqual([1, -1]);
    expect([
      ...concatPcm([Int16Array.from([1, 2]), new Int16Array(0), Int16Array.from([3])]),
    ]).toEqual([1, 2, 3]);
    expect(samplesToMs(22_050, 22_050)).toBe(1000);
    expect(samplesToMs(11_025, 22_050)).toBe(500);
  });

  it('resamples by linear interpolation', () => {
    const ramp = Int16Array.from({ length: 100 }, (_, i) => i * 100);
    const half = resampleLinear(ramp, 0.5);
    expect(half.length).toBe(50);
    expect(half[10]).toBe(2000);
    const double = resampleLinear(ramp, 2);
    expect(double.length).toBe(200);
    expect(double[101]).toBe(5050);
    expect(resampleLinear(ramp, 1)).not.toBe(ramp);
    expect([...resampleLinear(ramp, 1)]).toEqual([...ramp]);
    expect(resampleLinear(ramp, 0).length).toBe(0);
  });
});
