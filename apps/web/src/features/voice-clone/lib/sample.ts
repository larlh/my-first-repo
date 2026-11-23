import type { Voice } from '@parlante/shared';

/* The voice sample of a clone: length rules of the API (`POST /api/voice-clones` accepts
 * 10 s – 5 min), reading its duration in the browser, and turning a microphone recording
 * into a WAV file — the one container every part of the pipeline reads reliably (browser
 * recordings are WebM/Opus without a duration header). */

export const SAMPLE_MIN_MS = 10_000;
export const SAMPLE_MAX_MS = 5 * 60_000;
/** Recordings stop by themselves here (comfortably inside the limit). */
export const RECORDING_MAX_MS = 3 * 60_000;

/** Upload types offered in the file dialog (the server checks the real content). */
export const SAMPLE_ACCEPT = [
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
] as const;

export type DurationProblem = 'tooShort' | 'tooLong';

/** null = fine, or unknown (the server measures it again and has the last word). */
export function durationProblem(durationMs: number | null): DurationProblem | null {
  if (durationMs === null) return null;
  if (durationMs < SAMPLE_MIN_MS) return 'tooShort';
  if (durationMs > SAMPLE_MAX_MS) return 'tooLong';
  return null;
}

/** Average the channels of a recording into one. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const out = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) + (channel[i] ?? 0);
  }
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i] ?? 0) / channels.length;
  return out;
}

/** Mono 16-bit PCM WAV of `samples` (-1..1). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
  }
  return new Uint8Array(buffer);
}

/** Length in ms of mono PCM samples. */
export function samplesDurationMs(sampleCount: number, sampleRate: number): number {
  return sampleRate > 0 ? Math.round((sampleCount / sampleRate) * 1000) : 0;
}

/** Cloned voices that count towards the plan allowance (failed ones do not). */
export function countClonedVoices(voices: readonly Pick<Voice, 'kind' | 'status'>[]): number {
  return voices.filter((voice) => voice.kind === 'cloned' && voice.status !== 'failed').length;
}

/** Duration of an audio file as the browser reads it (null when it cannot tell). */
export function readAudioDurationMs(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () =>
      done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}
