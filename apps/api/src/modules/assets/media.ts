import fs from 'node:fs/promises';
import { imageSizeFromFile } from 'image-size/fromFile';
import { AppError } from '@parlante/shared';
import type { AssetKind } from '@parlante/shared';
import { ffprobe, runFfmpeg } from '@parlante/shared/node';
import { thumbnailJpeg } from '@parlante/renderer/node';

/* -------------------------------------------------------------------------------------------
 * What the server learns from an uploaded file by READING it (never from what the client
 * says): pixel size, duration and a small JPEG preview. `receiveUpload` has already checked
 * the magic bytes; this step proves that the file really decodes as that kind of media.
 * ----------------------------------------------------------------------------------------- */

/** Largest side of the preview stored next to an image or video asset. */
export const ASSET_THUMB_MAX_SIDE = 480;
/** Decoded images are held in memory as RGBA: refuse pictures that would not fit sensibly. */
export const MAX_IMAGE_PIXELS = 50_000_000;
export const MAX_IMAGE_SIDE = 16_384;

const FFMPEG_THUMB_TIMEOUT_MS = 60_000;

export interface InspectedMedia {
  /** May differ from the detected kind: an MP4 / WebM without a video track is audio. */
  kind: AssetKind;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** JPEG preview (images and videos), null for audio or when no frame could be decoded. */
  thumbnail: Buffer | null;
}

export interface MediaToInspect {
  /** Server-generated temp path of the upload. */
  path: string;
  kind: AssetKind;
  mimeType: string;
}

/** Containers that may legitimately hold only audio, and the audio type they are stored as. */
const AUDIO_ONLY_CONTAINER: Record<string, string> = {
  'video/mp4': 'audio/mp4',
  'video/webm': 'audio/webm',
};

function unreadable(media: MediaToInspect, reason: string): AppError {
  return new AppError(
    'UNSUPPORTED_MEDIA_TYPE',
    `The file looks like ${media.mimeType} but could not be read as ${media.kind}`,
    { detected: media.mimeType, reason },
  );
}

async function inspectImage(media: MediaToInspect): Promise<InspectedMedia> {
  let size: Awaited<ReturnType<typeof imageSizeFromFile>>;
  try {
    // Header-only: safe to run before deciding whether the picture may be decoded at all.
    size = await imageSizeFromFile(media.path);
  } catch {
    throw unreadable(media, 'image_header');
  }
  // EXIF orientations 5–8 rotate the picture by 90°: report it as it is displayed.
  const rotated = (size.orientation ?? 1) >= 5;
  const width = rotated ? size.height : size.width;
  const height = rotated ? size.width : size.height;
  if (!(width > 0) || !(height > 0)) throw unreadable(media, 'image_header');
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw AppError.validation(
      `The image is too large: at most ${MAX_IMAGE_PIXELS / 1_000_000} megapixels and ${MAX_IMAGE_SIDE} px per side`,
      [{ path: 'file', message: `${width}×${height} px` }],
    );
  }
  let thumbnail: Buffer;
  try {
    // Full decode: also the proof that the bytes after the header are a real picture.
    thumbnail = await thumbnailJpeg(media.path, ASSET_THUMB_MAX_SIDE);
  } catch {
    // Formats the canvas decoder does not handle (e.g. some animated files): try ffmpeg.
    const viaFfmpeg = await ffmpegThumbnail(media.path, 0);
    if (!viaFfmpeg) throw unreadable(media, 'image_decode');
    thumbnail = viaFfmpeg;
  }
  return { kind: 'image', mimeType: media.mimeType, width, height, durationMs: null, thumbnail };
}

async function inspectAudioVideo(media: MediaToInspect): Promise<InspectedMedia> {
  let info: Awaited<ReturnType<typeof ffprobe>>;
  try {
    info = await ffprobe(media.path);
  } catch (err) {
    if (err instanceof AppError && err.code === 'UNPROCESSABLE') throw unreadable(media, 'probe');
    throw err;
  }
  if (media.kind === 'video' && info.hasVideo) {
    if (!info.width || !info.height) throw unreadable(media, 'video_stream');
    const at = info.durationMs ? Math.min(1000, Math.floor(info.durationMs / 2)) : 0;
    return {
      kind: 'video',
      mimeType: media.mimeType,
      width: info.width,
      height: info.height,
      durationMs: info.durationMs,
      thumbnail: await ffmpegThumbnail(media.path, at),
    };
  }
  if (!info.hasAudio) {
    throw unreadable(media, media.kind === 'video' ? 'no_video_stream' : 'no_audio_stream');
  }
  let mimeType = media.mimeType;
  if (media.kind === 'video') {
    // A video container that only carries sound is stored (and listed) as audio.
    const audioType = AUDIO_ONLY_CONTAINER[media.mimeType];
    if (!audioType) throw unreadable(media, 'no_video_stream');
    mimeType = audioType;
  }
  return {
    kind: 'audio',
    mimeType,
    width: null,
    height: null,
    durationMs: info.durationMs,
    thumbnail: null,
  };
}

/**
 * One frame of a video (or picture) as a JPEG that fits in ASSET_THUMB_MAX_SIDE, or null when
 * ffmpeg cannot decode one. `inputPath` is a server-generated path; arguments are an array.
 */
async function ffmpegThumbnail(inputPath: string, atMs: number): Promise<Buffer | null> {
  const outputPath = `${inputPath}.thumb.jpg`;
  const side = String(ASSET_THUMB_MAX_SIDE);
  // Fit inside the box, never upscale, even dimensions.
  const scale = `scale='min(${side},iw)':'min(${side},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  try {
    await runFfmpeg(
      [
        // The upload is one self-contained local file: no network or nested protocols.
        '-protocol_whitelist',
        'file',
        '-ss',
        (atMs / 1000).toFixed(3),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-an',
        '-vf',
        scale,
        '-q:v',
        '4',
        '-f',
        'image2',
        outputPath,
      ],
      { timeoutMs: FFMPEG_THUMB_TIMEOUT_MS },
    );
    const bytes = await fs.readFile(outputPath);
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

/**
 * Read the real properties of an uploaded file. Throws UNSUPPORTED_MEDIA_TYPE when the bytes
 * do not decode as the detected type, VALIDATION_ERROR for pictures beyond the pixel budget.
 */
export function inspectMedia(media: MediaToInspect): Promise<InspectedMedia> {
  return media.kind === 'image' ? inspectImage(media) : inspectAudioVideo(media);
}
