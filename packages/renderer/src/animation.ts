import type { Animation, Layer } from '@parlante/shared';
import { clamp01, ease, lerp } from './easing';

/* -------------------------------------------------------------------------------------------
 * Layer enter / exit animations. Pure: (layer, scene-local time, scene length) → pose.
 *
 * Time line of a layer inside its scene
 *
 *   appear ── delay ──[ enter ]────────── visible ──────────[ exit ]── delay ── disappear
 *
 *  - `appear` / `disappear` are `layer.timing.startMs` / `endMs` (default: the whole scene).
 *  - Before the enter animation starts the layer is hidden; after the exit ends it is hidden.
 *  - Slides are named after the direction of MOTION: `slide-up` enters from below moving up,
 *    and leaves moving further up.
 * ----------------------------------------------------------------------------------------- */

export interface LayerPose {
  /** 0..1, multiplies the layer opacity. 0 = not drawn. */
  alpha: number;
  /** Offset in output pixels (whole pixels, so static bitmaps stay sharp while moving). */
  dx: number;
  dy: number;
  /** Uniform scale around the box centre. */
  scale: number;
}

export const IDENTITY_POSE: LayerPose = Object.freeze({ alpha: 1, dx: 0, dy: 0, scale: 1 });

/** Slide travel as a fraction of the canvas height (same distance on both axes). */
export const SLIDE_DISTANCE = 0.14;
const ZOOM_IN_FROM = 0.6;
const ZOOM_OUT_FROM = 1.45;
const POP_FROM = 0.3;

/**
 * Pose of an animation at visibility `v`: 0 = fully out (hidden), 1 = at rest; `back-out`
 * overshoots past 1 and settles. `direction` is +1 while entering and -1 while leaving (slides
 * keep moving the same way).
 */
function poseAt(
  type: Animation['type'],
  v: number,
  direction: 1 | -1,
  canvasHeight: number,
): LayerPose {
  if (type === 'none') return IDENTITY_POSE;
  const travel = (1 - v) * SLIDE_DISTANCE * canvasHeight * direction;
  // Opacity reaches 1 before the motion ends so the layer reads early.
  const alpha = clamp01(v * 1.6);
  switch (type) {
    case 'fade':
      return { alpha: clamp01(v), dx: 0, dy: 0, scale: 1 };
    case 'slide-up':
      return { alpha, dx: 0, dy: Math.round(travel), scale: 1 };
    case 'slide-down':
      return { alpha, dx: 0, dy: Math.round(-travel), scale: 1 };
    case 'slide-left':
      return { alpha, dx: Math.round(travel), dy: 0, scale: 1 };
    case 'slide-right':
      return { alpha, dx: Math.round(-travel), dy: 0, scale: 1 };
    case 'zoom-in':
      return { alpha, dx: 0, dy: 0, scale: lerp(ZOOM_IN_FROM, 1, v) };
    case 'zoom-out':
      return { alpha, dx: 0, dy: 0, scale: lerp(ZOOM_OUT_FROM, 1, v) };
    case 'pop':
      return { alpha: clamp01(v * 3), dx: 0, dy: 0, scale: Math.max(0, lerp(POP_FROM, 1, v)) };
  }
}

function progress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return elapsedMs >= 0 ? 1 : 0;
  return clamp01(elapsedMs / durationMs);
}

/**
 * Pose of `layer` at scene-local time `localMs` in a scene lasting `sceneDurationMs`.
 * The caller has already checked `layerActiveAt` (visibility window).
 */
export function layerPoseAt(
  layer: Layer,
  localMs: number,
  sceneDurationMs: number,
  canvasHeight: number,
): LayerPose {
  const enter = layer.enter;
  const exit = layer.exit;
  const hasEnter = enter !== undefined && enter.type !== 'none';
  const hasExit = exit !== undefined && exit.type !== 'none';
  if (!hasEnter && !hasExit) return IDENTITY_POSE;

  let pose: LayerPose = IDENTITY_POSE;
  if (hasEnter) {
    const appearMs = layer.timing?.startMs ?? 0;
    const p = progress(localMs - appearMs - enter.delayMs, enter.durationMs);
    if (p <= 0) return { ...IDENTITY_POSE, alpha: 0 };
    if (p < 1) {
      // `pop` always overshoots a little, whatever easing was chosen.
      const v = ease(enter.type === 'pop' ? 'back-out' : enter.easing, p);
      pose = poseAt(enter.type, v, 1, canvasHeight);
    }
  }
  if (hasExit) {
    const disappearMs = Math.min(layer.timing?.endMs ?? sceneDurationMs, sceneDurationMs);
    const exitEndMs = disappearMs - exit.delayMs;
    const q = progress(localMs - (exitEndMs - exit.durationMs), exit.durationMs);
    if (q >= 1) return { ...IDENTITY_POSE, alpha: 0 };
    if (q > 0) {
      const out = poseAt(exit.type, 1 - ease(exit.easing, q), -1, canvasHeight);
      pose = {
        alpha: pose.alpha * out.alpha,
        dx: pose.dx + out.dx,
        dy: pose.dy + out.dy,
        scale: pose.scale * out.scale,
      };
    }
  }
  return pose;
}
