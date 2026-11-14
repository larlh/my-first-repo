import { VISEME_MOUTH_SHAPES, blendMouthShapes } from '@parlante/shared';
import type { SceneRuntime, Viseme, VisemeCue } from '@parlante/shared';
import { hashString, seededUnit } from '../random';
import type { AvatarState } from './types';

/** Time (ms) the mouth takes to move from one viseme to the next. */
export const VISEME_BLEND_MS = 70;
const BLINK_MS = 160;
const BLINK_SLOT_MS = 3200;

function cueIndexAt(cues: readonly VisemeCue[], tMs: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (cue && cue.tMs <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Deterministic blink: one blink at a pseudo-random offset inside each time slot. */
function blinkAt(timeMs: number, seed: number): number {
  const t = Math.max(0, timeMs);
  const slot = Math.floor(t / BLINK_SLOT_MS);
  const start = slot * BLINK_SLOT_MS + seededUnit(seed, slot) * (BLINK_SLOT_MS - BLINK_MS);
  const phase = (t - start) / BLINK_MS;
  if (phase < 0 || phase > 1) return 0;
  return Math.sin(phase * Math.PI);
}

export interface AvatarStateInput {
  /** Runtime of the scene (null/undefined = silent scene). */
  runtime: SceneRuntime | null | undefined;
  /** Time since the narration audio started (ms); negative before it starts. */
  speechMs: number;
  /** Time since the scene started (ms). */
  sceneMs: number;
  /** Stable seed (use `${sceneId}:${layerId}`) so each avatar blinks/moves on its own rhythm. */
  seed: string;
}

/**
 * Pose of an avatar at a given instant: viseme pair + blend from the runtime timeline, plus
 * deterministic blink, gaze drift, head motion and breathing.
 *
 * Baseline implementation by the architect — owner: avatar-artist (may refine easing,
 * co-articulation and idle motion, keeping the signature and determinism).
 */
export function computeAvatarState(input: AvatarStateInput): AvatarState {
  const { runtime, speechMs, sceneMs } = input;
  const seed = hashString(input.seed);
  const cues = runtime?.visemes ?? [];
  const audioMs = runtime?.audioDurationMs ?? 0;
  const speaking = audioMs > 0 && speechMs >= 0 && speechMs < audioMs;

  let viseme: Viseme = 'rest';
  let nextViseme: Viseme = 'rest';
  let blend = 0;
  if (speaking && cues.length > 0) {
    const idx = cueIndexAt(cues, speechMs);
    const current = idx >= 0 ? cues[idx] : undefined;
    const upcoming = cues[idx + 1];
    viseme = current?.viseme ?? 'rest';
    nextViseme = viseme;
    if (upcoming) {
      const untilNext = upcoming.tMs - speechMs;
      if (untilNext <= VISEME_BLEND_MS) {
        nextViseme = upcoming.viseme;
        blend = 1 - Math.max(0, untilNext) / VISEME_BLEND_MS;
      }
    }
  }

  const seconds = Math.max(0, sceneMs) / 1000;
  const phase = seededUnit(seed, 1000) * Math.PI * 2;
  const energy = speaking ? 1 : 0.35;
  return {
    viseme,
    nextViseme,
    blend,
    mouth: blendMouthShapes(VISEME_MOUTH_SHAPES[viseme], VISEME_MOUTH_SHAPES[nextViseme], blend),
    blink: blinkAt(sceneMs, seed),
    gaze: {
      x: 0.12 * Math.sin(seconds * 0.45 + phase),
      y: 0.08 * Math.sin(seconds * 0.31 + phase * 1.7),
    },
    head: {
      nod: 0.25 * energy * Math.sin(seconds * 1.9 + phase),
      turn: 0.2 * energy * Math.sin(seconds * 0.7 + phase * 0.5),
      tilt: 0.15 * energy * Math.sin(seconds * 0.5 + phase * 1.3),
    },
    breath: 0.5 + 0.5 * Math.sin(seconds * 1.4 + phase),
    speaking,
    timeMs: sceneMs,
  };
}

/** Neutral pose (thumbnails, pickers). */
export function restingAvatarState(timeMs = 0): AvatarState {
  return computeAvatarState({ runtime: null, speechMs: -1, sceneMs: timeMs, seed: 'rest' });
}
