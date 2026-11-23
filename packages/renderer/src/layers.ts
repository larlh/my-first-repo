import { EMPTY_SCENE_RUNTIME, mediaRefKey } from '@parlante/shared';
import type {
  AvatarFraming,
  AvatarLayer,
  Fit,
  ImageLayer,
  Layer,
  PhotoLandmarks,
  RenderRuntime,
  Scene,
  ShapeLayer,
  TextLayer,
  VideoLayer,
} from '@parlante/shared';
import { layerPoseAt } from './animation';
import type { LayerPose } from './animation';
import { photoAvatarPlacement } from './avatars/photo';
import { computeAvatarState } from './avatars/state';
import { drawPlaceholder, fitRect, setSmoothing } from './background';
import type { DrawTarget } from './background';
import { acquireScratch, cachedRaster, objectKey, releaseScratch } from './cache';
import { avatarClipTimeMs, mediaTimeMs, videoLayerRawMs } from './media';
import { layoutTextBlock, paintTextBlock } from './text';
import type { Ctx2D, PixelBox, RenderImage } from './types';

/* -------------------------------------------------------------------------------------------
 * Layer drawing: one function per layer type plus the machinery they share (pose, rotation,
 * group opacity, pre-rasterised static content).
 *
 * Opacity is always applied to the layer AS A WHOLE: a half-transparent avatar or outlined
 * title is composited from an off-screen copy, so its overlapping parts never show through
 * each other.
 * ----------------------------------------------------------------------------------------- */

export interface LayerTarget extends DrawTarget {
  runtime: RenderRuntime;
}

/** Corner radius of `shape: 'rounded'` avatar masks, as a fraction of the canvas height. */
export const AVATAR_ROUNDED_RADIUS = 0.03;

function toPixels(
  target: DrawTarget,
  box: { x: number; y: number; w: number; h: number },
): PixelBox {
  return {
    x: box.x * target.width,
    y: box.y * target.height,
    w: box.w * target.width,
    h: box.h * target.height,
  };
}

function applyTransform(ctx: Ctx2D, box: PixelBox, rotation: number, pose: LayerPose): void {
  if (pose.dx !== 0 || pose.dy !== 0) ctx.translate(pose.dx, pose.dy);
  if (rotation === 0 && pose.scale === 1) return;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  ctx.translate(cx, cy);
  if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
  if (pose.scale !== 1) ctx.scale(pose.scale, pose.scale);
  ctx.translate(-cx, -cy);
}

/** Device-space bounding box of `rect` under the context's current transform. */
function deviceBounds(ctx: Ctx2D, rect: PixelBox, width: number, height: number): PixelBox | null {
  const m = ctx.getTransform();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y],
    [rect.x, rect.y + rect.h],
    [rect.x + rect.w, rect.y + rect.h],
  ] as const) {
    const dx = m.a * px + m.c * py + m.e;
    const dy = m.b * px + m.d * py + m.f;
    minX = Math.min(minX, dx);
    minY = Math.min(minY, dy);
    maxX = Math.max(maxX, dx);
    maxY = Math.max(maxY, dy);
  }
  const x = Math.max(0, Math.floor(minX) - 1);
  const y = Math.max(0, Math.floor(minY) - 1);
  const right = Math.min(width, Math.ceil(maxX) + 1);
  const bottom = Math.min(height, Math.ceil(maxY) + 1);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Run `draw` with the layer's pose, rotation and opacity applied. With `group` (content made
 * of several overlapping strokes) and a partial opacity, the content is drawn opaque on an
 * off-screen canvas and composited once. `ink` bounds what `draw` may paint, in layer space.
 */
function drawTransformed(
  target: DrawTarget,
  box: PixelBox,
  rotation: number,
  pose: LayerPose,
  alpha: number,
  group: boolean,
  ink: PixelBox,
  draw: (ctx: Ctx2D) => void,
): void {
  const { ctx } = target;
  const scratch = group && alpha < 1 ? acquireScratch(target.width, target.height) : null;
  if (!scratch) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    applyTransform(ctx, box, rotation, pose);
    draw(ctx);
    ctx.restore();
    return;
  }
  try {
    const m = ctx.getTransform();
    scratch.ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    applyTransform(scratch.ctx, box, rotation, pose);
    const area = deviceBounds(scratch.ctx, ink, target.width, target.height);
    if (!area) return;
    draw(scratch.ctx);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha *= alpha;
    ctx.drawImage(scratch.canvas, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h);
    ctx.restore();
  } finally {
    releaseScratch(scratch);
  }
}

