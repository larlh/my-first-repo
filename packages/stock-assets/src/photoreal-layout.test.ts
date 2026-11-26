import { describe, expect, it } from 'vitest';
import { compositionFromScript } from '@parlante/shared';
import type { AspectRatio, Composition } from '@parlante/shared';
import { drawSubtitleCue, photoAvatarPlacement } from '@parlante/renderer';
import { canvasToRgba, createNodeCanvas, registerNodeFonts } from '@parlante/renderer/node';
import { PHOTOREAL_AVATAR_DATA } from './photoreal-avatars.data';

/* -------------------------------------------------------------------------------------------
 * The AI script writer must never put burned-in subtitles over a photoreal presenter's mouth.
 * It did: in 9:16 a stock portrait in `bust` sat on the bottom edge with its mouth at 83 % of
 * the height, under a 2-line subtitle box starting at 79 % (16:9 and 1:1 covered the chin).
 * Measured here with the real geometry — `photoAvatarPlacement` + each stock face's landmarks,
 * and the subtitle box as `drawSubtitleCue` actually paints it — for every stock face, every
 * aspect ratio, with and without a headline.
 * ----------------------------------------------------------------------------------------- */

const ASPECTS: AspectRatio[] = ['16:9', '9:16', '1:1'];
/** Long enough to fill the 2 lines the default style allows. */
const LONG_CUE =
  'Una frase de subtítulo bastante larga para ocupar las dos líneas que permite el estilo.';

function script(aspect: AspectRatio, avatarId: string, headline: boolean): Composition {
  return compositionFromScript([{ text: 'x', ...(headline ? { headline: 'Titular' } : {}) }], {
    aspect,
    avatarId,
    voiceId: 'kokoro:ef_dora',
    language: 'es',
  });
}

/** First pixel row the subtitle box paints (the top of its block), as drawn. */
function subtitleTop(comp: Composition): number {
  const { width, height } = comp.canvas;
  const { canvas, ctx } = createNodeCanvas(width, height);
  drawSubtitleCue(ctx, { startMs: 0, endMs: 4000, text: LONG_CUE }, comp.subtitles, width, height);
  const rgba = canvasToRgba(canvas);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) > 0) return y;
    }
  }
  throw new Error('the subtitle cue painted nothing');
}

describe('script layout × subtitles', () => {
  registerNodeFonts();

  it('keeps every stock photoreal face (mouth and chin) above a 2-line subtitle box', () => {
    for (const aspect of ASPECTS) {
      for (const headline of [true, false]) {
        const top = subtitleTop(script(aspect, 'real_lucia', headline));
        for (const face of PHOTOREAL_AVATAR_DATA) {
          const comp = script(aspect, face.id, headline);
          const { width: W, height: H } = comp.canvas;
          const layer = comp.scenes[0]?.layers.find((l) => l.type === 'avatar');
          if (!layer || layer.type !== 'avatar') throw new Error('no avatar layer');
          expect(layer.framing, `${aspect} ${face.id}`).toBe('closeup');
          const { landmarks: lm, imageWidth, imageHeight } = face.rig;
          const box = {
            x: layer.box.x * W,
            y: layer.box.y * H,
            w: layer.box.w * W,
            h: layer.box.h * H,
          };
          const place = photoAvatarPlacement(imageWidth, imageHeight, box, layer.framing, lm);
          const chin = place.y + lm.chin.y * place.h;
          const label = `${aspect}${headline ? ' + headline' : ''} ${face.id}: chin ${chin.toFixed(0)} px, subtitles from ${top} px`;
          // A clear gap (1 % of the height), not just "not overlapping by a pixel".
          expect(chin, label).toBeLessThan(top - 0.01 * H);
          // …and the picture still reaches the bottom edge (no gap under the shoulders).
          expect(place.y + place.h, label).toBeGreaterThanOrEqual(H - 0.5);
        }
      }
    }
  });

  it('keeps instant (2D) presenters in the bust framing they already had', () => {
    for (const aspect of ASPECTS) {
      const layer = script(aspect, 'stock_lucia', true).scenes[0]?.layers.find(
        (l) => l.type === 'avatar',
      );
      expect(layer?.type === 'avatar' && layer.framing, aspect).toBe('bust');
    }
  });
});
