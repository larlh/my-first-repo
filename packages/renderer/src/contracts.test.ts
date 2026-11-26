import { describe, expect, it } from 'vitest';
import { SubtitleStyleSchema, createComposition, mediaRefKey } from '@parlante/shared';
import type { Composition, PhotoLandmarks, RenderRuntime } from '@parlante/shared';
import {
  MapRenderAssets,
  applyAlphaMatte,
  avatarClipTimeMs,
  computeTimeline,
  createPhotoAvatarRig,
  drawSubtitleCue,
  mediaPlaybackAt,
  mediaTimeMs,
  photoAvatarPlacement,
  renderFrame,
  restingAvatarState,
} from './index';
import type { PixelBox, RenderImage, VideoFrameSource } from './index';
import {
  canvasAsImage,
  canvasToPng,
  canvasToRgba,
  createNodeCanvas,
  cutoutPng,
  loadNodeImage,
  nodePlatform,
  thumbnailJpeg,
} from './node/index';

const LANDMARKS: PhotoLandmarks = {
  leftEye: { x: 0.4, y: 0.35 },
  rightEye: { x: 0.6, y: 0.35 },
  mouthLeft: { x: 0.44, y: 0.55 },
  mouthRight: { x: 0.56, y: 0.55 },
  chin: { x: 0.5, y: 0.65 },
};

function pixel(data: Buffer, width: number, x: number, y: number): number[] {
  const offset = (Math.round(y) * width + Math.round(x)) * 4;
  return [...data.subarray(offset, offset + 4)];
}

/** Opaque "portrait": blue body, a yellow face block between the eye line and the chin. */
function portrait(size: number): RenderImage {
  const { canvas, ctx } = createNodeCanvas(size, size);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#ffff00';
  ctx.fillRect(0.4 * size, 0.35 * size, 0.2 * size, 0.3 * size);
  return canvasAsImage(canvas);
}

describe('photoAvatarPlacement', () => {
  const box: PixelBox = { x: 100, y: 50, w: 300, h: 600 };

  it('half: whole image contained, centred, on the bottom edge', () => {
    expect(photoAvatarPlacement(400, 400, box, 'half', LANDMARKS)).toEqual({
      x: 100,
      y: 350,
      w: 300,
      h: 300,
    });
    // Without landmarks every framing falls back to the same rectangle.
    expect(photoAvatarPlacement(400, 400, box, 'closeup', null)).toEqual(
      photoAvatarPlacement(400, 400, box, 'half', LANDMARKS),
    );
    expect(photoAvatarPlacement(0, 400, box, 'bust', LANDMARKS).w).toBe(0);
  });

  it('bust / closeup: zoom to the face, centred horizontally', () => {
    const bust = photoAvatarPlacement(400, 400, box, 'bust', LANDMARKS);
    // eye→chin = 0.30 × image; target 0.20 × 600 = 120 px ⇒ image drawn 400 px tall.
    expect(bust.h).toBeCloseTo(400, 6);
    expect(bust.y + bust.h).toBeCloseTo(box.y + box.h, 6); // bottom anchored
    expect(bust.x + 0.5 * bust.w).toBeCloseTo(box.x + box.w / 2, 6); // face centre on box centre

    const close = photoAvatarPlacement(400, 400, box, 'closeup', LANDMARKS);
    expect(close.h).toBeCloseTo(640, 6); // 0.32 × 600 / 0.30
    expect(close.w).toBeGreaterThan(bust.w);
    // Eye line 40 % down the box, unless that would leave a gap below the image.
    const eyeLine = close.y + 0.35 * close.h;
    expect(eyeLine).toBeCloseTo(box.y + 0.4 * box.h, 6);
    expect(close.y + close.h).toBeGreaterThanOrEqual(box.y + box.h - 1e-6);
  });

  it('gives the portrait and a scaled-down clip frame the same rectangle', () => {
    for (const framing of ['half', 'bust', 'closeup'] as const) {
      const full = photoAvatarPlacement(768, 1024, box, framing, LANDMARKS);
      const clip = photoAvatarPlacement(384, 512, box, framing, LANDMARKS);
      for (const key of ['x', 'y', 'w', 'h'] as const) expect(clip[key]).toBeCloseTo(full[key], 6);
    }
  });
});

