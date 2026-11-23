import { beforeAll, describe, expect, it } from 'vitest';
import { SubtitleStyleSchema, createComposition, formatSrt } from '@parlante/shared';
import type { Composition, RenderRuntime, SubtitleStyle, WordCue } from '@parlante/shared';
import {
  MapRenderAssets,
  WATERMARK_CLEARANCE,
  buildSubtitleCues,
  clearRenderCaches,
  compositionSubtitleCues,
  computeTimeline,
  cueAt,
  drawSubtitleCue,
  locateScene,
  mediaPlaybackAt,
  renderCacheStats,
  sceneInstantsAt,
  setRenderCacheBudget,
  subtitleCharsPerLine,
} from './index';
import { canvasToRgba, createNodeCanvas, registerNodeFonts } from './node/index';
import { demoProject } from './testing/demo';
import { diffRatio, near, shoot, shotOf } from './testing/pixels';
import type { Rgb, Shot } from './testing/pixels';

const W = 640;
const H = 360;
const size = { width: W, height: H };
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const rgb = (shot: Shot, x: number, y: number) => shot.px(x, y).slice(0, 3) as Rgb;

beforeAll(() => {
  registerNodeFonts();
});

/* ---------- timeline ---------- */

describe('timeline', () => {
  const composition = createComposition({
    scenes: [
      { id: 'a', script: { kind: 'tts', text: 'Uno', voiceId: 'espeak:es-f1', language: 'es' } },
      {
        id: 'b',
        duration: { mode: 'fixed', seconds: 1 },
        paddingStartMs: 200,
        transition: { type: 'fade', durationMs: 2000 },
        script: { kind: 'tts', text: 'Dos', voiceId: 'espeak:es-f1', language: 'es' },
      },
      { id: 'c', transition: { type: 'none', durationMs: 500 } },
      {
        id: 'd',
        paddingStartMs: 0,
        paddingEndMs: 0,
        transition: { type: 'wipe', durationMs: 400 },
      },
    ],
  });
  const runtime: RenderRuntime = {
    scenes: {
      a: { audioDurationMs: 1234.4, visemes: [], words: [] },
      b: { audioDurationMs: 5000, visemes: [], words: [] },
      d: { audioDurationMs: 700, visemes: [], words: [] },
    },
  };
  const timeline = computeTimeline(composition, runtime);

  it('derives scene lengths from the audio and keeps scenes back to back', () => {
    const [a, b, c, d] = timeline.scenes;
    expect(a).toMatchObject({ startMs: 0, durationMs: 300 + 1234 + 500, speechStartMs: 300 });
    // Fixed scene: narration truncated to what fits after its padding.
    expect(b).toMatchObject({ durationMs: 1000, speechDurationMs: 800 });
    expect(b?.speechStartMs).toBe((a?.endMs ?? 0) + 200);
    expect(c).toMatchObject({ durationMs: 3000, speechDurationMs: 0, transitionMs: 0 });
    expect(d).toMatchObject({ durationMs: 700, speechDurationMs: 700 });
    for (let i = 1; i < timeline.scenes.length; i += 1) {
      expect(timeline.scenes[i]?.startMs).toBe(timeline.scenes[i - 1]?.endMs);
    }
    expect(timeline.totalMs).toBe(2034 + 1000 + 3000 + 700);
    expect(timeline.totalFrames).toBe(Math.ceil((timeline.totalMs / 1000) * 30));
  });

  it('clamps transitions to half of the shorter neighbour and never changes the total', () => {
    expect(timeline.scenes.map((s) => s.transitionMs)).toEqual([0, 500, 0, 350]);
    const without = createComposition({
      scenes: composition.scenes.map((scene) => ({
        ...scene,
        transition: { type: 'none' as const, durationMs: 0 },
      })),
    });
    expect(computeTimeline(without, runtime).totalMs).toBe(timeline.totalMs);
  });

  it('finds the scene and its local clocks, including the frozen scene of a transition', () => {
    const b = timeline.scenes[1];
    if (!b) throw new Error('missing scene');
    expect(locateScene(timeline, b.startMs - 0.5).timing.sceneId).toBe('a');
    expect(locateScene(timeline, b.startMs + 250)).toMatchObject({ localMs: 250, speechMs: 50 });
    const during = sceneInstantsAt(composition, timeline, b.startMs + 250);
    expect(during.map((i) => [i.scene.id, i.frozen])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(during[1]?.transitionProgress).toBeCloseTo(0.5, 6);
    expect(during[0]?.localMs).toBeCloseTo(2034 - 1000 / 30, 6);
    expect(sceneInstantsAt(composition, timeline, b.startMs + 500).map((i) => i.scene.id)).toEqual([
      'b',
    ]);
    // Every frame of the video maps to exactly one current scene, in order.
    let previousIndex = 0;
    for (let frame = 0; frame < timeline.totalFrames; frame += 1) {
      const { timing, localMs } = locateScene(timeline, (frame * 1000) / 30);
      expect(timing.index).toBeGreaterThanOrEqual(previousIndex);
      expect(localMs).toBeGreaterThanOrEqual(0);
      expect(localMs).toBeLessThan(timing.durationMs);
      previousIndex = timing.index;
    }
    expect(previousIndex).toBe(3);
  });

  it('lists media in paint order (z, then array order)', () => {
    const clip = { source: 'stock' as const, stockId: 'c' };
    const stacked = createComposition({
      scenes: [
        {
          id: 's',
          layers: [
            { id: 'top', type: 'video', src: clip, box: { x: 0, y: 0, w: 1, h: 1 }, z: 5 },
            { id: 'bottom', type: 'video', src: clip, box: { x: 0, y: 0, w: 1, h: 1 }, z: -1 },
            { id: 'middle', type: 'avatar', avatarId: 'real_x', box: { x: 0, y: 0, w: 1, h: 1 } },
          ],
        },
      ],
    });
    const order = mediaPlaybackAt(stacked, computeTimeline(stacked, { scenes: {} }), 100);
    expect(order.map((p) => p.layerId)).toEqual(['bottom', 'middle', 'top']);
  });
});

/* ---------- transitions ---------- */

describe('scene transitions', () => {
  function pair(type: string, durationMs = 1000): Composition {
    return createComposition({
      scenes: [
        {
          id: 'a',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#ff0000' },
        },
        {
          id: 'b',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#0000ff' },
          transition: { type: type as 'fade', durationMs },
        },
      ],
    });
  }
  const mid = (type: string) => shoot(pair(type), 2500, undefined, undefined, size);

  it('cuts without a transition', () => {
    const cut = pair('none');
    expect(rgb(shoot(cut, 1999, undefined, undefined, size), 10, 10)).toEqual(RED);
    expect(rgb(shoot(cut, 2000, undefined, undefined, size), 10, 10)).toEqual(BLUE);
  });

  it('cross-fades', () => {
    const fade = mid('fade');
    for (const [x, y] of [
      [10, 10],
      [W / 2, H / 2],
      [W - 10, H - 10],
    ] as const) {
      expect(near([128, 0, 128], 4)(...rgb(fade, x, y))).toBe(true);
    }
    const early = shoot(pair('fade'), 2100, undefined, undefined, size).px(10, 10);
    expect(early[0]).toBeGreaterThan(early[2]);
  });

  it('slides push the previous scene out in the named direction', () => {
    const left = mid('slide-left');
    expect(rgb(left, W * 0.25, H / 2)).toEqual(RED);
    expect(rgb(left, W * 0.75, H / 2)).toEqual(BLUE);
    const right = mid('slide-right');
    expect(rgb(right, W * 0.25, H / 2)).toEqual(BLUE);
    expect(rgb(right, W * 0.75, H / 2)).toEqual(RED);
    const up = mid('slide-up');
    expect(rgb(up, W / 2, H * 0.25)).toEqual(RED);
    expect(rgb(up, W / 2, H * 0.75)).toEqual(BLUE);
    const down = mid('slide-down');
    expect(rgb(down, W / 2, H * 0.25)).toEqual(BLUE);
    expect(rgb(down, W / 2, H * 0.75)).toEqual(RED);
    // Nothing but the two scenes: no gap, no seam.
    expect(
      left.count((r, g, b) => !(r === 255 && b === 0) && !(r === 0 && b === 255) && g === 0),
    ).toBe(0);
  });

  it('wipes from left to right and zooms the incoming scene in', () => {
    const wipe = mid('wipe');
    expect(rgb(wipe, W * 0.25, H / 2)).toEqual(BLUE);
    expect(rgb(wipe, W * 0.75, H / 2)).toEqual(RED);
    const quarter = shoot(pair('wipe'), 2250, undefined, undefined, size);
    expect(quarter.count(near(BLUE, 2))).toBeLessThan(wipe.count(near(BLUE, 2)));
    const zoom = mid('zoom');
    expect(rgb(zoom, 3, 3)).toEqual(RED); // the incoming scene has not reached the corners
    const centre = zoom.px(W / 2, H / 2);
    expect(centre[2]).toBeGreaterThan(150);
    expect(zoom.count((_r, _g, _b, a) => a !== 255)).toBe(0);
  });

  it('starts on the previous scene, ends on the incoming one, for every type', () => {
    for (const type of [
      'fade',
      'slide-left',
      'slide-right',
      'slide-up',
      'slide-down',
      'wipe',
      'zoom',
    ]) {
      const composition = pair(type);
      const first = shoot(composition, 2000, undefined, undefined, size);
      expect(first.count(near(RED, 2)), type).toBe(W * H);
      const done = shoot(composition, 3000, undefined, undefined, size);
      expect(done.count(near(BLUE, 2)), type).toBe(W * H);
      // Monotonic: the incoming scene only ever gains ground.
      let blue = -1;
      for (let t = 2000; t <= 3000; t += 100) {
        const b = shoot(composition, t, undefined, undefined, size);
        const sum = b.px(W / 2, H / 2)[2] + b.count(near(BLUE, 2)) / 100;
        expect(sum, `${type} @${t}`).toBeGreaterThanOrEqual(blue);
        blue = sum;
      }
    }
  });

  it('composites the incoming scene as a whole (its layers do not show through each other)', () => {
    const composition = createComposition({
      scenes: [
        {
          id: 'a',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#ff0000' },
        },
        {
          id: 'b',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#0000ff' },
          transition: { type: 'fade', durationMs: 1000 },
          layers: [
            { id: 'cover', type: 'shape', box: { x: 0, y: 0, w: 1, h: 1 }, fill: '#ffffff' },
          ],
        },
      ],
    });
    // Half-way: 50 % white over red. A per-layer blend would let the blue background through.
    const [r, g, b] = shoot(composition, 2500, undefined, undefined, size).px(W / 2, H / 2);
    expect(r).toBe(255);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(3);
    expect(Math.abs(b - 128)).toBeLessThanOrEqual(3);
  });

  it('holds the previous scene on its last frame and keeps layers of both scenes apart', () => {
    const composition = createComposition({
      scenes: [
        {
          id: 'a',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#000000' },
          layers: [
            {
              id: 'late',
              type: 'shape',
              box: { x: 0, y: 0, w: 0.2, h: 0.2 },
              fill: '#00ff00',
              timing: { startMs: 1900, endMs: null },
            },
            // Overflows the frame: must not leak into the incoming scene while sliding.
            { id: 'wide', type: 'shape', box: { x: 0.8, y: 0.4, w: 0.6, h: 0.2 }, fill: '#ffff00' },
          ],
        },
        {
          id: 'b',
          duration: { mode: 'fixed', seconds: 2 },
          background: { type: 'color', color: '#0000ff' },
          transition: { type: 'slide-left', durationMs: 1000 },
        },
      ],
    });
    const shot = shoot(composition, 2500, undefined, undefined, size);
    // Previous scene shifted left by half a frame: its right half is visible on the left.
    expect(rgb(shot, W * 0.4, H / 2)).toEqual([255, 255, 0]);
    expect(rgb(shot, W * 0.6, H / 2)).toEqual(BLUE);
    expect(shot.count(near([0, 255, 0], 2))).toBe(0); // the green square slid out with its scene
    const start = shoot(composition, 2000, undefined, undefined, size);
    expect(rgb(start, 10, 10)).toEqual([0, 255, 0]); // last frame of scene a, late layer included
  });
});

/* ---------- subtitles ---------- */

function words(text: string, stepMs = 300): WordCue[] {
  return text
    .split(' ')
    .map((word, i) => ({ tMs: 100 + i * stepMs, durMs: stepMs - 40, text: word }));
}

describe('subtitle cues', () => {
  const style = SubtitleStyleSchema.parse({});
  const speech = words(
    'Primero escribes el texto de cada escena, después eliges una voz y un idioma. Y por último añades imágenes, formas y subtítulos antes de exportar el vídeo final.',
  );

  it('budgets characters by aspect ratio', () => {
    expect(subtitleCharsPerLine(style)).toBe(38);
    expect(subtitleCharsPerLine(style, { width: 1280, height: 720 })).toBe(38);
    expect(subtitleCharsPerLine(style, { width: 720, height: 720 })).toBeLessThanOrEqual(38);
    const vertical = subtitleCharsPerLine(style, { width: 720, height: 1280 });
    expect(vertical).toBeGreaterThanOrEqual(15);
    expect(vertical).toBeLessThan(24);
    expect(
      subtitleCharsPerLine({ ...style, uppercase: true }, { width: 720, height: 1280 }),
    ).toBeLessThan(vertical);
  });

  it('covers every word exactly once, in order, without overlaps', () => {
    for (const canvas of [undefined, { width: 720, height: 1280 }, { width: 720, height: 720 }]) {
      const cues = buildSubtitleCues(speech, style, canvas);
      expect(cues.map((c) => c.text).join(' ')).toBe(speech.map((w) => w.text).join(' '));
      const budget = subtitleCharsPerLine(style, canvas) * style.maxLines;
      cues.forEach((cue, i) => {
        expect(cue.text.length).toBeLessThanOrEqual(budget);
        expect(cue.endMs).toBeGreaterThan(cue.startMs);
        const next = cues[i + 1];
        if (next) expect(cue.endMs).toBeLessThanOrEqual(next.startMs);
      });
    }
    const wide = buildSubtitleCues(speech, style, { width: 1280, height: 720 });
    const tall = buildSubtitleCues(speech, style, { width: 720, height: 1280 });
    expect(tall.length).toBeGreaterThan(wide.length);
    expect(wide[0]?.text.endsWith(',')).toBe(true); // clause break once the cue is full enough
    expect(cueAt(wide, 50)).toBeNull();
    expect(cueAt(wide, 150)?.text).toBe(wide[0]?.text);
  });

  it('exports the same cues it burns in (SRT / VTT on the video clock)', () => {
    const { composition, runtime } = demoProject({ aspect: '9:16', stubAvatars: true });
    const timeline = computeTimeline(composition, runtime);
    const exported = compositionSubtitleCues(composition, runtime, timeline);
    const burned = timeline.scenes.flatMap((timing) =>
      buildSubtitleCues(
        runtime.scenes[timing.sceneId]?.words ?? [],
        composition.subtitles,
        composition.canvas,
      ).map((cue) => cue.text),
    );
    expect(exported.map((c) => c.text)).toEqual(burned);
    exported.forEach((cue, i) => {
      const next = exported[i + 1];
      if (next) expect(cue.endMs).toBeLessThanOrEqual(next.startMs);
      expect(cue.endMs).toBeLessThanOrEqual(timeline.totalMs);
    });
    expect(formatSrt(exported).split('\n\n').length).toBe(exported.length);
  });
});

describe('drawSubtitleCue', () => {
  const draw = (
    text: string,
    overrides: Partial<SubtitleStyle> = {},
    options: { width?: number; height?: number; tMs?: number; cueWords?: WordCue[] } = {},
  ): Shot => {
    const width = options.width ?? W;
    const height = options.height ?? H;
    const style = SubtitleStyleSchema.parse(overrides);
    const { canvas, ctx } = createNodeCanvas(width, height);
    const cue = {
      startMs: 0,
      endMs: 3000,
      text,
      ...(options.cueWords ? { words: options.cueWords } : {}),
    };
    drawSubtitleCue(ctx, cue, style, width, height, options.tMs ?? 0);
    return shotOf(canvasToRgba(canvas), width, height);
  };
  const painted = (_r: number, _g: number, _b: number, a: number) => a > 8;
  const white = (r: number, g: number, b: number, a: number) =>
    a > 200 && r > 225 && g > 225 && b > 225;

  it('boxed: text on a rounded box of the background colour, at the margin', () => {
    const shot = draw('Hola mundo', { preset: 'boxed', backgroundColor: '#102030', margin: 0.1 });
    const box = shot.bbox(painted);
    const ink = shot.bbox(white);
    if (!box || !ink) throw new Error('subtitle was not drawn');
    expect(box.y1).toBeLessThanOrEqual(H - 0.1 * H);
    expect(H - 0.1 * H - box.y1).toBeLessThan(3);
    expect(Math.abs((box.x0 + box.x1) / 2 - W / 2)).toBeLessThanOrEqual(1.5);
    expect(box.x0).toBeLessThan(ink.x0 - 4);
    expect(shot.px(box.x0 + 4, Math.round((box.y0 + box.y1) / 2))).toEqual([0x10, 0x20, 0x30, 255]);
    expect(shot.px(box.x0, box.y0)[3]).toBeLessThan(255); // rounded corner
  });

  it('classic: outlined text without a box; minimal: smaller text with a soft shadow', () => {
    const classic = draw('Hola mundo', { preset: 'classic' });
    const ink = classic.bbox(white);
    if (!ink) throw new Error('subtitle was not drawn');
    // Dark outline right around the letters, nothing solid further out.
    expect(classic.count((r, g, b, a) => a > 200 && r < 40 && g < 40 && b < 50)).toBeGreaterThan(
      300,
    );
    expect(classic.px(ink.x0 - 30, Math.round((ink.y0 + ink.y1) / 2))[3]).toBe(0);
    const minimal = draw('Hola mundo', { preset: 'minimal' });
    const small = minimal.bbox(white);
    if (!small) throw new Error('subtitle was not drawn');
    expect(small.w).toBeLessThan(ink.w * 0.9);
    expect(minimal.count((_r, _g, _b, a) => a > 0 && a < 200)).toBeGreaterThan(200); // soft shadow
    expect(minimal.count((r, g, b, a) => a === 255 && r < 40 && g < 40 && b < 50)).toBeLessThan(50);
  });

  it('karaoke: highlights the word being spoken and moves on with time', () => {
    const cueWords = words('uno dos tres cuatro', 500);
    const yellow = (r: number, g: number, b: number, a: number) =>
      a > 200 && r > 220 && g > 190 && b < 120;
    const at = (tMs: number) =>
      draw('uno dos tres cuatro', { preset: 'karaoke' }, { tMs, cueWords }).bbox(yellow);
    expect(at(0)).toBeNull(); // nothing spoken yet
    const first = at(150);
    const second = at(650);
    const last = at(1700);
    if (!first || !second || !last) throw new Error('no highlighted word');
    expect(second.x0).toBeGreaterThan(first.x1);
    expect(last.x0).toBeGreaterThan(second.x1);
    // Without word timings the highlight is spread over the cue by word length.
    const plain = (tMs: number) =>
      draw('uno dos tres cuatro', { preset: 'karaoke' }, { tMs }).bbox(yellow);
    const start = plain(10);
    const end = plain(2900);
    if (!start || !end) throw new Error('no highlighted word');
    expect(end.x0).toBeGreaterThan(start.x1);
    // Other presets never use the highlight colour.
    expect(
      draw('uno dos tres cuatro', { preset: 'boxed' }, { tMs: 650, cueWords }).bbox(yellow),
    ).toBeNull();
  });

  it('positions at top, middle and bottom, and honours uppercase and colours', () => {
    const centreY = (position: 'top' | 'middle' | 'bottom') => {
      const box = draw('Hola', { position }).bbox(painted);
      if (!box) throw new Error('subtitle was not drawn');
      return { top: box.y0, bottom: box.y1, mid: (box.y0 + box.y1) / 2 };
    };
    expect(centreY('top').top).toBeGreaterThanOrEqual(Math.floor(0.07 * H));
    expect(centreY('top').top).toBeLessThan(0.07 * H + 3);
    expect(Math.abs(centreY('middle').mid - H / 2)).toBeLessThan(2);
    expect(centreY('bottom').bottom).toBeLessThanOrEqual(H - 0.07 * H);
    const lower = draw('hola', { preset: 'classic' }).bbox(white);
    const upper = draw('hola', { preset: 'classic', uppercase: true }).bbox(white);
    expect(upper?.w ?? 0).toBeGreaterThan(lower?.w ?? 0);
    expect(
      draw('Hola', { color: '#00ff00', preset: 'boxed' }).count(
        (r, g, b) => g > 220 && r < 60 && b < 60,
      ),
    ).toBeGreaterThan(50);
  });

  it('never leaves the safe area: wraps, balances, pages long cues and shrinks giant words', () => {
    const long =
      'Este es un subtítulo deliberadamente largo que no cabe en dos líneas de un vídeo vertical ni de lejos, así que debe paginarse.';
    for (const [width, height] of [
      [1280, 720],
      [720, 1280],
      [720, 720],
    ] as const) {
      const style = SubtitleStyleSchema.parse({});
      const lineHeight = style.fontSize * height * 1.3;
      const seen = new Set<string>();
      for (const tMs of [0, 700, 1400, 2100, 2900]) {
        const shot = draw(long, {}, { width, height, tMs });
        const box = shot.bbox(painted);
        if (!box) throw new Error('subtitle was not drawn');
        expect(box.x0, `${width}x${height}`).toBeGreaterThanOrEqual(Math.floor(width * 0.05));
        expect(box.x1, `${width}x${height}`).toBeLessThanOrEqual(Math.ceil(width * 0.95));
        expect(box.h, `${width}x${height}`).toBeLessThanOrEqual(
          style.maxLines * lineHeight + style.fontSize * height,
        );
        expect(box.y1).toBeLessThanOrEqual(height - style.margin * height);
        seen.add(`${box.w}x${box.h}:${shot.count(painted)}`);
      }
      expect(seen.size, `${width}x${height} pages`).toBeGreaterThan(1);
    }
    // Two-line cues are balanced rather than "full line + one word".
    const balanced = draw('Una frase de tamaño medio que ocupa dos líneas enteras', {
      preset: 'classic',
    });
    const ink = balanced.bbox(white);
    if (!ink) throw new Error('subtitle was not drawn');
    const rowWidth = (y0: number, y1: number) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let y = y0; y <= y1; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const [r, g, b, a] = balanced.px(x, y);
          if (white(r, g, b, a)) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
          }
        }
      }
      return x1 - x0;
    };
    const middle = Math.round((ink.y0 + ink.y1) / 2);
    const top = rowWidth(ink.y0, middle - 2);
    const bottom = rowWidth(middle + 2, ink.y1);
    expect(Math.min(top, bottom) / Math.max(top, bottom)).toBeGreaterThan(0.7);
    // A single word wider than the frame is scaled down, not cut.
    const giant = draw(
      'Supercalifragilisticoexpialidoso',
      { fontSize: 0.12 },
      { width: 360, height: 640 },
    ).bbox(painted);
    expect(giant?.x0 ?? -1).toBeGreaterThanOrEqual(Math.floor(360 * 0.05));
    expect(giant?.x1 ?? 9999).toBeLessThanOrEqual(Math.ceil(360 * 0.95));
  });
});

