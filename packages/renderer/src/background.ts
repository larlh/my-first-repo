import { mediaRefKey } from '@parlante/shared';
import type { Background, Fit, Gradient } from '@parlante/shared';
import { cachedRaster, objectKey } from './cache';
import { clamp01 } from './easing';
import { canvasFont } from './fonts';
import { backgroundVideoRawMs, mediaTimeMs } from './media';
import type { Ctx2D, PixelBox, RenderAssets, RenderImage } from './types';

/* -------------------------------------------------------------------------------------------
 * Scene backgrounds and the image-fitting primitives shared with image / video layers.
 * A background leaves the frame fully opaque (letterbox bars are black); the one exception is
 * a covering VIDEO that itself has transparent pixels, which is drawn as it is.
 * ----------------------------------------------------------------------------------------- */

/** What the drawing helpers need to know about the frame being rendered. */
export interface DrawTarget {
  ctx: Ctx2D;
  /** Output size in pixels. */
  width: number;
  height: number;
  assets: RenderAssets;
  quality: 'preview' | 'final';
  /**
   * True while the context transform is a whole-pixel translation: pre-rasterised bitmaps can
   * then be blitted 1:1. False under scene zooms and for rotated / scaled layers.
   */
  aligned: boolean;
}

/** Rectangle `image` occupies when fitted into `box` (cover overflows it, contain is inside). */
export function fitRect(imageW: number, imageH: number, box: PixelBox, fit: Fit): PixelBox {
  if (fit === 'fill' || !(imageW > 0) || !(imageH > 0)) return { ...box };
  const scale =
    fit === 'cover'
      ? Math.max(box.w / imageW, box.h / imageH)
      : Math.min(box.w / imageW, box.h / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * Resampling filter for a draw that maps `sourceW` pixels onto `destW`:
 *  - `still` pictures are rasterised once and cached, so they get the best filter
 *  - video frames are drawn every frame: bilinear, with mip-maps only when shrinking a lot
 */
export function setSmoothing(ctx: Ctx2D, still: boolean, sourceW: number, destW: number): void {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = still ? 'high' : destW < sourceW * 0.6 ? 'medium' : 'low';
}

/**
 * Draw `image` into `box` honouring the fit mode (cover crops, contain letterboxes).
 * Pass `still: false` for frames of a video (cheaper filter, see `setSmoothing`).
 */
export function drawImageFit(
  ctx: Ctx2D,
  image: RenderImage,
  box: PixelBox,
  fit: Fit,
  still = true,
): void {
  if (!(box.w > 0) || !(box.h > 0)) return;
  ctx.save();
  if (fit === 'fill' || image.width === 0 || image.height === 0) {
    setSmoothing(ctx, still, image.width, box.w);
    ctx.drawImage(image.source, box.x, box.y, box.w, box.h);
    ctx.restore();
    return;
  }
  const dest = fitRect(image.width, image.height, box, fit);
  setSmoothing(ctx, still, image.width, dest.w);
  if (fit === 'cover') {
    // Crop on the SOURCE side instead of clipping: no clip path, no anti-aliased seams.
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

/** Neutral stand-in for media that is not loaded (never throws, never blocks a render). */
export function drawPlaceholder(
  ctx: Ctx2D,
  box: PixelBox,
  label: string,
  canvasHeight: number,
): void {
  if (!(box.w > 0) || !(box.h > 0)) return;
  ctx.save();
  ctx.fillStyle = '#2a2f45';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  const inset = Math.max(1, canvasHeight * 0.003);
  ctx.strokeStyle = '#8c93b8';
  ctx.lineWidth = inset;
  ctx.setLineDash([canvasHeight * 0.012, canvasHeight * 0.012]);
  ctx.strokeRect(
    box.x + inset / 2,
    box.y + inset / 2,
    Math.max(0, box.w - inset),
    Math.max(0, box.h - inset),
  );
  const sizePx = Math.max(8, Math.min(box.h * 0.2, box.w * 0.16, canvasHeight * 0.03));
  if (box.h >= sizePx * 1.6) {
    ctx.fillStyle = '#c3c8e6';
    ctx.font = canvasFont('Inter', sizePx, 500);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, box.x + box.w / 2, box.y + box.h / 2, box.w * 0.9);
  }
  ctx.restore();
}

/** CanvasGradient for a `Gradient` filling the rectangle (0,0)-(width,height). */
export function createGradientFill(
  ctx: Ctx2D,
  gradient: Gradient,
  width: number,
  height: number,
): CanvasGradient {
  let fill: CanvasGradient;
  const cx = width / 2;
  const cy = height / 2;
  if (gradient.kind === 'radial') {
    fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width, height) / 2);
  } else {
    // CSS-style gradient line through the centre: its length makes the first / last stop land
    // exactly on the corners, whatever the angle (0° = left→right, 90° = top→bottom).
    const rad = (gradient.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const half = (Math.abs(width * cos) + Math.abs(height * sin)) / 2;
    fill = ctx.createLinearGradient(
      cx - cos * half,
      cy - sin * half,
      cx + cos * half,
      cy + sin * half,
    );
  }
  const stops = [...gradient.stops].sort((a, b) => a.offset - b.offset);
  for (const stop of stops) fill.addColorStop(clamp01(stop.offset), stop.color);
  return fill;
}

function dim(ctx: Ctx2D, amount: number, width: number, height: number): void {
  if (!(amount > 0)) return;
  ctx.save();
  ctx.globalAlpha = clamp01(amount);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** True when `ctx.filter` exists (Chromium, Firefox, Skia in Node). Safari lacks it. */
function supportsFilter(ctx: Ctx2D): boolean {
  return typeof (ctx as { filter?: unknown }).filter === 'string';
}

/** Paint an image background (fit, blur) over black. */
function paintImageBackground(
  ctx: Ctx2D,
  image: RenderImage,
  fit: Fit,
  blurPx: number,
  width: number,
  height: number,
): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  const full: PixelBox = { x: 0, y: 0, w: width, h: height };
  if (!(blurPx > 0.25)) {
    drawImageFit(ctx, image, full, fit);
    return;
  }
  // Blurring pulls in whatever lies beyond the picture's edges. A covering image is drawn
  // slightly oversized so its edges stay outside the frame and no dark halo appears.
  const bleed = fit === 'contain' ? 0 : Math.ceil(blurPx * 2.5);
  const box: PixelBox = { x: -bleed, y: -bleed, w: width + bleed * 2, h: height + bleed * 2 };
  ctx.save();
  if (supportsFilter(ctx)) {
    ctx.filter = `blur(${blurPx}px)`;
    drawImageFit(ctx, image, box, fit);
  } else {
    // No canvas filters: approximate the blur by averaging offset copies (two rings).
    drawImageFit(ctx, image, box, fit);
    const taps = 12;
    for (let ring = 1; ring <= 2; ring += 1) {
      for (let i = 0; i < taps; i += 1) {
        const angle = (i / taps) * Math.PI * 2 + ring;
        const radius = (blurPx * ring) / 1.5;
        ctx.globalAlpha = 1 / (i + 2 + (ring - 1) * taps);
        drawImageFit(
          ctx,
          image,
          { ...box, x: box.x + Math.cos(angle) * radius, y: box.y + Math.sin(angle) * radius },
          fit,
        );
      }
    }
  }
  ctx.restore();
}

/**
 * Paint the scene background at scene-local time `localMs`. Static backgrounds (gradients,
 * images with their fit / blur / dim) are rasterised once per output size and blitted.
 */
export function drawBackground(target: DrawTarget, background: Background, localMs: number): void {
  const { ctx, width, height } = target;
  const full: PixelBox = { x: 0, y: 0, w: width, h: height };
  switch (background.type) {
    case 'color': {
      // An opaque base first: a translucent colour must not leave the frame see-through.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, width, height);
      return;
    }
    case 'gradient': {
      const paint = (c: Ctx2D) => {
        c.fillStyle = '#000000';
        c.fillRect(0, 0, width, height);
        c.fillStyle = createGradientFill(c, background.gradient, width, height);
        c.fillRect(0, 0, width, height);
      };
      const raster = target.aligned
        ? cachedRaster(
            `bg-gradient|${width}x${height}|${JSON.stringify(background.gradient)}`,
            full,
            paint,
          )
        : null;
      if (raster) ctx.drawImage(raster.canvas, raster.x, raster.y);
      else paint(ctx);
      return;
    }
    case 'image': {
      const image = target.assets.image(mediaRefKey(background.src));
      if (!image) {
        drawPlaceholder(ctx, full, 'image', height);
        return;
      }
      const blurPx = background.blur * height;
      const paint = (c: Ctx2D) => {
        paintImageBackground(c, image, background.fit, blurPx, width, height);
        dim(c, background.dim, width, height);
      };
      const raster = target.aligned
        ? cachedRaster(
            `bg-image|${width}x${height}|${objectKey(image.source)}|${image.width}x${image.height}|${background.fit}|${background.blur}|${background.dim}`,
            full,
            paint,
          )
        : null;
      if (raster) {
        ctx.drawImage(raster.canvas, raster.x, raster.y);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        paint(ctx);
        ctx.restore();
      }
      return;
    }
    case 'video': {
      const source = target.assets.video(mediaRefKey(background.src));
      const t = mediaTimeMs(
        backgroundVideoRawMs(background, localMs),
        background.loop,
        source?.durationMs ?? 0,
      );
      const image = source?.frameAt(t) ?? null;
      if (!image) {
        drawPlaceholder(ctx, full, 'video', height);
        return;
      }
      if (background.fit === 'contain') {
        // Letterbox bars. (Covering fits paint every pixel themselves.)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
      }
      drawImageFit(ctx, image, full, background.fit, false);
      dim(ctx, background.dim, width, height);
      return;
    }
  }
}
