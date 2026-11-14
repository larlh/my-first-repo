import { EMPTY_SCENE_RUNTIME, mediaRefKey } from '@parlante/shared';
import type {
  AvatarFraming,
  Background,
  Composition,
  Fit,
  Layer,
  PhotoLandmarks,
  RenderRuntime,
  Scene,
} from '@parlante/shared';
import { photoAvatarPlacement } from './avatars/photo';
import { computeAvatarState } from './avatars/state';
import { clamp01, ease } from './easing';
import { canvasFont } from './fonts';
import {
  avatarClipTimeMs,
  backgroundVideoRawMs,
  layerActiveAt,
  mediaTimeMs,
  sceneInstantsAt,
  videoLayerRawMs,
} from './media';
import { drawSubtitleCue } from './subtitle-draw';
import { buildSubtitleCues, cueAt } from './subtitles';
import { computeTimeline } from './timeline';
import type { Timeline } from './timeline';
import type { Ctx2D, PixelBox, RenderAssets, RenderImage, RenderOptions } from './types';

/* -------------------------------------------------------------------------------------------
 * renderFrame — THE entry point of the renderer. Draws the frame of `composition` at video
 * time `tMs` onto `ctx`. Pure and deterministic: same arguments ⇒ same pixels. Used verbatim
 * by the Studio live preview (browser) and by the export worker (Node).
 *
 * BASELINE implementation by the architect: correct structure (timeline → scene → background →
 * z-ordered layers → transition → subtitles → watermark) with simplified drawing. Owner:
 * renderer-core, who completes each `draw*` function (text wrapping and styles, all shapes,
 * gradients, layer animations, every transition type, subtitle presets, blur/dim, masks).
 * Keep the exported signature stable.
 *
 * Two pieces are deliberately NOT private to this file, because other code must agree with
 * them exactly — keep routing through them when completing the drawing:
 *  - media clock (./media): which scene(s) are drawn and at which time every video is sampled
 *    (`sceneInstantsAt`, `mediaTimeMs`, `avatarClipTimeMs`), mirrored by `mediaPlaybackAt`
 *  - photoreal placement (`photoAvatarPlacement`): shared by the stand-in rig and the clip
 * ----------------------------------------------------------------------------------------- */

interface Frame {
  ctx: Ctx2D;
  /** Output size in pixels. */
  width: number;
  height: number;
  composition: Composition;
  runtime: RenderRuntime;
  assets: RenderAssets;
  quality: 'preview' | 'final';
}

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
  const frame: Frame = {
    ctx,
    width,
    height,
    composition,
    runtime,
    assets,
    quality: options.quality ?? 'final',
  };
  // One scene normally; during a transition the frozen previous scene, then the incoming one.
  const instants = sceneInstantsAt(composition, timeline, tMs);
  const current = instants[instants.length - 1];
  if (!current) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);

  for (const instant of instants) {
    if (instant.frozen || instant.transitionProgress >= 1) {
      drawScene(frame, instant.scene, instant.localMs, instant.speechMs);
    } else {
      // Incoming scene blended on top of the frozen previous one.
      ctx.save();
      ctx.globalAlpha = clamp01(ease('ease-in-out', instant.transitionProgress));
      drawScene(frame, instant.scene, instant.localMs, instant.speechMs);
      ctx.restore();
    }
  }

  const showSubtitles = options.subtitles ?? composition.subtitles.enabled;
  if (showSubtitles) drawSubtitles(frame, current.scene, current.speechMs);
  if (options.watermark) drawWatermark(frame);
  ctx.restore();
}

function drawScene(frame: Frame, scene: Scene, localMs: number, speechMs: number): void {
  drawBackground(frame, scene.background, localMs);
  const ordered = scene.layers
    .map((layer, index) => ({ layer, index }))
    .filter(({ layer }) => layerActiveAt(layer, localMs))
    .sort((a, b) => a.layer.z - b.layer.z || a.index - b.index);
  for (const { layer } of ordered) drawLayer(frame, scene, layer, localMs, speechMs);
}

function toPixels(frame: Frame, box: { x: number; y: number; w: number; h: number }): PixelBox {
  return {
    x: box.x * frame.width,
    y: box.y * frame.height,
    w: box.w * frame.width,
    h: box.h * frame.height,
  };
}