describe('subtitles and watermark in renderFrame', () => {
  const { composition, runtime, assets } = demoProject({ stubAvatars: true });
  const timeline = computeTimeline(composition, runtime);

  it('burns the cue of the current scene and nothing outside the narration', () => {
    const speaking = timeline.scenes[0]?.speechStartMs ?? 0;
    const on = shoot(composition, speaking + 1500, runtime, assets, {
      ...size,
      timeline,
      subtitles: true,
    });
    const off = shoot(composition, speaking + 1500, runtime, assets, {
      ...size,
      timeline,
      subtitles: false,
    });
    expect(diffRatio(on.data, off.data)).toBeGreaterThan(0.01);
    // Differences are confined to the subtitle band at the bottom.
    let topDiff = 0;
    for (let o = 0; o < (H * 0.6 * W * 4) / 1; o += 4) {
      if (on.data[o] !== off.data[o] || on.data[o + 1] !== off.data[o + 1]) topDiff += 1;
    }
    expect(topDiff).toBe(0);
    const before = shoot(composition, 100, runtime, assets, { ...size, timeline, subtitles: true });
    const beforeOff = shoot(composition, 100, runtime, assets, {
      ...size,
      timeline,
      subtitles: false,
    });
    expect(diffRatio(before.data, beforeOff.data)).toBe(0);
    // `composition.subtitles.enabled` is the default.
    const disabled = { ...composition, subtitles: { ...composition.subtitles, enabled: false } };
    const byDefault = shoot(disabled, speaking + 1500, runtime, assets, {
      width: W,
      height: H,
      timeline,
      subtitles: undefined,
    });
    expect(diffRatio(byDefault.data, off.data)).toBe(0);
  });

  it('draws the watermark in the bottom-right corner only when asked, clear of subtitles', () => {
    const t = (timeline.scenes[0]?.speechStartMs ?? 0) + 1500;
    const plain = shoot(composition, t, runtime, assets, { ...size, timeline });
    const marked = shoot(composition, t, runtime, assets, { ...size, timeline, watermark: true });
    let x0 = W;
    let y0 = H;
    let changed = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 4;
        if (
          plain.data[o] !== marked.data[o] ||
          plain.data[o + 1] !== marked.data[o + 1] ||
          plain.data[o + 2] !== marked.data[o + 2]
        ) {
          changed += 1;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
        }
      }
    }
    expect(changed).toBeGreaterThan(200);
    expect(x0).toBeGreaterThan(W * 0.75);
    expect(y0).toBeGreaterThan(H * 0.9);
    // Subtitles pinned to the very bottom are lifted above the watermark while it is on.
    const low = { ...composition, subtitles: { ...composition.subtitles, margin: 0 } };
    const base = shoot(low, t, runtime, assets, {
      ...size,
      timeline,
      watermark: true,
      subtitles: false,
    });
    const withSubs = shoot(low, t, runtime, assets, {
      ...size,
      timeline,
      watermark: true,
      subtitles: true,
    });
    let lowest = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 4;
        if (base.data[o] !== withSubs.data[o] || base.data[o + 2] !== withSubs.data[o + 2])
          lowest = Math.max(lowest, y);
      }
    }
    expect(lowest).toBeLessThanOrEqual(Math.ceil(H - WATERMARK_CLEARANCE * H));
    expect(lowest).toBeGreaterThan(H * 0.8);
  });
});

