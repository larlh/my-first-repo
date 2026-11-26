import type { PhotoLandmarks } from '@parlante/shared';
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
   *  - Node: frames decoded with ffmpeg by the worker.
   *  - Browser: the current frame of an HTMLVideoElement kept in sync by the preview player.
   * WHICH time the renderer will ask for is not private knowledge: `mediaPlaybackAt` (./media)
   * returns it for every video of a frame. The Studio player uses it to seek / set the volume
   * of its elements; the worker uses it to decode only the window it needs — nobody
   * re-derives the trim / loop / transition arithmetic by hand.
   */
  frameAt(timeMs: number): RenderImage | null;
}

/**
 * Pre-rendered neural clip of one photorealistic avatar layer in one scene.
 * Its frames have the same framing and aspect ratio as the avatar's prepared portrait and
 * carry an alpha channel (the worker merges the engine's matte while decoding).
 */
export interface AvatarClipSource extends VideoFrameSource {
  /**
   * Scene-local ms at which the clip's time 0 falls. Default (undefined): the start of the
   * scene's narration (`scene.paddingStartMs`), and the first / last frame is held outside the
   * clip. THE WORKER SETS `originMs: 0` and animates over the narration PADDED WITH SILENCE to
   * the full scene length, so the avatar keeps blinking and moving during paddings, the tail
   * of fixed-duration scenes and scenes with no narration at all (an all-silence clip).
   */
  readonly originMs?: number;
  /**
   * Landmarks of the avatar's prepared portrait (`Avatar.rig.landmarks`). With them the clip
   * is placed by `photoAvatarPlacement` honouring the layer's `framing`, exactly like the
   * Canvas stand-in; without them it is fitted whole (as framing `half`).
   */
  readonly landmarks?: PhotoLandmarks;
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
   * stand-in rig for photorealistic ones (`real_…`, `avt_…`), built with
   * `createPhotoAvatarRig(id, cutout, rig)` from the avatar's CUT-OUT image
   * (`Avatar.cutoutUrl`: portrait with its matte applied) so previews show the person over
   * the scene background, like the export.
   */
  avatar(avatarId: string): AvatarRig | null;
  /**
   * Pre-rendered neural clip of a PHOTOREALISTIC avatar layer for one scene (exports only).
   * When present it replaces the rig. Null in live previews.
   *
   * RULE FOR THE RENDER JOB (so an exported MP4 never shows the grey placeholder or a
   * stand-in next to neural scenes): for EVERY photorealistic avatar layer of EVERY scene it
   *  1. registers the stand-in too (`setAvatar`, from the cut-out) as a safety net, and
   *  2. registers a clip (`setAvatarClip`) with `originMs: 0` covering the whole scene —
   *     narration padded with silence; for scenes without narration, pure silence (the engine
   *     then produces idle motion: blinking, breathing) — and `landmarks` of the avatar.
   */
  avatarClip(sceneId: string, layerId: string): AvatarClipSource | null;
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
