import type { Ctx2D } from './types';

/* -------------------------------------------------------------------------------------------
 * Off-screen canvases for the renderer core: a platform-neutral factory, a pool of transient
 * "scratch" canvases (group opacity, scene transitions) and an LRU cache of pre-rasterised
 * static content (text blocks, gradients, fitted images, subtitles).
 *
 * Nothing here affects WHAT is drawn — only how fast. Every cached bitmap is a pure function
 * of its key, so a cache hit and a cache miss produce the same pixels (determinism holds
 * whatever the cache state is).
 * ----------------------------------------------------------------------------------------- */

/** A canvas the core can draw on and use as an image source. */
export interface ScratchCanvas {
  /** Pass to `ctx.drawImage`. */
  canvas: CanvasImageSource;
  ctx: Ctx2D;
  width: number;
  height: number;
}

export type CanvasFactory = (width: number, height: number) => { canvas: unknown; ctx: Ctx2D };

let registeredFactory: CanvasFactory | null = null;
let detectedFactory: CanvasFactory | null | undefined;

/**
 * Tell the core how to create off-screen canvases. The Node adapter registers itself when
 * imported; in a browser (or a web worker) the DOM / OffscreenCanvas is detected, so calling
 * this is optional there. Without any factory the renderer still works: it draws everything
 * directly (slower, and scene cross-fades blend per layer instead of per scene).
 */
export function setCanvasFactory(factory: CanvasFactory | null): void {
  registeredFactory = factory;
}

interface DomLike {
  document?: { createElement(tag: string): unknown };
  OffscreenCanvas?: new (width: number, height: number) => unknown;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d'): unknown;
}

function detectFactory(): CanvasFactory | null {
  const scope = globalThis as unknown as DomLike;
  const doc = scope.document;
  if (doc && typeof doc.createElement === 'function') {
    return (width, height) => {
      const canvas = doc.createElement('canvas') as CanvasLike;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is not available');
      return { canvas, ctx: ctx as Ctx2D };
    };
  }
  const Offscreen = scope.OffscreenCanvas;
  if (typeof Offscreen === 'function') {
    return (width, height) => {
      const canvas = new Offscreen(width, height) as CanvasLike;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D is not available');
      return { canvas, ctx: ctx as Ctx2D };
    };
  }
  return null;
}

function currentFactory(): CanvasFactory | null {
  if (registeredFactory) return registeredFactory;
  if (detectedFactory === undefined) detectedFactory = detectFactory();
  return detectedFactory;
}

/** True when off-screen canvases can be created (caches and group compositing are active). */
export function canCreateCanvas(): boolean {
  return currentFactory() !== null;
}

/** Largest side / area of a canvas the core will allocate (bigger content is drawn directly). */
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_AREA = 4096 * 4096;

/** New off-screen canvas, or null when unavailable / unreasonable. */
export function createCanvas(width: number, height: number): ScratchCanvas | null {
  const factory = currentFactory();
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  if (!factory || !(w > 0) || !(h > 0)) return null;
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE || w * h > MAX_CANVAS_AREA) return null;
  try {
    const { canvas, ctx } = factory(w, h);
    return { canvas: canvas as CanvasImageSource, ctx, width: w, height: h };
  } catch {
    return null;
  }
}

/* ---------- scratch pool ---------- */

const pool = new Map<string, ScratchCanvas[]>();
const POOL_PER_SIZE = 3;
const POOL_SIZES = 4;

function resetContext(ctx: Ctx2D, width: number, height: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
}

/**
 * Borrow a cleared canvas of exactly `width × height` pixels (identity transform). Give it
 * back with `releaseScratch` when done — always in the same synchronous call (the renderer is
 * synchronous, so a `try/finally` is enough). Returns null when canvases cannot be created.
 */
export function acquireScratch(width: number, height: number): ScratchCanvas | null {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const free = pool.get(`${w}x${h}`);
  const reused = free?.pop();
  if (reused) {
    reused.ctx.save();
    resetContext(reused.ctx, w, h);
    return reused;
  }
  const created = createCanvas(w, h);
  if (!created) return null;
  created.ctx.save();
  resetContext(created.ctx, w, h);
  return created;
}