/** Blit a bitmap rasterised relative to the whole-pixel origin (`baseX`, `baseY`). */
function blit(
  ctx: Ctx2D,
  raster: { canvas: CanvasImageSource; x: number; y: number },
  baseX: number,
  baseY: number,
  pose: LayerPose,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.drawImage(raster.canvas, baseX + raster.x + pose.dx, baseY + raster.y + pose.dy);
  ctx.restore();
}

function pad(box: PixelBox, amount: number): PixelBox {
  return { x: box.x - amount, y: box.y - amount, w: box.w + amount * 2, h: box.h + amount * 2 };
}

/* ---------- text ---------- */

function drawTextLayer(
  target: LayerTarget,
  layer: TextLayer,
  box: PixelBox,
  pose: LayerPose,
  alpha: number,
): void {
  const { ctx, height } = target;
  const style = layer.style;
  const block = layoutTextBlock(ctx, layer.text, style, box.w, box.h, height);
  if (block.lines.length === 0) return;
  if (target.aligned && layer.rotation === 0 && pose.scale === 1) {
    // Static lettering: rasterise once (relative to the box's whole-pixel origin, so layers
    // that only differ in position share nothing they should not) and blit while it moves.
    const baseX = Math.floor(box.x);
    const baseY = Math.floor(box.y);
    const fx = box.x - baseX;
    const fy = box.y - baseY;
    const raster = cachedRaster(
      `text|${fx.toFixed(3)}|${fy.toFixed(3)}|${block.key}`,
      {
        x: fx + block.bounds.x,
        y: fy + block.bounds.y,
        w: block.bounds.w,
        h: block.bounds.h,
      },
      (c) => paintTextBlock(c, block, style, fx, fy, height),
    );
    if (raster) {
      blit(ctx, raster, baseX, baseY, pose, alpha);
      return;
    }
  }
  const composite = style.stroke !== null || style.shadow !== null || style.background !== null;
  const ink: PixelBox = {
    x: box.x + block.bounds.x,
    y: box.y + block.bounds.y,
    w: block.bounds.w,
    h: block.bounds.h,
  };
  drawTransformed(target, box, layer.rotation, pose, alpha, composite, ink, (c) =>
    paintTextBlock(c, block, style, box.x, box.y, height),
  );
}

/* ---------- image / video ---------- */

/**
 * Paint `image` fitted into `box` with rounded corners. `still` images are resampled with the
 * best filter (they are rasterised once); video frames use a cheaper one.
 */
function paintFitted(
  ctx: Ctx2D,
  image: RenderImage,
  box: PixelBox,
  fit: Fit,
  radiusPx: number,
  still: boolean,
): void {
  if (!(box.w > 0) || !(box.h > 0) || image.width === 0 || image.height === 0) return;
  const dest = fitRect(image.width, image.height, box, fit);
  // The part of the picture that is visible: the box for cover / fill, the picture itself
  // for contain (so rounded corners follow the picture, not the empty bars).
  const visible = fit === 'contain' ? dest : box;
  ctx.save();
  setSmoothing(ctx, still, image.width, dest.w);
  if (radiusPx > 0) {
    ctx.beginPath();
    ctx.roundRect(
      visible.x,
      visible.y,
      visible.w,
      visible.h,
      Math.min(radiusPx, visible.w / 2, visible.h / 2),
    );
    ctx.clip();
  }
  if (fit === 'cover') {
    const scale = dest.w / image.width;
    const sw = box.w / scale;
    const sh = box.h / scale;
    ctx.drawImage(
      image.source,
      (image.width - sw) / 2,
      (image.height - sh) / 2,
      sw,
      sh,
      box.x,
      box.y,
      box.w,
      box.h,
    );
  } else {
    ctx.drawImage(image.source, dest.x, dest.y, dest.w, dest.h);
  }
  ctx.restore();
}

