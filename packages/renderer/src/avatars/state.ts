import { VISEME_MOUTH_SHAPES, blendMouthShapes } from '@parlante/shared';
import type { MouthShape, SceneRuntime, Viseme, VisemeCue, WordCue } from '@parlante/shared';
import { hashString, seededUnit } from '../random';
import type { AvatarState } from './types';

/* -------------------------------------------------------------------------------------------
 * From the scene runtime (viseme and word cues) to the pose of an avatar at one instant.
 *
 * Everything here is a pure function of (runtime, speechMs, sceneMs, seed): no clocks, no
 * Math.random, no state carried between frames. Any frame can be computed alone and always
 * comes out the same — which is what lets the Studio preview and the export agree.
 * ----------------------------------------------------------------------------------------- */

/** Longest time (ms) the mouth takes to travel from one viseme to the next. */
export const VISEME_BLEND_MS = 90;
/** Share of a viseme's own duration that may be spent travelling to the next one. */
const BLEND_SHARE = 0.75;
/** A vowel shorter than this (ms) does not reach its full opening. */
const FULL_VOWEL_MS = 90;
/** A consonant shorter than this (ms) is pulled towards its neighbours. */
const FULL_CONSONANT_MS = 60;
/** Conversational speech does not hit the canonical (dictionary) openings. */
const ARTICULATION = 0.92;

const REST = VISEME_MOUTH_SHAPES.rest;

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
const mixNum = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Index of the last cue with `tMs <= t`, or -1. Cues are sorted by time. */
function cueIndexAt(cues: readonly { tMs: number }[], tMs: number): number {
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

function isVowel(v: Viseme): boolean {
  return v === 'A' || v === 'E' || v === 'I' || v === 'O' || v === 'U';
}

/**
 * Co-articulated target of cue `i`: the canonical shape of its viseme, adjusted by context.
 *
 *  - Consonants borrow the lip shape of the vowel they lead into (or come from): the "s" of
 *    "su" is already rounded, the "s" of "sí" already spread. Bilabials and labiodentals keep
 *    their closure (that is what makes them readable) but take the rounding too.
 *  - The jaw anticipates the vowel a little during tongue consonants.
 *  - Very short sounds undershoot: a 40 ms vowel never opens fully, and a flicked consonant
 *    stays close to its neighbours — this is what keeps fast speech from flapping.
 */
function coarticulatedTarget(cues: readonly VisemeCue[], i: number, audioMs: number): MouthShape {
  const cue = cues[i];
  if (!cue || cue.viseme === 'rest') return REST;
  const base = VISEME_MOUTH_SHAPES[cue.viseme];
  const prev = cues[i - 1];
  const next = cues[i + 1];
  const dur = Math.max(0, (next ? next.tMs : audioMs) - cue.tMs);

  if (isVowel(cue.viseme)) {
    const reach = dur >= FULL_VOWEL_MS ? 1 : 0.55 + (0.45 * dur) / FULL_VOWEL_MS;
    return { ...base, open: base.open * reach * ARTICULATION };
  }

  const vowel =
    next && isVowel(next.viseme) && dur < 260
      ? VISEME_MOUTH_SHAPES[next.viseme]
      : prev && isVowel(prev.viseme)
        ? VISEME_MOUTH_SHAPES[prev.viseme]
        : null;
  if (!vowel) return base;
  const lipLocked = cue.viseme === 'MBP' || cue.viseme === 'FV';
  const ownRounding = cue.viseme === 'CHJ' || cue.viseme === 'R';
  const lipMix = ownRounding ? 0.25 : 0.5;
  const jawMix = lipLocked || cue.viseme === 'SZ' ? 0 : 0.22;
  // A flicked tongue consonant between two sounds barely interrupts them.
  const flick = lipLocked || dur >= FULL_CONSONANT_MS ? 0 : 0.35 * (1 - dur / FULL_CONSONANT_MS);
  return {
    open: mixNum(base.open, vowel.open * ARTICULATION, jawMix + flick),
    width: mixNum(base.width, vowel.width, lipMix),
    round: mixNum(base.round, vowel.round, lipMix),
    teeth: base.teeth,
    tongue: base.tongue,
  };
}

interface MouthTrack {
  viseme: Viseme;
  nextViseme: Viseme;
  blend: number;
  mouth: MouthShape;
}

const SILENT: MouthTrack = { viseme: 'rest', nextViseme: 'rest', blend: 0, mouth: REST };

/**
 * Mouth at `speechMs`. Each cue's shape is reached exactly at its `tMs` and held (the
 * contract of `VisemeCue`); the travel towards the next cue happens in an eased window just
 * before it, never longer than `VISEME_BLEND_MS` nor than 75 % of the current sound. The
 * track is continuous in time, and it closes to rest when the audio ends.
 */
function mouthAt(cues: readonly VisemeCue[], speechMs: number, audioMs: number): MouthTrack {
  if (cues.length === 0 || audioMs <= 0 || speechMs < 0 || speechMs >= audioMs) return SILENT;
  const idx = cueIndexAt(cues, speechMs);
  const current = idx >= 0 ? cues[idx] : undefined;
  const upcoming = cues[idx + 1];
  const viseme: Viseme = current?.viseme ?? 'rest';
  const from = idx >= 0 ? coarticulatedTarget(cues, idx, audioMs) : REST;
  const startMs = current ? current.tMs : 0;
  // Whatever the last cue is, the mouth is back at rest when the audio ends.
  const endMs = upcoming ? Math.min(upcoming.tMs, audioMs) : audioMs;
  const nextViseme: Viseme = upcoming && upcoming.tMs < audioMs ? upcoming.viseme : 'rest';
  const window = Math.min(VISEME_BLEND_MS, BLEND_SHARE * Math.max(0, endMs - startMs));
  const untilNext = endMs - speechMs;
  if (window <= 0 || untilNext > window) {
    return { viseme, nextViseme: viseme, blend: 0, mouth: from };
  }
  const to = nextViseme === 'rest' ? REST : coarticulatedTarget(cues, idx + 1, audioMs);
  const blend = smooth(1 - untilNext / window);
  return { viseme, nextViseme, blend, mouth: blendMouthShapes(from, to, blend) };
}

/* ------------------------------------------------------------------------------ idle motion */

/** Smooth value noise in [-1, 1] (C² continuous), deterministic per seed. */
function noise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = seededUnit(seed, i) * 2 - 1;
  const b = seededUnit(seed, i + 1) * 2 - 1;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return a + (b - a) * u;
}