/** Draw `image` into `box` honouring the fit mode (cover crops, contain letterboxes). */
export function drawImageFit(ctx: Ctx2D, image: RenderImage, box: PixelBox, fit: Fit): void {
  if (fit === 'fill' || image.width === 0 || image.height === 0) {
    ctx.drawImage(image.source, box.x, box.y, box.w, box.h);
    return;
  }
  const scale =
    fit === 'cover'
      ? Math.max(box.w / image.width, box.h / image.height)
      : Math.min(box.w / image.width, box.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.drawImage(image.source, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
  ctx.restore();
}

function drawBackground(frame: Frame, background: Background, localMs: number): void {
  const { ctx, width, height } = frame;
  const full: PixelBox = { x: 0, y: 0, w: width, h: height };
  switch (background.type) {
    case 'color':
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, width, height);
      return;
    case 'gradient': {
      const { gradient } = background;
      let fill: CanvasGradient;
      if (gradient.kind === 'radial') {
        fill = ctx.createRadialGradient(
          width / 2,
          height / 2,
          0,
          width / 2,
          height / 2,
          Math.hypot(width, height) / 2,
        );
      } else {
        const rad = (gradient.angle * Math.PI) / 180;
        const dx = (Math.cos(rad) * width) / 2;
        const dy = (Math.sin(rad) * height) / 2;
        fill = ctx.createLinearGradient(
          width / 2 - dx,
          height / 2 - dy,
          width / 2 + dx,
          height / 2 + dy,
        );
      }
      for (const stop of gradient.stops) fill.addColorStop(stop.offset, stop.color);
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, width, height);
      return;
    }
    case 'image': {
      const image = frame.assets.image(mediaRefKey(background.src));
      if (image) drawImageFit(ctx, image, full, background.fit);
      else drawPlaceholder(frame, full, 'image');
      if (background.dim > 0) dim(frame, background.dim);
      return;
    }
    case 'video': {
      const source = frame.assets.video(mediaRefKey(background.src));
      const t = mediaTimeMs(
        backgroundVideoRawMs(background, localMs),
        background.loop,
        source?.durationMs ?? 0,
      );
      const image = source?.frameAt(t) ?? null;
      if (image) drawImageFit(ctx, image, full, background.fit);
      else drawPlaceholder(frame, full, 'video');
      if (background.dim > 0) dim(frame, background.dim);
      return;
    }
  }
}

function dim(frame: Frame, amount: number): void {
  frame.ctx.save();
  frame.ctx.globalAlpha = clamp01(amount);
  frame.ctx.fillStyle = '#000000';
  frame.ctx.fillRect(0, 0, frame.width, frame.height);
  frame.ctx.restore();
}

/** Neutral stand-in for media that is not loaded (never throws, never blocks a render). */
function drawPlaceholder(frame: Frame, box: PixelBox, label: string): void {
  const { ctx } = frame;
  ctx.save();
  ctx.fillStyle = '#2a2f45';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = '#8c93b8';
  ctx.lineWidth = Math.max(1, frame.height * 0.003);
  ctx.setLineDash([frame.height * 0.012, frame.height * 0.012]);
  ctx.strokeRect(box.x, box.y, box.w, box.h);
  ctx.fillStyle = '#c3c8e6';
  ctx.font = canvasFont('Inter', Math.max(10, Math.min(box.h * 0.2, frame.height * 0.03)), 500);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2);
  ctx.restore();
}