function drawImageLayer(
  target: LayerTarget,
  layer: ImageLayer,
  box: PixelBox,
  pose: LayerPose,
  alpha: number,
): void {
  const { ctx, height } = target;
  const image = target.assets.image(mediaRefKey(layer.src));
  if (!image) {
    drawTransformed(target, box, layer.rotation, pose, alpha, true, box, (c) =>
      drawPlaceholder(c, box, 'image', height),
    );
    return;
  }
  const radiusPx = layer.radius * height;
  // The fitted, rounded picture is rasterised once with the best filter, relative to the
  // box's whole-pixel origin; at rest it is blitted 1:1, and while it rotates or scales the
  // same bitmap is drawn through the transform (bilinear over a pre-filtered image).
  const baseX = Math.floor(box.x);
  const baseY = Math.floor(box.y);
  const local: PixelBox = { x: box.x - baseX, y: box.y - baseY, w: box.w, h: box.h };
  const raster = cachedRaster(
    `image|${objectKey(image.source)}|${image.width}x${image.height}|${layer.fit}|${radiusPx}|${local.x.toFixed(3)}|${local.y.toFixed(3)}|${box.w}|${box.h}`,
    local,
    (c) => paintFitted(c, image, local, layer.fit, radiusPx, true),
  );
  if (raster && target.aligned && layer.rotation === 0 && pose.scale === 1) {
    blit(ctx, raster, baseX, baseY, pose, alpha);
    return;
  }
  drawTransformed(target, box, layer.rotation, pose, alpha, false, box, (c) => {
    if (raster) {
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'low';
      c.drawImage(raster.canvas, baseX + raster.x, baseY + raster.y);
    } else {
      paintFitted(c, image, box, layer.fit, radiusPx, true);
    }
  });
}

function drawVideoLayer(
  target: LayerTarget,
  layer: VideoLayer,
  box: PixelBox,
  pose: LayerPose,
  alpha: number,
  frame: RenderImage | null,
): void {
  const { height } = target;
  if (!frame) {
    drawTransformed(target, box, layer.rotation, pose, alpha, true, box, (c) =>
      drawPlaceholder(c, box, 'video', height),
    );
    return;
  }
  drawTransformed(target, box, layer.rotation, pose, alpha, false, box, (c) =>
    paintFitted(c, frame, box, layer.fit, layer.radius * height, false),
  );
}

/* ---------- shapes ---------- */

/** Ratio between the inner and outer radius of the five-pointed star. */
const STAR_INNER_RATIO = 0.4;

