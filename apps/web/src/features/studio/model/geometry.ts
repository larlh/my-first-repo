import type { Box } from '@parlante/shared';

/* Direct-manipulation geometry of the stage. Boxes are normalised to the canvas (0..1), like
 * the Composition; rotation maths runs in pixels because the canvas is not square. Pure. */

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export interface Guide {
  /** `x`: vertical line at normalised x = `at`; `y`: horizontal line at y = `at`. */
  axis: 'x' | 'y';
  at: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

const LIMITS = { minPos: -2, maxPos: 3, minSize: 0.01, maxSize: 4 } as const;
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Keep a box inside what the Composition schema accepts, rounded to 4 decimals. */
export function clampBox(box: Box): Box {
  return {
    x: round(clamp(box.x, LIMITS.minPos, LIMITS.maxPos)),
    y: round(clamp(box.y, LIMITS.minPos, LIMITS.maxPos)),
    w: round(clamp(box.w, LIMITS.minSize, LIMITS.maxSize)),
    h: round(clamp(box.h, LIMITS.minSize, LIMITS.maxSize)),
  };
}

export function moveBox(box: Box, dx: number, dy: number): Box {
  return { ...box, x: box.x + dx, y: box.y + dy };
}

function handleSigns(handle: Handle): { hx: number; hy: number } {
  return {
    hx: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    hy: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0,
  };
}

export interface ResizeOptions {
  /** Clockwise degrees of the layer. */
  rotation?: number;
  canvas: CanvasSize;
  /** Keep the width / height ratio (Shift, or layers whose content must not be distorted). */
  keepRatio?: boolean;
}

/**
 * Resize `box` by dragging `handle` by (dx, dy) — normalised canvas units. The opposite edge
 * or corner stays where it is on screen, also for rotated layers.
 */
export function resizeBox(
  box: Box,
  handle: Handle,
  dx: number,
  dy: number,
  options: ResizeOptions,
): Box {
  const { width, height } = options.canvas;
  const theta = ((options.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const { hx, hy } = handleSigns(handle);
  const w = box.w * width;
  const h = box.h * height;
  // Pointer delta in the layer's own (unrotated) axes.
  const px = dx * width;
  const py = dy * height;
  const localX = px * cos + py * sin;
  const localY = -px * sin + py * cos;
  const minW = LIMITS.minSize * width;
  const minH = LIMITS.minSize * height;
  let nextW = Math.max(minW, w + hx * localX);
  let nextH = Math.max(minH, h + hy * localY);
  if (options.keepRatio && w > 0 && h > 0) {
    const scale =
      hx !== 0 && hy !== 0 ? Math.max(nextW / w, nextH / h) : hx !== 0 ? nextW / w : nextH / h;
    nextW = Math.max(minW, w * scale);
    nextH = Math.max(minH, h * scale);
  }
  // The anchor (opposite side) keeps its place: the centre moves half the growth, rotated back.
  const shiftX = (hx * (nextW - w)) / 2;
  const shiftY = (hy * (nextH - h)) / 2;
  const cx = box.x * width + w / 2 + shiftX * cos - shiftY * sin;
  const cy = box.y * height + h / 2 + shiftX * sin + shiftY * cos;
  return {
    x: (cx - nextW / 2) / width,
    y: (cy - nextH / 2) / height,
    w: nextW / width,
    h: nextH / height,
  };
}

/** Lines a box can snap to: canvas edges and centre, plus edges and centres of other boxes. */
function candidates(others: readonly Box[], axis: 'x' | 'y'): number[] {
  const lines = [0, 0.5, 1];
  for (const other of others) {
    const start = axis === 'x' ? other.x : other.y;
    const size = axis === 'x' ? other.w : other.h;
    lines.push(start, start + size / 2, start + size);
  }
  return lines;
}

function nearest(
  points: readonly number[],
  lines: readonly number[],
  threshold: number,
): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  for (const point of points) {
    for (const line of lines) {
      const delta = line - point;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
        best = { delta, line };
      }
    }
  }
  return best;
}

export interface SnapResult {
  box: Box;
  guides: Guide[];
}

export interface SnapThreshold {
  x: number;
  y: number;
}

/** Snap a box being MOVED: its left / centre / right and top / middle / bottom. */
export function snapMove(box: Box, others: readonly Box[], threshold: SnapThreshold): SnapResult {
  const guides: Guide[] = [];
  let { x, y } = box;
  const sx = nearest(
    [box.x, box.x + box.w / 2, box.x + box.w],
    candidates(others, 'x'),
    threshold.x,
  );
  if (sx) {
    x += sx.delta;
    guides.push({ axis: 'x', at: sx.line });
  }
  const sy = nearest(
    [box.y, box.y + box.h / 2, box.y + box.h],
    candidates(others, 'y'),
    threshold.y,
  );
  if (sy) {
    y += sy.delta;
    guides.push({ axis: 'y', at: sy.line });
  }
  return { box: { ...box, x, y }, guides };
}

/** Snap the edges a RESIZE handle moves (unrotated layers only). */
export function snapResize(
  box: Box,
  handle: Handle,
  others: readonly Box[],
  threshold: SnapThreshold,
): SnapResult {
  const { hx, hy } = handleSigns(handle);
  const guides: Guide[] = [];
  const next = { ...box };
  if (hx !== 0) {
    const edge = hx > 0 ? box.x + box.w : box.x;
    const snap = nearest([edge], candidates(others, 'x'), threshold.x);
    if (snap) {
      if (hx > 0) next.w = Math.max(LIMITS.minSize, box.w + snap.delta);
      else {
        next.x = box.x + snap.delta;
        next.w = Math.max(LIMITS.minSize, box.w - snap.delta);
      }
      guides.push({ axis: 'x', at: snap.line });
    }
  }
  if (hy !== 0) {
    const edge = hy > 0 ? box.y + box.h : box.y;
    const snap = nearest([edge], candidates(others, 'y'), threshold.y);
    if (snap) {
      if (hy > 0) next.h = Math.max(LIMITS.minSize, box.h + snap.delta);
      else {
        next.y = box.y + snap.delta;
        next.h = Math.max(LIMITS.minSize, box.h - snap.delta);
      }
      guides.push({ axis: 'y', at: snap.line });
    }
  }
  return { box: next, guides };
}

/** Centre a box on the canvas along one or both axes. */
export function centreBox(box: Box, axis: 'x' | 'y' | 'both'): Box {
  return {
    ...box,
    x: axis === 'y' ? box.x : round((1 - box.w) / 2),
    y: axis === 'x' ? box.y : round((1 - box.h) / 2),
  };
}
