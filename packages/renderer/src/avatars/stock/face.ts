import type { Ctx2D } from '../../types';
import type { AvatarState } from '../types';
import { JAW_DROP, drawMouth } from './mouth';
import {
  addBlob,
  addCurve,
  fillBlob,
  fillEllipse,
  softSpot,
  strokeCurve,
  symmetric,
} from './paths';
import type { Pt } from './paths';
import type { CharacterSpec, Palette } from './spec';

/* -------------------------------------------------------------------------------------------
 * Head and face of a stock avatar, in character space (chin at the origin, crown at y = -1).
 * ----------------------------------------------------------------------------------------- */

export const EYE_Y = -0.452;
export const EYE_DX = 0.17;
const BROW_Y = EYE_Y - 0.098;
const NOSE_Y = -0.262;
const MOUTH_Y = -0.148;

/** Outline of the head. `jaw` (0..1) drops the chin: the face stretches as the mouth opens. */
export function headOutline(spec: CharacterSpec, jaw: number): Pt[] {
  const { width: hw, jaw: jw, chin: cw } = spec.face;
  const jd = jaw * JAW_DROP;
  return symmetric([
    [0, -1],
    [0.2, -0.975],
    [0.33, -0.865],
    [hw * 0.985, -0.68],
    [hw, -0.48],
    [hw * 0.96, -0.32],
    [jw + (hw - jw) * 0.25, -0.185 + jd * 0.3],
    [jw * 0.6 + cw * 0.4 + 0.022, -0.078 + jd * 0.75],
    [cw, -0.016 + jd],
    [0, jd],
  ]);
}

export function drawEars(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const x = spec.face.width - 0.006;
  for (const side of [-1, 1] as const) {
    fillEllipse(ctx, side * x, -0.405, 0.052, 0.092, pal.skin, side * 0.12);
    fillEllipse(ctx, side * (x + 0.006), -0.405, 0.026, 0.055, pal.skinShadeSoft, side * 0.12);
  }
}