function shapePath(ctx: Ctx2D, layer: ShapeLayer, box: PixelBox, canvasHeight: number): void {
  const { x, y, w, h } = box;
  ctx.beginPath();
  switch (layer.shape) {
    case 'rect': {
      const radius = Math.min(layer.radius * canvasHeight, w / 2, h / 2);
      if (radius > 0) ctx.roundRect(x, y, w, h, radius);
      else ctx.rect(x, y, w, h);
      return;
    }
    case 'ellipse':
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    case 'triangle':
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      return;
    case 'star': {
      const cx = x + w / 2;
      const cy = y + h / 2;
      for (let i = 0; i < 10; i += 1) {
        const ratio = i % 2 === 0 ? 1 : STAR_INNER_RATIO;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const px = cx + Math.cos(angle) * (w / 2) * ratio;
        const py = cy + Math.sin(angle) * (h / 2) * ratio;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      return;
    }
    case 'line':
      return; // drawn as a stroke, see paintShape
  }
}

function paintShape(ctx: Ctx2D, layer: ShapeLayer, box: PixelBox, canvasHeight: number): void {
  if (!(box.w > 0) || !(box.h > 0)) return;
  ctx.save();
  if (layer.shape === 'line') {
    // A segment along the horizontal axis of the box (rotate the layer for other directions):
    // as thick as its stroke, or as the box when it has no stroke. Round ends stay inside.
    const color = layer.stroke?.color ?? layer.fill;
    const thickness = layer.stroke ? layer.stroke.width * canvasHeight : box.h;
    if (color && thickness > 0) {
      const inset = Math.min(thickness, box.w) / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(box.x + inset, box.y + box.h / 2);
      ctx.lineTo(box.x + box.w - inset, box.y + box.h / 2);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  shapePath(ctx, layer, box, canvasHeight);
  if (layer.fill) {
    ctx.fillStyle = layer.fill;
    ctx.fill();
  }
  if (layer.stroke && layer.stroke.width > 0) {
    ctx.strokeStyle = layer.stroke.color;
    ctx.lineWidth = layer.stroke.width * canvasHeight;
    ctx.lineJoin = layer.radius > 0 ? 'round' : 'miter';
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------- avatar ---------- */

function avatarMaskPath(
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
    ctx.roundRect(
      box.x,
      box.y,
      box.w,
      box.h,
      Math.min(canvasHeight * AVATAR_ROUNDED_RADIUS, box.w / 2, box.h / 2),
    );
  }
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
  setSmoothing(ctx, false, image.width, dest.w);
  ctx.drawImage(image.source, dest.x, dest.y, dest.w, dest.h);
  ctx.restore();
}

function paintAvatar(
  ctx: Ctx2D,
  target: LayerTarget,
  scene: Scene,
  layer: AvatarLayer,
  box: PixelBox,
  localMs: number,
  speechMs: number,
  clipFrame: RenderImage | null,
  landmarks: PhotoLandmarks | undefined,
): void {
  ctx.save();
  if (layer.shape !== 'none') {
    if (layer.backdrop) {
      ctx.fillStyle = layer.backdrop;
      avatarMaskPath(ctx, box, layer.shape, target.height);
      ctx.fill();
    }
    avatarMaskPath(ctx, box, layer.shape, target.height);
    ctx.clip();
  }
  const rig = clipFrame ? null : target.assets.avatar(layer.avatarId);
  if (clipFrame) {
    // Photorealistic avatar: neural clip (with alpha), placed exactly like the stand-in.
    drawAvatarClipFrame(ctx, clipFrame, box, layer.framing, landmarks, layer.flip);
  } else if (rig) {
    const state = computeAvatarState({
      runtime: target.runtime.scenes[scene.id] ?? EMPTY_SCENE_RUNTIME,
      speechMs,
      sceneMs: localMs,
      seed: `${scene.id}:${layer.id}`,
    });
    rig.draw(ctx, box, state, {
      framing: layer.framing,
      flip: layer.flip,
      quality: target.quality,
    });
  } else {
    drawPlaceholder(ctx, box, 'avatar', target.height);
  }
  ctx.restore();
}

/* ---------- entry point ---------- */

/**
 * Draw one layer of `scene` at scene-local time `localMs` (the caller has checked
 * `layerActiveAt` and paints layers in z order). Video frames and avatar clip frames are
 * requested from the assets even while an animation keeps the layer invisible, so the media
 * clock (`mediaPlaybackAt`) always predicts exactly what is asked.
 */
export function drawLayer(
  target: LayerTarget,
  scene: Scene,
  layer: Layer,
  localMs: number,
  speechMs: number,
  sceneDurationMs: number,
): void {
  const box = toPixels(target, layer.box);
  const pose = layerPoseAt(layer, localMs, sceneDurationMs, target.height);
  const alpha = layer.opacity * pose.alpha;
  const hidden = !(alpha > 0) || !(pose.scale > 0.001);

  switch (layer.type) {
    case 'text':
      if (!hidden) drawTextLayer(target, layer, box, pose, alpha);
      return;
    case 'image':
      if (!hidden) drawImageLayer(target, layer, box, pose, alpha);
      return;
    case 'video': {
      const source = target.assets.video(mediaRefKey(layer.src));
      const t = mediaTimeMs(videoLayerRawMs(layer, localMs), layer.loop, source?.durationMs ?? 0);
      const frame = source?.frameAt(t) ?? null;
      if (!hidden) drawVideoLayer(target, layer, box, pose, alpha, frame);
      return;
    }
    case 'shape': {
      if (hidden) return;
      const strokePx = layer.stroke ? layer.stroke.width * target.height : 0;
      const composite = layer.fill !== null && strokePx > 0;
      drawTransformed(
        target,
        box,
        layer.rotation,
        pose,
        alpha,
        composite,
        pad(box, strokePx + 2),
        (c) => paintShape(c, layer, box, target.height),
      );
      return;
    }
    case 'avatar': {
      const clip = target.assets.avatarClip(scene.id, layer.id);
      const clipFrame = clip ? clip.frameAt(avatarClipTimeMs(clip, localMs, speechMs)) : null;
      if (hidden) return;
      // A little slack around the box: rigs are asked to stay inside, soft edges may not.
      const ink = pad(box, Math.max(box.w, box.h) * 0.05 + 2);
      drawTransformed(target, box, layer.rotation, pose, alpha, true, ink, (c) =>
        paintAvatar(c, target, scene, layer, box, localMs, speechMs, clipFrame, clip?.landmarks),
      );
      return;
    }
  }
}
