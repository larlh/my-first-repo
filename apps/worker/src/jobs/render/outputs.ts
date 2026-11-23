import { formatSrt, formatVtt } from '@parlante/shared';
import type { Composition, RenderRuntime } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import type { RenderRef } from '@parlante/jobs';
import { compositionSubtitleCues } from '@parlante/renderer';
import type { RenderAssets, Timeline } from '@parlante/renderer';
import { createFrameRenderer } from '@parlante/renderer/node';
import type { WorkerContext } from '../../context';

/* -------------------------------------------------------------------------------------------
 * Stage `finalize`: thumbnail, subtitle files and the upload of the four outputs under
 * `storageKeys.videoOutput` (ws/<ws>/videos/<video>/<renderJob>/…).
 * ----------------------------------------------------------------------------------------- */

/** Largest side of the thumbnail in pixels. */
const THUMBNAIL_SIDE = 640;

/**
 * Instant the thumbnail shows: inside the first scene, after its entrance animations have
 * settled (about 1.5 s in, or halfway through a shorter scene).
 */
export function thumbnailTimeMs(timeline: Timeline): number {
  const first = timeline.scenes[0];
  if (!first) return 0;
  const lastFrame = Math.max(0, first.durationMs - 1000 / timeline.fps);
  return Math.min(lastFrame, Math.min(1500, first.durationMs / 2));
}

export interface ThumbnailInput {
  composition: Composition;
  runtime: RenderRuntime;
  assets: RenderAssets;
  timeline: Timeline;
  width: number;
  height: number;
  watermark: boolean;
}

/** JPEG poster of the video: the same renderer at a reduced size, without subtitles. */
export async function renderThumbnail(input: ThumbnailInput): Promise<Buffer> {
  const scale = Math.min(1, THUMBNAIL_SIDE / Math.max(input.width, input.height));
  const renderer = createFrameRenderer({
    composition: input.composition,
    runtime: input.runtime,
    assets: input.assets,
    timeline: input.timeline,
    width: Math.max(2, Math.round(input.width * scale)),
    height: Math.max(2, Math.round(input.height * scale)),
    subtitles: false,
    watermark: input.watermark,
  });
  return renderer.jpeg(thumbnailTimeMs(input.timeline), 84);
}

/**
 * SRT and WebVTT of the whole video, from the word timings of every narration — the SAME cues
 * the renderer burns in (`compositionSubtitleCues`), on the video clock.
 */
export function subtitleFiles(
  composition: Composition,
  runtime: RenderRuntime,
  timeline: Timeline,
): { srt: string; vtt: string; cues: number } {
  const cues = compositionSubtitleCues(composition, runtime, timeline);
  return { srt: formatSrt(cues), vtt: formatVtt(cues), cues: cues.length };
}

export interface OutputKeys {
  videoKey: string;
  thumbnailKey: string;
  srtKey: string;
  vttKey: string;
}

export function outputKeys(ref: RenderRef): OutputKeys {
  const key = (file: 'video.mp4' | 'thumb.jpg' | 'subtitles.srt' | 'subtitles.vtt') =>
    storageKeys.videoOutput(ref.workspaceId, ref.videoId, ref.renderJobId, file);
  return {
    videoKey: key('video.mp4'),
    thumbnailKey: key('thumb.jpg'),
    srtKey: key('subtitles.srt'),
    vttKey: key('subtitles.vtt'),
  };
}

/** Upload the outputs. If any upload fails, nothing of this render is left behind. */
export async function uploadOutputs(
  ctx: WorkerContext,
  ref: RenderRef,
  files: { videoPath: string; thumbnail: Uint8Array; srt: string; vtt: string },
): Promise<OutputKeys> {
  const { storage } = ctx.providers;
  const keys = outputKeys(ref);
  const text = new TextEncoder();
  try {
    await storage.put(keys.videoKey, { filePath: files.videoPath }, { contentType: 'video/mp4' });
    await storage.put(keys.thumbnailKey, files.thumbnail, { contentType: 'image/jpeg' });
    await storage.put(keys.srtKey, text.encode(files.srt), {
      contentType: 'application/x-subrip; charset=utf-8',
    });
    await storage.put(keys.vttKey, text.encode(files.vtt), {
      contentType: 'text/vtt; charset=utf-8',
    });
  } catch (err) {
    await deleteOutputs(ctx, keys);
    throw err;
  }
  return keys;
}

/** Best-effort removal of output files (failed upload, cancellation, superseded render). */
export async function deleteOutputs(
  ctx: WorkerContext,
  keys: Partial<Record<keyof OutputKeys, string | null>>,
): Promise<void> {
  for (const key of Object.values(keys)) {
    if (key) await ctx.providers.storage.delete(key).catch(() => undefined);
  }
}