/** Two octaves of value noise, still within [-1, 1]. */
function drift(seed: number, x: number): number {
  return (noise(seed, x) + 0.5 * noise(seed ^ 0x5bd1e995, x * 2.13 + 17.3)) / 1.5;
}

const BLINK_SLOT_MS = 3400;
const BLINK_CLOSE_MS = 70;
const BLINK_HOLD_MS = 25;
const BLINK_OPEN_MS = 135;
const BLINK_MS = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS;

/** One blink: the lids drop fast, stay shut an instant and reopen more slowly. */
function blinkCurve(ms: number): number {
  if (ms < 0 || ms > BLINK_MS) return 0;
  if (ms < BLINK_CLOSE_MS) return smooth(ms / BLINK_CLOSE_MS);
  if (ms < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 1;
  return 1 - smooth((ms - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS);
}

/**
 * Blinking: one blink somewhere inside each ~3.4 s slot (so intervals vary between about
 * 0.7 and 6 s, like people's do), and now and then a double blink.
 */
function blinkAt(timeMs: number, seed: number): number {
  const t = Math.max(0, timeMs);
  const slot = Math.floor(t / BLINK_SLOT_MS);
  let value = 0;
  // The previous slot's blink may still be finishing.
  for (let s = Math.max(0, slot - 1); s <= slot; s += 1) {
    const start = s * BLINK_SLOT_MS + (0.1 + 0.8 * seededUnit(seed, s * 2)) * BLINK_SLOT_MS;
    value = Math.max(value, blinkCurve(t - start));
    if (seededUnit(seed, s * 2 + 1) < 0.16) {
      value = Math.max(value, blinkCurve(t - start - BLINK_MS - 60));
    }
  }
  return value;
}

const GAZE_SLOT_MS = 2600;
const SACCADE_MS = 70;

/**
 * Gaze: on the camera most of the time, with a brief glance away in roughly one slot out of
 * three. Eyes move in quick saccades, not in slow sweeps.
 */
function gazeAt(timeMs: number, seed: number): { x: number; y: number } {
  const t = Math.max(0, timeMs);
  const slot = Math.floor(t / GAZE_SLOT_MS);
  const local = t - slot * GAZE_SLOT_MS;
  if (seededUnit(seed, 500 + slot * 4) >= 0.32) return { x: 0, y: 0 };
  const start = (0.1 + 0.5 * seededUnit(seed, 501 + slot * 4)) * GAZE_SLOT_MS;
  const hold = 380 + 520 * seededUnit(seed, 502 + slot * 4);
  const angle = seededUnit(seed, 503 + slot * 4) * Math.PI * 2;
  const amount = smooth((local - start) / SACCADE_MS) - smooth((local - start - hold) / SACCADE_MS);
  return { x: Math.cos(angle) * 0.55 * amount, y: Math.sin(angle) * 0.3 * amount };
}

const BREATH_MS = 4200;

/** Breathing cycle 0..1: a quicker inhale and a longer exhale. */
function breathAt(timeMs: number, seed: number): number {
  const period = BREATH_MS * (0.9 + 0.2 * seededUnit(seed, 900));
  const p = (((Math.max(0, timeMs) / period + 0.5) % 1) + 1) % 1;
  return p < 0.4
    ? 0.5 - 0.5 * Math.cos((Math.PI * p) / 0.4)
    : 0.5 + 0.5 * Math.cos((Math.PI * (p - 0.4)) / 0.6);
}

/**
 * How much each word is stressed by gesture (0 = not at all): sentence openers and long words
 * get a brow flash and a small nod, and a few other words do at random (seeded). Questions
 * keep the brows up through their last word.
 */
function wordEmphasis(words: readonly WordCue[], i: number, seed: number): number {
  const word = words[i];
  if (!word) return 0;
  const prev = words[i - 1];
  if (!prev || /[.!?…:]["')\]]?$/.test(prev.text)) return 0.9;
  if (word.text.length >= 8) return 0.6;
  return seededUnit(seed, 3000 + i) < 0.2 ? 0.5 : 0;
}

/** Gesture envelope around the words near `speechMs`: quick rise, slower release. */
function emphasisAt(words: readonly WordCue[], speechMs: number, seed: number): number {
  if (words.length === 0) return 0;
  const last = cueIndexAt(words, speechMs + 120);
  let value = 0;
  for (let i = Math.max(0, last - 4); i <= last; i += 1) {
    const word = words[i];
    if (!word) continue;
    const strength = wordEmphasis(words, i, seed);
    const x = speechMs - word.tMs;
    if (strength > 0) {
      const env = x < 80 ? smooth((x + 120) / 200) : 1 - smooth((x - 80) / 460);
      value = Math.max(value, strength * env);
    }
    if (/\?["')\]]?$/.test(word.text)) {
      const env = smooth((x + 100) / 180) - smooth((x - word.durMs - 150) / 300);
      value = Math.max(value, 0.8 * env);
    }
  }
  return value;
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
 * Pose of an avatar at a given instant.
 *
 *  - mouth: co-articulated viseme track (see `mouthAt`), closed and softly smiling in silence
 *  - blink, gaze: seeded, irregular, with quick lid and eye movements
 *  - brows and head: react to the words being said (a flash and a small nod on stressed
 *    words, brows up on questions) on top of a slow, seeded drift; calmer when not speaking
 *  - breath: always on
 *
 * A scene starts from the neutral pose and eases into motion over the first half second, so
 * `sceneMs = 0` is a clean frame for thumbnails and cuts.
 */
export function computeAvatarState(input: AvatarStateInput): AvatarState {
  const { runtime, speechMs, sceneMs } = input;
  const seed = hashString(input.seed);
  const audioMs = runtime?.audioDurationMs ?? 0;
  const speaking = audioMs > 0 && speechMs >= 0 && speechMs < audioMs;
  const track = runtime ? mouthAt(runtime.visemes, speechMs, audioMs) : SILENT;

  // 0 in silence → 1 while talking, easing in just before the first word and out after the last.
  const activity =
    audioMs > 0 ? smooth((speechMs + 150) / 250) * (1 - smooth((speechMs - audioMs) / 600)) : 0;
  const emphasis = runtime && audioMs > 0 ? emphasisAt(runtime.words, speechMs, seed) : 0;
  const energy = 0.45 + 0.55 * activity;
  const settle = smooth(Math.max(0, sceneMs) / 500);
  const seconds = Math.max(0, sceneMs) / 1000;

  const turn =
    settle *
    energy *
    (0.5 * drift(seed + 11, seconds * 0.23) + 0.12 * drift(seed + 12, seconds * 0.9));
  const nod =
    settle * (energy * 0.34 * drift(seed + 21, seconds * 0.31) + 0.5 * emphasis * activity);
  const tilt = settle * energy * 0.42 * drift(seed + 31, seconds * 0.17);
  const glance = gazeAt(sceneMs, seed);

  return {
    viseme: track.viseme,
    nextViseme: track.nextViseme,
    blend: track.blend,
    mouth: track.mouth,
    blink: blinkAt(sceneMs, seed),
    gaze: {
      // The eyes stay on the camera while the head turns: counter-rotate a little.
      x: Math.max(-1, Math.min(1, glance.x - 0.35 * turn)) || 0,
      y: Math.max(-1, Math.min(1, glance.y - 0.3 * nod)) || 0,
    },
    // `|| 0` turns a negative zero into a plain 0 (clean values for the neutral pose).
    head: { nod: nod || 0, turn: turn || 0, tilt: tilt || 0 },
    breath: breathAt(sceneMs, seed),
    speaking,
    timeMs: sceneMs,
    brow: Math.max(
      -1,
      Math.min(1, 0.8 * emphasis * activity + settle * 0.07 * drift(seed + 41, seconds * 0.4)),
    ),
    smile: 0.5 - 0.3 * activity,
  };
}

/** Neutral pose (thumbnails, pickers); pass a running time for a gently animated idle. */
export function restingAvatarState(timeMs = 0): AvatarState {
  return computeAvatarState({ runtime: null, speechMs: -1, sceneMs: timeMs, seed: 'rest' });
}
