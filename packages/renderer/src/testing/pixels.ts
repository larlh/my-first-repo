import type { Composition, RenderRuntime } from '@parlante/shared';
import { renderFrame } from '../render-frame';
import { canvasToRgba, createNodeCanvas, registerNodeFonts } from '../node/index';
import type { RenderAssets, RenderOptions } from '../types';
import { MapRenderAssets } from '../assets';

/* Pixel helpers for renderer tests (Node only; not part of the public API). */

export type Rgb = [number, number, number];

export interface Shot {
  data: Buffer;
  width: number;
  height: number;
  /** RGBA of the pixel at (x, y). */
  px(x: number, y: number): [number, number, number, number];
  /** Number of pixels satisfying `test`. */
  count(test: (r: number, g: number, b: number, a: number) => boolean): number;
  /** Bounding box of the pixels satisfying `test`, or null when there are none. */
  bbox(
    test: (r: number, g: number, b: number, a: number) => boolean,
  ): { x0: number; y0: number; x1: number; y1: number; w: number; h: number } | null;
}

export function shotOf(data: Buffer, width: number, height: number): Shot {
  const at = (x: number, y: number) => (Math.round(y) * width + Math.round(x)) * 4;
  return {
    data,
    width,
    height,
    px(x, y) {
      const o = at(x, y);
      return [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, data[o + 3] ?? 0];
    },
    count(test) {
      let n = 0;
      for (let o = 0; o < data.length; o += 4) {
        if (test(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, data[o + 3] ?? 0)) n += 1;
      }
      return n;
    },
    bbox(test) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const o = (y * width + x) * 4;
          if (test(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, data[o + 3] ?? 0)) {
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
          }
        }
      }
      if (!Number.isFinite(x0)) return null;
      return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    },
  };
}

/** Render one frame on a fresh canvas and return its pixels. */
export function shoot(
  composition: Composition,
  tMs: number,
  runtime: RenderRuntime = { scenes: {} },
  assets: RenderAssets = new MapRenderAssets(),
  options: RenderOptions = {},
): Shot {
  registerNodeFonts();
  const width = options.width ?? composition.canvas.width;
  const height = options.height ?? composition.canvas.height;
  const { canvas, ctx } = createNodeCanvas(width, height);
  renderFrame(ctx, composition, tMs, runtime, assets, {
    subtitles: false,
    ...options,
    width,
    height,
  });
  return shotOf(canvasToRgba(canvas), width, height);
}

export const near =
  (target: Rgb, tolerance = 12) =>
  (r: number, g: number, b: number): boolean =>
    Math.abs(r - target[0]) <= tolerance &&
    Math.abs(g - target[1]) <= tolerance &&
    Math.abs(b - target[2]) <= tolerance;

/** Fraction of pixels whose colour differs by more than `tolerance` in some channel. */
export function diffRatio(a: Buffer, b: Buffer, tolerance = 0): number {
  if (a.length !== b.length) return 1;
  let different = 0;
  for (let o = 0; o < a.length; o += 4) {
    if (
      Math.abs((a[o] ?? 0) - (b[o] ?? 0)) > tolerance ||
      Math.abs((a[o + 1] ?? 0) - (b[o + 1] ?? 0)) > tolerance ||
      Math.abs((a[o + 2] ?? 0) - (b[o + 2] ?? 0)) > tolerance ||
      Math.abs((a[o + 3] ?? 0) - (b[o + 3] ?? 0)) > tolerance
    ) {
      different += 1;
    }
  }
  return different / (a.length / 4);
}

export { stubRig } from './stub-rig';
