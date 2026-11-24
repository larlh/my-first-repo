import type { AvatarFraming, PhotoAvatarRig, PhotoLandmarks } from '@parlante/shared';
import type { Ctx2D, PixelBox, RenderImage } from '../types';
import type { AvatarDrawOptions, AvatarRig, AvatarState } from './types';

/**
 * Landmarks assumed when the user did not mark them: a centred, front-facing portrait.
 * Used by the photo-avatar job (`landmarksSource: 'estimated'`).
 */
export const ESTIMATED_LANDMARKS: PhotoLandmarks = {
  leftEye: { x: 0.4, y: 0.4 },
  rightEye: { x: 0.6, y: 0.4 },
  mouthLeft: { x: 0.43, y: 0.62 },
  mouthRight: { x: 0.57, y: 0.62 },
  chin: { x: 0.5, y: 0.74 },
};

/**
 * Eye-line → chin distance as a fraction of the box height, per framing. `half` shows the
 * whole prepared portrait; `bust` and `closeup` zoom into the face.
 */
export const PHOTO_FRAMING_FACE_HEIGHT: Record<AvatarFraming, number> = {
  half: 0,
  bust: 0.2,
  closeup: 0.32,
};
/** `closeup`: height of the eye line inside the box (fraction from the top). */
const CLOSEUP_EYE_LINE = 0.4;

/**
 * WHERE a photorealistic avatar image goes inside an avatar layer box — pure geometry, and
 * the SINGLE definition shared by the Canvas stand-in (`createPhotoAvatarRig`) and the neural
 * clip of the export (`renderFrame`), so the face sits in the same place in the Studio preview
 * and in the MP4. `imageW × imageH` is the size of what is drawn (portrait, cut-out or clip
 * frame — all share the prepared portrait's framing, so normalised `landmarks` apply to each).
 *
 *  - half:    the whole image, contained in the box, centred, anchored to the bottom
 *  - bust:    zoomed so eye-line→chin is 20 % of the box height (never smaller than `half`),
 *             face centred horizontally, anchored to the bottom
 *  - closeup: eye-line→chin is 32 % of the box height, face centred horizontally with the eye
 *             line 40 % down the box (so a `circle` mask frames the face, not the chest)
 * The image may overflow the box: callers clip to it. Returns the destination rectangle.
 */
export function photoAvatarPlacement(
  imageW: number,
  imageH: number,
  box: PixelBox,
  framing: AvatarFraming,
  landmarks: PhotoLandmarks | null | undefined,
): PixelBox {
  if (!(imageW > 0) || !(imageH > 0)) return { x: box.x, y: box.y, w: 0, h: 0 };
  const contain = Math.min(box.w / imageW, box.h / imageH);
  const containBox = (): PixelBox => {
    const w = imageW * contain;
    const h = imageH * contain;
    return { x: box.x + (box.w - w) / 2, y: box.y + box.h - h, w, h };
  };
  if (framing === 'half' || !landmarks) return containBox();
  const eyeY = ((landmarks.leftEye.y + landmarks.rightEye.y) / 2) * imageH;
  const faceCx = ((landmarks.leftEye.x + landmarks.rightEye.x) / 2) * imageW;
  const faceH = landmarks.chin.y * imageH - eyeY;
  if (!(faceH > 1)) return containBox();
  const scale = Math.max(contain, (PHOTO_FRAMING_FACE_HEIGHT[framing] * box.h) / faceH);
  const w = imageW * scale;
  const h = imageH * scale;
  const x = box.x + box.w / 2 - faceCx * scale;
  const bottomAnchored = box.y + box.h - h;
  const y =
    framing === 'closeup'
      ? // Never leave a gap under the image: the bottom edge stays at or below the box bottom.
        Math.max(bottomAnchored, box.y + CLOSEUP_EYE_LINE * box.h - eyeY * scale)
      : bottomAnchored;
  return { x, y, w, h };
}

