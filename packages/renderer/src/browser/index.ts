import { FONT_FAMILY_NAMES, FONT_WEIGHTS, mediaRefKey } from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { MapRenderAssets } from '../assets';
import { clearRenderCaches } from '../cache';
import { canvasFont } from '../fonts';
import { mediaPlaybackAt, mediaTimeMs } from '../media';
import type { Timeline } from '../timeline';
import type { Ctx2D, RenderImage, RenderPlatform, VideoFrameSource } from '../types';

/* -------------------------------------------------------------------------------------------
 * Browser adapter. Import from `@parlante/renderer/browser`.
 *
 * Fonts: the web app imports the @fontsource CSS of every bundled family / weight, normal and
 * italic (apps/web/src/fonts.css). A browser only downloads a face when something uses it, and
 * a canvas does not wait: text drawn before its face arrives uses a fallback font and stays
 * that way. So, before rendering:
 *   await ensureBrowserFonts();                    // once: Latin faces of every family
 *   await ensureCompositionFonts(composition);     // whenever texts change: exactly the faces
 *                                                  // (weights, italics, scripts) the document uses
 * Both drop the renderer's text caches when new faces arrived.
 *
 * Off-screen canvases for the renderer core are created from `document` (or OffscreenCanvas
 * in a worker) automatically; nothing to register.
 * ----------------------------------------------------------------------------------------- */

export function createBrowserCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: Ctx2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available');
  return { canvas, ctx };
}

/** Decode an image from a URL (same-origin or CORS-enabled) or from bytes. */
export async function loadBrowserImage(source: Uint8Array | string): Promise<RenderImage> {
  const blob =
    typeof source === 'string'
      ? await fetch(source, { credentials: 'include' }).then((res) => {
          if (!res.ok) throw new Error(`Failed to load image (${res.status})`);
          return res.blob();
        })
      : new Blob([source as BlobPart]);
  const bitmap = await createImageBitmap(blob);
  return { source: bitmap, width: bitmap.width, height: bitmap.height };
}

/* ---------- fonts ---------- */

/** Sample covering the `latin` and `latin-ext` subsets (Spanish, French, Polish…). */
const LATIN_SAMPLE = 'AaÑñÉéÜüÇç¿¡ĄąŁłŐőŞş';

async function loadFaces(requests: Iterable<[font: string, text: string]>): Promise<boolean> {
  const loads: Promise<FontFace[]>[] = [];
  for (const [font, text] of requests) {
    if (text === '') continue;
    loads.push(document.fonts.load(font, text).catch(() => []));
  }
  const before = countLoaded();
  await Promise.all(loads);
  await document.fonts.ready;
  const changed = countLoaded() !== before;
  // Measurements and bitmaps made with fallback fonts are stale now.
  if (changed) clearRenderCaches();
  return changed;
}

function countLoaded(): number {
  let loaded = 0;
  document.fonts.forEach((face) => {
    if (face.status === 'loaded') loaded += 1;
  });
  return loaded;
}

let fontsReady: Promise<void> | null = null;

/**
 * Wait until every bundled family / weight can be drawn on a canvas for Latin text (upright
 * faces). Idempotent. Other faces — italics, Cyrillic, Greek, Vietnamese — are fetched by
 * `ensureCompositionFonts` for the documents that use them.
 */
export function ensureBrowserFonts(): Promise<void> {
  fontsReady ??= (async () => {
    const requests: [string, string][] = [];
    for (const family of FONT_FAMILY_NAMES) {
      for (const weight of FONT_WEIGHTS) {
        requests.push([canvasFont(family, 16, weight), LATIN_SAMPLE]);
      }
    }
    await loadFaces(requests);
  })();
  return fontsReady;
}

/**
 * Load exactly the font faces `composition` needs: every text layer with its family, weight,
 * style and the characters it contains, the subtitle font for everything that can be spoken,
 * and the watermark font. Cheap to call again (already-loaded faces resolve at once), so call
 * it whenever the document's texts or text styles change, then redraw.
 * Resolves to true when new faces were loaded (the renderer's text caches were dropped).
 */
