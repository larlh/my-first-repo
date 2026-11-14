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
 * STAND-IN rig for photorealistic avatars (`real_…`, `avt_…`): animates the prepared portrait
 * in real time on Canvas2D (mouth driven by `state.mouth`, blink, subtle head motion). It is
 * what the Studio live preview and the interactive avatar show; exports replace it with the
 * neural clip (`RenderAssets.avatarClip`). The UI labels it as a preview.
 *
 * `image` MUST be the avatar's CUT-OUT (`Avatar.cutoutUrl`: prepared portrait with its alpha
 * matte applied — or `applyAlphaMatte(platform, portrait, mask)`), not the raw portrait:
 * the person is then composited over the scene background exactly like the exported clip.
 * Placement comes from `photoAvatarPlacement` (shared with the clip) — keep using it.
 *
 * PLACEHOLDER implementation — draws the image with a simple mouth overlay so the pipeline
 * works end to end. Owner: avatar-artist.
 */
export function createPhotoAvatarRig(
  id: string,
  image: RenderImage,
  rig: PhotoAvatarRig,
): AvatarRig {
  return {
    id,
    kind: 'photo',
    draw(ctx: Ctx2D, box: PixelBox, state: AvatarState, options: AvatarDrawOptions): void {
      const { x, y, w, h } = photoAvatarPlacement(
        image.width,
        image.height,
        box,
        options.framing,
        rig.landmarks,
      );
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      if (options.flip) {
        ctx.translate(2 * (box.x + box.w / 2), 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(image.source, x, y, w, h);
      const { mouthLeft, mouthRight } = rig.landmarks;
      const mx = x + ((mouthLeft.x + mouthRight.x) / 2) * w;
      const my = y + ((mouthLeft.y + mouthRight.y) / 2) * h;
      const mw = Math.abs(mouthRight.x - mouthLeft.x) * w;
      if (state.mouth.open > 0.05) {
        ctx.fillStyle = '#3a0f16';
        ctx.beginPath();
        ctx.ellipse(
          mx,
          my,
          (mw / 2) * (0.8 + 0.2 * state.mouth.width),
          mw * 0.3 * state.mouth.open,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.restore();
    },
  };
}
