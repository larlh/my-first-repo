import type { AvatarRig } from '../avatars/types';

/**
 * A trivially simple avatar rig for tests that must not depend on the stock drawings: a
 * `body` coloured silhouette filling the lower 80 % of the box, a head disc, and a mouth
 * whose height follows `state.mouth.open`. Records every call.
 */
export function stubRig(id: string, body = '#2e7d6b'): AvatarRig & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    id,
    kind: 'stock',
    calls,
    draw(ctx, box, state, options) {
      calls.push({ box: { ...box }, state, options });
      ctx.save();
      if (options.flip) {
        ctx.translate(2 * (box.x + box.w / 2), 0);
        ctx.scale(-1, 1);
      }
      const zoom = options.framing === 'closeup' ? 1.5 : options.framing === 'half' ? 0.85 : 1;
      const cx = box.x + box.w / 2;
      const headR = Math.min(box.w, box.h) * 0.2 * zoom;
      const headY = box.y + box.h * 0.36;
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.ellipse(cx, box.y + box.h, box.w * 0.42 * zoom, box.h * 0.45, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e0b08a';
      ctx.beginPath();
      ctx.arc(cx, headY, headR, 0, Math.PI * 2);
      ctx.fill();
      // Asymmetric mark, so `flip` is observable.
      ctx.fillStyle = '#3b2a1e';
      ctx.fillRect(cx - headR, headY - headR, headR * 0.5, headR * 0.5);
      ctx.fillStyle = '#7a1f2b';
      ctx.fillRect(
        cx - headR * 0.3,
        headY + headR * 0.4,
        headR * 0.6,
        headR * 0.1 + headR * 0.4 * state.mouth.open,
      );
      ctx.restore();
    },
  };
}
