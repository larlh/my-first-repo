/* -------------------------------------------------------------------------------------------
 * Minimal PCM helpers of the render job: reading the mono 16-bit WAVs the TTS providers
 * produce and writing the narration PADDED WITH SILENCE that the neural avatar engine animates.
 * ----------------------------------------------------------------------------------------- */

export interface MonoPcm {
  /** Signed 16-bit mono samples. */
  samples: Int16Array;
  sampleRate: number;
}

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * Parse a RIFF/WAVE file holding PCM 16-bit MONO audio (what every TTS provider returns).
 * Returns null for anything else (other codecs, stereo, truncated files): the caller then
 * decodes the file with ffmpeg instead.
 */
export function parseMonoPcm16Wav(bytes: Uint8Array): MonoPcm | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourCc(view, 0) !== 'RIFF' || fourCc(view, 8) !== 'WAVE') return null;
  let offset = 12;
  let sampleRate = 0;
  let formatOk = false;
  while (offset + 8 <= bytes.byteLength) {
    const id = fourCc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > bytes.byteLength) return null;
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      formatOk = format === 1 && channels === 1 && bits === 16 && sampleRate > 0;
      if (!formatOk) return null;
    } else if (id === 'data') {
      if (!formatOk) return null;
      // Streamed WAVs may declare 0 / 0xFFFFFFFF: take what is actually there.
      const available = bytes.byteLength - body;
      const length = Math.min(size === 0 || size === 0xffffffff ? available : size, available);
      const count = Math.floor(length / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(body + i * 2, true);
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Raw little-endian signed 16-bit PCM bytes → samples (a trailing odd byte is dropped). */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Mono PCM16 samples → canonical 44-byte-header WAV. Deterministic: same samples, same bytes. */
export function encodeMonoPcm16Wav(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) out.writeInt16LE(samples[i] ?? 0, 44 + i * 2);
  return out;
}

/** Sample rate of the silent clips animated for scenes without narration. */
export const SILENCE_SAMPLE_RATE = 22_050;

/**
 * Audio of a WHOLE scene for the avatar engine: `offsetMs` of silence, the first `speechMs` of
 * the narration, then silence up to `sceneMs` — so the clip covers the scene from its first to
 * its last frame (`AvatarClipSource.originMs: 0`). `narration: null` gives pure silence.
 */
export function sceneAudioWav(
  narration: MonoPcm | null,
  timing: { sceneMs: number; offsetMs: number; speechMs: number },
): Buffer {
  const sampleRate = narration?.sampleRate ?? SILENCE_SAMPLE_RATE;
  const total = Math.max(1, Math.round((timing.sceneMs * sampleRate) / 1000));
  const out = new Int16Array(total);
  if (narration && timing.speechMs > 0) {
    const start = Math.min(total, Math.round((timing.offsetMs * sampleRate) / 1000));
    const count = Math.min(
      narration.samples.length,
      Math.round((timing.speechMs * sampleRate) / 1000),
      total - start,
    );
    if (count > 0) out.set(narration.samples.subarray(0, count), start);
  }
  return encodeMonoPcm16Wav(out, sampleRate);
}

/** Mono samples as floats in -1..1 (input of `sceneRuntimeFromAudio`). */
export function toFloatSamples(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] ?? 0) / 32768;
  return out;
}
