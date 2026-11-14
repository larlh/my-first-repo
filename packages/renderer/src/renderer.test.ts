import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VISEMES, createComposition, formatSrt } from '@parlante/shared';
import type { Composition, RenderRuntime } from '@parlante/shared';
import {
  MapRenderAssets,
  buildSubtitleCues,
  compositionSubtitleCues,
  computeAvatarState,
  computeTimeline,
  frameToMs,
  getStockAvatarRig,
  listStockAvatars,
  locateScene,
  msToFrame,
  renderFrame,
} from './index';
import {
  canvasAsImage,
  canvasToRgba,
  createNodeCanvas,
  loadNodeImage,
  registerNodeFonts,
  renderFrameToPng,
} from './node/index';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-output');

function demo(): { composition: Composition; runtime: RenderRuntime } {
  const composition = createComposition({
    aspect: '16:9',
    scenes: [
      {
        id: 'intro',
        name: 'Intro',
        script: {
          kind: 'tts',
          text: 'Hola mundo. Esto es Parlante.',
          voiceId: 'espeak:es-f1',
          language: 'es',
        },
        background: {
          type: 'gradient',
          gradient: {
            stops: [
              { offset: 0, color: '#1b1f3b' },
              { offset: 1, color: '#6d5efc' },
            ],
          },
        },
        layers: [
          {
            id: 'avatar',
            type: 'avatar',
            avatarId: 'stock_lucia',
            box: { x: 0.55, y: 0.08, w: 0.4, h: 0.92 },
          },
          {
            id: 'title',
            type: 'text',
            text: 'Hola, mundo',
            box: { x: 0.06, y: 0.3, w: 0.45, h: 0.2 },
            style: { fontFamily: 'Poppins', fontSize: 0.09, align: 'left' },
          },
          {
            id: 'bar',
            type: 'shape',
            box: { x: 0.06, y: 0.52, w: 0.2, h: 0.012 },
            fill: '#ffb547',
          },
          {
            id: 'pic',
            type: 'image',
            src: { source: 'stock', stockId: 'missing' },
            box: { x: 0.06, y: 0.6, w: 0.2, h: 0.2 },
          },
        ],
      },
      {
        id: 'outro',
        name: 'Cierre',
        duration: { mode: 'fixed', seconds: 2 },
        transition: { type: 'fade', durationMs: 600 },
        background: { type: 'color', color: '#0f1224' },
      },
    ],
  });
  const runtime: RenderRuntime = {
    scenes: {
      intro: {
        audioDurationMs: 2000,
        visemes: [
          { tMs: 0, viseme: 'rest' },
          { tMs: 100, viseme: 'O' },
          { tMs: 300, viseme: 'A' },
          { tMs: 600, viseme: 'MBP' },
          { tMs: 800, viseme: 'U' },
          { tMs: 1900, viseme: 'rest' },
        ],
        words: [
          { tMs: 100, durMs: 350, text: 'Hola' },
          { tMs: 500, durMs: 400, text: 'mundo.' },
          { tMs: 1100, durMs: 250, text: 'Esto' },
          { tMs: 1380, durMs: 150, text: 'es' },
          { tMs: 1550, durMs: 400, text: 'Parlante.' },
        ],
      },
    },
  };
  return { composition, runtime };
}

describe('timeline', () => {
  it('places scenes back to back with narration offsets and clamped transitions', () => {
    const { composition, runtime } = demo();
    const timeline = computeTimeline(composition, runtime);
    expect(timeline.fps).toBe(30);
    expect(timeline.scenes).toEqual([
      {
        sceneId: 'intro',
        index: 0,
        startMs: 0,
        endMs: 2800,
        durationMs: 2800,
        speechStartMs: 300,
        speechDurationMs: 2000,
        transitionMs: 0,
      },
      {
        sceneId: 'outro',
        index: 1,
        startMs: 2800,
        endMs: 4800,
        durationMs: 2000,
        speechStartMs: 3100,
        speechDurationMs: 0,
        transitionMs: 600,
      },
    ]);
    expect(timeline.totalMs).toBe(4800);
    expect(timeline.totalFrames).toBe(144);
  });

  it('treats scenes without runtime as silent, or estimates them on request', () => {
    const { composition } = demo();
    expect(computeTimeline(composition, { scenes: {} }).scenes[0]?.durationMs).toBe(3000);
    const estimated = computeTimeline(composition, { scenes: {} }, { estimateMissing: true });
    expect(estimated.scenes[0]?.speechDurationMs).toBeGreaterThan(600);
  });

  it('locates scenes and converts frames', () => {
    const { composition, runtime } = demo();
    const timeline = computeTimeline(composition, runtime);
    expect(locateScene(timeline, 0)).toMatchObject({
      localMs: 0,
      speechMs: -300,
      timing: { sceneId: 'intro' },
    });
    expect(locateScene(timeline, 2799).timing.sceneId).toBe('intro');
    expect(locateScene(timeline, 2800)).toMatchObject({ localMs: 0, timing: { sceneId: 'outro' } });
    expect(locateScene(timeline, 99_999).timing.sceneId).toBe('outro');
    expect(locateScene(timeline, -5).localMs).toBe(0);
    expect(frameToMs(30)).toBe(1000);
    expect(msToFrame(1000)).toBe(30);
    expect(msToFrame(frameToMs(143))).toBe(143);
  });
});

