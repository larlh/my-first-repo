/**
 * Browser half of scripts/browser-parity.ts: bundled with esbuild and run inside Chromium,
 * on a page that links the web app's own fonts.css.
 */
import type { Composition, RenderRuntime } from '@parlante/shared';
import {
  createBrowserCanvas,
  ensureBrowserFonts,
  ensureCompositionFonts,
  loadBrowserImage,
} from '../src/browser/index';
import { MapRenderAssets, computeTimeline, renderFrame } from '../src/index';
import type { AvatarClipSource, RenderImage, VideoFrameSource } from '../src/index';
import { stubRig } from '../src/testing/stub-rig';

interface ParityJob {
  composition: Composition;
  runtime: RenderRuntime;
  width: number;
  height: number;
  /** key → data URL */
  images: Record<string, string>;
  /** Stub rig colours by avatar id. */
  rigs: Record<string, string>;
  instants: {
    tMs: number;
    /** Frames the sources hand out at this instant, in the order renderFrame asks. */
    media: { key: string; url: string; durationMs: number; clip: boolean }[];
  }[];
}

async function run(job: ParityJob): Promise<string[]> {
  await ensureBrowserFonts();
  await ensureCompositionFonts(job.composition);
  const assets = new MapRenderAssets();
  for (const [key, url] of Object.entries(job.images)) {
    assets.setImage(key, await loadBrowserImage(url));
  }
  for (const [id, colour] of Object.entries(job.rigs)) assets.setAvatar(id, stubRig(id, colour));
  const timeline = computeTimeline(job.composition, job.runtime);
  const { canvas, ctx } = createBrowserCanvas(job.width, job.height);
  const out: string[] = [];
  for (const instant of job.instants) {
    const queues = new Map<string, RenderImage[]>();
    for (const media of instant.media) {
      const image = await loadBrowserImage(media.url);
      queues.set(media.key, [...(queues.get(media.key) ?? []), image]);
      const source: VideoFrameSource = {
        durationMs: media.durationMs,
        width: image.width,
        height: image.height,
        frameAt: () => queues.get(media.key)?.shift() ?? null,
      };
      if (media.clip) {
        const [sceneId = '', layerId = ''] = media.key.split('/');
        const clip: AvatarClipSource = { ...source, originMs: 0 };
        assets.setAvatarClip(sceneId, layerId, clip);
      } else {
        assets.setVideo(media.key, source);
      }
    }
    renderFrame(ctx, job.composition, instant.tMs, job.runtime, assets, {
      width: job.width,
      height: job.height,
      timeline,
      watermark: true,
    });
    out.push(canvas.toDataURL('image/png'));
  }
  return out;
}

(window as unknown as { parlanteParity: typeof run }).parlanteParity = run;
