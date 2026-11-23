import type { Canvas } from '@napi-rs/canvas';
import type { Composition, RenderRuntime } from '@parlante/shared';
import { avatarClipTimeMs, mediaPlaybackAt, mediaTimeMs } from '../media';
import { renderFrame } from '../render-frame';
import { computeTimeline, frameToMs } from '../timeline';
import type { Timeline } from '../timeline';
import type { Ctx2D, RenderAssets, RenderOptions } from '../types';
import { isPreparable } from './video';

/* -------------------------------------------------------------------------------------------
 * Frame renderer for exports: one canvas, reused for every frame, handing out raw RGBA.
 *
 *   const frames = createFrameRenderer({ composition, runtime, assets, width, height, watermark });
 *   for (let i = 0; i < frames.totalFrames; i += 1) {
 *     ffmpegStdin.write(await frames.frame(i));        // -f rawvideo -pix_fmt rgba -s WxH -r 30
 *   }
 *
 * `frame(i)` first lets every file-backed video the frame needs decode it (`prepare`, driven
 * by the renderer's own media clock), then draws and copies the pixels out.
 *
 * MEMORY — why exports must go through `frame()` (or `frames()`), not a hand-written loop
 * around `canvas.data()`: the pixel buffer @napi-rs/canvas returns is native memory that V8
 * does not count and that is only released when its finalizer runs, which needs a turn of the
 * event loop. A loop that never yields (or only awaits already-resolved promises) keeps EVERY
 * frame alive: measured 4 MB per 720p frame, 2.9 GB for a 22 s video. `frame()` copies the
 * pixels into an ordinary Buffer and yields to the event loop every few frames, which keeps
 * the process flat (about 200 MB at 720p whatever the length of the video).
 * ----------------------------------------------------------------------------------------- */

/** Native pixel bytes handed out before `frame()` lets the event loop release them. */
const YIELD_AFTER_BYTES = 48 * 1024 * 1024;

export interface FrameRendererOptions extends Omit<RenderOptions, 'timeline'> {
  composition: Composition;
  runtime: RenderRuntime;
  assets: RenderAssets;
  /** Precomputed timeline; default `computeTimeline(composition, runtime)`. */
  timeline?: Timeline;
}

export interface FrameRenderer {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly timeline: Timeline;
  readonly totalFrames: number;
  /** Size of one RGBA frame in bytes (`width × height × 4`). */
  readonly frameBytes: number;
  /** The canvas frames are drawn on (holds the last frame drawn). */
  readonly canvas: Canvas;
  /** Decode what the frame at `tMs` needs from file-backed video sources. */
  prepareAt(tMs: number): Promise<void>;
  /** Draw the frame at `tMs` on `canvas` (sources must be ready: see `prepareAt`). */
  drawAt(tMs: number): void;
  /**
   * RGBA pixels (top row first) of frame `index`: prepare, draw, copy. Returns a new Buffer,
   * or `target` when given (at least `frameBytes` long; reuse it only once its previous
   * contents have been consumed, e.g. after the write callback of the encoder's stdin).
   */
  frame(index: number, target?: Buffer): Promise<Buffer>;
  /**
   * Same without preparing video sources and without yielding. For single frames and tests:
   * a long synchronous loop over it retains native memory (see the note at the top of this
   * file) unless the caller lets the event loop turn (`await setImmediate`) now and then.
   */
  frameSync(index: number, target?: Buffer): Buffer;
  /** Frames `from` (inclusive, default 0) to `to` (exclusive, default all) in order. */
  frames(from?: number, to?: number): AsyncGenerator<Buffer, void, void>;
  /** Encoded stills of an arbitrary instant (thumbnails, posters). */
  png(tMs: number): Promise<Buffer>;
  jpeg(tMs: number, quality?: number): Promise<Buffer>;
}

/**
 * Await `prepare` on every file-backed video `renderFrame(…, tMs, …)` is going to ask for,
 * at exactly the media time it will ask (same arithmetic: `mediaPlaybackAt`).
 */
export async function prepareMediaAt(
  composition: Composition,
  timeline: Timeline,
  tMs: number,
  assets: RenderAssets,
): Promise<void> {
  for (const entry of mediaPlaybackAt(composition, timeline, tMs)) {
    if (entry.kind === 'avatarClip') {
      const clip = entry.layerId ? assets.avatarClip(entry.sceneId, entry.layerId) : null;
      if (isPreparable(clip)) {
        await clip.prepare(avatarClipTimeMs(clip, entry.localMs, entry.speechMs));
      }
    } else {
      const source = assets.video(entry.key);
      if (isPreparable(source)) {
        await source.prepare(mediaTimeMs(entry.rawMs, entry.loop, source.durationMs));
      }
    }
  }
}

export function createFrameRenderer(
  options: FrameRendererOptions,
  createCanvas: (width: number, height: number) => { canvas: Canvas; ctx: Ctx2D },
): FrameRenderer {
  const { composition, runtime, assets } = options;
  const width = Math.round(options.width ?? composition.canvas.width);
  const height = Math.round(options.height ?? composition.canvas.height);
  const timeline = options.timeline ?? computeTimeline(composition, runtime);
  const { canvas, ctx } = createCanvas(width, height);
  const renderOptions: RenderOptions = {
    width,
    height,
    timeline,
    subtitles: options.subtitles,
    watermark: options.watermark,
    quality: options.quality,
  };
  const drawAt = (tMs: number) =>
    renderFrame(ctx, composition, tMs, runtime, assets, renderOptions);
  const prepareAt = (tMs: number) => prepareMediaAt(composition, timeline, tMs, assets);
  let unreleased = 0;
  const frameSync = (index: number, target?: Buffer) => {
    drawAt(frameToMs(index, timeline.fps));
    const native = canvas.data();
    unreleased += native.length;
    if (target && target.length < native.length) {
      throw new RangeError(`target buffer too small: ${target.length} < ${native.length} bytes`);
    }
    const out = target ?? Buffer.allocUnsafe(native.length);
    native.copy(out);
    return out;
  };
  const frame = async (index: number, target?: Buffer) => {
    await prepareAt(frameToMs(index, timeline.fps));
    if (unreleased >= YIELD_AFTER_BYTES) {
      unreleased = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return frameSync(index, target);
  };
  return {
    width,
    height,
    fps: timeline.fps,
    timeline,
    totalFrames: timeline.totalFrames,
    frameBytes: width * height * 4,
    canvas,
    prepareAt,
    drawAt,
    frame,
    frameSync,
    async *frames(from = 0, to = timeline.totalFrames) {
      for (let index = Math.max(0, from); index < Math.min(to, timeline.totalFrames); index += 1) {
        yield await frame(index);
      }
    },
    async png(tMs) {
      await prepareAt(tMs);
      drawAt(tMs);
      return canvas.toBuffer('image/png');
    },
    async jpeg(tMs, quality = 85) {
      await prepareAt(tMs);
      drawAt(tMs);
      return canvas.toBuffer('image/jpeg', quality);
    },
  };
}
