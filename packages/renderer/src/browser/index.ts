import { FONT_FAMILY_NAMES, FONT_WEIGHTS } from '@parlante/shared';
import type { Ctx2D, RenderImage, RenderPlatform, VideoFrameSource } from '../types';

/* -------------------------------------------------------------------------------------------
 * Browser adapter. Import from `@parlante/renderer/browser`.
 * Fonts: the web app must import the @fontsource CSS for every bundled family/weight (see
 * apps/web/src/fonts.css); `ensureBrowserFonts()` then waits until they are usable on canvas.
 * ----------------------------------------------------------------------------------------- */

export function createBrowserCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: Ctx2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  return { canvas, ctx };
}

/** Decode an image from a URL (same-origin or CORS-enabled) or from bytes. */
export async function loadBrowserImage(source: Uint8Array | string): Promise<RenderImage> {
  const blob =
    typeof source === 'string'
      ? await fetch(source, { credentials: 'include' }).then((res) => {
          if (!res.ok) throw new Error(`Failed to load image (${res.status})`);
          return res.blob();
        })
      : new Blob([source as BlobPart]);
  const bitmap = await createImageBitmap(blob);
  return { source: bitmap, width: bitmap.width, height: bitmap.height };
}

let fontsReady: Promise<void> | null = null;

/** Wait until every bundled family/weight can be drawn on a canvas. Idempotent. */
export function ensureBrowserFonts(): Promise<void> {
  fontsReady ??= (async () => {
    const loads: Promise<unknown>[] = [];
    for (const family of FONT_FAMILY_NAMES) {
      for (const weight of FONT_WEIGHTS) {
        loads.push(document.fonts.load(`${weight} 16px "${family}"`).catch(() => undefined));
      }
    }
    await Promise.all(loads);
    await document.fonts.ready;
  })();
  return fontsReady;
}

/**
 * VideoFrameSource backed by an HTMLVideoElement. The preview player is responsible for
 * seeking/playing the element; `frameAt` returns whatever frame is currently decoded.
 */
export function videoElementSource(video: HTMLVideoElement): VideoFrameSource {
  return {
    get durationMs() {
      return Number.isFinite(video.duration) ? video.duration * 1000 : 0;
    },
    get width() {
      return video.videoWidth;
    },
    get height() {
      return video.videoHeight;
    },
    frameAt: () =>
      video.readyState >= 2
        ? { source: video, width: video.videoWidth, height: video.videoHeight }
        : null,
  };
}

export const browserPlatform: RenderPlatform = {
  name: 'browser',
  createCanvas: createBrowserCanvas,
  loadImage: loadBrowserImage,
  ensureFonts: ensureBrowserFonts,
};
