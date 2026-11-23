/**
 * Render PNG stills of the demo composition (every aspect ratio, several instants) to a
 * directory, for eyeballing the renderer:
 *
 *   pnpm --filter @parlante/renderer exec tsx scripts/shots.ts <outDir> [preset]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AspectRatio, SubtitleStyle } from '@parlante/shared';
import { computeTimeline } from '../src/index';
import { createFrameRenderer } from '../src/node/index';
import { demoProject } from '../src/testing/demo';

const outDir = path.resolve(process.argv[2] ?? 'test-output/shots');
const preset = (process.argv[3] ?? 'boxed') as SubtitleStyle['preset'];
fs.mkdirSync(outDir, { recursive: true });

async function main(): Promise<void> {
  for (const aspect of ['16:9', '9:16', '1:1'] as AspectRatio[]) {
    const { composition, runtime, assets } = demoProject({ aspect, subtitles: { preset } });
    const timeline = computeTimeline(composition, runtime);
    const frames = createFrameRenderer({
      composition,
      runtime,
      assets,
      timeline,
      watermark: true,
    });
    const [intro, data, closing] = timeline.scenes;
    if (!intro || !data || !closing) throw new Error('demo composition must have three scenes');
    const instants: [string, number][] = [
      ['1-intro-enter', 350],
      ['1-intro', intro.startMs + 4200],
      ['2-transition', data.startMs + data.transitionMs * 0.5],
      ['2-data-enter', data.startMs + 950],
      ['2-data', data.startMs + 5200],
      ['3-transition', closing.startMs + closing.transitionMs * 0.5],
      ['3-closing', closing.startMs + 2600],
    ];
    for (const [name, tMs] of instants) {
      const file = path.join(outDir, `${aspect.replace(':', 'x')}-${name}.png`);
      fs.writeFileSync(file, await frames.png(tMs));
      console.log(file, `t=${Math.round(tMs)}ms`);
    }
    console.log(aspect, 'total', timeline.totalMs, 'ms', timeline.totalFrames, 'frames');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