describe('subtitles', () => {
  it('groups words into cues at sentence ends and exports them on the video clock', () => {
    const { composition, runtime } = demo();
    const words = runtime.scenes.intro?.words ?? [];
    const cues = buildSubtitleCues(words, composition.subtitles);
    expect(cues.map((c) => c.text)).toEqual(['Hola mundo.', 'Esto es Parlante.']);
    expect(cues[0]?.startMs).toBe(100);
    expect(cues[0]?.endMs).toBeLessThanOrEqual(cues[1]?.startMs ?? 0);
    const timeline = computeTimeline(composition, runtime);
    const absolute = compositionSubtitleCues(composition, runtime, timeline);
    expect(absolute[0]).toMatchObject({ startMs: 400, text: 'Hola mundo.' });
    expect(formatSrt(absolute)).toContain('00:00:00,400 -->');
  });

  it('breaks long sentences by character budget', () => {
    const { composition } = demo();
    const words = Array.from({ length: 30 }, (_, i) => ({
      tMs: i * 300,
      durMs: 250,
      text: 'palabra',
    }));
    const cues = buildSubtitleCues(words, composition.subtitles);
    expect(cues.length).toBeGreaterThan(2);
    for (const cue of cues) {
      expect(cue.text.length).toBeLessThanOrEqual(
        composition.subtitles.maxCharsPerLine * composition.subtitles.maxLines,
      );
    }
  });
});