/**
 * Width of the fade applied to a VISIBLE VERTICAL EDGE of a photorealistic avatar picture, as
 * a fraction of the picture's placed width. A prepared portrait is square and its shoulders
 * run into its left and right borders, so wherever such a border (or the layer box that crops
 * the zoomed picture) falls inside the frame the body would end in a straight vertical cut.
 */
export const PHOTO_SIDE_FADE = 0.1;

/** One faded edge in box-local x: fully transparent at `from`, fully opaque at `to`. */
export interface PhotoFadeEdge {
  from: number;
  to: number;
}

export interface PhotoSideFade {
  left: PhotoFadeEdge | null;
  right: PhotoFadeEdge | null;
}

/**
 * WHICH vertical edges of a photorealistic avatar picture must fade out, and where — pure
 * geometry shared by the stand-in and the neural clip (the layer painter applies it to both),
 * so the Studio preview and the exported MP4 end the shoulders the same way.
 *
 * `place` is `photoAvatarPlacement(...)` for the layer `box`; x coordinates of the result are
 * relative to `box.x`, already mirrored when `flip` is set. An edge fades when it is visible
 * as a cut inside the frame:
 *  - the picture's own border lies inside the box (the picture is narrower than the box), or
 *  - the box crops the picture, the layer has no shape mask (`windowed` false — with a circle
 *    or rounded mask the box is a window and its edge is a legitimate frame) and that box edge
 *    is inside the canvas (a crop by the canvas edge is how any camera frame ends).
 * Returns null when nothing has to fade (callers then draw directly, untouched).
 */
export function photoSideFade(
  place: PixelBox,
  box: PixelBox,
  options: { windowed: boolean; canvasWidth: number; flip?: boolean },
): PhotoSideFade | null {
  if (!(place.w > 0) || !(box.w > 0)) return null;
  const EPS = 0.5;
  const visLeft = Math.max(place.x, box.x);
  const visRight = Math.min(place.x + place.w, box.x + box.w);
  const visible = visRight - visLeft;
  if (!(visible > 2)) return null;
  const width = Math.min(PHOTO_SIDE_FADE * place.w, 0.4 * visible);
  const fades = (edgeX: number, pictureBorderInside: boolean): boolean => {
    if (edgeX <= EPS || edgeX >= options.canvasWidth - EPS) return false; // cropped by the frame
    return pictureBorderInside || !options.windowed;
  };
  let left = fades(visLeft, place.x > box.x + EPS)
    ? { from: visLeft - box.x, to: visLeft - box.x + width }
    : null;
  let right = fades(visRight, place.x + place.w < box.x + box.w - EPS)
    ? { from: visRight - box.x, to: visRight - box.x - width }
    : null;
  if (options.flip) {
    const mirror = (edge: PhotoFadeEdge | null): PhotoFadeEdge | null =>
      edge ? { from: box.w - edge.from, to: box.w - edge.to } : null;
    [left, right] = [mirror(right), mirror(left)];
  }
  return left || right ? { left, right } : null;
}

/**
 * How far the stand-in may move, as fractions of the layer box (so the motion is the same
 * number of pixels whatever the framing zoom). Kept to about a pixel or two at preview sizes:
 * the stand-in must stay registered with the neural clip that replaces it in the export.
 */
export const PHOTO_STAND_IN_MOTION = {
  /** Breathing: the portrait grows from its bottom edge; lift of its top, × box height. */
  breath: 0.004,
  /** Sideways sway for `head.turn` = ±1, × box width. */
  sway: 0.004,
  /** Downward dip for `head.nod` = 1 (stressed words), × box height. */
  nod: 0.004,
} as const;

/** Largest half-height of the mouth shade, × the mouth width (corner to corner). */
const MOUTH_SHADE_OPEN = 0.12;

