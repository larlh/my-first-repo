import type { Ctx2D, RenderImage, RenderPlatform } from './types';

/**
 * Apply a greyscale alpha matte to an image: white = keep, black = transparent (the matte's
 * luminance multiplies the image's alpha). The matte is scaled to the image size. Isomorphic —
 * the ONE definition of "portrait + mask → cut-out", used by:
 *  - the photo-avatar job to write `cutout.png` (via `cutoutPng` in @parlante/renderer/node)
 *  - the stock route `GET /api/stock-avatars/:id/cutout`
 *  - the render job when it merges the engine's `mask-image` matte into clip frames
 *  - a browser client that only has `imageUrl` + `maskUrl`
 * Returns the canvas it drew on, so callers can encode it or draw it.
 */
export function matteCanvas(
  platform: RenderPlatform,
  image: RenderImage,
  mask: RenderImage | null,
): { canvas: unknown; ctx: Ctx2D; image: RenderImage } {
  const width = Math.round(image.width);
  const height = Math.round(image.height);
  const { canvas, ctx } = platform.createCanvas(width, height);
  const result: RenderImage = { source: canvas as CanvasImageSource, width, height };
  if (width === 0 || height === 0) return { canvas, ctx, image: result };
  if (mask) {
    ctx.drawImage(mask.source, 0, 0, width, height);
    const matte = ctx.getImageData(0, 0, width, height).data;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image.source, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      // Rec. 601 luma of the matte pixel, weighted by its own alpha.
      const luma =
        ((matte[i] ?? 0) * 0.299 + (matte[i + 1] ?? 0) * 0.587 + (matte[i + 2] ?? 0) * 0.114) *
        ((matte[i + 3] ?? 255) / 255);
      data[i + 3] = Math.round(((data[i + 3] ?? 0) * luma) / 255);
    }
    ctx.putImageData(pixels, 0, 0);
  } else {
    ctx.drawImage(image.source, 0, 0, width, height);
  }
  return { canvas, ctx, image: result };
}

/** `matteCanvas` returning just the drawable cut-out. */
export function applyAlphaMatte(
  platform: RenderPlatform,
  image: RenderImage,
  mask: RenderImage | null,
): RenderImage {
  return matteCanvas(platform, image, mask).image;
}