describe('avatars', () => {
  it('exposes at least 8 diverse stock avatars with unique ids and a rig each', () => {
    const avatars = listStockAvatars();
    expect(avatars.length).toBeGreaterThanOrEqual(8);
    expect(new Set(avatars.map((a) => a.id)).size).toBe(avatars.length);
    expect(new Set(avatars.map((a) => a.gender)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(avatars.map((a) => a.ageGroup)).size).toBe(3);
    for (const meta of avatars) {
      expect(meta.id).toMatch(/^stock_[a-z0-9-]+$/);
      expect(getStockAvatarRig(meta.id)?.id).toBe(meta.id);
    }
    expect(getStockAvatarRig('stock_nope')).toBeNull();
    expect(getStockAvatarRig('avt_0123456789abcdef')).toBeNull();
  });

  it('derives a deterministic pose from the runtime', () => {
    const { runtime } = demo();
    const sceneRuntime = runtime.scenes.intro;
    const at = (speechMs: number) =>
      computeAvatarState({
        runtime: sceneRuntime,
        speechMs,
        sceneMs: speechMs + 300,
        seed: 'intro:avatar',
      });
    expect(at(-100)).toMatchObject({ viseme: 'rest', speaking: false });
    expect(at(400)).toMatchObject({ viseme: 'A', nextViseme: 'A', blend: 0, speaking: true });
    const blending = at(580);
    expect(blending.viseme).toBe('A');
    expect(blending.nextViseme).toBe('MBP');
    expect(blending.blend).toBeGreaterThan(0);
    expect(blending.mouth.open).toBeLessThan(1);
    expect(at(5000).speaking).toBe(false);
    expect(at(700)).toEqual(at(700));
    for (const t of [0, 250, 900, 1500, 3100, 6400]) {
      const s = at(t);
      expect(VISEMES).toContain(s.viseme);
      expect(s.blink).toBeGreaterThanOrEqual(0);
      expect(s.blink).toBeLessThanOrEqual(1);
    }
  });
});

describe('renderFrame (Node, @napi-rs/canvas)', () => {
  it('registers the bundled fonts', () => {
    expect(registerNodeFonts()).toBeGreaterThan(100);
    expect(registerNodeFonts()).toBe(registerNodeFonts());
  });

  it('renders a frame to a PNG file', async () => {
    const { composition, runtime } = demo();
    const png = renderFrameToPng(composition, 700, runtime, new MapRenderAssets());
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, 'frame.png');
    fs.writeFileSync(file, png);
    const decoded = await loadNodeImage(file);
    expect(decoded.width).toBe(1280);
    expect(decoded.height).toBe(720);
    expect(png.length).toBeGreaterThan(5000);
  });

  it('is deterministic and changes over time', () => {
    const { composition, runtime } = demo();
    const assets = new MapRenderAssets();
    const pixelsAt = (tMs: number) => {
      const { canvas, ctx } = createNodeCanvas(640, 360);
      renderFrame(ctx, composition, tMs, runtime, assets, { width: 640, height: 360 });
      return canvasToRgba(canvas);
    };
    const a = pixelsAt(700);
    expect(a.length).toBe(640 * 360 * 4);
    expect(a.equals(pixelsAt(700))).toBe(true);
    expect(a.equals(pixelsAt(4000))).toBe(false);
    // Mouth open at 700 ms (viseme A) vs closed before the narration starts.
    expect(a.equals(pixelsAt(100))).toBe(false);
  });

  it('paints the scene background and blends during transitions', () => {
    const { composition, runtime } = demo();
    const assets = new MapRenderAssets();
    const topLeft = (tMs: number) => {
      const { canvas, ctx } = createNodeCanvas(320, 180);
      renderFrame(ctx, composition, tMs, runtime, assets, {
        width: 320,
        height: 180,
        subtitles: false,
      });
      return [...canvasToRgba(canvas).subarray(0, 4)];
    };
    expect(topLeft(4500)).toEqual([0x0f, 0x12, 0x24, 255]);
    const start = topLeft(2000);
    const mid = topLeft(2800 + 300);
    expect(mid).not.toEqual(start);
    expect(mid).not.toEqual([0x0f, 0x12, 0x24, 255]);
  });

  it('draws the neural clip instead of the rig for photorealistic avatar layers', () => {
    const composition = createComposition({
      scenes: [
        {
          id: 's',
          background: { type: 'color', color: '#000000' },
          layers: [
            { id: 'a', type: 'avatar', avatarId: 'real_ana', box: { x: 0.25, y: 0, w: 0.5, h: 1 } },
          ],
        },
      ],
    });
    const runtime: RenderRuntime = {
      scenes: { s: { audioDurationMs: 1000, visemes: [], words: [] } },
    };
    const { canvas: clipCanvas, ctx: clipCtx } = createNodeCanvas(100, 100);
    const requested: number[] = [];
    const assets = new MapRenderAssets().setAvatarClip('s', 'a', {
      durationMs: 1000,
      width: 100,
      height: 100,
      frameAt: (timeMs) => {
        requested.push(timeMs);
        clipCtx.fillStyle = timeMs < 500 ? '#ff0000' : '#00ff00';
        clipCtx.fillRect(0, 0, 100, 100);
        return canvasAsImage(clipCanvas);
      },
    });
    const centre = (tMs: number) => {
      const { canvas, ctx } = createNodeCanvas(320, 180);
      renderFrame(ctx, composition, tMs, runtime, assets, {
        width: 320,
        height: 180,
        subtitles: false,
      });
      const data = canvasToRgba(canvas);
      const offset = (90 * 320 + 160) * 4;
      return [...data.subarray(offset, offset + 3)];
    };
    // Scene-local 400 ms = 100 ms into the narration (padding 300 ms) → red clip frame.
    expect(centre(400)).toEqual([255, 0, 0]);
    expect(requested.at(-1)).toBe(100);
    expect(centre(1000)).toEqual([0, 255, 0]);
    // Before the narration starts the first clip frame is held.
    expect(centre(0)).toEqual([255, 0, 0]);
    expect(requested.at(-1)).toBe(0);
    // Without a clip (live preview) and without a stand-in rig → placeholder, never a crash.
    const { ctx } = createNodeCanvas(320, 180);
    expect(() =>
      renderFrame(ctx, composition, 400, runtime, new MapRenderAssets(), {
        width: 320,
        height: 180,
      }),
    ).not.toThrow();
  });

  it('scales with the output size and supports every aspect ratio', () => {
    for (const aspect of ['16:9', '9:16', '1:1'] as const) {
      const composition = createComposition({ aspect });
      const png = renderFrameToPng(composition, 0, { scenes: {} }, new MapRenderAssets(), {
        width: composition.canvas.width / 2,
        height: composition.canvas.height / 2,
        watermark: true,
      });
      expect(png.length).toBeGreaterThan(100);
    }
  });
});
