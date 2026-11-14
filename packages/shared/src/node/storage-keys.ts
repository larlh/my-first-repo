import { sha256Hex } from './crypto';

/**
 * Storage key layout. Keys are built ONLY from server-generated ids and whitelisted
 * extensions/filenames — never from raw user input.
 *
 *   ws/<workspaceId>/assets/<assetId>/original.<ext>
 *   ws/<workspaceId>/assets/<assetId>/thumb.jpg
 *   ws/<workspaceId>/videos/<videoId>/<renderJobId>/video.mp4 | thumb.jpg | subtitles.srt | subtitles.vtt
 *   ws/<workspaceId>/avatars/<avatarId>/image.png | thumb.jpg
 *   ws/<workspaceId>/voices/<voiceId>/sample.wav
 *   ws/<workspaceId>/translations/<jobId>/<language>/video.mp4 | subtitles.srt | subtitles.vtt
 *   cache/tts/<sha256>.wav | <sha256>.json
 */
export const storageKeys = {
  workspacePrefix: (workspaceId: string) => `ws/${seg(workspaceId)}/`,
  asset: (workspaceId: string, assetId: string, ext: string) =>
    `ws/${seg(workspaceId)}/assets/${seg(assetId)}/original.${safeExt(ext)}`,
  assetThumb: (workspaceId: string, assetId: string) =>
    `ws/${seg(workspaceId)}/assets/${seg(assetId)}/thumb.jpg`,
  assetPrefix: (workspaceId: string, assetId: string) =>
    `ws/${seg(workspaceId)}/assets/${seg(assetId)}/`,
  videoPrefix: (workspaceId: string, videoId: string) =>
    `ws/${seg(workspaceId)}/videos/${seg(videoId)}/`,
  videoOutput: (
    workspaceId: string,
    videoId: string,
    renderJobId: string,
    file: 'video.mp4' | 'thumb.jpg' | 'subtitles.srt' | 'subtitles.vtt',
  ) => `ws/${seg(workspaceId)}/videos/${seg(videoId)}/${seg(renderJobId)}/${file}`,
  avatarPrefix: (workspaceId: string, avatarId: string) =>
    `ws/${seg(workspaceId)}/avatars/${seg(avatarId)}/`,
  avatarFile: (workspaceId: string, avatarId: string, file: 'image.png' | 'thumb.jpg') =>
    `ws/${seg(workspaceId)}/avatars/${seg(avatarId)}/${file}`,
  voicePrefix: (workspaceId: string, voiceId: string) =>
    `ws/${seg(workspaceId)}/voices/${seg(voiceId)}/`,
  voiceSample: (workspaceId: string, voiceId: string) =>
    `ws/${seg(workspaceId)}/voices/${seg(voiceId)}/sample.wav`,
  translationPrefix: (workspaceId: string, jobId: string) =>
    `ws/${seg(workspaceId)}/translations/${seg(jobId)}/`,
  translationOutput: (
    workspaceId: string,
    jobId: string,
    language: string,
    file: 'video.mp4' | 'subtitles.srt' | 'subtitles.vtt',
  ) => `ws/${seg(workspaceId)}/translations/${seg(jobId)}/${seg(language)}/${file}`,
  ttsCacheAudio: (hash: string) => `cache/tts/${seg(hash)}.wav`,
  ttsCacheMeta: (hash: string) => `cache/tts/${seg(hash)}.json`,
} as const;

function seg(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new Error(`Unsafe storage key segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function safeExt(ext: string): string {
  const clean = ext.replace(/^\./, '').toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(clean)) throw new Error(`Unsafe file extension: ${ext}`);
  return clean;
}

/** True when a key is well-formed (no traversal, no absolute paths, sane characters). */
export function isSafeStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > 400) return false;
  if (key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  return key
    .split('/')
    .every((part) => /^[A-Za-z0-9_.-]{1,120}$/.test(part) && !/^\.+$/.test(part));
}

export function assertSafeStorageKey(key: string): void {
  if (!isSafeStorageKey(key)) throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
}

/** Workspace that owns a `ws/<id>/…` key, or null for shared keys (cache). */
export function workspaceOfStorageKey(key: string): string | null {
  const match = /^ws\/([A-Za-z0-9_-]+)\//.exec(key);
  return match?.[1] ?? null;
}

/** Display-safe file name for Content-Disposition (keeps letters, digits, space, dot, dash). */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 100);
  return cleaned === '' ? fallback : cleaned;
}

export interface TtsCacheInput {
  /** TTS provider id (`espeak`, `elevenlabs`…). */
  provider: string;
  providerVoiceId: string;
  text: string;
  language: string;
  speed: number;
  pitch: number;
  /** Serialised voice profile for cloned local voices. */
  profile?: unknown;
}

/**
 * Content hash of a synthesis request. API (`/api/tts/synthesize`) and worker (render job)
 * use it with `storageKeys.ttsCacheAudio/Meta` so the same narration is synthesised once.
 */
export function ttsCacheKey(input: TtsCacheInput): string {
  return sha256Hex(
    JSON.stringify([
      'v1',
      input.provider,
      input.providerVoiceId,
      input.text,
      input.language,
      Math.round(input.speed * 100),
      Math.round(input.pitch * 100),
      input.profile ?? null,
    ]),
  );
}