function drawLayer(
  frame: Frame,
  scene: Scene,
  layer: Layer,
  localMs: number,
  speechMs: number,
): void {
  const { ctx } = frame;
  const box = toPixels(frame, layer.box);
  ctx.save();
  ctx.globalAlpha *= layer.opacity;
  if (layer.rotation !== 0) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  switch (layer.type) {
    case 'avatar': {
      const rig = frame.assets.avatar(layer.avatarId);
      if (layer.shape !== 'none') {
        if (layer.backdrop) {
          ctx.fillStyle = layer.backdrop;
          clipShape(ctx, box, layer.shape, frame.height);
          ctx.fill();
        }
        clipShape(ctx, box, layer.shape, frame.height);
        ctx.clip();
      }
      const clip = frame.assets.avatarClip(scene.id, layer.id);
      const clipFrame = clip ? clip.frameAt(avatarClipTimeMs(clip, localMs, speechMs)) : null;
      if (clip && clipFrame) {
        // Photorealistic avatar: neural clip (with alpha), placed exactly like the stand-in.
        drawAvatarClipFrame(ctx, clipFrame, box, layer.framing, clip.landmarks, layer.flip);
      } else if (rig) {
        const state = computeAvatarState({
          runtime: frame.runtime.scenes[scene.id] ?? EMPTY_SCENE_RUNTIME,
          speechMs,
          sceneMs: localMs,
          seed: `${scene.id}:${layer.id}`,
        });
        rig.draw(ctx, box, state, {
          framing: layer.framing,
          flip: layer.flip,
          quality: frame.quality,
        });
      } else {
        drawPlaceholder(frame, box, 'avatar');
      }
      break;
    }
    case 'text': {
      const style = layer.style;
      const sizePx = style.fontSize * frame.height;
      ctx.font = canvasFont(style.fontFamily, sizePx, style.fontWeight, style.italic);
      ctx.fillStyle = style.color;
      ctx.textAlign = style.align;
      ctx.textBaseline = 'middle';
      const x =
        style.align === 'left'
          ? box.x
          : style.align === 'right'
            ? box.x + box.w
            : box.x + box.w / 2;
      const lines = (style.uppercase ? layer.text.toUpperCase() : layer.text).split('\n');
      const lineHeight = sizePx * style.lineHeight;
      const startY = box.y + box.h / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, i) => ctx.fillText(line, x, startY + i * lineHeight, box.w));
      break;
    }
    case 'image': {
      const image = frame.assets.image(mediaRefKey(layer.src));
      if (image) drawImageFit(ctx, image, box, layer.fit);
      else drawPlaceholder(frame, box, 'image');
      break;
    }
    case 'video': {
      const source = frame.assets.video(mediaRefKey(layer.src));
      const t = mediaTimeMs(videoLayerRawMs(layer, localMs), layer.loop, source?.durationMs ?? 0);
      const image = source?.frameAt(t) ?? null;
      if (image) drawImageFit(ctx, image, box, layer.fit);
      else drawPlaceholder(frame, box, 'video');
      break;
    }
    case 'shape': {
      ctx.beginPath();
      if (layer.shape === 'ellipse') {
        ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.roundRect(box.x, box.y, box.w, box.h, layer.radius * frame.height);
      }
      if (layer.fill) {
        ctx.fillStyle = layer.fill;
        ctx.fill();
      }
      if (layer.stroke) {
        ctx.strokeStyle = layer.stroke.color;
        ctx.lineWidth = layer.stroke.width * frame.height;
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * Draw a neural clip frame where `photoAvatarPlacement` puts it — the same rectangle the
 * stand-in rig uses for the same box, framing and landmarks — clipped to the layer box.
 */
function drawAvatarClipFrame(
  ctx: Ctx2D,
  image: RenderImage,
  box: PixelBox,
  framing: AvatarFraming,
  landmarks: PhotoLandmarks | undefined,
  flip: boolean,
): void {
  if (image.width === 0 || image.height === 0) return;
  const dest = photoAvatarPlacement(image.width, image.height, box, framing, landmarks);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  if (flip) {
    ctx.translate(2 * (box.x + box.w / 2), 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(image.source, dest.x, dest.y, dest.w, dest.h);
  ctx.restore();
}

function clipShape(
  ctx: Ctx2D,
  box: PixelBox,
  shape: 'circle' | 'rounded',
  canvasHeight: number,
): void {
  ctx.beginPath();
  if (shape === 'circle') {
    const r = Math.min(box.w, box.h) / 2;
    ctx.arc(box.x + box.w / 2, box.y + box.h / 2, r, 0, Math.PI * 2);
  } else {
    ctx.roundRect(box.x, box.y, box.w, box.h, canvasHeight * 0.03);
  }
}

function drawSubtitles(frame: Frame, scene: Scene, speechMs: number): void {
  const sceneRuntime = frame.runtime.scenes[scene.id];
  if (!sceneRuntime || sceneRuntime.words.length === 0) return;
  const style = frame.composition.subtitles;
  const cue = cueAt(buildSubtitleCues(sceneRuntime.words, style), speechMs);
  if (cue) drawSubtitleCue(frame.ctx, cue, style, frame.width, frame.height, speechMs);
}

function drawWatermark(frame: Frame): void {
  const { ctx, width, height } = frame;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.font = canvasFont('Inter', height * 0.028, 700);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Parlante', width - height * 0.025, height - height * 0.02);
  ctx.restore();
}
