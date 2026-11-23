import type { AvatarFraming } from '@parlante/shared';
import type { Ctx2D, PixelBox } from '../../types';
import type { AvatarDrawOptions, AvatarRig, AvatarState } from '../types';
import { drawEarrings, drawEars, drawHead, drawNeck } from './face';
import { createHair } from './hair';
import { drawOutfit, drawOutfitBack } from './outfit';
import { buildPalette } from './spec';
import type { CharacterSpec } from './spec';

/**
 * Framing windows in character space (1 unit = head height, chin at y = 0): the vertical
 * range a framing shows and the narrowest width it should keep in view. The window is fitted
 * inside the layer box (contain), centred horizontally and anchored to the bottom edge.
 *
 *   closeup  hair → collar     the face fills the box; its centre sits between the eyes and
 *                              the nose, so a `circle` mask frames the face
 *   bust     hair → chest      the classic presenter shot
 *   half     hair → waist      shoulders, arms and torso
 *
 * The scales are close to those of photorealistic avatars (`PHOTO_FRAMING_FACE_HEIGHT`:
 * eye line → chin is 0.45 units here), so swapping an instant avatar for a photoreal one in
 * the same layer keeps the person about the same size.
 */
export const STOCK_FRAMING_WINDOWS: Record<
  AvatarFraming,
  { top: number; bottom: number; minWidth: number }
> = {
  closeup: { top: -1.26, bottom: 0.38, minWidth: 1.25 },
  bust: { top: -1.32, bottom: 1.1, minWidth: 2.0 },
  half: { top: -1.4, bottom: 2.56, minWidth: 2.3 },
};

/** Pixel size of one character unit (head height) for a box and framing. */
export function stockAvatarScale(box: PixelBox, framing: AvatarFraming): number {
  const win = STOCK_FRAMING_WINDOWS[framing];
  return Math.max(0, Math.min(box.h / (win.bottom - win.top), box.w / win.minWidth));
}

// Amplitudes of the pose, in character units / radians, for state values of ±1.
const HEAD_TURN = 0.022;
const HEAD_NOD = 0.012;
const HEAD_TILT = 0.045;
const FACE_TURN = 0.03;
const FACE_NOD = 0.018;
const BREATH_LIFT = 0.012;
/** The body sits this far up in character space (shoulders tucked under the jaw line). */
const BODY_Y = -0.1;

/**
 * A parametric 2D character drawn with Canvas2D paths only (no images, no platform access):
 * the same code runs in the browser and in Node, and one frame costs well under a
 * millisecond-scale budget. The rig keeps no state between frames.
 */
export function createCharacterRig(id: string, spec: CharacterSpec): AvatarRig {
  const pal = buildPalette(spec);
  const hair = createHair(spec.hairStyle);
  const hairShadow = (ctx: Ctx2D): void => {
    hair.frontPath(ctx);
    ctx.fillStyle = pal.skinDeep;
    ctx.fill();
  };

  return {
    id,
    kind: 'stock',
    draw(ctx: Ctx2D, box: PixelBox, state: AvatarState, options: AvatarDrawOptions): void {
      if (!(box.w > 0) || !(box.h > 0)) return;
      const win = STOCK_FRAMING_WINDOWS[options.framing];
      const u = stockAvatarScale(box, options.framing);
      if (!(u > 0)) return;

      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      if (options.flip) {
        ctx.translate(2 * (box.x + box.w / 2), 0);
        ctx.scale(-1, 1);
      }
      ctx.translate(box.x + box.w / 2, box.y + box.h - win.bottom * u);
      ctx.scale(u, u);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Breathing lifts the shoulders; the head rides along a little less.
      const lift = -(state.breath - 0.5) * BREATH_LIFT;
      const head = (): void => {
        ctx.translate(state.head.turn * HEAD_TURN, state.head.nod * HEAD_NOD + lift * 0.6);
        ctx.translate(0, 0.1);
        ctx.rotate(state.head.tilt * HEAD_TILT);
        ctx.translate(0, -0.1);
      };

      ctx.save();
      head();
      hair.back(ctx, pal);
      ctx.restore();

      ctx.save();
      ctx.translate(0, BODY_Y + lift);
      drawOutfitBack(ctx, pal, spec);
      drawNeck(ctx, pal, spec);
      drawOutfit(ctx, pal, spec);
      ctx.restore();

      ctx.save();
      head();
      hair.mid(ctx, pal);
      if (!hair.coversEars) drawEars(ctx, pal, spec);
      drawEarrings(ctx, pal, spec);
      drawHead(
        ctx,
        pal,
        spec,
        state,
        { fx: state.head.turn * FACE_TURN, fy: state.head.nod * FACE_NOD },
        hairShadow,
      );
      hair.front(ctx, pal);
      ctx.restore();

      ctx.restore();
    },
  };
}
