import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AspectRatio } from '@parlante/shared';
import { computeTimeline } from './index';
import { canvasToRgba, createFrameRenderer, createNodeCanvas, loadNodeImage } from './node/index';
import { demoProject } from './testing/demo';
import { diffRatio } from './testing/pixels';

/* -------------------------------------------------------------------------------------------
 * Golden frames of the three-scene demo composition (every layer type, transitions,
 * subtitles, watermark) in the three aspect ratios. They pin the LOOK of the renderer: any
 * change in layout, text, compositing or timing shows up here.
 *
 * Regenerate after an intentional visual change and LOOK at the new images before committing:
 *   UPDATE_GOLDEN=1 pnpm --filter @parlante/renderer exec vitest run src/golden.test.ts
 *
 * The comparison tolerates the rounding differences between CPU architectures / Skia builds
 * (a channel may differ by a few levels on a tiny fraction of pixels), nothing more.
 * ----------------------------------------------------------------------------------------- */

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__golden__');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Output size per aspect ratio (half the design size keeps the fixtures small). */
const SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 640, height: 360 },
  '9:16': { width: 360, height: 640 },
  '1:1': { width: 360, height: 360 },
};

/** Named instants: [name, scene index, ms into that scene]. */
const INSTANTS: Record<AspectRatio, [string, number, number][]> = {
  '16:9': [
    ['intro-entering', 0, 350],
    ['intro', 0, 4200],
    ['slide-into-data', 1, 300],
    ['data-entering', 1, 950],
    ['data', 1, 5200],
    ['data-exiting', 1, 8900],
    ['fade-into-closing', 2, 250],
    ['closing', 2, 2600],
  ],
  '9:16': [
    ['intro', 0, 4200],
    ['data', 1, 5200],
    ['closing', 2, 2600],
  ],
  '1:1': [
    ['intro', 0, 4200],
    ['data', 1, 5200],
    ['closing', 2, 2600],
  ],
};

async function decode(file: string, width: number, height: number): Promise<Buffer> {
  const image = await loadNodeImage(file);
  expect([image.width, image.height]).toEqual([width, height]);
  const { canvas, ctx } = createNodeCanvas(width, height);
  ctx.drawImage(image.source, 0, 0);
  return canvasToRgba(canvas);
}

describe('golden frames', () => {
  for (const aspect of ['16:9', '9:16', '1:1'] as AspectRatio[]) {
    it(`${aspect}: the demo composition renders as recorded`, async () => {
      const { composition, runtime, assets } = demoProject({
        aspect,
        stubAvatars: true,
        subtitles: {
          preset: aspect === '9:16' ? 'karaoke' : aspect === '1:1' ? 'classic' : 'boxed',
        },
      });
      const timeline = computeTimeline(composition, runtime);
      const frames = createFrameRenderer({
        composition,
        runtime,
        assets,
        timeline,
        ...SIZES[aspect],
        watermark: true,
      });
      for (const [name, sceneIndex, localMs] of INSTANTS[aspect]) {
        const scene = timeline.scenes[sceneIndex];
        if (!scene) throw new Error(`scene ${sceneIndex} missing`);
        // Snap to a frame boundary: this is exactly what an export produces.
        const frameIndex = Math.round(((scene.startMs + localMs) * timeline.fps) / 1000);
        const pixels = frames.frameSync(frameIndex);
        const file = path.join(GOLDEN_DIR, `${aspect.replace(':', 'x')}-${name}.png`);
        if (UPDATE) {
          fs.mkdirSync(GOLDEN_DIR, { recursive: true });
          fs.writeFileSync(file, frames.canvas.toBuffer('image/png'));
          continue;
        }
        expect(fs.existsSync(file), `missing golden ${path.basename(file)}`).toBe(true);
        const golden = await decode(file, frames.width, frames.height);
        // Identical on the machine that recorded them; elsewhere allow rounding noise only.
        expect(diffRatio(pixels, golden, 6), `${aspect} ${name}`).toBeLessThan(0.003);
        expect(diffRatio(pixels, golden, 40), `${aspect} ${name} (gross)`).toBeLessThan(0.0005);
      }
    });
  }

  it('golden frames are present for every recorded instant', () => {
    if (UPDATE) return;
    const expected = Object.entries(INSTANTS).flatMap(([aspect, list]) =>
      list.map(([name]) => `${aspect.replace(':', 'x')}-${name}.png`),
    );
    expect(
      fs
        .readdirSync(GOLDEN_DIR)
        .filter((f) => f.endsWith('.png'))
        .sort(),
    ).toEqual(expected.sort());
  });
});
