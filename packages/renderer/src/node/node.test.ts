import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FONT_FAMILY_NAMES, createComposition } from '@parlante/shared';
import { runFfmpeg } from '@parlante/shared/node';
import {
  FONT_METRICS,
  MapRenderAssets,
  canvasFont,
  computeTimeline,
  listFontFiles,
  renderFrame,
} from '../index';
import { demoProject } from '../testing/demo';
import { diffRatio, shotOf } from '../testing/pixels';
import {
  NodeImageCache,
  canvasToPng,
  canvasToRgba,
  createFrameRenderer,
  createNodeCanvas,
  createRawVideoSource,
  isPreparable,
  openAvatarClipSource,
  openVideoSource,
  registerNodeFonts,
} from './index';

describe('fonts', () => {
  beforeAll(() => {
    registerNodeFonts();
  });

  it('registers every bundled family; scripts a family lacks fall back to Inter', () => {
    const own = listFontFiles();
    expect(new Set(own.map((f) => f.family))).toEqual(new Set(FONT_FAMILY_NAMES));
    expect(registerNodeFonts()).toBeGreaterThan(250);
    const { ctx } = createNodeCanvas(10, 10);
    const width = (family: string, text: string, italic = false) => {
      ctx.font = canvasFont(family, 40, 700, italic);
      return ctx.measureText(text).width;
    };
    // Cyrillic / Greek set in a family without them is drawn with Inter's glyphs of the same
    // weight and style (same advance) — what a browser does with the same family list.
    expect(width('Poppins', 'Привет')).toBeCloseTo(width('Inter', 'Привет'), 3);
    expect(width('Poppins', 'Привет', true)).toBeCloseTo(width('Inter', 'Привет', true), 3);
    expect(width('Montserrat', 'Γειά')).toBeCloseTo(width('Inter', 'Γειά'), 3);
    // …while every family keeps its own glyphs for what it does cover.
    const latin = FONT_FAMILY_NAMES.map((family) => width(family, 'Hola mundo').toFixed(2));
    expect(new Set(latin).size).toBe(FONT_FAMILY_NAMES.length);
    expect(width('Montserrat', 'Привет')).not.toBeCloseTo(width('Inter', 'Привет'), 0);
    expect(width('JetBrains Mono', 'Hola')).toBeCloseTo(width('JetBrains Mono', 'WWWW'), 3); // still monospaced
    // Latin Extended and Vietnamese subsets are registered too.
    expect(width('Poppins', 'żółć')).not.toBeCloseTo(width('Inter', 'żółć'), 0);
  });

  it('keeps the metrics table in line with the font files', () => {
    const { ctx } = createNodeCanvas(10, 10);
    for (const family of FONT_FAMILY_NAMES) {
      ctx.font = canvasFont(family, 1000, 400);
      const measured = ctx.measureText('Hxg');
      const table = FONT_METRICS[family];
      expect(table, family).toBeDefined();
      expect(
        Math.abs(measured.fontBoundingBoxAscent / 1000 - (table?.ascent ?? 0)),
        family,
      ).toBeLessThan(0.006);
      expect(
        Math.abs(measured.fontBoundingBoxDescent / 1000 - (table?.descent ?? 0)),
        family,
      ).toBeLessThan(0.006);
    }
  });
});

