import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import type { Composition, RenderRuntime } from '@parlante/shared';
import { setCanvasFactory } from '../cache';
import { FONT_FAMILY_NAMES } from '@parlante/shared';
import { listFontFiles, setRegisteredFamilyNames } from '../fonts';
import { matteCanvas } from '../matte';
import { renderFrame } from '../render-frame';
import type { Ctx2D, RenderAssets, RenderImage, RenderOptions, RenderPlatform } from '../types';
import { createFrameRenderer as createFrameRendererWith } from './frames';
import type { FrameRenderer, FrameRendererOptions } from './frames';

export { prepareMediaAt } from './frames';
export type { FrameRenderer, FrameRendererOptions } from './frames';
export { createRawVideoSource, isPreparable, openAvatarClipSource, openVideoSource } from './video';
export type { OpenVideoOptions, PreparableVideoSource, RawVideoSourceOptions } from './video';

/* -------------------------------------------------------------------------------------------
 * Node adapter (@napi-rs/canvas, Skia). Import from `@parlante/renderer/node` — never from
 * browser code.
 * ----------------------------------------------------------------------------------------- */

export type NodeCanvas = Canvas;

const require = createRequire(import.meta.url);
let fontsRegistered: number | null = null;

const BUNDLED_FAMILIES = new Set<string>(FONT_FAMILY_NAMES);

/**
 * Name the bundled files of `family` are registered under in Skia. Not the family name itself:
 * Skia also matches the fonts installed on the machine, and on a host with a system "Inter"
 * (Ubuntu's `fonts-inter`) that one was drawn instead of the bundled file — the export then
 * depended on the host and differed from the browser preview. Families that are not bundled
 * keep their name and resolve as before.
 */
export function bundledFamilyName(family: string): string {
  return BUNDLED_FAMILIES.has(family) ? `Parlante Bundled ${family}` : family;
}

/**
 * Register every bundled @fontsource file (woff2) under its private name (`bundledFamilyName`).
 * All subsets of a family share the name, so Latin, Cyrillic and Greek text resolve to the same
 * family; glyphs a family lacks come from Inter through the family list of `canvasFont`, like
 * in a browser. Idempotent; returns the number of font files registered.
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
    if (GlobalFonts.registerFromPath(file, bundledFamilyName(font.family))) count += 1;
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

// Off-screen canvases for the renderer core (group opacity, transitions, raster caches).
setCanvasFactory(createNodeCanvas);
// Font strings built by `canvasFont` name the bundled files, never a same-named system font.
setRegisteredFamilyNames(bundledFamilyName);

export const nodePlatform: RenderPlatform = {
  name: 'node',
  createCanvas: createNodeCanvas,
  loadImage: loadNodeImage,
  ensureFonts: async () => {
    registerNodeFonts();
  },
};

/**
 * Renderer bound to one composition and one reused canvas, for exporting consecutive frames
 * as raw RGBA (see ./frames). Registers the bundled fonts.
 */
export function createFrameRenderer(options: FrameRendererOptions): FrameRenderer {
  registerNodeFonts();
  return createFrameRendererWith(options, createNodeCanvas);
}

/**
 * Decoded images by key, so the same file is decoded once however many layers, scenes or
 * renders use it. Failed loads are not cached.
 */
export class NodeImageCache {
  private readonly entries = new Map<string, Promise<RenderImage>>();

  constructor(private readonly maxEntries = 128) {}

  /** Image for `key`, decoding `source` (bytes or a local path) the first time. */
  load(
    key: string,
    source: Uint8Array | string | (() => Promise<Uint8Array | string>),
  ): Promise<RenderImage> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const loading = (async () =>
      loadNodeImage(typeof source === 'function' ? await source() : source))();
    this.entries.set(key, loading);
    loading.catch(() => {
      if (this.entries.get(key) === loading) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return loading;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Raw RGBA pixels of a canvas (what ffmpeg reads as `-f rawvideo -pix_fmt rgba`).
 *
 * For a single frame. To export many, use `createFrameRenderer(...).frame(i)`: the buffer
 * returned here is native memory that is only released after the event loop turns, so a
 * loop that calls this for every frame without yielding grows by 4 MB (720p) per frame.
 */
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

/**
 * Portrait (+ greyscale matte) → RGBA PNG with the matte applied: the avatar CUT-OUT stored as
 * `cutout.png` by the photo-avatar job and served for stock `real_…` avatars. Inputs are
 * encoded image bytes or local file paths; `mask: null` just re-encodes the portrait.
 */
export async function cutoutPng(
  portrait: Uint8Array | string,
  mask: Uint8Array | string | null,
): Promise<Buffer> {
  const image = await loadNodeImage(portrait);
  const matte = mask === null ? null : await loadNodeImage(mask);
  const { canvas } = matteCanvas(nodePlatform, image, matte);
  return canvasToPng(canvas as NodeCanvas);
}

/** Downscaled JPEG (largest side `maxSide`) of an image, over an opaque background. */
export async function thumbnailJpeg(
  source: Uint8Array | string,
  maxSide = 256,
  background = '#e9e6f0',
): Promise<Buffer> {
  const image = await loadNodeImage(source);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height, 1));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const { canvas, ctx } = createNodeCanvas(width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image.source, 0, 0, width, height);
  return canvasToJpeg(canvas, 86);
}