describe('photorealistic avatar: stand-in and neural clip agree', () => {
  function scene(framing: 'half' | 'bust' | 'closeup', shape: 'none' | 'circle'): Composition {
    return createComposition({
      scenes: [
        {
          id: 's',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#ff0000' },
          layers: [
            {
              id: 'a',
              type: 'avatar',
              avatarId: 'avt_abcdefgh12345678',
              framing,
              shape,
              box: { x: 0.25, y: 0.1, w: 0.3, h: 0.9 },
            },
          ],
        },
      ],
    });
  }
  const render = (composition: Composition, assets: MapRenderAssets) => {
    const { canvas, ctx } = createNodeCanvas(640, 360);
    renderFrame(ctx, composition, 500, { scenes: {} }, assets, {
      width: 640,
      height: 360,
      subtitles: false,
    });
    return canvasToRgba(canvas);
  };

  it('draws the clip in the same place as the stand-in for every framing', () => {
    for (const framing of ['half', 'bust', 'closeup'] as const) {
      for (const shape of ['none', 'circle'] as const) {
        const composition = scene(framing, shape);
        const rig = { imageWidth: 400, imageHeight: 400, landmarks: LANDMARKS };
        const standIn = new MapRenderAssets().setAvatar(
          'avt_abcdefgh12345678',
          createPhotoAvatarRig('avt_abcdefgh12345678', portrait(400), {
            ...rig,
            landmarksSource: 'detected',
          }),
        );
        const clipImage = portrait(200); // engine output: same framing, smaller
        const withClip = new MapRenderAssets().setAvatarClip('s', 'a', {
          durationMs: 2000,
          width: 200,
          height: 200,
          originMs: 0,
          landmarks: LANDMARKS,
          frameAt: () => clipImage,
        });
        const a = render(composition, standIn);
        const b = render(composition, withClip);
        let different = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (
            Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 40 ||
            Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) > 40 ||
            Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)) > 40
          ) {
            different += 1;
          }
        }
        // Only resampling differences along edges (the two sources differ in resolution).
        expect(different / (640 * 360), `${framing}/${shape}`).toBeLessThan(0.01);
        // And the avatar really is there (yellow face block inside the layer box).
        let yellow = 0;
        for (let i = 0; i < b.length; i += 4) {
          if ((b[i] ?? 0) > 200 && (b[i + 1] ?? 0) > 200 && (b[i + 2] ?? 0) < 60) yellow += 1;
        }
        expect(yellow, `${framing}/${shape}`).toBeGreaterThan(200);
      }
    }
  });

  it('closeup with a circle mask frames the face, not the chest', () => {
    const { canvas, ctx } = createNodeCanvas(640, 360);
    const assets = new MapRenderAssets().setAvatar(
      'avt_abcdefgh12345678',
      createPhotoAvatarRig('avt_abcdefgh12345678', portrait(400), {
        imageWidth: 400,
        imageHeight: 400,
        landmarks: LANDMARKS,
        landmarksSource: 'detected',
      }),
    );
    renderFrame(ctx, scene('closeup', 'circle'), 500, { scenes: {} }, assets, {
      width: 640,
      height: 360,
      subtitles: false,
    });
    const data = canvasToRgba(canvas);
    // Centre of the circle (= centre of the layer box) shows the yellow face block.
    const [r, g, b] = pixel(data, 640, 0.4 * 640, (0.1 + 0.45) * 360);
    expect([r, g, b]).toEqual([255, 255, 0]);
  });

  it('keeps the stand-in rig pure and inside its box', () => {
    const rig = createPhotoAvatarRig('avt_x', portrait(400), {
      imageWidth: 400,
      imageHeight: 400,
      landmarks: LANDMARKS,
      landmarksSource: 'user',
    });
    const { canvas, ctx } = createNodeCanvas(200, 200);
    rig.draw(ctx, { x: 50, y: 50, w: 100, h: 100 }, restingAvatarState(), {
      framing: 'closeup',
      flip: false,
      quality: 'final',
    });
    const data = canvasToRgba(canvas);
    expect(pixel(data, 200, 20, 20)[3]).toBe(0);
    expect(pixel(data, 200, 180, 100)[3]).toBe(0);
    expect(pixel(data, 200, 100, 100)[3]).toBe(255);
  });
});

describe('neural clip origin (idle motion outside the narration)', () => {
  it('measures clip time from the narration by default and from originMs when set', () => {
    expect(avatarClipTimeMs({ durationMs: 1000 }, 400, 100)).toBe(100);
    expect(avatarClipTimeMs({ durationMs: 1000 }, 100, -200)).toBe(0); // held first frame
    expect(avatarClipTimeMs({ durationMs: 1000 }, 5000, 4700)).toBe(999); // held last frame
    expect(avatarClipTimeMs({ durationMs: 3000, originMs: 0 }, 100, -200)).toBe(100);
    expect(avatarClipTimeMs({ durationMs: 3000, originMs: 0 }, 2500, 2200)).toBe(2500);
  });

  it('plays a full-scene clip during paddings and in scenes without narration', () => {
    const composition = createComposition({
      scenes: [
        {
          id: 'silent',
          layers: [
            {
              id: 'a',
              type: 'avatar',
              avatarId: 'real_ana',
              box: { x: 0, y: 0, w: 1, h: 1 },
            },
          ],
        },
      ],
    });
    const runtime: RenderRuntime = { scenes: {} }; // no narration at all → 3 s silent scene
    const requested: number[] = [];
    const { canvas: clipCanvas } = createNodeCanvas(64, 64);
    const assets = new MapRenderAssets().setAvatarClip('silent', 'a', {
      durationMs: 3000,
      width: 64,
      height: 64,
      originMs: 0,
      frameAt: (timeMs) => {
        requested.push(timeMs);
        return canvasAsImage(clipCanvas);
      },
    });
    const { ctx } = createNodeCanvas(320, 180);
    for (const t of [0, 1000, 2900]) {
      renderFrame(ctx, composition, t, runtime, assets, { width: 320, height: 180 });
    }
    expect(requested).toEqual([0, 1000, 2900]);
  });
});