export function ensureCompositionFonts(composition: Composition): Promise<boolean> {
  const wanted = new Map<string, string>();
  const want = (font: string, text: string) => wanted.set(font, (wanted.get(font) ?? '') + text);
  const subtitleFont = canvasFont(
    composition.subtitles.fontFamily,
    16,
    composition.subtitles.fontWeight,
  );
  for (const scene of composition.scenes) {
    const spoken =
      scene.script.kind === 'tts'
        ? scene.script.text
        : scene.script.kind === 'audio'
          ? scene.script.transcript
          : '';
    want(subtitleFont, spoken + spoken.toUpperCase());
    for (const layer of scene.layers) {
      if (layer.type !== 'text') continue;
      const { fontFamily, fontWeight, italic, uppercase } = layer.style;
      want(
        canvasFont(fontFamily, 16, fontWeight, italic),
        uppercase ? layer.text.toUpperCase() : layer.text,
      );
    }
  }
  want(canvasFont('Inter', 16, 700), 'Parlante');
  want(canvasFont('Inter', 16, 500), 'imagevideoavatar');
  return loadFaces(wanted.entries());
}

/* ---------- video ---------- */

/**
 * VideoFrameSource backed by an HTMLVideoElement. The preview player is responsible for
 * seeking/playing the element; `frameAt` returns whatever frame is currently decoded.
 */
export function videoElementSource(video: HTMLVideoElement): VideoFrameSource {
  return {
    get durationMs() {
      return Number.isFinite(video.duration) ? video.duration * 1000 : 0;
    },
    get width() {
      return video.videoWidth;
    },
    get height() {
      return video.videoHeight;
    },
    frameAt: () =>
      video.readyState >= 2
        ? { source: video, width: video.videoWidth, height: video.videoHeight }
        : null,
  };
}

export interface SyncVideosOptions {
  /** True while the preview is playing (elements play and are only re-seeked when they drift). */
  playing: boolean;
  /** Master volume 0..1 applied on top of each video's own volume. Default 1. */
  volume?: number;
  /** Drift (ms) tolerated while playing before an element is re-seeked. Default 180. */
  maxDriftMs?: number;
}

/**
 * RenderAssets for the Studio preview: a `MapRenderAssets` that also loads and remembers
 * images and `<video>` elements by media key, and keeps the videos on the renderer's media
 * clock.
 *
 *   const assets = new BrowserRenderAssets();
 *   await assets.loadImage(mediaRefKey(ref), asset.url);
 *   await assets.loadVideo(mediaRefKey(ref), asset.url);
 *   // every animation frame:
 *   assets.syncVideos(composition, timeline, tMs, { playing });
 *   renderFrame(ctx, composition, tMs, runtime, assets, { timeline });
 *
 * Keys identify media (signed URLs change between API responses): a key that is loaded or
 * loading is not fetched again unless `reload` is passed.
 */
export class BrowserRenderAssets extends MapRenderAssets {
  private readonly imageLoads = new Map<string, Promise<RenderImage>>();
  private readonly videoLoads = new Map<string, Promise<HTMLVideoElement>>();
  private readonly videoElements = new Map<string, HTMLVideoElement>();

  /** Load (once) and register the image for `key`. */
  loadImage(key: string, url: string, options: { reload?: boolean } = {}): Promise<RenderImage> {
    const pending = options.reload ? undefined : this.imageLoads.get(key);
    if (pending) return pending;
    const loading = loadBrowserImage(url).then((image) => {
      if (this.imageLoads.get(key) === loading) this.setImage(key, image);
      return image;
    });
    this.imageLoads.set(key, loading);
    loading.catch(() => {
      if (this.imageLoads.get(key) === loading) this.imageLoads.delete(key);
    });
    return loading;
  }

  /**
   * Create (once) a muted, inline `<video>` for `key`, register it as the frame source and
   * resolve when its first frame can be drawn. The element is not attached to the document.
   */
  loadVideo(
    key: string,
    url: string,
    options: { reload?: boolean; crossOrigin?: 'anonymous' | 'use-credentials' } = {},
  ): Promise<HTMLVideoElement> {
    const pending = options.reload ? undefined : this.videoLoads.get(key);
    if (pending) return pending;
    const loading = new Promise<HTMLVideoElement>((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = options.crossOrigin ?? 'use-credentials';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('loadeddata', () => resolve(video), { once: true });
      video.addEventListener('error', () => reject(new Error('Failed to load video')), {
        once: true,
      });
      video.src = url;
      video.load();
    }).then((video) => {
      if (this.videoLoads.get(key) === loading) {
        this.releaseVideo(key);
        this.videoElements.set(key, video);
        this.setVideo(key, videoElementSource(video));
      }
      return video;
    });
    this.videoLoads.set(key, loading);
    loading.catch(() => {
      if (this.videoLoads.get(key) === loading) this.videoLoads.delete(key);
    });
    return loading;
  }

