import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VISEMES, VISEME_MOUTH_SHAPES } from '@parlante/shared';
import type {
  AvatarFraming,
  MouthShape,
  PhotoLandmarks,
  SceneRuntime,
  Viseme,
} from '@parlante/shared';
import { canvasAsImage, canvasToRgba, createNodeCanvas } from '../node/index';
import type { PixelBox } from '../types';
import {
  PHOTO_STAND_IN_MOTION,
  VISEME_BLEND_MS,
  computeAvatarState,
  createPhotoAvatarRig,
  getStockAvatarRig,
  listStockAvatars,
  photoAvatarPlacement,
  restingAvatarState,
} from './index';
import type { AvatarRig, AvatarState } from './index';
import { STOCK_FRAMING_WINDOWS, stockAvatarScale } from './stock/rig';

const FRAMINGS: readonly AvatarFraming[] = ['closeup', 'bust', 'half'];
const RIGS: readonly AvatarRig[] = listStockAvatars().map((meta) => {
  const rig = getStockAvatarRig(meta.id);
  if (!rig) throw new Error(`no rig for ${meta.id}`);
  return rig;
});

function draw(
  rig: AvatarRig,
  size: { w: number; h: number },
  box: PixelBox,
  state: AvatarState,
  framing: AvatarFraming = 'bust',
  flip = false,
): Buffer {
  const { canvas, ctx } = createNodeCanvas(size.w, size.h);
  rig.draw(ctx, box, state, { framing, flip, quality: 'final' });
  return canvasToRgba(canvas);
}

const digest = (data: Buffer): string => createHash('sha1').update(data).digest('hex');

function withMouth(viseme: Viseme): AvatarState {
  return {
    ...restingAvatarState(),
    viseme,
    nextViseme: viseme,
    mouth: VISEME_MOUTH_SHAPES[viseme],
  };
}

/** Bounding box of every pixel with alpha > 0, or null when nothing was painted. */
function paintedBounds(
  data: Buffer,
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        count += 1;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return count === 0 ? null : { x0, y0, x1, y1, count };
}

/** A runtime that says every viseme of the contract, 120 ms each, between two rests. */
function allVisemesRuntime(): SceneRuntime {
  const spoken = VISEMES.filter((v) => v !== 'rest');
  const visemes = [
    { tMs: 0, viseme: 'rest' as Viseme },
    ...spoken.map((viseme, i) => ({ tMs: 100 + i * 120, viseme })),
    { tMs: 100 + spoken.length * 120, viseme: 'rest' as Viseme },
  ];
  return { audioDurationMs: 200 + spoken.length * 120, visemes, words: [] };
}

/** "Hola, bienvenidos a Parlante. ¿Empezamos?" — hand-timed, like a TTS provider returns it. */
function phraseRuntime(): SceneRuntime {
  const seq: [number, Viseme][] = [
    [0, 'rest'],
    [80, 'O'],
    [190, 'NL'],
    [260, 'A'],
    [420, 'rest'],
    [560, 'MBP'],
    [630, 'I'],
    [700, 'E'],
    [790, 'NL'],
    [850, 'MBP'],
    [910, 'E'],
    [1000, 'NL'],
    [1060, 'I'],
    [1150, 'DT'],
    [1210, 'O'],
    [1320, 'SZ'],
    [1420, 'A'],
    [1540, 'MBP'],
    [1610, 'A'],
    [1720, 'R'],
    [1780, 'NL'],
    [1850, 'A'],
    [1960, 'NL'],
    [2020, 'DT'],
    [2080, 'E'],
    [2260, 'rest'],
    [2700, 'E'],
    [2780, 'MBP'],
    [2850, 'E'],
    [2940, 'SZ'],
    [3020, 'A'],
    [3140, 'MBP'],
    [3210, 'O'],
    [3330, 'SZ'],
    [3420, 'rest'],
  ];
  return {
    audioDurationMs: 3600,
    visemes: seq.map(([tMs, viseme]) => ({ tMs, viseme })),
    words: [
      { tMs: 80, durMs: 340, text: 'Hola,' },
      { tMs: 560, durMs: 860, text: 'bienvenidos' },
      { tMs: 1420, durMs: 110, text: 'a' },
      { tMs: 1540, durMs: 720, text: 'Parlante.' },
      { tMs: 2700, durMs: 720, text: '¿Empezamos?' },
    ],
  };
}