describe('mediaPlaybackAt (the renderer and its feeders share one media clock)', () => {
  const bg = { source: 'stock' as const, stockId: 'bg-loop' };
  const clip = { source: 'asset' as const, assetId: 'ast_abcdefgh12345678' };
  const composition = createComposition({
    scenes: [
      {
        id: 'one',
        duration: { mode: 'fixed', seconds: 4 },
        background: { type: 'video', src: bg, trimStartMs: 500, loop: true, volume: 0.4 },
        layers: [
          {
            id: 'v',
            type: 'video',
            src: clip,
            box: { x: 0, y: 0, w: 0.5, h: 0.5 },
            trimStartMs: 200,
            loop: false,
            volume: 0.8,
            timing: { startMs: 1000, endMs: 3000 },
          },
          {
            id: 'hidden',
            type: 'video',
            src: clip,
            visible: false,
            box: { x: 0, y: 0, w: 0.5, h: 0.5 },
          },
          { id: 'av', type: 'avatar', avatarId: 'real_ana', box: { x: 0.5, y: 0, w: 0.5, h: 1 } },
        ],
      },
      {
        id: 'two',
        duration: { mode: 'fixed', seconds: 2 },
        transition: { type: 'fade', durationMs: 600 },
        background: { type: 'video', src: bg, loop: false },
      },
    ],
  });
  const timeline = computeTimeline(composition, { scenes: {} });

  it('lists every video of a frame with its media time and volume', () => {
    const at = (t: number) =>
      mediaPlaybackAt(composition, timeline, t).map((p) => [p.kind, p.key, p.rawMs, p.volume]);
    expect(at(500)).toEqual([
      ['background', 'stock:bg-loop', 1000, 0.4],
      ['avatarClip', 'one/av', 200, 0],
    ]);
    // The video layer exists only inside its window and starts at its trim point.
    expect(at(1500)).toEqual([
      ['background', 'stock:bg-loop', 2000, 0.4],
      ['layer', 'asset:ast_abcdefgh12345678', 700, 0.8],
      ['avatarClip', 'one/av', 1200, 0],
    ]);
    expect(at(3500).map((e) => e[0])).toEqual(['background', 'avatarClip']);
    // Transition into scene two: scene one frozen on its last frame and muted, then scene two.
    const during = mediaPlaybackAt(composition, timeline, 4300);
    expect(during.map((p) => [p.sceneId, p.kind, p.frozen, p.volume])).toEqual([
      ['one', 'background', true, 0],
      ['one', 'avatarClip', true, 0],
      ['two', 'background', false, 0],
    ]);
    expect(during[0]?.rawMs).toBeCloseTo(500 + 4000 - 1000 / 30, 6);
    expect(during[2]?.rawMs).toBe(300);
    expect(mediaPlaybackAt(composition, timeline, 5000).map((p) => p.sceneId)).toEqual(['two']);
    expect(mediaTimeMs(4600, true, 1500)).toBe(100);
    expect(mediaTimeMs(4600, false, 1500)).toBe(1500);
    expect(mediaTimeMs(-50, true, 1500)).toBe(0);
    expect(mediaTimeMs(100, true, 0)).toBe(0);
  });

  it('predicts exactly the frames renderFrame asks its sources for', () => {
    const asked = new Map<string, number[]>();
    const source = (key: string, durationMs: number): VideoFrameSource => ({
      durationMs,
      width: 16,
      height: 16,
      frameAt: (timeMs) => {
        asked.set(key, [...(asked.get(key) ?? []), timeMs]);
        return null;
      },
    });
    const durations: Record<string, number> = {
      [mediaRefKey(bg)]: 1500,
      [mediaRefKey(clip)]: 1200,
      'one/av': 3000,
    };
    const assets = new MapRenderAssets()
      .setVideo(mediaRefKey(bg), source(mediaRefKey(bg), 1500))
      .setVideo(mediaRefKey(clip), source(mediaRefKey(clip), 1200))
      .setAvatarClip('one', 'av', { ...source('one/av', 3000), originMs: 0 });
    const { ctx } = createNodeCanvas(160, 90);
    for (let t = 0; t < timeline.totalMs; t += 1000 / 6) {
      asked.clear();
      renderFrame(ctx, composition, t, { scenes: {} }, assets, {
        width: 160,
        height: 90,
        timeline,
      });
      const predicted = new Map<string, number[]>();
      for (const entry of mediaPlaybackAt(composition, timeline, t)) {
        const duration = durations[entry.key] ?? 0;
        const time =
          entry.kind === 'avatarClip'
            ? avatarClipTimeMs({ durationMs: duration, originMs: 0 }, entry.localMs, entry.speechMs)
            : mediaTimeMs(entry.rawMs, entry.loop, duration);
        predicted.set(entry.key, [...(predicted.get(entry.key) ?? []), time]);
      }
      expect([...asked.entries()].sort(), `t=${t}`).toEqual([...predicted.entries()].sort());
    }
  });
});

