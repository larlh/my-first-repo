import type { AvatarRig } from './avatars/types';
import type { Timeline } from './timeline';

/* -------------------------------------------------------------------------------------------
 * Platform-neutral drawing types. The renderer core only talks to these; the browser and Node
 * adapters (./browser, ./node) provide the concrete canvas, image decoding and fonts.
 * ----------------------------------------------------------------------------------------- */

/**
 * The 2D context the renderer draws on. In the browser it is a real CanvasRenderingContext2D
 * (or OffscreenCanvasRenderingContext2D); in Node it is the @napi-rs/canvas context, which
 * implements the same API (the Node adapter performs the cast).
 * Only use features available in BOTH: no `ctx.filter` strings beyond blur(), no DOM access.
 */
export type Ctx2D = CanvasRenderingContext2D;

/** A decoded, drawable image with its intrinsic pixel size. */
export interface RenderImage {
  /** Pass to `ctx.drawImage`. */
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

/** Rectangle in OUTPUT pixels. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Frame provider for a video asset. */
export interface VideoFrameSource {
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  /**
   * Frame to show at `timeMs` of the media (already trimmed/looped by the caller).
   * Returns null when the frame is not available (the renderer then keeps the placeholder).
   *  - Node: frames pre-extracted with ffmpeg by the worker.
   *  - Browser: the current frame of an HTMLVideoElement kept in sync by the preview player.
   */
  frameAt(timeMs: number): RenderImage | null;
}

/**
 * Everything external a frame may need, looked up SYNCHRONOUSLY while drawing. Load/prepare
 * assets before rendering (see `MapRenderAssets` and the platform loaders). Keys are
 * `mediaRefKey(ref)` from @parlante/shared (`asset:<id>` / `stock:<id>`).
 * Missing entries never throw: the renderer draws a neutral placeholder instead.
 */
export interface RenderAssets {
  image(key: string): RenderImage | null;
  video(key: string): VideoFrameSource | null;
  /**
   * Canvas rig for an avatar id: the real drawing for instant avatars (`stock_…`), or the
   * stand-in rig over the portrait for photorealistic ones (`real_…`, `avt_…`).
   */
  avatar(avatarId: string): AvatarRig | null;
  /**
   * Pre-rendered neural clip of a PHOTOREALISTIC avatar layer for one scene (exports only):
   * frames carry an alpha channel (the worker merges the engine's matte when extracting them)
   * and frame time 0 = start of the scene's narration. When present it replaces the rig;
   * outside the clip's duration the first/last frame is held. Null in live previews.
   */
  avatarClip(sceneId: string, layerId: string): VideoFrameSource | null;
}

export interface RenderOptions {
  /** Output size in pixels. Defaults to the composition canvas size. */
  width?: number;
  height?: number;
  /** Precomputed timeline (avoids recomputing it for every frame). */
  timeline?: Timeline;
  /** Force subtitles on/off. Default: `composition.subtitles.enabled`. */
  subtitles?: boolean;
  /** Draw the plan watermark (free plan exports). Default false. */
  watermark?: boolean;
  /**
   * `preview` may skip expensive effects (blur, shadows) to stay interactive in the Studio;
   * `final` is used for exports. Layout must be identical in both.
   */
  quality?: 'preview' | 'final';
}

/** What a platform adapter provides. */
export interface RenderPlatform {
  readonly name: 'node' | 'browser';
  /** Create a canvas of the given pixel size and return it with its 2D context. */
  createCanvas(width: number, height: number): { canvas: unknown; ctx: Ctx2D };
  /** Decode an encoded image (PNG/JPEG/WebP/GIF bytes, or a URL in the browser). */
  loadImage(source: Uint8Array | string): Promise<RenderImage>;
  /** Make every bundled font family available to `ctx.font`. Idempotent. */
  ensureFonts(): Promise<void>;
}
