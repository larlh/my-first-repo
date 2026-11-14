import type { PhotoAvatarRig, PhotoLandmarks } from '@parlante/shared';
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
 * STAND-IN rig for photorealistic avatars (`real_…`, `avt_…`): animates the prepared portrait
 * in real time on Canvas2D (mouth driven by `state.mouth`, blink, subtle head motion). It is
 * what the Studio live preview and the interactive avatar show; exports replace it with the
 * neural clip (`RenderAssets.avatarClip`). The UI labels it as a preview.
 * PLACEHOLDER implementation — draws the portrait fitted to the box with a simple mouth
 * overlay so the pipeline works end to end. Owner: avatar-artist.
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
      const scale = Math.min(box.w / image.width, box.h / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      const x = box.x + (box.w - w) / 2;
      const y = box.y + box.h - h;
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
