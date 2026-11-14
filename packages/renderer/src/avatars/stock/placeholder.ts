import type { StockAvatarMeta } from '@parlante/shared';
import type { Ctx2D, PixelBox } from '../../types';
import type { AvatarDrawOptions, AvatarRig, AvatarState } from '../types';

/**
 * PLACEHOLDER rig — a visible stand-in drawn with the avatar's palette: shoulders, head, eyes
 * that blink and a mouth driven by `state.mouth`. It proves the whole pipeline (state → rig →
 * canvas) end to end. Owner: avatar-artist, who replaces it with the real parametric avatars.
 */
export function createPlaceholderRig(meta: StockAvatarMeta): AvatarRig {
  const skin = meta.traits.skin ?? '#d9a57e';
  const hair = meta.traits.hair ?? '#222222';
  const outfit = meta.traits.outfit ?? '#6d5efc';
  return {
    id: meta.id,
    kind: 'stock',
    draw(ctx: Ctx2D, box: PixelBox, state: AvatarState, options: AvatarDrawOptions): void {
      const zoom = options.framing === 'closeup' ? 1.5 : options.framing === 'half' ? 0.8 : 1;
      const unit = Math.min(box.w, box.h) * zoom;
      const cx = box.x + box.w / 2 + state.head.turn * unit * 0.01;
      const bottom = box.y + box.h;
      const headR = unit * 0.2;
      const headY = bottom - unit * 0.56 + state.head.nod * unit * 0.008;

      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      if (options.flip) {
        ctx.translate(2 * (box.x + box.w / 2), 0);
        ctx.scale(-1, 1);
      }

      // shoulders
      ctx.fillStyle = outfit;
      ctx.beginPath();
      ctx.ellipse(
        cx,
        bottom + unit * 0.02 - state.breath * unit * 0.006,
        unit * 0.36,
        unit * 0.34,
        0,
        Math.PI,
        0,
      );
      ctx.fill();
      // neck
      ctx.fillStyle = skin;
      ctx.fillRect(cx - headR * 0.32, headY + headR * 0.7, headR * 0.64, headR * 0.7);
      // hair (behind) + head
      ctx.fillStyle = hair;
      ctx.beginPath();
      ctx.arc(cx, headY - headR * 0.12, headR * 1.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.ellipse(cx, headY, headR * 0.9, headR, 0, 0, Math.PI * 2);
      ctx.fill();
      // eyes
      const eyeOpen = Math.max(0.08, 1 - state.blink);
      ctx.fillStyle = '#1b1b1f';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(
          cx + side * headR * 0.36 + state.gaze.x * headR * 0.06,
          headY - headR * 0.12 + state.gaze.y * headR * 0.05,
          headR * 0.09,
          headR * 0.11 * eyeOpen,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      // mouth
      const mouthW = headR * (0.42 + 0.16 * state.mouth.width);
      const mouthH = headR * (0.035 + 0.3 * state.mouth.open);
      ctx.fillStyle = '#7a1f2b';
      ctx.beginPath();
      ctx.ellipse(cx, headY + headR * 0.45, mouthW / 2, mouthH / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (state.mouth.teeth > 0.4 && state.mouth.open > 0.08) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(
          cx - mouthW * 0.3,
          headY + headR * 0.45 - mouthH / 2,
          mouthW * 0.6,
          mouthH * 0.3,
        );
      }
      ctx.restore();
    },
  };
}
