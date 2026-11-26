/**
 * Browser ⇄ Node parity check: renders the same frames of the demo composition with
 * @napi-rs/canvas (what the export worker does) and inside headless Chromium (what the Studio
 * preview does, with the web app's own fonts.css), and reports how much the pixels differ.
 *
 *   pnpm --filter @parlante/renderer exec tsx scripts/browser-parity.ts <outDir>
 *
 * Needs Playwright with Chromium; point PLAYWRIGHT_MODULE at its directory when it is not
 * resolvable from here (default: /opt/node-tools/node_modules/playwright). Opens no port: the
 * page is a local file.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AspectRatio } from '@parlante/shared';
import {
  avatarClipTimeMs,
  computeTimeline,
  mediaPlaybackAt,
  mediaTimeMs,
  renderFrame,
} from '../src/index';
import type { RenderImage } from '../src/index';
import {
  canvasToPng,
  canvasToRgba,
  createNodeCanvas,
  loadNodeImage,
  registerNodeFonts,
} from '../src/node/index';
import { demoProject } from '../src/testing/demo';
import { diffRatio } from '../src/testing/pixels';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outDir = path.resolve(process.argv[2] ?? path.join(here, '../test-output/parity'));

interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  on(event: 'console' | 'pageerror', handler: (message: { text?: () => string }) => void): void;
}
interface Browser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { args: string[] }): Promise<Browser> };
}

function dataUrl(image: RenderImage): string {
  const { canvas, ctx } = createNodeCanvas(image.width, image.height);
  ctx.drawImage(image.source, 0, 0);
  return `data:image/png;base64,${canvasToPng(canvas).toString('base64')}`;
}

async function bundle(): Promise<string> {
  const tsxDir = path.dirname(require.resolve('tsx/package.json'));
  const esbuild = (await import(
    pathToFileURL(require.resolve('esbuild', { paths: [tsxDir] })).href
  )) as { build(options: Record<string, unknown>): Promise<unknown> };
  const dir = path.join(outDir, 'page');
  fs.mkdirSync(dir, { recursive: true });
  await esbuild.build({
    // The page uses exactly what the web app uses: its fonts.css and the renderer sources.
    entryPoints: {
      parity: path.join(here, 'browser-parity.entry.ts'),
      fonts: path.join(here, '../../../apps/web/src/fonts.css'),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outdir: dir,
    loader: { '.woff2': 'file', '.woff': 'file' },
    logLevel: 'warning',
  });
  const html = path.join(dir, 'index.html');
  fs.writeFileSync(
    html,
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fonts.css"><script src="parity.js"></script>',
  );
  return html;
}

async function main(): Promise<void> {
  if (process.env.PARLANTE_TEXT_RENDERER === 'system') {
    // Experiment only: @napi-rs/canvas' OS text renderer (see its `setTextRenderer` docs).
    const napi = require('@napi-rs/canvas') as { setTextRenderer(mode: string): void };
    napi.setTextRenderer('system');
  }
  registerNodeFonts();
  fs.mkdirSync(outDir, { recursive: true });
  const html = await bundle();
  const playwrightDir = process.env.PLAYWRIGHT_MODULE ?? '/opt/node-tools/node_modules/playwright';
  const playwright = require(playwrightDir) as Playwright;
  const browser = await playwright.chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage();
  page.on('console', (message) => console.log('[page]', message.text?.()));
  page.on('pageerror', (message) => console.error('[page error]', String(message)));
  await page.goto(pathToFileURL(html).href);

  let worst = 0;
  for (const aspect of ['16:9', '9:16', '1:1'] as AspectRatio[]) {
    const preset = aspect === '9:16' ? 'karaoke' : aspect === '1:1' ? 'classic' : 'boxed';
    const { composition, runtime, assets } = demoProject({
      aspect,
      stubAvatars: true,
      subtitles: { preset },
    });
    const timeline = computeTimeline(composition, runtime);
    const { width, height } = composition.canvas;
    const [intro, data, closing] = timeline.scenes;
    if (!intro || !data || !closing) throw new Error('demo composition must have three scenes');
    const times = [
      350,
      4200,
      data.startMs + 300,
      data.startMs + 950,
      data.startMs + 5200,
      closing.startMs + 250,
      closing.startMs + 2600,
    ];

    // Node render + the exact video / clip frames each instant consumes, for the browser.
    const { canvas, ctx } = createNodeCanvas(width, height);
    const nodeFrames: Buffer[] = [];
    const instants = times.map((tMs) => {
      const media = mediaPlaybackAt(composition, timeline, tMs).flatMap((entry) => {
        if (entry.kind === 'avatarClip') {
          const clip = entry.layerId ? assets.avatarClip(entry.sceneId, entry.layerId) : null;
          const frame = clip?.frameAt(avatarClipTimeMs(clip, entry.localMs, entry.speechMs));
          return clip && frame
            ? [{ key: entry.key, url: dataUrl(frame), durationMs: clip.durationMs, clip: true }]
            : [];
        }
        const source = assets.video(entry.key);
        const frame = source?.frameAt(mediaTimeMs(entry.rawMs, entry.loop, source.durationMs));
        return source && frame
          ? [{ key: entry.key, url: dataUrl(frame), durationMs: source.durationMs, clip: false }]
          : [];
      });
      renderFrame(ctx, composition, tMs, runtime, assets, {
        width,
        height,
        timeline,
        watermark: true,
      });
      nodeFrames.push(canvasToRgba(canvas));
      fs.writeFileSync(
        path.join(outDir, `${aspect.replace(':', 'x')}-${Math.round(tMs)}-node.png`),
        canvasToPng(canvas),
      );
      return { tMs, media };
    });
    const images: Record<string, string> = {};
    for (const key of ['stock:demo-photo', 'stock:demo-logo', 'stock:demo-product']) {
      const image = assets.image(key);
      if (image) images[key] = dataUrl(image);
    }
    const job = {
      composition,
      runtime,
      width,
      height,
      images,
      rigs: { stock_lucia: '#2e4f8a', stock_mateo: '#2e7d6b' },
      instants,
    };
    const urls = await page.evaluate(
      (arg) =>
        (window as unknown as { parlanteParity(job: unknown): Promise<string[]> }).parlanteParity(
          arg,
        ),
      job,
    );
    for (const [index, url] of urls.entries()) {
      const tMs = times[index] ?? 0;
      const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      const name = `${aspect.replace(':', 'x')}-${Math.round(tMs)}`;
      fs.writeFileSync(path.join(outDir, `${name}-browser.png`), png);
      const decoded = await loadNodeImage(png);
      const target = createNodeCanvas(width, height);
      target.ctx.drawImage(decoded.source, 0, 0);
      const browserPixels = canvasToRgba(target.canvas);
      const nodePixels = nodeFrames[index] ?? Buffer.alloc(0);
      const fine = diffRatio(nodePixels, browserPixels, 8);
      const gross = diffRatio(nodePixels, browserPixels, 48);
      worst = Math.max(worst, gross);
      console.log(
        `${name.padEnd(14)} pixels differing by > 8 levels: ${(fine * 100).toFixed(3)} %   by > 48 levels: ${(gross * 100).toFixed(3)} %`,
      );
    }
  }
  await browser.close();
  console.log(`worst frame: ${(worst * 100).toFixed(3)} % of pixels differ visibly (> 48 levels)`);
  if (worst > 0.01) process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
