import { AppError } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Minimal RIFF/WAVE helpers for the speech providers: every TTS result is PCM 16-bit mono WAV,
 * and STT / voice cloning receive that format from the worker.
 * ----------------------------------------------------------------------------------------- */

export interface PcmAudio {
  /** Mono samples, signed 16-bit. */
  samples: Int16Array;
  sampleRate: number;
}

const HEADER_BYTES = 44;

/**
 * Wrap mono PCM16 samples in a canonical 44-byte RIFF/WAVE header. The result owns a fresh
 * `ArrayBuffer` (never a shared one), which is what `Blob` / `fetch` bodies require.
 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(HEADER_BYTES + i * 2, samples[i] ?? 0, true);
  }
  return out;
}

/** Raw little-endian signed 16-bit PCM bytes → samples (a trailing odd byte is dropped). */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return fourCc(view, 0) === 'RIFF' && fourCc(view, 8) === 'WAVE';
}

/**
 * Decode a PCM WAV (8/16/24/32-bit integer or 32-bit float, any channel count) to mono PCM16.
 * Tolerates streamed files whose RIFF / data sizes are 0 or 0xFFFFFFFF (data runs to the end).
 * Throws `UNPROCESSABLE` for anything that is not a readable PCM WAV.
 */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  if (!isWav(bytes)) throw new AppError('UNPROCESSABLE', 'The audio is not a WAV file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCc(view, offset);
    const declared = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && declared >= 26 && body + 26 <= bytes.byteLength) {
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataStart = body;
      const available = bytes.byteLength - body;
      dataBytes = declared === 0 || declared > available ? available : declared;
      break;
    }
    offset = body + declared + (declared % 2);
  }
  const float = format === 3 && bits === 32;
  const integer = format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32);
  if (dataStart < 0 || channels < 1 || sampleRate < 1 || !(float || integer)) {
    throw new AppError('UNPROCESSABLE', 'Unsupported WAV file: PCM audio is required', {
      format,
      bits,
      channels,
    });
  }
  const bytesPerSample = bits / 8;
  const frameBytes = bytesPerSample * channels;
  const frames = Math.floor(dataBytes / frameBytes);
  const samples = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      const at = dataStart + frame * frameBytes + ch * bytesPerSample;
      if (float) sum += Math.max(-1, Math.min(1, view.getFloat32(at, true))) * 32767;
      else if (bits === 16) sum += view.getInt16(at, true);
      else if (bits === 8) sum += (view.getUint8(at) - 128) * 256;
      else if (bits === 24) sum += view.getInt16(at + 1, true);
      else sum += view.getInt16(at + 2, true);
    }
    samples[frame] = Math.round(sum / channels);
  }
  return { samples, sampleRate };
}

/** Milliseconds of `sampleCount` samples at `sampleRate` (rounded to the nearest integer). */
export function samplesToMs(sampleCount: number, sampleRate: number): number {
  return Math.round((sampleCount * 1000) / sampleRate);
}

/** Concatenate PCM blocks into one array. */
export function concatPcm(blocks: readonly Int16Array[]): Int16Array {
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

/** Resample mono PCM16 by linear interpolation (speech-grade; used for small ratio changes). */
export function resampleLinear(samples: Int16Array, ratio: number): Int16Array {
  if (!(ratio > 0) || samples.length === 0) return new Int16Array(0);
  if (Math.abs(ratio - 1) < 1e-9) return samples.slice();
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Int16Array(length);
  const step = samples.length / length;
  for (let i = 0; i < length; i += 1) {
    const position = i * step;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index] ?? 0;
    const b = samples[Math.min(samples.length - 1, index + 1)] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}
