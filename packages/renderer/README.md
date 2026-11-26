# @parlante/renderer

Isomorphic, deterministic Canvas2D renderer: `renderFrame(ctx, composition, tMs, runtime, assets, options)`
draws one frame of a Composition. The Studio preview (browser) and the export worker (Node,
@napi-rs/canvas) run the same code. Contract: `docs/CONTRACTS.md` §1–§3.

## What a frame is made of

| Step                         | File                               | Notes                                                                                                      |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Which scene(s), local clocks | `timeline.ts`, `media.ts`          | `computeTimeline`, `sceneInstantsAt`; `mediaPlaybackAt` lists every video a frame samples, in paint order  |
| Background                   | `background.ts`                    | colour, gradient (CSS gradient line), image (fit / blur / dim), video; static ones are rasterised once     |
| Layers, by `z`               | `layers.ts`                        | text, image, video, shape, avatar; rotation, opacity (applied to the layer as a whole), enter / exit pose  |
| Layer animations             | `animation.ts`                     | `layerPoseAt`: fade, slide-* (named after the direction of motion), zoom-in/out, pop                       |
| Text                         | `text.ts`, `fonts.ts`              | wrapping by measured width, baselines from `FONT_METRICS`, manual letter spacing, pill / outline / shadow  |
| Scene transition             | `render-frame.ts`                  | fade, slide-* (push), wipe, zoom; the incoming scene is composited as one image                            |
| Subtitles                    | `subtitles.ts`, `subtitle-draw.ts` | cues budgeted by aspect ratio; presets classic / boxed / karaoke / minimal; never outside the central 90 % |
| Watermark                    | `render-frame.ts`                  | `options.watermark`; bottom subtitles keep `WATERMARK_CLEARANCE`                                           |

Off-screen canvases, the raster cache and its budget live in `cache.ts`
(`clearRenderCaches`, `setRenderCacheBudget`, `renderCacheStats`). Cached bitmaps are pure
functions of their key: a hit and a miss give the same pixels.

## Node (export)

```ts
import { MapRenderAssets } from '@parlante/renderer';
import {
  createFrameRenderer,
  openVideoSource,
  openAvatarClipSource,
  NodeImageCache,
} from '@parlante/renderer/node';

const assets = new MapRenderAssets()
  .setImage(key, await images.load(key, bytesOrPath))
  .setVideo(key, await openVideoSource({ path, maxWidth: width, maxHeight: height }))
  .setAvatarClip(
    sceneId,
    layerId,
    await openAvatarClipSource({ path, mattePath, originMs: 0, landmarks }),
  );
const frames = createFrameRenderer({ composition, runtime, assets, width, height, watermark });
for (let i = 0; i < frames.totalFrames; i += 1) {
  if (!ffmpegStdin.write(await frames.frame(i))) await once(ffmpegStdin, 'drain'); // rawvideo rgba
}
```

- `frame(i)` awaits `prepare()` on every file-backed source the frame needs (decoded on demand
  by ffmpeg, a few frames ahead), draws, and returns a copy of the pixels.
- **Always export through `frame()` / `frames()`.** `canvas.data()` returns native memory that
  is only freed after the event loop turns; a loop that never yields keeps every frame alive
  (measured: 2.9 GB for 22 s of 720p). `frame()` yields for you (≈ 300 MB flat).
- Close file-backed sources (`source.close()`) when the job ends or is cancelled.

## Browser (preview)

```ts
import { renderFrame, computeTimeline } from '@parlante/renderer';
import {
  BrowserRenderAssets,
  ensureBrowserFonts,
  ensureCompositionFonts,
} from '@parlante/renderer/browser';

await ensureBrowserFonts(); // once
await ensureCompositionFonts(composition); // whenever texts / text styles change, then redraw
const assets = new BrowserRenderAssets();
await assets.loadComposition(composition, (key) => urls.get(key) ?? null);
// each animation frame
assets.syncVideos(composition, timeline, tMs, { playing });
renderFrame(ctx, composition, tMs, runtime, assets, { timeline, quality: 'preview' });
```

Text drawn before its font face has loaded uses a fallback font; both `ensure…` functions drop
the renderer's text caches when new faces arrive. The web app must import the @fontsource CSS
of every family / weight, upright and italic (`apps/web/src/fonts.css`).

## Checking the renderer

```bash
pnpm --filter @parlante/renderer test                                  # includes golden frames (src/__golden__)
UPDATE_GOLDEN=1 pnpm --filter @parlante/renderer exec vitest run src/golden.test.ts   # after an intended visual change — look at the PNGs
pnpm --filter @parlante/renderer exec tsx scripts/shots.ts <dir> [preset]              # stills in 16:9, 9:16, 1:1
pnpm --filter @parlante/renderer exec tsx scripts/bench.ts 1280 720                    # frames per second, peak memory
pnpm --filter @parlante/renderer exec tsx scripts/browser-parity.ts <dir>              # same frames in Chromium vs Node
```

Rules that keep it deterministic: no `Date.now()` / `Math.random()` (use `random.ts`), font
strings only through `canvasFont`, media times only through `media.ts`, photoreal placement
only through `photoAvatarPlacement`.
