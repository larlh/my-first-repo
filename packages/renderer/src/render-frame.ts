import type { Composition, RenderRuntime, Scene, SubtitleStyle } from '@parlante/shared';
import { drawBackground } from './background';
import { acquireScratch, cachedRaster, releaseScratch } from './cache';
import { clamp01, ease, lerp } from './easing';
import { canvasFont } from './fonts';
import { drawLayer } from './layers';
import type { LayerTarget } from './layers';
import { layersInPaintOrder, sceneInstantsAt } from './media';
import type { SceneInstant } from './media';
import { drawSubtitleCue } from './subtitle-draw';
import { cachedSubtitleCues, cueAt } from './subtitles';
import { computeTimeline } from './timeline';
import type { Timeline } from './timeline';
import type { Ctx2D, RenderAssets, RenderOptions } from './types';

export { drawImageFit, fitRect, createGradientFill, setSmoothing } from './background';

/* -------------------------------------------------------------------------------------------
 * renderFrame — THE entry point of the renderer. Draws the frame of `composition` at video
 * time `tMs` onto `ctx`. Pure and deterministic: same arguments ⇒ same pixels. Used verbatim
 * by the Studio live preview (browser) and by the export worker (Node).
 *
 * Structure: timeline → scene(s) → background → z-ordered layers (pose, opacity, rotation)
 * → scene transition → subtitles → watermark. The drawing lives in ./background (scene
 * backgrounds), ./layers (one function per layer type), ./text, ./animation and
 * ./subtitle-draw; this file decides WHAT is drawn at `tMs` and composes scenes.
 *
 * Two pieces are deliberately NOT private to the renderer, because other code must agree with
 * them exactly:
 *  - media clock (./media): which scene(s) are drawn and at which time every video is sampled
 *    (`sceneInstantsAt`, `mediaTimeMs`, `avatarClipTimeMs`), mirrored by `mediaPlaybackAt`
 *  - photoreal placement (`photoAvatarPlacement`): shared by the stand-in rig and the clip
 * ----------------------------------------------------------------------------------------- */

/**
 * Watermark geometry, as fractions of the canvas height. It sits in the bottom-right corner;
 * bottom subtitles keep at least `WATERMARK_CLEARANCE` from the bottom edge while it is on.
 */
const WATERMARK = { height: 0.044, inset: 0.02, fontSize: 0.024 } as const;
export const WATERMARK_CLEARANCE = WATERMARK.inset * 2 + WATERMARK.height;
/** Text of the plan watermark (free plan exports). */
export const WATERMARK_TEXT = 'Parlante';

export function renderFrame(
  ctx: Ctx2D,
  composition: Composition,
  tMs: number,
  runtime: RenderRuntime,
  assets: RenderAssets,
  options: RenderOptions = {},
): void {
  const width = options.width ?? composition.canvas.width;
  const height = options.height ?? composition.canvas.height;
  const timeline: Timeline = options.timeline ?? computeTimeline(composition, runtime);
  // One scene normally; during a transition the frozen previous scene, then the incoming one.
  const instants = sceneInstantsAt(composition, timeline, tMs);
  const current = instants[instants.length - 1];
  if (!current) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);

  const target: LayerTarget = {
    ctx,
    width,
    height,
    assets,
    runtime,
    quality: options.quality ?? 'final',
    aligned: true,
  };
  const previous = instants.length > 1 ? instants[0] : undefined;
  if (previous && current.transitionProgress < 1) {
    drawTransition(target, previous, current);
  } else {
    drawScene(target, current);
  }

  const watermark = options.watermark === true;
  const showSubtitles = options.subtitles ?? composition.subtitles.enabled;
  if (showSubtitles) drawSubtitles(target, composition, current.scene, current.speechMs, watermark);
  if (watermark) drawWatermark(target);
  ctx.restore();
}

function drawScene(target: LayerTarget, instant: SceneInstant): void {
  const { scene, localMs, speechMs, timing } = instant;
  drawBackground(target, scene.background, localMs);
  for (const layer of layersInPaintOrder(scene, localMs)) {
    drawLayer(target, scene, layer, localMs, speechMs, timing.durationMs);
  }
}

/** Draw a scene shifted by whole pixels and clipped to the frame it occupies. */
function drawSceneAt(target: LayerTarget, instant: SceneInstant, dx: number, dy: number): void {
  const { ctx, width, height } = target;
  ctx.save();
  ctx.translate(dx, dy);
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  drawScene(target, instant);
  ctx.restore();
}

/** Zoom transition: how far the outgoing scene grows and where the incoming one starts. */
const ZOOM_OUTGOING_SCALE = 1.12;
const ZOOM_INCOMING_SCALE = 0.72;

/**
 * Transition INTO `incoming` over the frozen last frame of `previous`. Each scene is drawn
 * exactly once, previous first (so the media clock's order holds).
 *  - fade:    cross-fade (the incoming scene is composited as one image, not layer by layer)
 *  - slide-*: the incoming scene pushes the previous one out in the named direction
 *  - wipe:    the incoming scene is revealed from left to right
 *  - zoom:    the previous scene grows slightly while the incoming one scales up and fades in
 */
