import type { Ctx2D } from '../../types';

/**
 * Path helpers for the stock rigs. Shapes are authored as short lists of points the outline
 * passes through; a Catmull-Rom spline turns them into smooth Béziers. A point may be marked
 * as a corner (third tuple element = 1) to keep a crease there (lapel tips, collar points).
 */
export type Pt = readonly [x: number, y: number, corner?: 0 | 1];

const TENSION = 1 / 6;

function tangent(prev: Pt, next: Pt, at: Pt): [number, number] {
  if (at[2] === 1) return [0, 0];
  return [(next[0] - prev[0]) * TENSION, (next[1] - prev[1]) * TENSION];
}

/** Append a smooth CLOSED outline through `pts` to the current path (no beginPath/fill). */
export function addBlob(ctx: Ctx2D, pts: readonly Pt[]): void {
  const n = pts.length;
  if (n < 3) return;
  const first = pts[0] as Pt;
  ctx.moveTo(first[0], first[1]);
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n] as Pt;
    const p1 = pts[i] as Pt;
    const p2 = pts[(i + 1) % n] as Pt;
    const p3 = pts[(i + 2) % n] as Pt;
    const t1 = tangent(p0, p2, p1);
    const t2 = tangent(p1, p3, p2);
    ctx.bezierCurveTo(p1[0] + t1[0], p1[1] + t1[1], p2[0] - t2[0], p2[1] - t2[1], p2[0], p2[1]);
  }
  ctx.closePath();
}

/**
 * Append a smooth OPEN curve through `pts`. With `move = false` the curve continues the
 * current sub-path with a straight segment to the first point (to chain edges of one shape).
 */
export function addCurve(ctx: Ctx2D, pts: readonly Pt[], move = true): void {
  const n = pts.length;
  if (n < 2) return;
  const first = pts[0] as Pt;
  if (move) ctx.moveTo(first[0], first[1]);
  else ctx.lineTo(first[0], first[1]);
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)] as Pt;
    const p1 = pts[i] as Pt;
    const p2 = pts[i + 1] as Pt;
    const p3 = pts[Math.min(n - 1, i + 2)] as Pt;
    const t1 = tangent(p0, p2, p1);
    const t2 = tangent(p1, p3, p2);
    ctx.bezierCurveTo(p1[0] + t1[0], p1[1] + t1[1], p2[0] - t2[0], p2[1] - t2[1], p2[0], p2[1]);
  }
}

/** Fill a smooth closed outline. */
export function fillBlob(ctx: Ctx2D, pts: readonly Pt[], fill: string | CanvasGradient): void {
  ctx.beginPath();
  addBlob(ctx, pts);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Stroke a smooth open curve with round caps. */
export function strokeCurve(ctx: Ctx2D, pts: readonly Pt[], stroke: string, width: number): void {
  ctx.beginPath();
  addCurve(ctx, pts);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Fill a straight-edged polygon. */
export function fillPoly(ctx: Ctx2D, pts: readonly Pt[], fill: string | CanvasGradient): void {
  const first = pts[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (let i = 1; i < pts.length; i += 1) {
    const p = pts[i] as Pt;
    ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

export function fillEllipse(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fill: string | CanvasGradient,
  rotation = 0,
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0, rx), Math.max(0, ry), rotation, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Mirror a list of points across the vertical axis (x → -x), keeping drawing order valid. */
export function mirror(pts: readonly Pt[]): Pt[] {
  return pts.map((p) => (p[2] === undefined ? [-p[0], p[1]] : [-p[0], p[1], p[2]]) as Pt);
}

/**
 * A left/right symmetric closed outline from its RIGHT half, listed top → bottom (points on
 * the axis, x = 0, are not duplicated).
 */
export function symmetric(rightHalf: readonly Pt[]): Pt[] {
  const left = mirror(rightHalf)
    .filter((p) => p[0] !== 0)
    .reverse();
  return [...rightHalf, ...left];
}

/** Soft round spot (blush, soft shadows): radial gradient from `color` to transparent. */
export function softSpot(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  inner: string,
  outer: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
