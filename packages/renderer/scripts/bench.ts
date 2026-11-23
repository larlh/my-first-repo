/**
 * Render-speed benchmark: every frame of the demo composition (real stock rigs, images, video
 * background, neural-clip stand-in, subtitles, watermark) drawn and read back as raw RGBA —
 * what the export worker does before piping frames to ffmpeg.
 *
 *   pnpm --filter @parlante/renderer exec tsx scripts/bench.ts [width] [height] [aspect]
 */
import type { AspectRatio } from '@parlante/shared';
import { clearRenderCaches, renderCacheStats } from '../src/index';
import { createFrameRenderer } from '../src/node/index';
import { demoProject } from '../src/testing/demo';

const aspect = (process.argv[4] ?? '16:9') as AspectRatio;
const width = Number(process.argv[2] ?? 1280);
const height = Number(process.argv[3] ?? 720);

async function main(): Promise<void> {
  const { composition, runtime, assets } = demoProject({ aspect });
  const frames = createFrameRenderer({
    composition,
    runtime,
    assets,
    width,
    height,
    watermark: true,
  });
  clearRenderCaches();
  const perScene = frames.timeline.scenes.map((scene) => ({
    id: scene.sceneId,
    ms: 0,
    frames: 0,
    worst: 0,
  }));
  let bytes = 0;
  let peakRss = 0;
  const target = Buffer.allocUnsafe(frames.frameBytes);
  const started = performance.now();
  for (let index = 0; index < frames.totalFrames; index += 1) {
    const t0 = performance.now();
    bytes += (await frames.frame(index, target)).length;
    const elapsed = performance.now() - t0;
    if (index % 30 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const tMs = (index * 1000) / frames.fps;
    const scene =
      perScene[frames.timeline.scenes.findIndex((s) => tMs >= s.startMs && tMs < s.endMs)];
    if (scene) {
      scene.ms += elapsed;
      scene.frames += 1;
      scene.worst = Math.max(scene.worst, elapsed);
    }
  }
  const total = performance.now() - started;
  const fps = (frames.totalFrames / total) * 1000;
  console.log(
    `${width}x${height} ${aspect}: ${frames.totalFrames} frames (${(frames.timeline.totalMs / 1000).toFixed(1)} s of video) in ${(total / 1000).toFixed(2)} s`,
  );
  console.log(
    `  ${fps.toFixed(1)} fps  =  ${(fps / frames.fps).toFixed(2)}x real time  (${(total / frames.totalFrames).toFixed(2)} ms/frame, ${(bytes / 1e6).toFixed(0)} MB of RGBA)`,
  );
  for (const scene of perScene) {
    console.log(
      `  scene ${scene.id.padEnd(8)} ${(scene.ms / Math.max(1, scene.frames)).toFixed(2)} ms/frame avg, ${scene.worst.toFixed(1)} ms worst (${scene.frames} frames)`,
    );
  }
  const stats = renderCacheStats();
  console.log(
    `  peak RSS ${(Math.max(peakRss, process.memoryUsage().rss) / 1048576).toFixed(0)} MB`,
  );
  console.log(
    `  raster cache: ${stats.entries} bitmaps, ${(stats.bytes / 1e6).toFixed(1)} MB, ${stats.hits} hits / ${stats.misses} misses`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