function drawTransition(target: LayerTarget, previous: SceneInstant, incoming: SceneInstant): void {
  const { ctx, width, height } = target;
  const type = incoming.scene.transition.type;
  const p = clamp01(ease('ease-in-out', incoming.transitionProgress));

  switch (type) {
    case 'slide-left':
    case 'slide-right':
    case 'slide-up':
    case 'slide-down': {
      const horizontal = type === 'slide-left' || type === 'slide-right';
      const sign = type === 'slide-left' || type === 'slide-up' ? -1 : 1;
      const span = horizontal ? width : height;
      const shift = Math.round(p * span) * sign;
      const from = shift - sign * span;
      drawSceneAt(target, previous, horizontal ? shift : 0, horizontal ? 0 : shift);
      drawSceneAt(target, incoming, horizontal ? from : 0, horizontal ? 0 : from);
      return;
    }
    case 'wipe': {
      drawScene(target, previous);
      const edge = Math.round(p * width);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, edge, height);
      ctx.clip();
      drawScene(target, incoming);
      ctx.restore();
      return;
    }
    case 'zoom': {
      const grow = lerp(1, ZOOM_OUTGOING_SCALE, p);
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.scale(grow, grow);
      ctx.translate(-width / 2, -height / 2);
      drawScene({ ...target, aligned: false }, previous);
      ctx.restore();
      const scale = lerp(ZOOM_INCOMING_SCALE, 1, p);
      compositeScene(target, incoming, clamp01(p * 1.5), scale);
      return;
    }
    case 'none':
    case 'fade':
    default:
      drawScene(target, previous);
      compositeScene(target, incoming, p, 1);
  }
}

/** Draw a scene as ONE image with the given opacity and scale (about the frame centre). */
function compositeScene(
  target: LayerTarget,
  instant: SceneInstant,
  alpha: number,
  scale: number,
): void {
  const { ctx, width, height } = target;
  const scratch = acquireScratch(width, height);
  if (!scratch) {
    // No off-screen canvas on this platform: blend the scene's layers directly.
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (scale !== 1) {
      ctx.translate(width / 2, height / 2);
      ctx.scale(scale, scale);
      ctx.translate(-width / 2, -height / 2);
    }
    drawScene({ ...target, aligned: scale === 1 }, instant);
    ctx.restore();
    return;
  }
  try {
    drawScene({ ...target, ctx: scratch.ctx, aligned: true }, instant);
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (scale !== 1) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      const w = width * scale;
      const h = height * scale;
      ctx.drawImage(scratch.canvas, (width - w) / 2, (height - h) / 2, w, h);
    } else {
      ctx.drawImage(scratch.canvas, 0, 0);
    }
    ctx.restore();
  } finally {
    releaseScratch(scratch);
  }
}

function drawSubtitles(
  target: LayerTarget,
  composition: Composition,
  scene: Scene,
  speechMs: number,
  watermark: boolean,
): void {
  const sceneRuntime = target.runtime.scenes[scene.id];
  if (!sceneRuntime || sceneRuntime.words.length === 0) return;
  let style: SubtitleStyle = composition.subtitles;
  const cue = cueAt(cachedSubtitleCues(sceneRuntime.words, style, composition.canvas), speechMs);
  if (!cue) return;
  if (watermark && style.position === 'bottom' && style.margin < WATERMARK_CLEARANCE) {
    // Keep bottom subtitles clear of the watermark.
    style = { ...style, margin: WATERMARK_CLEARANCE };
  }
  drawSubtitleCue(target.ctx, cue, style, target.width, target.height, speechMs);
}

function paintWatermark(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  height: number,
): void {
  const sizePx = WATERMARK.fontSize * height;
  ctx.save();
  ctx.fillStyle = 'rgba(11, 13, 23, 0.42)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  // Mark: a speech bubble made of a disc and a small tail.
  const r = h * 0.26;
  const cx = x + h * 0.55;
  const cy = y + h / 2;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.08, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.75, cy + r * 0.45);
  ctx.lineTo(cx - r * 1.05, cy + r * 1.25);
  ctx.lineTo(cx - r * 0.05, cy + r * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.font = canvasFont('Inter', sizePx, 700);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(WATERMARK_TEXT, x + h * 1.02, cy + sizePx * 0.04);
  ctx.restore();
}

/** Plan watermark (free plan exports): a small translucent pill in the bottom-right corner. */
function drawWatermark(target: LayerTarget): void {
  const { ctx, width, height } = target;
  const h = WATERMARK.height * height;
  const sizePx = WATERMARK.fontSize * height;
  ctx.save();
  ctx.font = canvasFont('Inter', sizePx, 700);
  const w = h * 1.02 + ctx.measureText(WATERMARK_TEXT).width + h * 0.45;
  ctx.restore();
  const x = width - WATERMARK.inset * height - w;
  const y = height - WATERMARK.inset * height - h;
  const raster = cachedRaster(
    `watermark|${width}x${height}`,
    { x: x - 1, y: y - 1, w: w + 2, h: h + 2 },
    (c) => paintWatermark(c, x, y, w, h, height),
  );
  if (raster) ctx.drawImage(raster.canvas, raster.x, raster.y);
  else paintWatermark(ctx, x, y, w, h, height);
}
