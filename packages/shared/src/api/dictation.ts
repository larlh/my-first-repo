import { z } from 'zod';
import { DICTATION_MAX_SEGMENT_MS, DICTATION_SAMPLE_RATE, ProviderRefSchema } from '../entities';
import { LanguageCodeSchema } from '../languages';
import { route } from './contract';

/* ====================== dictation by microphone (feature 17, first-party) ======================
 * The web app records the microphone, cuts the speech into phrases and posts each phrase here.
 * The audio is transcribed on the machine that runs Parlante, in memory, and is never stored
 * or logged. Not part of the public /v1 API.
 * ============================================================================================ */

/** WAV header (44 bytes) + 30 s of PCM 16-bit mono at 16 kHz, with room for extra chunks. */
export const DICTATION_MAX_UPLOAD_BYTES =
  44 + (DICTATION_MAX_SEGMENT_MS / 1000) * DICTATION_SAMPLE_RATE * 2 + 4096;

/**
 * `details.reason` of the 400 / 413 / 415 answers of `transcribe`, for the UI to translate.
 *  - `not_wav`             the file is not RIFF/WAVE
 *  - `invalid_wav`         truncated or inconsistent header / chunks
 *  - `unsupported_format`  WAV, but not PCM 16-bit mono at 16 kHz
 *  - `empty_audio`         no samples
 *  - `audio_too_long`      longer than `DICTATION_MAX_SEGMENT_MS` (or than the byte limit)
 */
export const DICTATION_AUDIO_ERROR_REASONS = [
  'not_wav',
  'invalid_wav',
  'unsupported_format',
  'empty_audio',
  'audio_too_long',
] as const;
export type DictationAudioErrorReason = (typeof DICTATION_AUDIO_ERROR_REASONS)[number];

export const DictationTranscribeFieldsSchema = z.object({
  /**
   * Language of the speech (the language of the field or of the UI). Omitted ⇒ detected among
   * `capabilities.dictation.local.languages`.
   */
  language: LanguageCodeSchema.optional(),
});

export const DictationTranscriptionSchema = z.object({
  /** Recognised text, trimmed; `''` when the segment holds no speech. */
  text: z.string(),
  /** The hint when sent, otherwise the detected language; null when nothing was recognised. */
  language: LanguageCodeSchema.nullable(),
  /** Who transcribed (honesty rule): `quality: 'basic'` and `local: true` for the local model. */
  provider: ProviderRefSchema,
  /** Real length of the audio received. */
  audioMs: z.number().int().nonnegative(),
  /** Time the server spent on the segment, waiting for its turn included. */
  processingMs: z.number().int().nonnegative(),
});
export type DictationTranscription = z.infer<typeof DictationTranscriptionSchema>;

export const dictationRoutes = {
  transcribe: route({
    method: 'POST',
    path: '/api/dictation/transcribe',
    auth: 'session',
    feature: 17,
    tag: 'Dictation',
    summary:
      'Transcribe one spoken phrase (WAV PCM 16-bit mono 16 kHz, at most 30 s) on this server. The audio is processed in memory and never stored; no credits are charged',
    multipart: {
      fileField: 'audio',
      fields: DictationTranscribeFieldsSchema,
      description:
        'multipart/form-data with one `audio` part (audio/wav: PCM 16-bit, mono, 16 000 Hz, ≤ 30 s) and an optional `language` field (send the field BEFORE the file)',
    },
    response: DictationTranscriptionSchema,
    errors: [
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
      'PROVIDER_ERROR',
    ],
  }),
} as const;