/**
 * STAND-IN rig for photorealistic avatars (`real_…`, `avt_…`): what the Studio live preview
 * and the interactive avatar show in real time. Exports replace it with the neural clip
 * (`RenderAssets.avatarClip`), and the UI labels it as a preview.
 *
 * It is deliberately modest and never warps the photo — a face that is stretched or has a
 * mouth painted over it reads as wrong long before it reads as alive:
 *
 *  - the cut-out is drawn exactly where `photoAvatarPlacement` puts it (the SAME geometry as
 *    the exported clip), and only moves RIGIDLY and by a pixel or two: it breathes (grows a
 *    hair from its bottom edge), sways and dips slightly on stressed words;
 *  - speech shows as a soft shade between the lips whose size and width follow `state.mouth`
 *    (so timing can be judged in the preview). It is a translucent shadow, not a drawn mouth,
 *    and it is skipped when the landmarks are only `estimated` — better no cue than a cue in
 *    the wrong place;
 *  - no blink and no eye motion: those need the neural engine.
 *
 * `image` MUST be the avatar's CUT-OUT (`Avatar.cutoutUrl`: prepared portrait with its alpha
 * matte applied — or `applyAlphaMatte(platform, portrait, mask)`), not the raw portrait:
 * the person is then composited over the scene background exactly like the exported clip.
 */
export function createPhotoAvatarRig(
  id: string,
  image: RenderImage,
  rig: PhotoAvatarRig,
): AvatarRig {
  const { mouthLeft, mouthRight } = rig.landmarks;
  const mouthKnown = rig.landmarksSource !== 'estimated';
  return {
    id,
    kind: 'photo',
    placement: (box: PixelBox, framing: AvatarFraming): PixelBox =>
      photoAvatarPlacement(image.width, image.height, box, framing, rig.landmarks),
    draw(ctx: Ctx2D, box: PixelBox, state: AvatarState, options: AvatarDrawOptions): void {
      const place = photoAvatarPlacement(
        image.width,
        image.height,
        box,
        options.framing,
        rig.landmarks,
      );
      if (!(place.w > 0) || !(place.h > 0)) return;

      // Rigid micro-motion. The portrait only ever grows from its bottom edge and dips
      // downwards, so it never uncovers a gap under the shoulders.
      const grow = 1 + (PHOTO_STAND_IN_MOTION.breath * state.breath * box.h) / place.h;
      const w = place.w * grow;
      const h = place.h * grow;
      const x = place.x - (w - place.w) / 2 + state.head.turn * PHOTO_STAND_IN_MOTION.sway * box.w;
      const y =
        place.y - (h - place.h) + Math.max(0, state.head.nod) * PHOTO_STAND_IN_MOTION.nod * box.h;

      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      if (options.flip) {
        ctx.translate(2 * (box.x + box.w / 2), 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(image.source, x, y, w, h);

      const open = Math.min(1, Math.max(0, state.mouth.open));
      if (mouthKnown && open > 0.03) {
        const mx = x + ((mouthLeft.x + mouthRight.x) / 2) * w;
        const my = y + ((mouthLeft.y + mouthRight.y) / 2) * h;
        const mw = Math.hypot((mouthRight.x - mouthLeft.x) * w, (mouthRight.y - mouthLeft.y) * h);
        const spread = Math.min(1, Math.max(-1, state.mouth.width));
        const rx = mw * (0.3 + 0.07 * spread - 0.05 * state.mouth.round);
        const ry = mw * MOUTH_SHADE_OPEN * open ** 0.7;
        if (rx > 0.5 && ry > 0.25) {
          const strength = Math.min(0.8, 0.35 + 0.6 * open);
          ctx.translate(mx, my + ry * 0.25);
          ctx.rotate(
            Math.atan2((mouthRight.y - mouthLeft.y) * h, (mouthRight.x - mouthLeft.x) * w),
          );
          ctx.scale(1, ry / rx);
          const shade = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
          shade.addColorStop(0, `rgba(38,10,14,${strength.toFixed(3)})`);
          shade.addColorStop(0.45, `rgba(38,10,14,${(strength * 0.9).toFixed(3)})`);
          shade.addColorStop(1, 'rgba(38,10,14,0)');
          ctx.fillStyle = shade;
          ctx.beginPath();
          ctx.arc(0, 0, rx, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    },
  };
}