describe('createFrameRenderer', () => {
  it('hands out consecutive frames as raw RGBA, identical to renderFrame', async () => {
    const { composition, runtime, assets } = demoProject({ stubAvatars: true });
    const frames = createFrameRenderer({
      composition,
      runtime,
      assets,
      width: 320,
      height: 180,
      watermark: true,
    });
    expect(frames.timeline).toEqual(computeTimeline(composition, runtime));
    expect(frames).toMatchObject({ width: 320, height: 180, fps: 30, frameBytes: 320 * 180 * 4 });
    expect(frames.totalFrames).toBe(frames.timeline.totalFrames);

    const { canvas, ctx } = createNodeCanvas(320, 180);
    const collected: Buffer[] = [];
    for await (const frame of frames.frames(100, 106)) collected.push(frame);
    expect(collected).toHaveLength(6);
    collected.forEach((frame, i) => {
      expect(frame.length).toBe(frames.frameBytes);
      renderFrame(ctx, composition, ((100 + i) * 1000) / 30, runtime, assets, {
        width: 320,
        height: 180,
        watermark: true,
        timeline: frames.timeline,
      });
      expect(frame.equals(canvasToRgba(canvas)), `frame ${100 + i}`).toBe(true);
    });
    // Buffers are copies: a later frame does not overwrite an earlier one.
    expect(collected[0]?.equals(collected[5] ?? Buffer.alloc(0))).toBe(false);
    expect((await frames.frame(100)).equals(collected[0] ?? Buffer.alloc(0))).toBe(true);
    expect(frames.frameSync(103).equals(collected[3] ?? Buffer.alloc(0))).toBe(true);
    const png = await frames.png(4200);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const jpeg = await frames.jpeg(4200);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    // The whole video can be iterated and has the announced number of frames.
    let count = 0;
    for await (const frame of frames.frames(frames.totalFrames - 3))
      count += frame.length / frames.frameBytes;
    expect(count).toBe(3);
  });
});

describe('createRawVideoSource', () => {
  it('maps media time to frames and reuses canvases', () => {
    const reads: number[] = [];
    const source = createRawVideoSource({
      width: 4,
      height: 4,
      fps: 10,
      frameCount: 5,
      readFrame: (index) => {
        reads.push(index);
        return index === 3 ? null : new Uint8Array(4 * 4 * 4).fill(index * 50);
      },
    });
    expect(source.durationMs).toBe(500);
    expect(isPreparable(source)).toBe(false);
    const { canvas, ctx } = createNodeCanvas(4, 4);
    const valueAt = (timeMs: number) => {
      const image = source.frameAt(timeMs);
      if (!image) return null;
      ctx.clearRect(0, 0, 4, 4);
      ctx.drawImage(image.source, 0, 0);
      return canvasToRgba(canvas)[3];
    };
    expect(valueAt(0)).toBe(0);
    expect(valueAt(199)).toBe(50);
    expect(valueAt(200)).toBe(100);
    expect(valueAt(200)).toBe(100);
    expect(valueAt(310)).toBeNull(); // not available → the renderer draws its placeholder
    expect(valueAt(9999)).toBe(200); // clamped to the last frame
    expect(valueAt(-5)).toBe(0);
    expect(reads).toEqual([0, 1, 2, 3, 4, 0]); // frame 2 was served from its canvas the second time
  });
});

