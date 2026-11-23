import type { AvatarFraming, MouthShape, StockAvatarMeta, Viseme } from '@parlante/shared';
import type { Ctx2D, PixelBox } from '../types';

/**
 * Pose of an avatar at one instant. Computed by `computeAvatarState` from the scene runtime;
 * rigs only DRAW it (they keep no state between frames, so any frame can be rendered alone).
 */
export interface AvatarState {
  /** Mouth shape being left and the one being approached, with the progress between them. */
  viseme: Viseme;
  nextViseme: Viseme;
  /** 0 = fully `viseme`, 1 = fully `nextViseme`. */
  blend: number;
  /**
   * The mouth to draw: canonical viseme parameters (`VISEME_MOUTH_SHAPES`) after
   * co-articulation — continuous in time, eased between cues and softened by the neighbouring
   * sounds. Rigs draw THIS; `viseme` / `nextViseme` / `blend` describe the same transition
   * coarsely (labels, debugging, simple rigs).
   */
  mouth: MouthShape;
  /** Eyelids: 0 = open, 1 = closed. */
  blink: number;
  /** Gaze offset, each axis -1..1 (0,0 = looking at the camera). */
  gaze: { x: number; y: number };
  /** Head motion, each -1..1: nod = pitch (down positive), turn = yaw, tilt = roll. */
  head: { nod: number; turn: number; tilt: number };
  /** Breathing cycle 0..1 (chest/shoulder rise). */
  breath: number;
  /** True while narration audio is playing for this avatar. */
  speaking: boolean;
  /** Scene-local time in ms, for any further deterministic idle motion. */
  timeMs: number;
  /**
   * Eyebrow raise, -1..1 (0 = relaxed, 1 = fully raised on an emphasised word). Optional so
   * hand-built states stay valid; `computeAvatarState` always sets it. Rigs treat a missing
   * value as 0.
   */
  brow?: number;
  /**
   * Smile, 0..1: the friendly resting expression (stronger while idle, lighter while the
   * mouth articulates). `computeAvatarState` always sets it; rigs default it to a soft smile.
   */
  smile?: number;
}

export interface AvatarDrawOptions {
  framing: AvatarFraming;
  /** Mirror horizontally. */
  flip: boolean;
  quality: 'preview' | 'final';
}

/**
 * A drawable avatar. `draw` paints the character inside `box` (output pixels) — the box is the
 * avatar layer's box; the rig fits itself according to `options.framing`, anchored to the
 * bottom-centre of the box, and must not paint outside of it (the caller clips when a shape
 * mask is set). `draw` must be pure: same arguments ⇒ same pixels.
 */
export interface AvatarRig {
  readonly id: string;
  readonly kind: 'stock' | 'photo';
  draw(ctx: Ctx2D, box: PixelBox, state: AvatarState, options: AvatarDrawOptions): void;
}

/** A stock avatar: catalogue metadata + a factory for its rig. */
export interface StockAvatarDefinition {
  meta: StockAvatarMeta;
  createRig(): AvatarRig;
}

export const DEFAULT_AVATAR_DRAW_OPTIONS: AvatarDrawOptions = {
  framing: 'bust',
  flip: false,
  quality: 'final',
};
