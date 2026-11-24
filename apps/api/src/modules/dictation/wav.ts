import { AppError, DICTATION_MAX_SEGMENT_MS, DICTATION_SAMPLE_RATE } from '@parlante/shared';
import type { DictationAudioErrorReason } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Strict reader of the only audio dictation accepts: RIFF/WAVE, PCM 16-bit, mono, 16 kHz, at
 * most 30 s. Nothing here trusts the header: the length is the number of sample bytes that
 * really arrived. Works on the bytes in memory and keeps no copy besides the samples it
 * returns.
 * ----------------------------------------------------------------------------------------- */

export interface DictationAudio {
  samples: Int16Array;
  sampleRate: number;
  /** Real length, from the samples received. */
  durationMs: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
export const DICTATION_MAX_SAMPLES = (DICTATION_MAX_SEGMENT_MS / 1000) * DICTATION_SAMPLE_RATE;

function invalid(reason: DictationAudioErrorReason, message: string, extra: object = {}): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    reason,
    issues: [{ path: 'audio', message }],
    ...extra,
  });
}

export function audioTooLong(audioMs: number | null): AppError {
  return new AppError(
    'PAYLOAD_TOO_LARGE',
    `A dictation segment can be at most ${DICTATION_MAX_SEGMENT_MS / 1000} s long`,
    { reason: 'audio_too_long' satisfies DictationAudioErrorReason, maxSegmentMs: DICTATION_MAX_SEGMENT_MS, audioMs },
  );
}

export function parseDictationWav(bytes: Uint8Array): DictationAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);

  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Dictation audio must be a WAV file', {
      reason: 'not_wav' satisfies DictationAudioErrorReason,
      allowed: ['audio/wav'],
    });
  }

  let format: { code: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | null =
    null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const declared = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const remaining = bytes.byteLength - start;

    if (id === 'fmt ') {
      if (declared < 16 || declared > remaining) {
        throw invalid('invalid_wav', 'The WAV header is truncated');
      }
      let code = view.getUint16(start, true);
      if (code === WAVE_FORMAT_EXTENSIBLE && declared >= 26) code = view.getUint16(start + 24, true);
      format = {
        code,
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        blockAlign: view.getUint16(start + 12, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw invalid('invalid_wav', 'The WAV file has no format chunk before its data');
      if (
        format.code !== WAVE_FORMAT_PCM ||
        format.channels !== 1 ||
        format.sampleRate !== DICTATION_SAMPLE_RATE ||
        format.bits !== 16 ||
        format.blockAlign !== 2
      ) {
        throw invalid('unsupported_format', 'Dictation audio must be PCM 16-bit, mono, 16 kHz', {
          received: {
            format: format.code,
            channels: format.channels,
            sampleRate: format.sampleRate,
            bitsPerSample: format.bits,
          },
          expected: { format: WAVE_FORMAT_PCM, channels: 1, sampleRate: DICTATION_SAMPLE_RATE, bitsPerSample: 16 },
        });
      }
      // Streaming encoders leave 0 or 0xFFFFFFFF as the size: the data then runs to the end.
      const streamed = declared === 0xffffffff || (declared === 0 && remaining > 0);
      if (!streamed && declared > remaining) {
        throw invalid('invalid_wav', 'The WAV file is truncated: it holds less audio than its header says');
      }
      const length = streamed ? remaining - (remaining % 2) : declared;
      if (length % 2 !== 0) throw invalid('invalid_wav', 'The WAV data has an odd number of bytes');
      const count = length / 2;
      if (count === 0) throw invalid('empty_audio', 'The audio is empty');
      const durationMs = Math.round((count * 1000) / DICTATION_SAMPLE_RATE);
      if (count > DICTATION_MAX_SAMPLES) throw audioTooLong(durationMs);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i += 1) samples[i] = view.getInt16(start + i * 2, true);
      return { samples, sampleRate: DICTATION_SAMPLE_RATE, durationMs };
    }
    // Chunks are word aligned.
    offset = start + declared + (declared % 2);
  }
  throw invalid(format ? 'empty_audio' : 'invalid_wav', format ? 'The audio is empty' : 'The WAV file has no format chunk');
}