const at = (runtime: SceneRuntime | null, speechMs: number, seed = 'scene:avatar'): AvatarState =>
  computeAvatarState({ runtime, speechMs, sceneMs: speechMs + 300, seed });

describe('stock rigs', () => {
  it('give every catalogue avatar its own character (≥ 8, balanced, all distinct)', () => {
    const metas = listStockAvatars();
    expect(metas.length).toBeGreaterThanOrEqual(8);
    const byGender = new Map<string, number>();
    for (const m of metas) byGender.set(m.gender, (byGender.get(m.gender) ?? 0) + 1);
    expect(byGender.get('female') ?? 0).toBeGreaterThanOrEqual(3);
    expect(byGender.get('male') ?? 0).toBeGreaterThanOrEqual(3);
    expect(
      Math.abs((byGender.get('female') ?? 0) - (byGender.get('male') ?? 0)),
    ).toBeLessThanOrEqual(2);
    expect(new Set(metas.map((m) => m.ageGroup))).toEqual(new Set(['young', 'adult', 'senior']));
    expect(new Set(metas.map((m) => m.traits.skin)).size).toBe(metas.length);

    const box = { x: 0, y: 0, w: 200, h: 240 };
    const frames = RIGS.map((rig) => draw(rig, { w: 200, h: 240 }, box, restingAvatarState()));
    expect(new Set(frames.map(digest)).size).toBe(RIGS.length);
    // Not just recolours: any two avatars differ in a good share of their silhouette too.
    for (let a = 0; a < frames.length; a += 1) {
      for (let b = a + 1; b < frames.length; b += 1) {
        let differentAlpha = 0;
        const fa = frames[a] as Buffer;
        const fb = frames[b] as Buffer;
        for (let i = 3; i < fa.length; i += 4) {
          if ((fa[i] ?? 0) > 127 !== (fb[i] ?? 0) > 127) differentAlpha += 1;
        }
        expect(differentAlpha, `${RIGS[a]?.id} vs ${RIGS[b]?.id}`).toBeGreaterThan(200);
      }
    }
  });

  it('draw the same pixels for the same arguments (pure, no state between frames)', () => {
    const runtime = phraseRuntime();
    const box = { x: 20, y: 10, w: 220, h: 260 };
    for (const rig of RIGS) {
      const talking = at(runtime, 1450);
      const first = digest(draw(rig, { w: 260, h: 280 }, box, talking));
      // Draw other poses in between: nothing may leak from one frame into the next.
      draw(rig, { w: 260, h: 280 }, box, at(runtime, 300), 'half', true);
      draw(rig, { w: 260, h: 280 }, box, restingAvatarState(5000), 'closeup');
      expect(digest(draw(rig, { w: 260, h: 280 }, box, at(runtime, 1450))), rig.id).toBe(first);
      expect(digest(draw(rig, { w: 260, h: 280 }, box, at(runtime, 1500))), rig.id).not.toBe(first);
    }
  });

  it('draw a distinct mouth for each of the 15 visemes', () => {
    const size = { w: 240, h: 240 };
    const box = { x: 0, y: 0, w: 240, h: 240 };
    for (const rig of RIGS) {
      const frames = new Map<Viseme, Buffer>();
      for (const viseme of VISEMES)
        frames.set(viseme, draw(rig, size, box, withMouth(viseme), 'closeup'));
      expect(new Set([...frames.values()].map(digest)).size, rig.id).toBe(VISEMES.length);
      // The change is confined to the lower face: nothing above the eyes moves with the mouth.
      const rest = frames.get('rest') as Buffer;
      const open = frames.get('A') as Buffer;
      let top = 0;
      let bottom = 0;
      for (let y = 0; y < size.h; y += 1) {
        for (let x = 0; x < size.w; x += 1) {
          const i = (y * size.w + x) * 4;
          if (rest[i] !== open[i] || rest[i + 1] !== open[i + 1] || rest[i + 2] !== open[i + 2]) {
            if (y < size.h * 0.4) top += 1;
            else bottom += 1;
          }
        }
      }
      expect(top, rig.id).toBe(0);
      expect(bottom, rig.id).toBeGreaterThan(150);
    }
  });

  it('show teeth, tongue and a dark opening where the viseme calls for them', () => {
    const rig = getStockAvatarRig('stock_lucia') as AvatarRig;
    const size = { w: 400, h: 400 };
    const box = { x: 0, y: 0, w: 400, h: 400 };
    // Count near-white (teeth) and very dark (cavity) pixels around the mouth.
    const mouthStats = (viseme: Viseme): { white: number; dark: number } => {
      const data = draw(rig, size, box, withMouth(viseme), 'closeup');
      const u = stockAvatarScale(box, 'closeup');
      const chinY = box.h - STOCK_FRAMING_WINDOWS.closeup.bottom * u;
      let white = 0;
      let dark = 0;
      for (let y = Math.round(chinY - 0.3 * u); y < Math.round(chinY - 0.07 * u); y += 1) {
        for (let x = Math.round(200 - 0.14 * u); x < Math.round(200 + 0.14 * u); x += 1) {
          const i = (y * size.w + x) * 4;
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          if (r > 205 && g > 195 && b > 185) white += 1;
          if (r < 95 && g < 32 && b < 40) dark += 1;
        }
      }
      return { white, dark };
    };
    expect(mouthStats('rest')).toEqual({ white: 0, dark: 0 });
    expect(mouthStats('MBP')).toEqual({ white: 0, dark: 0 });
    expect(mouthStats('SZ').white).toBeGreaterThan(20);
    expect(mouthStats('SZ').dark).toBe(0);
    expect(mouthStats('FV').white).toBeGreaterThan(20);
    expect(mouthStats('A').dark).toBeGreaterThan(mouthStats('E').dark);
    expect(mouthStats('E').dark).toBeGreaterThan(0);
    expect(mouthStats('O').white).toBe(0);
    expect(mouthStats('U').white).toBe(0);
    expect(mouthStats('O').dark).toBeGreaterThan(mouthStats('U').dark);
  });

  it('stay inside their box, anchored to its bottom centre, in every framing', () => {
    const size = { w: 360, h: 300 };
    const boxes: PixelBox[] = [
      { x: 60, y: 40, w: 200, h: 220 }, // typical
      { x: 30, y: 100, w: 300, h: 120 }, // wide
      { x: 140, y: 20, w: 90, h: 260 }, // tall and narrow
    ];
    const states = [restingAvatarState(), at(phraseRuntime(), 1450), at(phraseRuntime(), 1850)];
    for (const rig of RIGS) {
      for (const framing of FRAMINGS) {
        for (const box of boxes) {
          for (const flip of [false, true]) {
            const state = states[(box.w + (flip ? 1 : 0)) % states.length] as AvatarState;
            const data = draw(rig, size, box, state, framing, flip);
            const label = `${rig.id} ${framing} ${box.w}x${box.h} flip=${flip}`;
            const bounds = paintedBounds(data, size.w, size.h);
            expect(bounds, label).not.toBeNull();
            if (!bounds) continue;
            // Nothing outside the box (the canvas is transparent there).
            expect(bounds.x0, label).toBeGreaterThanOrEqual(box.x);
            expect(bounds.y0, label).toBeGreaterThanOrEqual(box.y);
            expect(bounds.x1, label).toBeLessThan(box.x + box.w);
            expect(bounds.y1, label).toBeLessThan(box.y + box.h);
            // Anchored: the figure reaches the bottom edge, right under the box centre.
            expect(bounds.y1, label).toBe(box.y + box.h - 1);
            const bottomCentre = ((box.y + box.h - 1) * size.w + Math.round(box.x + box.w / 2)) * 4;
            expect(data[bottomCentre + 3], label).toBe(255);
            // Centred: the painted area is balanced around the box centre.
            const centre = (bounds.x0 + bounds.x1 + 1) / 2;
            expect(Math.abs(centre - (box.x + box.w / 2)), label).toBeLessThan(box.w * 0.12);
            // And it is a real figure, not a sliver.
            expect(bounds.count, label).toBeGreaterThan(box.w * box.h * 0.12);
          }
        }
      }
    }
  });

  it('frame closer from half to bust to closeup, with the face always in view', () => {
    const box = { x: 0, y: 0, w: 300, h: 400 };
    const scales = FRAMINGS.map((f) => stockAvatarScale(box, f));
    expect(scales[0]).toBeGreaterThan(scales[1] as number);
    expect(scales[1]).toBeGreaterThan(scales[2] as number);
    for (const framing of FRAMINGS) {
      // Eye line and chin (character y = -0.45 and 0) land inside the box, eyes in its upper
      // half: the face is never cropped, whatever the hair does.
      const u = stockAvatarScale(box, framing);
      const chinY = box.h - STOCK_FRAMING_WINDOWS[framing].bottom * u;
      const eyeY = chinY - 0.45 * u;
      expect(eyeY, framing).toBeGreaterThan(box.h * 0.12);
      expect(eyeY, framing).toBeLessThan(box.h * 0.55);
      expect(chinY, framing).toBeLessThan(box.h * 0.85);
    }
    for (const rig of RIGS) {
      for (const framing of ['bust', 'half'] as const) {
        const data = draw(rig, { w: 300, h: 400 }, box, restingAvatarState(), framing);
        const bounds = paintedBounds(data, 300, 400);
        // The whole hairdo fits with headroom (only `closeup` may crop voluminous hair).
        expect(bounds?.y0 ?? 0, `${rig.id} ${framing}`).toBeGreaterThan(2);
      }
    }
    // A circle mask on a square closeup shows the face: its centre is skin, not hair or shirt.
    const square = { x: 0, y: 0, w: 240, h: 240 };
    const lucia = draw(
      getStockAvatarRig('stock_lucia') as AvatarRig,
      { w: 240, h: 240 },
      square,
      restingAvatarState(),
      'closeup',
    );
    const centre = (120 * 240 + 120) * 4;
    expect([lucia[centre], lucia[centre + 1], lucia[centre + 2]]).toEqual(
      [0xe2, 0xb0, 0x8c].map((c) => expect.closeTo(c, -1.5)),
    );
  });

  it('survive degenerate boxes without throwing or painting', () => {
    const rig = RIGS[0] as AvatarRig;
    for (const box of [
      { x: 10, y: 10, w: 0, h: 50 },
      { x: 10, y: 10, w: 50, h: 0 },
      { x: 10, y: 10, w: -5, h: 20 },
    ]) {
      const data = draw(rig, { w: 80, h: 80 }, box, restingAvatarState());
      expect(paintedBounds(data, 80, 80)).toBeNull();
    }
    // A tiny box still paints something sensible.
    const tiny = draw(rig, { w: 40, h: 40 }, { x: 10, y: 10, w: 16, h: 16 }, restingAvatarState());
    expect(paintedBounds(tiny, 40, 40)?.count ?? 0).toBeGreaterThan(20);
  });

  it('render one 720p avatar frame far below 10 ms', () => {
    const { ctx } = createNodeCanvas(1280, 720);
    const runtime = phraseRuntime();
    // A typical presenter layer and a full-frame one (the heaviest case).
    const boxes: PixelBox[] = [
      { x: 704, y: 58, w: 512, h: 662 },
      { x: 0, y: 0, w: 1280, h: 720 },
    ];
    const frame = (rig: AvatarRig, box: PixelBox, i: number, framing: AvatarFraming): void => {
      const speechMs = (i * 1000) / 30;
      const state = computeAvatarState({
        runtime,
        speechMs,
        sceneMs: speechMs + 300,
        seed: 'perf:avatar',
      });
      rig.draw(ctx, box, state, { framing, flip: false, quality: 'final' });
      // Skia defers rasterisation: reading a pixel back forces the frame to be really drawn
      // inside the timed section (and adds the cost of the read-back itself, ~0.5 ms).
      ctx.getImageData(640, 400, 1, 1);
    };
    const medians: number[] = [];
    for (const rig of RIGS) {
      for (const box of boxes) {
        for (let i = 0; i < 20; i += 1) frame(rig, box, i, 'bust'); // warm-up
        const samples: number[] = [];
        for (let i = 0; i < 90; i += 1) {
          ctx.clearRect(0, 0, 1280, 720);
          const start = performance.now();
          frame(rig, box, i, FRAMINGS[i % 3] as AvatarFraming);
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        medians.push(samples[45] as number);
      }
    }
    const worst = Math.max(...medians);
    const mean = medians.reduce((a, b) => a + b, 0) / medians.length;
    // Measured on the shared 4-core build machine: about 3 ms per frame (state + draw +
    // rasterisation + read-back), 4 ms for the heaviest rig in a full-frame closeup.
    expect(worst, `worst median ${worst.toFixed(2)} ms`).toBeLessThan(10);
    expect(mean, `mean of medians ${mean.toFixed(2)} ms`).toBeLessThan(6);
  });
});

describe('computeAvatarState', () => {
  it('is a pure function of its input and varies with the seed', () => {
    const runtime = phraseRuntime();
    for (const t of [-200, 0, 137, 640, 1450, 2100, 3599, 3600, 9000]) {
      expect(at(runtime, t)).toEqual(at(runtime, t));
      expect(JSON.stringify(at(runtime, t))).toBe(JSON.stringify(at(phraseRuntime(), t)));
    }
    // Order of evaluation does not matter (no hidden state).
    const forward = [100, 900, 1700].map((t) => at(runtime, t));
    const backward = [1700, 900, 100].map((t) => at(runtime, t)).reverse();
    expect(forward).toEqual(backward);
    // Two avatars in the same scene move on their own rhythm but say the same thing.
    const a = at(runtime, 1450, 'scene:left');
    const b = at(runtime, 1450, 'scene:right');
    expect(a.mouth).toEqual(b.mouth);
    expect(a.head).not.toEqual(b.head);
  });

  it('covers every viseme of the contract and reaches each shape at its cue', () => {
    const runtime = allVisemesRuntime();
    const seen = new Set<Viseme>();
    for (const cue of runtime.visemes) {
      const state = at(runtime, cue.tMs);
      seen.add(state.viseme);
      expect(state.viseme).toBe(cue.viseme);
      const canon = VISEME_MOUTH_SHAPES[cue.viseme];
      // Teeth and tongue are the viseme's own; lips and jaw may lean towards the neighbours.
      expect(state.mouth.teeth).toBeCloseTo(canon.teeth, 6);
      expect(state.mouth.tongue).toBeCloseTo(canon.tongue, 6);
      expect(Math.abs(state.mouth.open - canon.open)).toBeLessThan(0.25);
      expect(Math.abs(state.mouth.width - canon.width)).toBeLessThan(0.5);
    }
    expect(seen).toEqual(new Set(VISEMES));
    // Closures stay closed whatever surrounds them.
    const mbp = runtime.visemes.find((c) => c.viseme === 'MBP');
    expect(at(runtime, mbp?.tMs ?? 0).mouth.open).toBe(0);
  });

  it('keeps every mouth parameter in range at any time', () => {
    for (const runtime of [allVisemesRuntime(), phraseRuntime()]) {
      for (let t = -300; t < runtime.audioDurationMs + 900; t += 7) {
        const { mouth, blend } = at(runtime, t);
        for (const key of ['open', 'round', 'teeth', 'tongue'] as const) {
          expect(mouth[key]).toBeGreaterThanOrEqual(0);
          expect(mouth[key]).toBeLessThanOrEqual(1);
        }
        expect(mouth.width).toBeGreaterThanOrEqual(-1);
        expect(mouth.width).toBeLessThanOrEqual(1);
        expect(blend).toBeGreaterThanOrEqual(0);
        expect(blend).toBeLessThanOrEqual(1);
      }
    }
  });

  it('moves the mouth continuously (no pops between frames)', () => {
    const runtime = phraseRuntime();
    let previous: MouthShape | null = null;
    let worst = 0;
    for (let t = -100; t <= runtime.audioDurationMs + 300; t += 1) {
      const { mouth } = at(runtime, t);
      if (previous) {
        worst = Math.max(
          worst,
          Math.abs(mouth.open - previous.open),
          Math.abs(mouth.width - previous.width) / 2,
          Math.abs(mouth.teeth - previous.teeth),
        );
      }
      previous = mouth;
    }
    // Fastest legitimate travel: a full parameter swing eased over ~45 ms.
    expect(worst).toBeLessThan(0.05);
    expect(VISEME_BLEND_MS).toBeGreaterThanOrEqual(60);
  });

  it('co-articulates: consonants take the lip shape of the vowel they lead into', () => {
    const syllable = (vowel: Viseme): SceneRuntime => ({
      audioDurationMs: 600,
      visemes: [
        { tMs: 0, viseme: 'rest' },
        { tMs: 100, viseme: 'SZ' },
        { tMs: 220, viseme: vowel },
        { tMs: 480, viseme: 'rest' },
      ],
      words: [],
    });
    const su = at(syllable('U'), 110).mouth;
    const si = at(syllable('I'), 110).mouth;
    expect(su.width).toBeLessThan(0);
    expect(su.round).toBeGreaterThan(0.3);
    expect(si.width).toBeGreaterThan(VISEME_MOUTH_SHAPES.SZ.width);
    expect(si.round).toBe(0);
    // The teeth stay together for the sibilant either way.
    expect(su.teeth).toBe(1);
    expect(si.teeth).toBe(1);
  });

  it('undershoots very short sounds instead of flapping', () => {
    const vowel = (durMs: number): number =>
      at(
        {
          audioDurationMs: 800,
          visemes: [
            { tMs: 0, viseme: 'rest' },
            { tMs: 100, viseme: 'MBP' },
            { tMs: 200, viseme: 'A' },
            { tMs: 200 + durMs, viseme: 'MBP' },
            { tMs: 700, viseme: 'rest' },
          ],
          words: [],
        },
        200,
      ).mouth.open;
    expect(vowel(200)).toBeGreaterThan(0.85);
    expect(vowel(30)).toBeLessThan(vowel(200) * 0.8);
    expect(vowel(30)).toBeGreaterThan(0.4);
  });

  it('closes the mouth when the audio ends, even without a final rest cue', () => {
    const runtime: SceneRuntime = {
      audioDurationMs: 500,
      visemes: [
        { tMs: 0, viseme: 'rest' },
        { tMs: 100, viseme: 'A' },
      ],
      words: [],
    };
    expect(at(runtime, 300).mouth.open).toBeGreaterThan(0.8);
    expect(at(runtime, 499).mouth.open).toBeLessThan(0.02);
    expect(at(runtime, 500)).toMatchObject({ speaking: false, viseme: 'rest' });
    expect(at(runtime, 500).mouth).toEqual(VISEME_MOUTH_SHAPES.rest);
    expect(at(runtime, -1).mouth).toEqual(VISEME_MOUTH_SHAPES.rest);
  });

  it('starts every scene from a clean neutral pose', () => {
    const state = computeAvatarState({ runtime: null, speechMs: -1, sceneMs: 0, seed: 'any' });
    expect(state.head).toEqual({ nod: 0, turn: 0, tilt: 0 });
    expect(state.gaze.x).toBeCloseTo(0, 10);
    expect(state.gaze.y).toBeCloseTo(0, 10);
    expect(state.blink).toBe(0);
    expect(state.mouth).toEqual(VISEME_MOUTH_SHAPES.rest);
    expect(restingAvatarState()).toMatchObject({ speaking: false, viseme: 'rest', blink: 0 });
  });

  it('stays alive and natural in silence: blinks, breathes and drifts', () => {
    const states: AvatarState[] = [];
    for (let t = 0; t < 30_000; t += 1000 / 30) {
      states.push(computeAvatarState({ runtime: null, speechMs: -1, sceneMs: t, seed: 's1:a1' }));
    }
    // Blinks: several in 30 s, short (eyes closed a small share of the time), irregular.
    const starts: number[] = [];
    states.forEach((s, i) => {
      if (s.blink > 0.5 && (states[i - 1]?.blink ?? 0) <= 0.5) starts.push(i / 30);
    });
    expect(starts.length).toBeGreaterThanOrEqual(6);
    expect(starts.length).toBeLessThanOrEqual(16);
    expect(states.filter((s) => s.blink > 0.5).length / states.length).toBeLessThan(0.08);
    expect(Math.max(...states.map((s) => s.blink))).toBeGreaterThan(0.95);
    const gaps = starts.slice(1).map((s, i) => s - (starts[i] as number));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(0.8);
    // Breathing covers its whole range, smoothly.
    const breaths = states.map((s) => s.breath);
    expect(Math.min(...breaths)).toBeLessThan(0.05);
    expect(Math.max(...breaths)).toBeGreaterThan(0.95);
    // The head moves, but gently and without jumps from one frame to the next.
    const turns = states.map((s) => s.head.turn);
    expect(Math.max(...turns) - Math.min(...turns)).toBeGreaterThan(0.1);
    for (let i = 1; i < states.length; i += 1) {
      const a = states[i - 1] as AvatarState;
      const b = states[i] as AvatarState;
      expect(Math.abs(b.head.turn - a.head.turn)).toBeLessThan(0.03);
      expect(Math.abs(b.head.nod - a.head.nod)).toBeLessThan(0.03);
      expect(Math.abs(b.head.tilt - a.head.tilt)).toBeLessThan(0.03);
      expect(Math.abs(b.breath - a.breath)).toBeLessThan(0.05);
    }
    for (const s of states) {
      expect(s.speaking).toBe(false);
      expect(s.mouth).toEqual(VISEME_MOUTH_SHAPES.rest);
      for (const v of [s.head.nod, s.head.turn, s.head.tilt, s.gaze.x, s.gaze.y, s.brow ?? 0]) {
        expect(Math.abs(v)).toBeLessThanOrEqual(1);
      }
      // Relaxed, lightly smiling, mostly looking at the camera.
      expect(s.smile).toBeCloseTo(0.5, 6);
    }
    expect(
      states.filter((s) => Math.hypot(s.gaze.x, s.gaze.y) < 0.2).length / states.length,
    ).toBeGreaterThan(0.6);
  });

  it('gestures with the words: brows and a nod on stressed words, calmer when silent', () => {
    const runtime = phraseRuntime();
    // "Hola," opens the sentence → brow flash right at its onset.
    expect(at(runtime, 130).brow ?? 0).toBeGreaterThan(0.4);
    // The question keeps the brows up through its last word.
    expect(at(runtime, 3100).brow ?? 0).toBeGreaterThan(0.4);
    // Long after the audio: relaxed again.
    expect(Math.abs(at(runtime, 6000).brow ?? 0)).toBeLessThan(0.1);
    // More head movement while talking than while idle (same seed, same times).
    const range = (rt: SceneRuntime | null): number => {
      let energy = 0;
      for (let t = 0; t < 3600; t += 33)
        energy += Math.abs(at(rt, t).head.nod) + Math.abs(at(rt, t).head.turn);
      return energy;
    };
    expect(range(runtime)).toBeGreaterThan(range(null) * 1.3);
    // The smile gives way to articulation while speaking and comes back afterwards.
    expect(at(runtime, 1500).smile ?? 0).toBeLessThan(at(runtime, 6000).smile ?? 0);
  });
});

describe('photo stand-in rig', () => {
  const LANDMARKS: PhotoLandmarks = {
    leftEye: { x: 0.4, y: 0.35 },
    rightEye: { x: 0.6, y: 0.35 },
    mouthLeft: { x: 0.44, y: 0.55 },
    mouthRight: { x: 0.56, y: 0.55 },
    chin: { x: 0.5, y: 0.65 },
  };
  /** Opaque flat "portrait" (a skin-like colour everywhere), 400 × 400. */
  function portrait(): ReturnType<typeof canvasAsImage> {
    const { canvas, ctx } = createNodeCanvas(400, 400);
    ctx.fillStyle = '#d8a888';
    ctx.fillRect(0, 0, 400, 400);
    return canvasAsImage(canvas);
  }
  const rigFor = (source: 'detected' | 'user' | 'estimated'): AvatarRig =>
    createPhotoAvatarRig('avt_test', portrait(), {
      imageWidth: 400,
      imageHeight: 400,
      landmarks: LANDMARKS,
      landmarksSource: source,
    });
  const box: PixelBox = { x: 40, y: 30, w: 300, h: 400 };
  const size = { w: 380, h: 460 };

  it('stays inside the box and within a couple of pixels of the clip placement', () => {
    const rig = rigFor('detected');
    const runtime = phraseRuntime();
    for (const framing of FRAMINGS) {
      const place = photoAvatarPlacement(400, 400, box, framing, LANDMARKS);
      const expected = {
        x0: Math.max(box.x, place.x),
        y0: Math.max(box.y, place.y),
        x1: Math.min(box.x + box.w, place.x + place.w),
      };
      for (let t = 0; t < 4000; t += 211) {
        const data = draw(rig, size, box, at(runtime, t), framing);
        const bounds = paintedBounds(data, size.w, size.h);
        expect(bounds).not.toBeNull();
        if (!bounds) continue;
        expect(bounds.x0).toBeGreaterThanOrEqual(box.x);
        expect(bounds.y0).toBeGreaterThanOrEqual(box.y);
        expect(bounds.x1).toBeLessThan(box.x + box.w);
        // Never a gap under the portrait.
        expect(bounds.y1).toBe(box.y + box.h - 1);
        const slack =
          1.5 + Math.max(PHOTO_STAND_IN_MOTION.breath * box.h, PHOTO_STAND_IN_MOTION.sway * box.w);
        expect(Math.abs(bounds.x0 - expected.x0)).toBeLessThanOrEqual(slack);
        expect(Math.abs(bounds.y0 - expected.y0)).toBeLessThanOrEqual(slack);
        expect(Math.abs(bounds.x1 + 1 - expected.x1)).toBeLessThanOrEqual(slack);
      }
    }
  });

  it('is pure and shows speech as a soft shade between the lips, without touching the rest', () => {
    const rig = rigFor('detected');
    const closed = draw(rig, size, box, withMouth('rest'), 'half');
    const open = draw(rig, size, box, withMouth('A'), 'half');
    expect(digest(draw(rig, size, box, withMouth('A'), 'half'))).toBe(digest(open));
    const place = photoAvatarPlacement(400, 400, box, 'half', LANDMARKS);
    const mx = place.x + 0.5 * place.w;
    const my = place.y + 0.55 * place.h;
    const mouthWidth = 0.12 * place.w;
    let changedNear = 0;
    let changedFar = 0;
    for (let y = 0; y < size.h; y += 1) {
      for (let x = 0; x < size.w; x += 1) {
        const i = (y * size.w + x) * 4;
        if (closed[i] === open[i] && closed[i + 1] === open[i + 1] && closed[i + 2] === open[i + 2])
          continue;
        if (Math.abs(x - mx) <= mouthWidth * 0.6 && Math.abs(y - my) <= mouthWidth * 0.4)
          changedNear += 1;
        else changedFar += 1;
      }
    }
    expect(changedNear).toBeGreaterThan(30);
    expect(changedFar).toBe(0);
    // Darker at the lips, and never an opaque blot: the photo still shows through.
    const centre = (Math.round(my + 2) * size.w + Math.round(mx)) * 4;
    expect(open[centre] as number).toBeLessThan(closed[centre] as number);
    expect(open[centre] as number).toBeGreaterThan(50);
  });

  it('draws no mouth cue when the landmarks are only estimated', () => {
    const rig = rigFor('estimated');
    expect(digest(draw(rig, size, box, withMouth('A'), 'bust'))).toBe(
      digest(draw(rig, size, box, withMouth('rest'), 'bust')),
    );
  });
});