  /** The `<video>` element of a loaded key (to attach listeners, read `buffered`…). */
  videoElement(key: string): HTMLVideoElement | null {
    return this.videoElements.get(key) ?? null;
  }

  /**
   * Load every image and video `composition` references that is not loaded yet. `urlOf`
   * returns the URL of a media key (`asset:<id>` / `stock:<id>`) and its kind, or null when
   * unknown. Failures are reported, not thrown: the renderer draws its placeholder for them.
   */
  async loadComposition(
    composition: Composition,
    urlOf: (key: string) => { url: string; kind: 'image' | 'video' } | null,
  ): Promise<{ failed: string[] }> {
    const jobs = new Map<string, Promise<unknown>>();
    const add = (key: string, kind: 'image' | 'video') => {
      if (jobs.has(key)) return;
      const media = urlOf(key);
      if (!media || media.kind !== kind) return;
      jobs.set(
        key,
        kind === 'image' ? this.loadImage(key, media.url) : this.loadVideo(key, media.url),
      );
    };
    for (const scene of composition.scenes) {
      if (scene.background.type === 'image') add(mediaRefKey(scene.background.src), 'image');
      if (scene.background.type === 'video') add(mediaRefKey(scene.background.src), 'video');
      for (const layer of scene.layers) {
        if (layer.type === 'image') add(mediaRefKey(layer.src), 'image');
        if (layer.type === 'video') add(mediaRefKey(layer.src), 'video');
      }
    }
    const failed: string[] = [];
    await Promise.all(
      [...jobs].map(([key, job]) =>
        job.catch(() => {
          failed.push(key);
        }),
      ),
    );
    return { failed };
  }

  /**
   * Put every loaded `<video>` where `renderFrame(…, tMs, …)` will sample it — the same
   * arithmetic, through `mediaPlaybackAt`. Paused / scrubbing: elements are seeked to the
   * exact instant. Playing: they play on their own and are re-seeked only when they drift.
   * Videos the frame does not use are paused. When one video is needed at two instants at
   * once (held under a transition and playing in the next scene), the playing one wins.
   */
  syncVideos(
    composition: Composition,
    timeline: Timeline,
    tMs: number,
    options: SyncVideosOptions,
  ): void {
    const wanted = new Map<string, { timeMs: number; volume: number; frozen: boolean }>();
    for (const entry of mediaPlaybackAt(composition, timeline, tMs)) {
      if (entry.kind === 'avatarClip') continue;
      const video = this.videoElements.get(entry.key);
      if (!video) continue;
      const durationMs = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
      wanted.set(entry.key, {
        timeMs: mediaTimeMs(entry.rawMs, entry.loop, durationMs),
        volume: entry.volume,
        frozen: entry.frozen,
      });
    }
    const master = options.volume ?? 1;
    const maxDrift = options.maxDriftMs ?? 180;
    for (const [key, video] of this.videoElements) {
      const target = wanted.get(key);
      if (!target) {
        if (!video.paused) video.pause();
        continue;
      }
      const volume = Math.min(1, Math.max(0, target.volume * master));
      video.muted = volume === 0;
      if (volume > 0) video.volume = volume;
      const shouldPlay = options.playing && !target.frozen;
      const driftMs = Math.abs(video.currentTime * 1000 - target.timeMs);
      if (shouldPlay) {
        if (driftMs > maxDrift) video.currentTime = target.timeMs / 1000;
        if (video.paused) void video.play().catch(() => undefined);
      } else {
        if (!video.paused) video.pause();
        // Half a frame at 30 fps: closer than that is the same picture.
        if (driftMs > 16) video.currentTime = target.timeMs / 1000;
      }
    }
  }

  private releaseVideo(key: string): void {
    const video = this.videoElements.get(key);
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
    this.videoElements.delete(key);
  }

  /** Stop every video and release decoded images. The instance must not be used afterwards. */
  dispose(): void {
    for (const key of [...this.videoElements.keys()]) this.releaseVideo(key);
    for (const loading of this.imageLoads.values()) {
      void loading
        .then((image) => {
          const source = image.source as { close?: () => void };
          if (typeof source.close === 'function') source.close();
        })
        .catch(() => undefined);
    }
    this.imageLoads.clear();
    this.videoLoads.clear();
    clearRenderCaches();
  }
}

export const browserPlatform: RenderPlatform = {
  name: 'browser',
  createCanvas: createBrowserCanvas,
  loadImage: loadBrowserImage,
  ensureFonts: ensureBrowserFonts,
};
