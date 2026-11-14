import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import type { Composition, RenderRuntime } from '@parlante/shared';
import { listFontFiles } from '../fonts';
import { renderFrame } from '../render-frame';
import type { Ctx2D, RenderAssets, RenderImage, RenderOptions, RenderPlatform } from '../types';

/* -------------------------------------------------------------------------------------------
 * Node adapter (@napi-rs/canvas, Skia). Import from `@parlante/renderer/node` — never from
 * browser code.
 * ----------------------------------------------------------------------------------------- */

export type NodeCanvas = Canvas;

const require = createRequire(import.meta.url);
let fontsRegistered: number | null = null;

/**
 * Register every bundled @fontsource file (woff2) under its family name. All subsets of a
 * family share the name, so Latin, Cyrillic and Greek text resolve to the same family.
 * Idempotent; returns the number of font files registered.
 */
export function registerNodeFonts(): number {
  if (fontsRegistered !== null) return fontsRegistered;
  let count = 0;
  const dirs = new Map<string, string | null>();
  for (const font of listFontFiles()) {
    let dir = dirs.get(font.package);
    if (dir === undefined) {
      try {
        dir = path.join(path.dirname(require.resolve(`${font.package}/package.json`)), 'files');
      } catch {
        dir = null;
      }
      dirs.set(font.package, dir);
    }
    if (!dir) continue;
    const file = path.join(dir, font.file);
    if (!fs.existsSync(file)) continue; // not every family ships every subset/style
    if (GlobalFonts.registerFromPath(file, font.family)) count += 1;
  }
  fontsRegistered = count;
  return count;
}

/** Create a canvas and its 2D context typed for the renderer. */
export function createNodeCanvas(
  width: number,
  height: number,
): { canvas: NodeCanvas; ctx: Ctx2D } {
  const canvas = createCanvas(Math.round(width), Math.round(height));
  // The Skia context implements the Canvas 2D API used by the renderer.
  const ctx = canvas.getContext('2d') as unknown as Ctx2D;
  return { canvas, ctx };
}

/** Decode image bytes (PNG/JPEG/WebP/GIF/SVG) or a local file path. */
export async function loadNodeImage(source: Uint8Array | string): Promise<RenderImage> {
  const image = await loadImage(typeof source === 'string' ? source : Buffer.from(source));
  return {
    source: image as unknown as CanvasImageSource,
    width: image.width,
    height: image.height,
  };
}

/** Wrap a canvas as a RenderImage (e.g. pre-rendered layers, generated stock images). */
export function canvasAsImage(canvas: NodeCanvas): RenderImage {
  return {
    source: canvas as unknown as CanvasImageSource,
    width: canvas.width,
    height: canvas.height,
  };
}

export const nodePlatform: RenderPlatform = {
  name: 'node',
  createCanvas: createNodeCanvas,
  loadImage: loadNodeImage,
  ensureFonts: async () => {
    registerNodeFonts();
  },
};

/** Raw RGBA pixels of a canvas (what the worker pipes to ffmpeg as `-f rawvideo -pix_fmt rgba`). */
export function canvasToRgba(canvas: NodeCanvas): Buffer {
  return canvas.data();
}

export function canvasToPng(canvas: NodeCanvas): Buffer {
  return canvas.toBuffer('image/png');
}

export function canvasToJpeg(canvas: NodeCanvas, quality = 85): Buffer {
  return canvas.toBuffer('image/jpeg', quality);
}

/** Convenience for thumbnails and tests: render one frame and encode it as PNG. */
export function renderFrameToPng(
  composition: Composition,
  tMs: number,
  runtime: RenderRuntime,
  assets: RenderAssets,
  options: RenderOptions = {},
): Buffer {
  registerNodeFonts();
  const width = options.width ?? composition.canvas.width;
  const height = options.height ?? composition.canvas.height;
  const { canvas, ctx } = createNodeCanvas(width, height);
  renderFrame(ctx, composition, tMs, runtime, assets, { ...options, width, height });
  return canvasToPng(canvas);
}