describe('openVideoSource (ffmpeg)', () => {
  let dir = '';
  let clip = '';
  let matte = '';
  let matteImage = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parlante-renderer-'));
    clip = path.join(dir, 'clip.mp4');
    matte = path.join(dir, 'matte.mp4');
    matteImage = path.join(dir, 'matte.png');
    // 2 s at 30 fps, 64×48: the red channel ramps with time (frame n ≈ 4n), green is constant.
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x48:r=30:d=2',
      '-vf',
      "geq=r='min(255,N*4)':g=200:b=0",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv444p',
      clip,
    ]);
    // Matte video: left half white (person), right half black.
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=64x48:r=30:d=2',
      '-vf',
      "geq=lum='if(lt(X,32),255,0)':cb=128:cr=128",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      '-pix_fmt',
      'yuv444p',
      matte,
    ]);
    const { canvas, ctx } = createNodeCanvas(64, 48);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 64, 48);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 64, 24); // top half
    fs.writeFileSync(matteImage, canvasToPng(canvas));
  }, 60_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const pixelOf = (
    source: { frameAt(t: number): { source: CanvasImageSource } | null },
    timeMs: number,
    x = 8,
    y = 8,
  ) => {
    const image = source.frameAt(timeMs);
    if (!image) return null;
    const { canvas, ctx } = createNodeCanvas(64, 48);
    ctx.drawImage(image.source, 0, 0);
    return shotOf(canvasToRgba(canvas), 64, 48).px(x, y);
  };

  it('decodes on demand: sequentially, after seeking back, far ahead and past the end', async () => {
    const source = await openVideoSource({ path: clip });
    try {
      expect(source).toMatchObject({ width: 64, height: 48 });
      expect(Math.abs(source.durationMs - 2000)).toBeLessThan(40);
      expect(isPreparable(source)).toBe(true);
      expect(pixelOf(source, 0)).toBeNull(); // nothing prepared yet
      const redAt = async (timeMs: number) => {
        await source.prepare(timeMs);
        const pixel = pixelOf(source, timeMs);
        expect(pixel, `frame at ${timeMs} ms`).not.toBeNull();
        expect(Math.abs((pixel?.[1] ?? 0) - 200)).toBeLessThan(6);
        return pixel?.[0] ?? -1;
      };
      const near = (value: number, frame: number) =>
        expect(Math.abs(value - frame * 4), `frame ${frame}`).toBeLessThanOrEqual(6);
      // Sequential playback.
      for (let frame = 0; frame < 20; frame += 1) near(await redAt((frame * 1000) / 30), frame);
      // A held frame of the past (frozen scene) stays available while playback continues.
      near(await redAt((19 * 1000) / 30), 19);
      near(await redAt((21 * 1000) / 30), 21);
      near(await redAt((19 * 1000) / 30), 19);
      // Backwards (a loop wrapping around) and a long jump forwards.
      near(await redAt(0), 0);
      near(await redAt(1700), 51);
      near(await redAt(1733.4), 52);
      // Past the end: the last frame is held, never a hole.
      const last = await redAt(1990);
      expect(await redAt(5000)).toBe(last);
      expect(last).toBeGreaterThan(55 * 4);
    } finally {
      await source.close();
    }
    await expect(source.prepare(0)).rejects.toThrow(/closed/);
    await source.close(); // idempotent
  }, 60_000);

  it('scales down to the requested box and never up', async () => {
    const small = await openVideoSource({ path: clip, maxWidth: 32, maxHeight: 32 });
    const same = await openVideoSource({ path: clip, maxWidth: 4000 });
    try {
      expect([small.width, small.height]).toEqual([32, 24]);
      expect([same.width, same.height]).toEqual([64, 48]);
      await small.prepare(500);
      expect(small.frameAt(500)).toMatchObject({ width: 32, height: 24 });
    } finally {
      await small.close();
      await same.close();
    }
  }, 60_000);

  it('merges a matte (video or still) into the alpha channel for avatar clips', async () => {
    const landmarks = {
      leftEye: { x: 0.4, y: 0.4 },
      rightEye: { x: 0.6, y: 0.4 },
      mouthLeft: { x: 0.45, y: 0.6 },
      mouthRight: { x: 0.55, y: 0.6 },
      chin: { x: 0.5, y: 0.75 },
    };
    const withVideoMatte = await openAvatarClipSource({
      path: clip,
      mattePath: matte,
      originMs: 0,
      landmarks,
    });
    const withStillMatte = await openAvatarClipSource({ path: clip, mattePath: matteImage });
    try {
      expect(withVideoMatte).toMatchObject({ originMs: 0, landmarks });
      await withVideoMatte.prepare(1000);
      expect(pixelOf(withVideoMatte, 1000, 8, 24)?.[3]).toBeGreaterThan(250); // left: person
      expect(pixelOf(withVideoMatte, 1000, 56, 24)?.[3]).toBeLessThan(5); // right: transparent
      expect(Math.abs((pixelOf(withVideoMatte, 1000, 8, 24)?.[0] ?? 0) - 120)).toBeLessThanOrEqual(
        6,
      );
      await withStillMatte.prepare(1500);
      expect(pixelOf(withStillMatte, 1500, 32, 6)?.[3]).toBeGreaterThan(250); // top: person
      expect(pixelOf(withStillMatte, 1500, 32, 42)?.[3]).toBeLessThan(5);
      expect(Math.abs((pixelOf(withStillMatte, 1500, 32, 6)?.[0] ?? 0) - 180)).toBeLessThanOrEqual(
        6,
      );
    } finally {
      await withVideoMatte.close();
      await withStillMatte.close();
    }
  }, 60_000);

  it('feeds renderFrame through the frame renderer (background loop + neural clip)', async () => {
    const src = { source: 'stock' as const, stockId: 'clip' };
    const composition = createComposition({
      scenes: [
        {
          id: 'one',
          duration: { mode: 'fixed', seconds: 3 },
          background: { type: 'video', src, fit: 'fill', loop: true },
          layers: [
            {
              id: 'av',
              type: 'avatar',
              avatarId: 'real_x',
              framing: 'half',
              box: { x: 0, y: 0, w: 1, h: 1 },
            },
          ],
        },
        {
          id: 'two',
          duration: { mode: 'fixed', seconds: 1 },
          transition: { type: 'fade', durationMs: 400 },
          background: { type: 'video', src, fit: 'fill', loop: false, trimStartMs: 1000 },
        },
      ],
    });
    const background = await openVideoSource({ path: clip });
    const clipSource = await openAvatarClipSource({ path: clip, mattePath: matte, originMs: 0 });
    const assets = new MapRenderAssets()
      .setVideo('stock:clip', background)
      .setAvatarClip('one', 'av', clipSource);
    const frames = createFrameRenderer({
      composition,
      runtime: { scenes: {} },
      assets,
      width: 64,
      height: 48,
    });
    try {
      const isPlaceholder = (frame: Buffer) =>
        shotOf(frame, 64, 48).count((r, g, b) => r === 0x2a && g === 0x2f && b === 0x45);
      const seen: number[] = [];
      for await (const frame of frames.frames()) {
        expect(isPlaceholder(frame)).toBe(0); // every frame was decoded in time
        seen.push(shotOf(frame, 64, 48).px(56, 40)[0]); // right side: background only
      }
      expect(seen).toHaveLength(120);
      const expectFrame = (index: number, mediaFrame: number) =>
        expect(
          Math.abs((seen[index] ?? -99) - Math.min(255, mediaFrame * 4)),
          `frame ${index}`,
        ).toBeLessThanOrEqual(8);
      expectFrame(0, 0);
      expectFrame(45, 45);
      expectFrame(59, 59);
      expectFrame(61, 1); // the 2 s clip looped
      expectFrame(89, 29);
      // Scene two (after its fade): starts at 1000 ms of the clip, not looping.
      expectFrame(90 + 15, 30 + 15);
      expectFrame(119, 59);
      // Left side: the neural clip (opaque where the matte is white) over the background.
      const left = shotOf(await frames.frame(30), 64, 48).px(8, 24);
      expect(Math.abs(left[0] - 120)).toBeLessThanOrEqual(8);
      // Rendering is repeatable through the decoder too.
      const again = await frames.frame(45);
      const { canvas, ctx } = createNodeCanvas(64, 48);
      await frames.prepareAt(1500);
      renderFrame(ctx, composition, 1500, { scenes: {} }, assets, {
        width: 64,
        height: 48,
        timeline: frames.timeline,
      });
      expect(diffRatio(again, canvasToRgba(canvas))).toBe(0);
    } finally {
      await background.close();
      await clipSource.close();
    }
  }, 120_000);

  it('rejects files without video', async () => {
    const text = path.join(dir, 'not-a-video.txt');
    fs.writeFileSync(text, 'hola');
    await expect(openVideoSource({ path: text })).rejects.toThrow();
  });
});

describe('NodeImageCache', () => {
  it('decodes each key once and forgets failures', async () => {
    const { canvas, ctx } = createNodeCanvas(6, 4);
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 6, 4);
    const png = canvasToPng(canvas);
    const cache = new NodeImageCache(2);
    let produced = 0;
    const load = () =>
      cache.load('a', async () => {
        produced += 1;
        return png;
      });
    const [first, second] = await Promise.all([load(), load()]);
    expect(first).toBe(second);
    expect(first).toMatchObject({ width: 6, height: 4 });
    expect(produced).toBe(1);
    await expect(cache.load('bad', new Uint8Array([1, 2, 3]))).rejects.toThrow();
    const recovered = await cache.load('bad', png);
    expect(recovered.width).toBe(6);
    await cache.load('c', png);
    await cache.load('d', png); // evicts the least recently used
    await load();
    expect(produced).toBe(2);
  });
});
