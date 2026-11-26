import type { MouthShape } from '@parlante/shared';
import type { Ctx2D } from '../../types';
import { softSpot } from './paths';
import type { CharacterSpec, Palette } from './spec';

/** Largest inner opening of the mouth (viseme A), in head units. */
const OPEN_MAX = 0.118;
/** How far the chin drops when the jaw is fully open. */
export const JAW_DROP = 0.04;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The mouth, drawn from the canonical viseme parameters (`MouthShape`), centred on (0, cy):
 *
 *  - `open`   parts the lips; the lower lip (jaw) travels further than the upper one
 *  - `width`  spreads (> 0) or puckers (< 0) the corners; spreading thins the lips
 *  - `round`  protrudes the lips: thicker, with a rounder opening
 *  - `teeth`  height of the upper teeth band; near 1 the teeth meet (S, Z)
 *  - `tongue` how far the tongue rises from the floor of the mouth
 *
 * Everything is continuous in the five parameters, so any blend of visemes is a valid mouth.
 * `smile` (0..1) lifts the corners a little.
 */
export function drawMouth(
  ctx: Ctx2D,
  pal: Palette,
  spec: CharacterSpec,
  mouth: MouthShape,
  smile: number,
  cy: number,
): void {
  const open = clamp01(mouth.open);
  const width = Math.min(1, Math.max(-1, mouth.width));
  const round = clamp01(mouth.round);
  const teeth = clamp01(mouth.teeth);
  const tongue = clamp01(mouth.tongue);
  const full = spec.face.lips;

  const spread = width >= 0 ? 0.26 * width : 0.44 * width;
  const hw = spec.face.mouth * (1 + spread + 0.07 * smile * (1 - round));
  const gap = OPEN_MAX * open ** 0.85;
  // Inner corners sit inside the outer ones; rounding pulls them further in (O, U).
  const ihw = Math.max(hw * 0.35, hw - (0.01 + 0.03 * round) - 0.004 * full);
  const lipU = 0.019 * full * (1 + 0.7 * round) * (1 - 0.22 * Math.max(0, width));
  const lipL = 0.03 * full * (1 + 0.12 * round) * (1 - 0.16 * Math.max(0, width));

  const upper = cy - gap * 0.26; // upper inner apex
  const lower = cy + gap * 0.74; // lower inner apex
  // The corners follow the middle of the opening and rise with a smile / a spread.
  const cornerY =
    cy + gap * 0.2 - 0.02 * smile * (1 - 0.6 * round) - 0.006 * Math.max(0, width) * (1 - open);
  // Closed lips meet in a gentle curve (a soft smile line).
  const seamSag = 0.005 + 0.012 * smile;
  const upCtrl = cornerY + (Math.min(upper, cy + seamSag) - cornerY) / 0.75;
  const lowCtrl = cornerY + (Math.max(lower, cy + seamSag) - cornerY) / 0.75;
  const upperEdgeY = gap > 0.002 ? upCtrl : cornerY + (cy + seamSag - cornerY) / 0.75;
  const lowerEdgeY = gap > 0.002 ? lowCtrl : upperEdgeY;

  // Soft shadow under the lower lip.
  softSpot(ctx, 0, lower + lipL + 0.016, hw * 0.62, 0.016, pal.skinShadeSoft, pal.skinShadeClear);

  if (gap > 0.002) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-ihw, cornerY);
    ctx.bezierCurveTo(-ihw * 0.5, upCtrl, ihw * 0.5, upCtrl, ihw, cornerY);
    ctx.bezierCurveTo(ihw * 0.55, lowCtrl, -ihw * 0.55, lowCtrl, -ihw, cornerY);
    ctx.closePath();
    ctx.clip();

    const cavity = ctx.createLinearGradient(0, upper, 0, lower);
    cavity.addColorStop(0, pal.mouthDeep);
    cavity.addColorStop(1, pal.mouthInner);
    ctx.fillStyle = cavity;
    ctx.fillRect(-hw, upper - 0.01, hw * 2, gap + 0.02);

    // Tongue: rises from the floor of the mouth.
    if (tongue > 0.04) {
      const rise = gap * (0.2 + 0.55 * tongue);
      ctx.fillStyle = pal.tongue;
      ctx.beginPath();
      ctx.ellipse(0, lower + gap * 0.12, ihw * (0.62 + 0.2 * tongue), rise, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = pal.tongueLight;
      ctx.beginPath();
      ctx.ellipse(0, lower + gap * 0.12 - rise * 0.62, ihw * 0.3, rise * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Upper teeth: one clean band under the upper lip (no individual teeth: at video sizes
    // tooth gaps read as noise). Its lower edge is slightly curved and lifts at the corners.
    if (teeth > 0.04) {
      const clench = clamp01((teeth - 0.82) / 0.18);
      const band = Math.min(gap * (0.3 + 0.5 * teeth), 0.034) + gap * 0.5 * clench;
      const top = Math.min(upper, cornerY) - 0.02;
      const bottom = upper + band;
      ctx.fillStyle = pal.teeth;
      ctx.beginPath();
      ctx.moveTo(-ihw, top);
      ctx.lineTo(ihw, top);
      ctx.lineTo(ihw, bottom - 0.004);
      ctx.quadraticCurveTo(0, bottom + 0.006, -ihw, bottom - 0.004);
      ctx.closePath();
      ctx.fill();
      // Shade where the teeth go under the lip.
      const tg = ctx.createLinearGradient(0, upper - 0.004, 0, upper + 0.012);
      tg.addColorStop(0, 'rgba(120,96,104,0.55)');
      tg.addColorStop(1, 'rgba(120,96,104,0)');
      ctx.fillStyle = tg;
      ctx.fillRect(-ihw, upper - 0.01, ihw * 2, 0.024);
      if (clench > 0.02) {
        // Teeth together (S, Z): lower teeth meet the upper ones along a thin line.
        const meet = upper + gap * 0.56;
        ctx.fillStyle = pal.teeth;
        ctx.fillRect(-ihw, meet, ihw * 2, gap);
        ctx.strokeStyle = `rgba(150,128,130,${(0.75 * clench).toFixed(3)})`;
        ctx.lineWidth = 0.0035;
        ctx.beginPath();
        ctx.moveTo(-ihw, meet - 0.001);
        ctx.quadraticCurveTo(0, meet + 0.003, ihw, meet - 0.001);
        ctx.stroke();
      }
      // The tongue tip shows in front of the teeth for dental sounds (TH).
      if (tongue > 0.7) {
        const tip = (tongue - 0.7) / 0.3;
        ctx.fillStyle = pal.tongueLight;
        ctx.beginPath();
        ctx.ellipse(0, lower - gap * 0.02, ihw * 0.5, gap * 0.42 * tip, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Upper lip (with a soft cupid's bow), in the shadow tone.
  const bow = upper - lipU;
  const dip = lipU * (0.24 - 0.14 * round);
  ctx.fillStyle = pal.lipDark;
  ctx.beginPath();
  const rise = cornerY - bow;
  ctx.moveTo(-hw, cornerY);
  ctx.bezierCurveTo(-hw * 0.9, cornerY - rise * 0.45, -hw * 0.46, bow - 0.001, -hw * 0.2, bow);
  ctx.quadraticCurveTo(-hw * 0.08, bow - 0.001, 0, bow + dip);
  ctx.quadraticCurveTo(hw * 0.08, bow - 0.001, hw * 0.2, bow);
  ctx.bezierCurveTo(hw * 0.46, bow - 0.001, hw * 0.9, cornerY - rise * 0.45, hw, cornerY);
  ctx.lineTo(ihw, cornerY);
  ctx.bezierCurveTo(ihw * 0.5, upperEdgeY, -ihw * 0.5, upperEdgeY, -ihw, cornerY);
  ctx.closePath();
  ctx.fill();

  // Lower lip, fuller and lit.
  const base = Math.max(lower, cy + seamSag) + lipL;
  ctx.fillStyle = pal.lip;
  ctx.beginPath();
  ctx.moveTo(-hw, cornerY);
  ctx.lineTo(-ihw, cornerY);
  ctx.bezierCurveTo(-ihw * 0.55, lowerEdgeY, ihw * 0.55, lowerEdgeY, ihw, cornerY);
  ctx.lineTo(hw, cornerY);
  // The outer edge is a soft half ellipse from corner to corner.
  const drop = base + 0.004 - cornerY;
  ctx.bezierCurveTo(hw * 0.97, cornerY + drop * 0.6, hw * 0.52, base + 0.004, 0, base + 0.004);
  ctx.bezierCurveTo(-hw * 0.52, base + 0.004, -hw * 0.97, cornerY + drop * 0.6, -hw, cornerY);
  ctx.closePath();
  ctx.fill();
  // Highlight on the lower lip.
  ctx.save();
  ctx.fillStyle = pal.lipLight;
  ctx.globalAlpha *= 0.45;
  ctx.beginPath();
  ctx.ellipse(0, base - lipL * 0.5, hw * 0.34, lipL * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Seam between closed lips; fades out as the mouth opens.
  const seamAlpha = clamp01(1 - gap / 0.012);
  if (seamAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha *= seamAlpha;
    ctx.strokeStyle = pal.seam;
    ctx.lineWidth = 0.0065;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-hw * 0.97, cornerY);
    ctx.bezierCurveTo(-ihw * 0.5, upperEdgeY, ihw * 0.5, upperEdgeY, hw * 0.97, cornerY);
    ctx.stroke();
    ctx.restore();
  }
  // Corners: tiny creases that keep the expression friendly.
  ctx.save();
  ctx.fillStyle = pal.seam;
  ctx.globalAlpha *= 0.4 * (1 - 0.6 * open);
  ctx.beginPath();
  ctx.ellipse(-hw, cornerY - 0.001, 0.0048, 0.0036, 0.5, 0, Math.PI * 2);
  ctx.moveTo(hw + 0.0048, cornerY - 0.001);
  ctx.ellipse(hw, cornerY - 0.001, 0.0048, 0.0036, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