describe('alpha matte / cut-out', () => {
  async function fixtures() {
    const { canvas: p, ctx: pc } = createNodeCanvas(8, 8);
    pc.fillStyle = '#ff0000';
    pc.fillRect(0, 0, 8, 8);
    const { canvas: m, ctx: mc } = createNodeCanvas(4, 4); // smaller: scaled to the image
    mc.fillStyle = '#000000';
    mc.fillRect(0, 0, 4, 4);
    mc.fillStyle = '#ffffff';
    mc.fillRect(0, 0, 2, 4);
    return { portraitPng: canvasToPng(p), maskPng: canvasToPng(m) };
  }

  it('keeps the person (white matte) and makes the background transparent', async () => {
    const { portraitPng, maskPng } = await fixtures();
    const cutout = applyAlphaMatte(
      nodePlatform,
      await loadNodeImage(portraitPng),
      await loadNodeImage(maskPng),
    );
    expect([cutout.width, cutout.height]).toEqual([8, 8]);
    const { canvas, ctx } = createNodeCanvas(8, 8);
    ctx.drawImage(cutout.source, 0, 0);
    const data = canvasToRgba(canvas);
    expect(pixel(data, 8, 1, 4)).toEqual([255, 0, 0, 255]);
    expect(pixel(data, 8, 6, 4)[3]).toBe(0);
  });

  it('encodes the cut-out as PNG and thumbnails as JPEG', async () => {
    const { portraitPng, maskPng } = await fixtures();
    const png = await cutoutPng(portraitPng, maskPng);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const decoded = await loadNodeImage(png);
    const { canvas, ctx } = createNodeCanvas(8, 8);
    ctx.drawImage(decoded.source, 0, 0);
    expect(pixel(canvasToRgba(canvas), 8, 7, 0)[3]).toBe(0);
    expect(pixel(canvasToRgba(canvas), 8, 0, 0)).toEqual([255, 0, 0, 255]);
    // No matte: the portrait is kept whole.
    const whole = await loadNodeImage(await cutoutPng(portraitPng, null));
    const { canvas: c2, ctx: x2 } = createNodeCanvas(8, 8);
    x2.drawImage(whole.source, 0, 0);
    expect(pixel(canvasToRgba(c2), 8, 7, 0)).toEqual([255, 0, 0, 255]);
    const jpeg = await thumbnailJpeg(png, 4);
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    const thumb = await loadNodeImage(jpeg);
    expect([thumb.width, thumb.height]).toEqual([4, 4]);
  });
});

describe('drawSubtitleCue', () => {
  it('paints a cue with the composition look on any canvas (used by video translation)', () => {
    const style = SubtitleStyleSchema.parse({ position: 'bottom' });
    const { canvas, ctx } = createNodeCanvas(640, 360);
    drawSubtitleCue(ctx, { startMs: 0, endMs: 1500, text: 'Hola mundo' }, style, 640, 360, 200);
    const data = canvasToRgba(canvas);
    let top = 0;
    let bottom = 0;
    for (let y = 0; y < 360; y += 1) {
      for (let x = 0; x < 640; x += 1) {
        if ((data[(y * 640 + x) * 4 + 3] ?? 0) > 0) {
          if (y < 180) top += 1;
          else bottom += 1;
        }
      }
    }
    expect(top).toBe(0);
    expect(bottom).toBeGreaterThan(500);
    // Empty cues paint nothing.
    const { canvas: empty, ctx: emptyCtx } = createNodeCanvas(64, 64);
    drawSubtitleCue(emptyCtx, { startMs: 0, endMs: 1, text: '  ' }, style, 64, 64);
    expect(canvasToRgba(empty).every((v) => v === 0)).toBe(true);
  });
});