export function drawEarrings(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  if (spec.earrings === 'none') return;
  const x = spec.face.width + 0.012;
  const y = -0.318;
  for (const side of [-1, 1] as const) {
    if (spec.earrings === 'hoop') {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 0.017;
      ctx.beginPath();
      ctx.ellipse(side * (x + 0.004), y + 0.06, 0.042, 0.058, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = pal.accentLight;
      ctx.lineWidth = 0.005;
      ctx.beginPath();
      ctx.ellipse(side * (x + 0.004), y + 0.06, 0.042, 0.058, 0, Math.PI * 0.9, Math.PI * 1.4);
      ctx.stroke();
    } else if (spec.earrings === 'pearl') {
      fillEllipse(ctx, side * x, y + 0.012, 0.021, 0.021, '#f4efe6');
      fillEllipse(ctx, side * x - 0.006, y + 0.006, 0.007, 0.007, '#ffffff');
    } else {
      fillEllipse(ctx, side * x, y + 0.008, 0.014, 0.014, pal.metal);
      fillEllipse(ctx, side * x - 0.004, y + 0.004, 0.005, 0.005, '#fff6da');
    }
  }
}

/** Neck with the shadow the jaw casts on it. Drawn in BODY space (it does not tilt). */
export function drawNeck(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const n = spec.neck;
  const pts: Pt[] = [
    [-n, -0.3],
    [-n * 1.02, 0.1],
    [-n * 1.22, 0.3],
    [-n * 2.3, 0.44],
    [n * 2.3, 0.44],
    [n * 1.22, 0.3],
    [n * 1.02, 0.1],
    [n, -0.3],
  ];
  const g = ctx.createLinearGradient(0, -0.1, 0, 0.36);
  g.addColorStop(0, pal.skinShade);
  g.addColorStop(0.55, pal.skin);
  g.addColorStop(1, pal.skin);
  ctx.beginPath();
  addCurve(ctx, pts);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
}

function eyePath(ctx: Ctx2D, spec: CharacterSpec, open: number, squint: number): void {
  const ew = spec.face.eye;
  const up = 0.064 * spec.face.eyeOpen;
  const low = 0.03 * (1 - 0.5 * squint);
  const top = -up * open + low * (1 - open) * 0.9;
  const tilt = spec.face.eyeTilt;
  ctx.moveTo(-ew, 0.004);
  ctx.bezierCurveTo(-ew * 0.55, top - 0.004, ew * 0.4, top, ew, tilt);
  ctx.bezierCurveTo(ew * 0.45, low, -ew * 0.5, low, -ew, 0.004);
  ctx.closePath();
}

function drawEye(
  ctx: Ctx2D,
  pal: Palette,
  spec: CharacterSpec,
  state: AvatarState,
  side: -1 | 1,
  squint: number,
): void {
  const ew = spec.face.eye;
  const open = Math.min(1, Math.max(0, 1 - state.blink)) * (1 - 0.14 * squint);
  const up = 0.064 * spec.face.eyeOpen;
  const low = 0.03 * (1 - 0.5 * squint);
  const top = -up * open + low * (1 - open) * 0.9;
  const tilt = spec.face.eyeTilt;

  ctx.save();
  ctx.translate(side * EYE_DX, EYE_Y);
  // Draw the avatar's left eye mirrored so inner/outer corners are right on both sides.
  ctx.scale(side, 1);

  if (open > 0.06) {
    ctx.save();
    ctx.beginPath();
    eyePath(ctx, spec, open, squint);
    ctx.clip();
    const white = ctx.createLinearGradient(0, -up * 0.8, 0, low);
    white.addColorStop(0, pal.eyeWhiteShade);
    white.addColorStop(0.45, pal.eyeWhite);
    white.addColorStop(1, pal.eyeWhite);
    ctx.fillStyle = white;
    ctx.fillRect(-ew - 0.01, -up - 0.01, ew * 2 + 0.02, up + low + 0.02);
    // Iris + pupil follow the gaze (un-mirrored so both eyes look the same way).
    const ix = side * state.gaze.x * 0.02 + 0.002;
    const iy = state.gaze.y * 0.012 - 0.006;
    const r = ew * 0.56;
    const iris = ctx.createRadialGradient(ix, iy + r * 0.25, r * 0.15, ix, iy, r);
    iris.addColorStop(0, pal.irisLight);
    iris.addColorStop(0.62, pal.iris);
    iris.addColorStop(1, pal.irisDark);
    fillEllipse(ctx, ix, iy, r, r, iris);
    fillEllipse(ctx, ix, iy, r * 0.46, r * 0.46, pal.pupil);
    fillEllipse(ctx, ix - side * r * 0.34, iy - r * 0.36, r * 0.24, r * 0.24, '#ffffff');
    // Shadow of the upper lid over the eyeball.
    const lid = ctx.createLinearGradient(0, top, 0, top + 0.024);
    lid.addColorStop(0, 'rgba(40,24,30,0.38)');
    lid.addColorStop(1, 'rgba(40,24,30,0)');
    ctx.fillStyle = lid;
    ctx.fillRect(-ew - 0.01, top - 0.02, ew * 2 + 0.02, 0.06);
    ctx.restore();
  }

  // Upper lash line: a tapered shape, thickest over the outer third, with a small flick.
  const th = spec.lashes ? 0.017 : 0.0125;
  ctx.fillStyle = pal.lash;
  ctx.beginPath();
  ctx.moveTo(-ew, 0.004);
  ctx.bezierCurveTo(-ew * 0.55, top - 0.004, ew * 0.4, top, ew, tilt);
  if (spec.lashes) {
    ctx.lineTo(ew + 0.024, tilt - 0.016 - 0.006 * open);
    ctx.quadraticCurveTo(ew + 0.004, tilt - 0.012, ew * 0.82, tilt - th * 0.9);
  }
  ctx.bezierCurveTo(ew * 0.42, top - th * 1.25, -ew * 0.5, top - th * 0.75, -ew, 0.004);
  ctx.closePath();
  ctx.fill();
  // Lower lid: a faint line on the outer half.
  ctx.strokeStyle = pal.skinShadeSoft;
  ctx.lineWidth = 0.006;
  ctx.beginPath();
  ctx.moveTo(ew, tilt);
  ctx.bezierCurveTo(ew * 0.45, low, -ew * 0.2, low + 0.001, -ew * 0.55, low * 0.72);
  ctx.stroke();
  // Lid crease.
  ctx.strokeStyle = pal.skinShadeSoft;
  ctx.lineWidth = 0.0055;
  ctx.beginPath();
  ctx.moveTo(-ew * 0.8, -up * 0.62 - 0.012);
  ctx.quadraticCurveTo(0, -up - 0.028, ew * 0.92, -up * 0.42 - 0.012 + tilt);
  ctx.stroke();
  ctx.restore();
}

function drawBrow(
  ctx: Ctx2D,
  pal: Palette,
  spec: CharacterSpec,
  side: -1 | 1,
  raise: number,
): void {
  const t = spec.face.brow;
  const arch = spec.face.browArch;
  ctx.save();
  ctx.translate(side * EYE_DX, BROW_Y - 0.03 * raise);
  ctx.scale(side, 1);
  // A soft arch whose tail ends lower than its inner end: relaxed, never frowning. Raising
  // the brows lifts the inner ends a little more (an open, attentive look).
  const inner = -0.002 - 0.008 * Math.max(0, raise);
  const tail = 0.014;
  ctx.fillStyle = pal.brow;
  ctx.beginPath();
  ctx.moveTo(-0.08, inner);
  ctx.bezierCurveTo(-0.045, -arch * 0.9 - t * 0.55, 0.035, -arch - t * 0.5, 0.102, tail);
  ctx.bezierCurveTo(0.045, -arch + t * 0.42, -0.03, -arch * 0.75 + t * 0.6, -0.078, inner + t);
  ctx.quadraticCurveTo(-0.09, inner + t * 0.5, -0.08, inner);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNose(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const w = 0.043 * spec.face.nose;
  // Under-nose shadow and nostril wings: enough to read as a nose without outlining it.
  softSpot(ctx, 0.004, NOSE_Y + 0.012, w * 1.25, 0.02, pal.skinShadeSoft, pal.skinShadeClear);
  ctx.save();
  ctx.strokeStyle = pal.skinDeep;
  ctx.globalAlpha *= 0.5;
  ctx.lineWidth = 0.0075;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-w, NOSE_Y - 0.006);
  ctx.quadraticCurveTo(-w * 0.9, NOSE_Y + 0.012, -w * 0.4, NOSE_Y + 0.008);
  ctx.moveTo(w, NOSE_Y - 0.006);
  ctx.quadraticCurveTo(w * 0.9, NOSE_Y + 0.012, w * 0.4, NOSE_Y + 0.008);
  ctx.stroke();
  // Light along the bridge and on the tip.
  ctx.fillStyle = pal.skinLight;
  ctx.beginPath();
  ctx.ellipse(-0.004, NOSE_Y - 0.075, 0.011, 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-0.004, NOSE_Y - 0.014, w * 0.42, 0.017, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBeard(ctx: Ctx2D, pal: Palette, spec: CharacterSpec, jaw: number): void {
  if (spec.beard === 'none') return;
  const { width: hw, jaw: jw, chin: cw } = spec.face;
  const jd = jaw * JAW_DROP;
  const my = MOUTH_Y + jd * 0.35;
  const outer: Pt[] = [
    [hw * 0.99, -0.5],
    [hw * 0.968, -0.32],
    [jw + (hw - jw) * 0.25 + 0.005, -0.183 + jd * 0.3],
    [jw * 0.6 + cw * 0.4 + 0.028, -0.072 + jd * 0.75],
    [cw + 0.004, -0.008 + jd],
    [0, 0.01 + jd],
  ];
  const beard: Pt[] = [
    ...outer,
    ...outer
      .slice(0, -1)
      .reverse()
      .map((p) => [-p[0], p[1]] as Pt),
    // inner edge, avatar's right cheek → moustache → left cheek
    [-hw * 0.93, -0.44],
    [-0.3, -0.27],
    [-0.19, my - 0.05],
    [-0.07, my - 0.074],
    [0, my - 0.064],
    [0.07, my - 0.074],
    [0.19, my - 0.05],
    [0.3, -0.27],
    [hw * 0.93, -0.44],
  ];
  if (spec.beard === 'stubble') {
    // A day's growth: the beard shape layered a few times, each lower and fainter, so its
    // upper edge fades into the cheeks instead of drawing a line.
    ctx.save();
    ctx.beginPath();
    addBlob(ctx, headOutline(spec, jaw));
    ctx.clip();
    ctx.globalAlpha *= 0.075;
    for (let k = 0; k < 4; k += 1) {
      fillBlob(ctx, beard, pal.hair);
      ctx.translate(0, 0.018);
    }
    ctx.restore();
    return;
  }
  fillBlob(ctx, beard, pal.hair);
  // A few lighter strokes for volume.
  ctx.save();
  ctx.globalAlpha *= 0.5;
  strokeCurve(
    ctx,
    [
      [-0.2, -0.13 + jd * 0.4],
      [-0.1, -0.05 + jd * 0.8],
      [0, -0.03 + jd],
    ],
    pal.hairLight,
    0.008,
  );
  strokeCurve(
    ctx,
    [
      [0.25, -0.16 + jd * 0.3],
      [0.17, -0.07 + jd * 0.7],
    ],
    pal.hairLight,
    0.008,
  );
  ctx.restore();
}

function drawGlasses(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  if (spec.glasses === 'none') return;
  const r = 0.098;
  const y = EYE_Y + 0.006;
  ctx.save();
  for (const side of [-1, 1] as const) {
    const x = side * (EYE_DX + 0.004);
    // lens tint + glint
    fillEllipse(ctx, x, y, r, r * 0.95, 'rgba(255,255,255,0.07)');
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.95, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    ctx.moveTo(x - r, y - r * 0.5);
    ctx.lineTo(x - r * 0.5, y - r);
    ctx.lineTo(x - r * 0.25, y - r);
    ctx.lineTo(x - r, y - r * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = pal.accentShade;
    ctx.lineWidth = 0.017;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.95, 0, 0, Math.PI * 2);
    ctx.stroke();
    // temple
    ctx.lineWidth = 0.014;
    ctx.beginPath();
    ctx.moveTo(x + side * r, y - 0.012);
    ctx.lineTo(side * (spec.face.width + 0.012), y - 0.03);
    ctx.stroke();
  }
  ctx.strokeStyle = pal.accentShade;
  ctx.lineWidth = 0.014;
  ctx.beginPath();
  ctx.moveTo(-(EYE_DX + 0.004) + r, y - 0.012);
  ctx.quadraticCurveTo(0, y - 0.04, EYE_DX + 0.004 - r, y - 0.012);
  ctx.stroke();
  ctx.restore();
}

function drawAgeLines(ctx: Ctx2D, pal: Palette, jaw: number): void {
  ctx.save();
  ctx.globalAlpha *= 0.42;
  const jd = jaw * JAW_DROP;
  for (const side of [-1, 1] as const) {
    // nasolabial fold
    strokeCurve(
      ctx,
      [
        [side * 0.07, NOSE_Y + 0.004],
        [side * 0.125, NOSE_Y + 0.06],
        [side * 0.14, MOUTH_Y + 0.012 + jd * 0.3],
      ],
      pal.skinDeep,
      0.006,
    );
    // crow's feet
    strokeCurve(
      ctx,
      [
        [side * (EYE_DX + 0.092), EYE_Y - 0.012],
        [side * (EYE_DX + 0.12), EYE_Y - 0.026],
      ],
      pal.skinDeep,
      0.005,
    );
    strokeCurve(
      ctx,
      [
        [side * (EYE_DX + 0.094), EYE_Y + 0.008],
        [side * (EYE_DX + 0.122), EYE_Y + 0.016],
      ],
      pal.skinDeep,
      0.005,
    );
    // under-eye
    strokeCurve(
      ctx,
      [
        [side * (EYE_DX - 0.05), EYE_Y + 0.052],
        [side * EYE_DX, EYE_Y + 0.064],
        [side * (EYE_DX + 0.05), EYE_Y + 0.052],
      ],
      pal.skinDeep,
      0.0045,
    );
  }
  // forehead
  strokeCurve(
    ctx,
    [
      [-0.13, -0.7],
      [0, -0.708],
      [0.13, -0.7],
    ],
    pal.skinDeep,
    0.005,
  );
  ctx.restore();
}

function drawFreckles(ctx: Ctx2D, pal: Palette): void {
  const dots: readonly Pt[] = [
    [0.1, -0.325],
    [0.14, -0.345],
    [0.18, -0.322],
    [0.215, -0.34],
    [0.125, -0.3],
    [0.17, -0.296],
    [0.045, -0.31],
  ];
  ctx.save();
  ctx.fillStyle = pal.skinDeep;
  ctx.globalAlpha *= 0.4;
  ctx.beginPath();
  for (const [x, y] of dots) {
    ctx.moveTo(x + 0.006, y);
    ctx.arc(x, y, 0.006, 0, Math.PI * 2);
    ctx.moveTo(-x + 0.006, y + 0.004);
    ctx.arc(-x, y + 0.004, 0.006, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
}

export interface FaceMotion {
  /** Parallax of the facial features over the skull (pseudo-3D turn / nod). */
  fx: number;
  fy: number;
}

/**
 * Head (skin, shading) and every facial feature. `hairShadow` paints the shadow the front
 * hair casts on the forehead (clipped to the skin).
 */
export function drawHead(
  ctx: Ctx2D,
  pal: Palette,
  spec: CharacterSpec,
  state: AvatarState,
  motion: FaceMotion,
  hairShadow: ((ctx: Ctx2D) => void) | null,
): void {
  const jaw = Math.min(1, Math.max(0, state.mouth.open));
  const smile = state.smile ?? 0.3;
  const outline = headOutline(spec, jaw);
  const hw = spec.face.width;

  // Form shading baked into ONE opaque fill (light from the upper left, the far cheek falls
  // into shadow): an opaque gradient costs a fraction of blending a translucent one on top.
  ctx.beginPath();
  addBlob(ctx, outline);
  const skin = ctx.createLinearGradient(-hw, 0, hw, 0);
  skin.addColorStop(0, pal.skinLit);
  skin.addColorStop(0.45, pal.skin);
  skin.addColorStop(0.7, pal.skin);
  skin.addColorStop(1, pal.skinSide);
  ctx.fillStyle = skin;
  ctx.fill();
  // Shadow under the lower lip / on the chin (it may spill onto the neck, which is in shadow).
  softSpot(ctx, 0, -0.012 + jaw * JAW_DROP, 0.15, 0.075, pal.skinShadeSoft, pal.skinShadeClear);
  if (hairShadow) {
    ctx.save();
    ctx.beginPath();
    addBlob(ctx, outline);
    ctx.clip();
    ctx.translate(0.006, 0.03);
    ctx.globalAlpha *= 0.3;
    hairShadow(ctx);
    ctx.restore();
  }
  // Cheeks.
  if (spec.blush > 0) {
    softSpot(ctx, -0.215 + motion.fx, -0.275, 0.1, 0.07, pal.blush, pal.blushClear);
    softSpot(ctx, 0.215 + motion.fx, -0.275, 0.1, 0.07, pal.blush, pal.blushClear);
  }

  ctx.save();
  ctx.translate(motion.fx, motion.fy);
  if (spec.freckles) drawFreckles(ctx, pal);
  if (spec.lines) drawAgeLines(ctx, pal, jaw);
  drawBeard(ctx, pal, spec, jaw);
  drawNose(ctx, pal, spec);
  const squint = Math.max(0, smile - 0.3) * 0.6;
  drawEye(ctx, pal, spec, state, -1, squint);
  drawEye(ctx, pal, spec, state, 1, squint);
  const raise = state.brow ?? 0;
  // The brows dip a little while the lids are closed.
  drawBrow(ctx, pal, spec, -1, raise - state.blink * 0.18);
  drawBrow(ctx, pal, spec, 1, raise - state.blink * 0.18);
  ctx.save();
  ctx.translate(0, MOUTH_Y + jaw * JAW_DROP * 0.35);
  drawMouth(ctx, pal, spec, state.mouth, smile, 0);
  ctx.restore();
  drawGlasses(ctx, pal, spec);
  ctx.restore();
}