/* ---------- determinism and caches ---------- */

describe('determinism', () => {
  it('renders the same pixels for the same instant, whatever was drawn before', () => {
    const { composition, runtime, assets } = demoProject({ stubAvatars: true });
    const timeline = computeTimeline(composition, runtime);
    const instants = [0, 350, 4200, 8767, 9417, 13667, 17784, 20134, timeline.totalMs - 1];
    const options = { ...size, timeline, subtitles: true, watermark: true };
    clearRenderCaches();
    const forward = instants.map((t) => shoot(composition, t, runtime, assets, options).data);
    const backward = [...instants]
      .reverse()
      .map((t) => shoot(composition, t, runtime, assets, options).data)
      .reverse();
    clearRenderCaches();
    const cold = instants.map((t) => shoot(composition, t, runtime, assets, options).data);
    instants.forEach((t, i) => {
      expect(forward[i]?.equals(backward[i] ?? Buffer.alloc(0)), `t=${t} order`).toBe(true);
      expect(forward[i]?.equals(cold[i] ?? Buffer.alloc(0)), `t=${t} cold cache`).toBe(true);
    });
    // And the frames really differ from each other.
    expect(forward[1]?.equals(forward[2] ?? Buffer.alloc(0))).toBe(false);
  });

  it('is unaffected by cache eviction and reuses cached bitmaps across frames', () => {
    const { composition, runtime, assets } = demoProject({ stubAvatars: true });
    const timeline = computeTimeline(composition, runtime);
    const options = { ...size, timeline, subtitles: true };
    clearRenderCaches();
    const reference = shoot(composition, 13667, runtime, assets, options).data;
    const before = renderCacheStats();
    expect(before.entries).toBeGreaterThan(2);
    shoot(composition, 13700, runtime, assets, options);
    const after = renderCacheStats();
    expect(after.hits).toBeGreaterThan(before.hits);
    expect(after.entries).toBe(before.entries); // nothing new to rasterise 33 ms later
    try {
      // A budget that fits single bitmaps but not all of them: constant eviction, same pixels.
      setRenderCacheBudget(640 * 360 * 4 * 4 + 4096);
      clearRenderCaches();
      for (const t of [350, 4200, 9417, 17784, 20134])
        shoot(composition, t, runtime, assets, options);
      const evicting = shoot(composition, 13667, runtime, assets, options).data;
      expect(renderCacheStats().bytes).toBeLessThanOrEqual(640 * 360 * 4 * 4 + 4096);
      expect(evicting.equals(reference)).toBe(true);
      // No cache at all (nothing fits): everything is drawn directly. The picture is the
      // same up to 8-bit rounding of "draw over" versus "draw aside, then blend", and the
      // resampling of the rotated photo (filtered once and rotated, versus in one step).
      setRenderCacheBudget(64 * 1024);
      clearRenderCaches();
      const direct = shoot(composition, 13667, runtime, assets, options).data;
      expect(renderCacheStats().entries).toBe(0);
      expect(diffRatio(direct, reference, 3)).toBeLessThan(0.03);
      expect(diffRatio(direct, reference, 48)).toBeLessThan(0.003);
    } finally {
      setRenderCacheBudget(192 * 1024 * 1024);
      clearRenderCaches();
    }
  });

  it('scales with the output size (720p and 1080p are the same picture)', () => {
    const { composition, runtime, assets } = demoProject({ stubAvatars: true });
    const small = shoot(composition, 4200, runtime, assets, {
      width: 640,
      height: 360,
      subtitles: true,
    });
    const big = shoot(composition, 4200, runtime, assets, {
      width: 1280,
      height: 720,
      subtitles: true,
    });
    // Compare the big frame downsampled 2× against the small one.
    const { canvas, ctx } = createNodeCanvas(640, 360);
    const source = createNodeCanvas(1280, 720);
    const image = source.ctx.createImageData(1280, 720);
    image.data.set(big.data);
    source.ctx.putImageData(image, 0, 0);
    ctx.drawImage(source.canvas as unknown as CanvasImageSource, 0, 0, 640, 360);
    expect(diffRatio(canvasToRgba(canvas), small.data, 48)).toBeLessThan(0.02);
  });

  it('never fails on a document with nothing loaded', () => {
    const { composition, runtime } = demoProject();
    const timeline = computeTimeline(composition, runtime);
    for (let t = 0; t < timeline.totalMs; t += 1500) {
      expect(() =>
        shoot(composition, t, runtime, new MapRenderAssets(), {
          ...size,
          timeline,
          subtitles: true,
        }),
      ).not.toThrow();
    }
  });
});