export function releaseScratch(scratch: ScratchCanvas): void {
  scratch.ctx.restore();
  const key = `${scratch.width}x${scratch.height}`;
  let free = pool.get(key);
  if (!free) {
    if (pool.size >= POOL_SIZES) {
      // Output size changed (preview resized, another export): forget the oldest size.
      const oldest = pool.keys().next().value;
      if (oldest !== undefined) pool.delete(oldest);
    }
    free = [];
    pool.set(key, free);
  }
  if (free.length < POOL_PER_SIZE) free.push(scratch);
}

/* ---------- LRU raster cache ---------- */

/** A cached bitmap and where its top-left pixel sits (integer device pixels). */
export interface Raster {
  canvas: CanvasImageSource;
  /** Position of the bitmap's origin in the coordinate space it was rasterised for. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Entry {
  raster: Raster;
  bytes: number;
}

const DEFAULT_BUDGET_BYTES = 192 * 1024 * 1024;
let budgetBytes = DEFAULT_BUDGET_BYTES;
let usedBytes = 0;
let hits = 0;
let misses = 0;
const rasters = new Map<string, Entry>();

function evict(): void {
  for (const [key, entry] of rasters) {
    if (usedBytes <= budgetBytes) break;
    rasters.delete(key);
    usedBytes -= entry.bytes;
  }
}

/**
 * Bitmap for `key`, painted once by `paint` and reused afterwards. `bounds` is the area to
 * rasterise in the caller's coordinates (floats allowed); the bitmap is snapped OUTWARD to
 * whole pixels and `paint` receives a context already translated so that it can draw with the
 * caller's coordinates. Draw the result with `ctx.drawImage(r.canvas, r.x, r.y)`.
 *
 * Returns null when the content cannot be cached (no canvas factory, empty or oversized
 * area): callers then draw directly.
 */
export function cachedRaster(
  key: string,
  bounds: { x: number; y: number; w: number; h: number },
  paint: (ctx: Ctx2D) => void,
): Raster | null {
  const hit = rasters.get(key);
  if (hit) {
    // Refresh recency.
    rasters.delete(key);
    rasters.set(key, hit);
    hits += 1;
    return hit.raster;
  }
  const x = Math.floor(bounds.x);
  const y = Math.floor(bounds.y);
  const width = Math.ceil(bounds.x + bounds.w) - x;
  const height = Math.ceil(bounds.y + bounds.h) - y;
  const bytes = width * height * 4;
  if (!(width > 0) || !(height > 0) || bytes > budgetBytes / 4) return null;
  const target = createCanvas(width, height);
  if (!target) return null;
  misses += 1;
  target.ctx.save();
  target.ctx.translate(-x, -y);
  paint(target.ctx);
  target.ctx.restore();
  const raster: Raster = { canvas: target.canvas, x, y, width, height };
  rasters.set(key, { raster, bytes });
  usedBytes += bytes;
  evict();
  return raster;
}

const clearHooks: (() => void)[] = [];

/** Register another memo (text layouts…) to be dropped by `clearRenderCaches`. */
export function onClearRenderCaches(hook: () => void): void {
  clearHooks.push(hook);
}

/**
 * Drop every cached bitmap, memoised layout and pooled canvas. Call it when fonts finish
 * loading (measurements change), after an export to release memory, or in tests.
 */
export function clearRenderCaches(): void {
  rasters.clear();
  pool.clear();
  usedBytes = 0;
  hits = 0;
  misses = 0;
  for (const hook of clearHooks) hook();
}

/** Memory budget of the raster cache in bytes (default 192 MiB). */
export function setRenderCacheBudget(bytes: number): void {
  budgetBytes = Math.max(0, bytes);
  evict();
}

export function renderCacheStats(): {
  entries: number;
  bytes: number;
  budgetBytes: number;
  hits: number;
  misses: number;
} {
  return { entries: rasters.size, bytes: usedBytes, budgetBytes, hits, misses };
}

/* ---------- identity keys ---------- */

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

/**
 * Stable small integer for an object (decoded image, words array…), to build cache keys from
 * identity without keeping the object alive.
 */
export function objectKey(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId;
    nextObjectId += 1;
    objectIds.set(value, id);
  }
  return id;
}
