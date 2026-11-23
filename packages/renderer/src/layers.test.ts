import { beforeAll, describe, expect, it } from 'vitest';
import { TextStyleSchema, createComposition } from '@parlante/shared';
import type { Composition, NewLayerInput, NewSceneInput, RenderRuntime } from '@parlante/shared';
import {
  MapRenderAssets,
  clearRenderCaches,
  layerPoseAt,
  layoutTextBlock,
  wrapText,
} from './index';
import type { RenderImage } from './index';
import {
  canvasAsImage,
  createNodeCanvas,
  createRawVideoSource,
  registerNodeFonts,
} from './node/index';
import { diffRatio, near, shoot, stubRig } from './testing/pixels';
import type { Rgb } from './testing/pixels';

const BG: Rgb = [16, 19, 34]; // default scene background #101322
const RED: Rgb = [255, 0, 0];
const W = 640;
const H = 360;

function one(layers: NewLayerInput[], scene: Partial<NewSceneInput> = {}): Composition {
  return createComposition({
    scenes: [{ id: 's', duration: { mode: 'fixed', seconds: 4 }, layers, ...scene }],
  });
}

const size = { width: W, height: H };
const full = { x: 0, y: 0, w: 1, h: 1 };

/** 200×100 image: left half red, right half blue, with a green 20 px frame at the very top. */
function twoTone(): RenderImage {
  const { canvas, ctx } = createNodeCanvas(200, 100);
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(100, 0, 100, 100);
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, 200, 20);
  return canvasAsImage(canvas);
}

const PIC = { source: 'stock' as const, stockId: 'pic' };
const CLIP = { source: 'stock' as const, stockId: 'clip' };
const withPic = () => new MapRenderAssets().setImage('stock:pic', twoTone());

/** Video whose frame `i` is a flat colour (i × 8, 0, 255 − i × 8): the frame index is readable. */
function indexedVideo(frameCount = 30, fps = 30) {
  const asked: number[] = [];
  const source = createRawVideoSource({
    width: 8,
    height: 8,
    fps,
    frameCount,
    readFrame: (index) => {
      asked.push(index);
      const pixels = new Uint8Array(8 * 8 * 4);
      for (let o = 0; o < pixels.length; o += 4) {
        pixels[o] = index * 8;
        pixels[o + 2] = 255 - index * 8;
        pixels[o + 3] = 255;
      }
      return pixels;
    },
  });
  return { source, asked };
}

beforeAll(() => {
  registerNodeFonts();
});

describe('backgrounds', () => {
  it('fills a colour and never leaves the frame translucent', () => {
    const solid = shoot(
      one([], { background: { type: 'color', color: '#336699' } }),
      0,
      undefined,
      undefined,
      size,
    );
    expect(solid.px(5, 5)).toEqual([0x33, 0x66, 0x99, 255]);
    expect(solid.count((_r, _g, _b, a) => a !== 255)).toBe(0);
    const half = shoot(
      one([], { background: { type: 'color', color: '#ffffff80' } }),
      0,
      undefined,
      undefined,
      size,
    );
    expect(half.px(5, 5)[3]).toBe(255);
    expect(half.px(5, 5)[0]).toBeGreaterThan(120);
    expect(half.px(5, 5)[0]).toBeLessThan(136);
  });

  it('draws linear gradients along the CSS gradient line and radial ones from the centre', () => {
    const gradient = (angle: number, kind: 'linear' | 'radial' = 'linear') =>
      shoot(
        one([], {
          background: {
            type: 'gradient',
            gradient: {
              kind,
              angle,
              stops: [
                { offset: 0, color: '#ff0000' },
                { offset: 1, color: '#0000ff' },
              ],
            },
          },
        }),
        0,
        undefined,
        undefined,
        size,
      );
    const leftRight = gradient(0);
    expect(near(RED, 4)(...(leftRight.px(0, H / 2).slice(0, 3) as Rgb))).toBe(true);
    expect(near([0, 0, 255], 4)(...(leftRight.px(W - 1, H / 2).slice(0, 3) as Rgb))).toBe(true);
    expect(leftRight.px(W / 2, 10)).toEqual(leftRight.px(W / 2, H - 10)); // no vertical change
    const topBottom = gradient(90);
    expect(near(RED, 4)(...(topBottom.px(W / 2, 0).slice(0, 3) as Rgb))).toBe(true);
    expect(near([0, 0, 255], 4)(...(topBottom.px(W / 2, H - 1).slice(0, 3) as Rgb))).toBe(true);
    // Diagonal: the first and last stops land exactly on opposite corners.
    const diagonal = gradient(45);
    expect(near(RED, 6)(...(diagonal.px(0, 0).slice(0, 3) as Rgb))).toBe(true);
    expect(near([0, 0, 255], 6)(...(diagonal.px(W - 1, H - 1).slice(0, 3) as Rgb))).toBe(true);
    const radial = gradient(0, 'radial');
    expect(near(RED, 6)(...(radial.px(W / 2, H / 2).slice(0, 3) as Rgb))).toBe(true);
    expect(near([0, 0, 255], 8)(...(radial.px(0, 0).slice(0, 3) as Rgb))).toBe(true);
  });

  it('fits image backgrounds: cover crops, contain letterboxes on black, fill stretches', () => {
    const bg = (fit: 'cover' | 'contain' | 'fill', width: number, height: number) =>
      shoot(one([], { background: { type: 'image', src: PIC, fit } }), 0, undefined, withPic(), {
        width,
        height,
      });
    // 2:1 image on a 1:1 frame.
    const cover = bg('cover', 200, 200);
    expect(cover.count(near([0, 0, 0], 2))).toBe(0);
    expect(near(RED)(...(cover.px(10, 120).slice(0, 3) as Rgb))).toBe(true); // centre crop: red | blue
    expect(near([0, 0, 255])(...(cover.px(190, 120).slice(0, 3) as Rgb))).toBe(true);
    const contain = bg('contain', 200, 200);
    expect(contain.px(100, 10)).toEqual([0, 0, 0, 255]); // bar above
    expect(contain.px(100, 190)).toEqual([0, 0, 0, 255]); // bar below
    expect(near(RED)(...(contain.px(20, 110).slice(0, 3) as Rgb))).toBe(true);
    expect(near([0, 255, 0])(...(contain.px(20, 54).slice(0, 3) as Rgb))).toBe(true); // green band kept
    const fill = bg('fill', 200, 200);
    expect(near([0, 255, 0])(...(fill.px(20, 10).slice(0, 3) as Rgb))).toBe(true);
    expect(near(RED)(...(fill.px(20, 190).slice(0, 3) as Rgb))).toBe(true);
  });

  it('blurs without darkening the frame edges, and dims', () => {
    const bg = (blur: number, dim: number) =>
      shoot(
        one([], { background: { type: 'image', src: PIC, fit: 'fill', blur, dim } }),
        0,
        undefined,
        withPic(),
        size,
      );
    const sharp = bg(0, 0);
    const blurred = bg(0.05, 0);
    // The red | blue edge is at x = W / 2: sharp is pure on both sides, blurred is a mix.
    expect(near(RED, 3)(...(sharp.px(W / 2 - 6, 200).slice(0, 3) as Rgb))).toBe(true);
    const mixed = blurred.px(W / 2 - 6, 200);
    expect(mixed[0]).toBeLessThan(200);
    expect(mixed[2]).toBeGreaterThan(55);
    // Corners keep their colour (no black halo pulled in from outside the picture).
    expect(blurred.px(1, H - 2)[0]).toBeGreaterThan(245);
    expect(blurred.px(W - 2, H - 2)[2]).toBeGreaterThan(245);
    expect(blurred.count((_r, _g, _b, a) => a !== 255)).toBe(0);
    const dimmed = bg(0, 0.5);
    expect(dimmed.px(10, 200)[0]).toBeGreaterThan(120);
    expect(dimmed.px(10, 200)[0]).toBeLessThan(136);
  });

  it('samples video backgrounds with the media clock (trim, loop, clamp) and dims them', () => {
    const { source, asked } = indexedVideo(30);
    const assets = new MapRenderAssets().setVideo('stock:clip', source);
    const at = (tMs: number, loop: boolean) => {
      asked.length = 0;
      const shot = shoot(
        one([], { background: { type: 'video', src: CLIP, trimStartMs: 200, loop, fit: 'fill' } }),
        tMs,
        undefined,
        assets,
        size,
      );
      return { index: asked.at(-1), red: shot.px(50, 50)[0] };
    };
    expect(at(0, true)).toEqual({ index: 6, red: 48 }); // 200 ms → frame 6
    expect(at(500, true)).toEqual({ index: 21, red: 168 });
    expect(at(1000, true).red).toBe(6 * 8); // 1200 ms wraps to 200 ms on a 1 s clip
    expect(at(3000, false).red).toBe(29 * 8); // clamped to the last frame
    const dimmed = shoot(
      one([], { background: { type: 'video', src: CLIP, loop: false, fit: 'fill', dim: 0.5 } }),
      3900,
      undefined,
      assets,
      size,
    );
    expect(dimmed.px(50, 50)[0]).toBeGreaterThan(110);
    expect(dimmed.px(50, 50)[0]).toBeLessThan(122);
  });

  it('draws a neutral placeholder for missing media instead of failing', () => {
    const missing = shoot(
      one([], { background: { type: 'image', src: PIC } }),
      0,
      undefined,
      undefined,
      size,
    );
    expect(missing.px(W / 2, 30)).toEqual([0x2a, 0x2f, 0x45, 255]);
    const layer = shoot(
      one([{ id: 'v', type: 'video', src: CLIP, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }]),
      0,
      undefined,
      undefined,
      size,
    );
    expect(layer.px(W / 2, H * 0.3)).toEqual([0x2a, 0x2f, 0x45, 255]);
    expect(layer.px(10, 10).slice(0, 3)).toEqual(BG);
  });
});

describe('text layers', () => {
  const style = (overrides: Record<string, unknown> = {}) =>
    TextStyleSchema.parse({ fontSize: 0.08, ...overrides });
  const isInk = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
  const text = (
    content: string,
    overrides: Record<string, unknown> = {},
    box = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
  ) =>
    shoot(
      one([{ id: 't', type: 'text', text: content, box, style: { fontSize: 0.08, ...overrides } }]),
      0,
      undefined,
      undefined,
      size,
    );

  it('wraps by measured width, splits words that cannot fit and keeps explicit breaks', () => {
    const mono = (s: string) => s.length * 10;
    expect(wrapText('uno dos tres cuatro', 80, mono)).toEqual(['uno dos', 'tres', 'cuatro']);
    expect(wrapText('a   b\n\nc', 100, mono)).toEqual(['a b', '', 'c']);
    expect(wrapText('abcdefghijkl xy', 50, mono)).toEqual(['abcde', 'fghij', 'kl xy']);
    expect(wrapText('', 50, mono)).toEqual(['']);
    expect(wrapText('€€€', 5, mono)).toEqual(['€', '€', '€']); // never loops on an impossible fit
  });

  it('lays every line out inside the box width', () => {
    const { ctx } = createNodeCanvas(W, H);
    const long = 'Un texto bastante largo que necesita varias líneas para caber dentro de su caja';
    for (const fontFamily of ['Inter', 'Poppins', 'Playfair Display', 'JetBrains Mono'] as const) {
      const block = layoutTextBlock(ctx, long, style({ fontFamily }), 300, 200, H);
      expect(block.lines.length).toBeGreaterThan(2);
      for (const line of block.lines) {
        expect(line.width).toBeLessThanOrEqual(300);
        expect(line.x).toBeGreaterThanOrEqual(-0.01);
        expect(line.x + line.width).toBeLessThanOrEqual(300.01);
      }
      expect(block.lines.map((line) => line.text).join(' ')).toBe(long);
    }
    // Same layout at twice the resolution: only the scale changes.
    const small = layoutTextBlock(ctx, long, style(), 300, 200, 360);
    const big = layoutTextBlock(ctx, long, style(), 600, 400, 720);
    expect(big.lines.map((l) => l.text)).toEqual(small.lines.map((l) => l.text));
  });

  it('aligns horizontally and vertically inside the box', () => {
    const box = { x0: 0.1 * W, x1: 0.9 * W, y0: 0.1 * H, y1: 0.9 * H };
    const left = text('Hola', { align: 'left', verticalAlign: 'top' }).bbox(isInk);
    const centre = text('Hola', { align: 'center', verticalAlign: 'middle' }).bbox(isInk);
    const right = text('Hola', { align: 'right', verticalAlign: 'bottom' }).bbox(isInk);
    if (!left || !centre || !right) throw new Error('text was not drawn');
    expect(left.x0 - box.x0).toBeLessThan(6);
    expect(left.y0 - box.y0).toBeLessThan(H * 0.05);
    expect(Math.abs((centre.x0 + centre.x1) / 2 - W / 2)).toBeLessThan(3);
    expect(Math.abs((centre.y0 + centre.y1) / 2 - H / 2)).toBeLessThan(H * 0.03);
    expect(box.x1 - right.x1).toBeLessThan(6);
    expect(box.y1 - right.y1).toBeLessThan(H * 0.05);
    expect(right.y1).toBeLessThanOrEqual(box.y1);
  });

  it('applies colour, weight, italic, uppercase, line height and letter spacing', () => {
    const plain = text('Hola mundo');
    expect(text('Hola mundo', { color: '#ff0000' }).count(near(RED, 30))).toBeGreaterThan(200);
    const inkOf = (overrides: Record<string, unknown>, content = 'Hola mundo') => {
      const box = text(content, overrides).bbox(isInk);
      if (!box) throw new Error('text was not drawn');
      return box;
    };
    const base = inkOf({});
    expect(text('Hola mundo', { fontWeight: 400 }).count(isInk)).toBeLessThan(plain.count(isInk));
    expect(diffRatio(text('Hola mundo', { italic: true }).data, plain.data)).toBeGreaterThan(0.001);
    expect(inkOf({ uppercase: true }).w).toBeGreaterThan(base.w);
    expect(diffRatio(text('HOLA MUNDO').data, text('Hola mundo', { uppercase: true }).data)).toBe(
      0,
    );
    expect(inkOf({ letterSpacing: 0.2 }).w).toBeGreaterThan(base.w * 1.25);
    const tight = inkOf({ lineHeight: 1 }, 'Hola\nmundo');
    const loose = inkOf({ lineHeight: 2 }, 'Hola\nmundo');
    expect(loose.h - tight.h).toBeGreaterThan(0.08 * H * 0.9);
    expect(text('   ').count(isInk)).toBe(0);
  });

  it('paints the pill, the outline and the shadow', () => {
    const pill = text('Hola', { background: { color: '#00ff00', padding: 0.02, radius: 0.02 } });
    const green = pill.bbox(near([0, 255, 0], 20));
    const ink = pill.bbox(isInk);
    if (!green || !ink) throw new Error('pill was not drawn');
    expect(green.x0).toBeLessThan(ink.x0);
    expect(green.x1).toBeGreaterThan(ink.x1);
    expect(ink.x0 - green.x0).toBeGreaterThan(0.02 * H - 3);

    const outlined = text('Hola', { stroke: { color: '#ff0000', width: 0.01 } });
    const redBox = outlined.bbox(near(RED, 40));
    const plain = text('Hola').bbox(isInk);
    if (!redBox || !plain) throw new Error('outline was not drawn');
    // The outline grows the lettering outwards by about its width.
    expect(plain.x0 - redBox.x0).toBeGreaterThan(1.5);
    expect(plain.x0 - redBox.x0).toBeLessThan(0.01 * H + 3);

    const shadowed = text('Hola', {
      color: '#ffffff',
      shadow: { color: '#ff0000', blur: 0, offsetX: 0.03, offsetY: 0.03 },
    });
    const shadow = shadowed.bbox(near(RED, 40));
    if (!shadow) throw new Error('shadow was not drawn');
    expect(shadow.x1 - plain.x1).toBeGreaterThan(0.03 * H - 3);
    expect(shadow.y1 - plain.y1).toBeGreaterThan(0.03 * H - 3);
    // Outline + shadow: the shadow is cast once, by the outlined lettering as a whole.
    const both = text('Hola', {
      stroke: { color: '#00ff00', width: 0.008 },
      shadow: { color: '#ff000080', blur: 0, offsetX: 0.05, offsetY: 0 },
    });
    const tones = new Set<number>();
    for (let o = 0; o < both.data.length; o += 4) {
      const [r, g, b] = [both.data[o] ?? 0, both.data[o + 1] ?? 0, both.data[o + 2] ?? 0];
      if (r > 90 && g < 40 && b < 60) tones.add(Math.round(r / 16));
    }
    // A single translucent red tone (plus anti-aliased edges), not a denser doubled core.
    expect(Math.max(...tones)).toBeLessThanOrEqual(Math.round(145 / 16));
  });

  it('draws the same pixels with a cold and a warm cache, and after cache eviction', () => {
    const composition = one([
      {
        id: 't',
        type: 'text',
        text: 'Caché de texto',
        box: { x: 0.103, y: 0.207, w: 0.8, h: 0.3 },
        style: {
          fontSize: 0.1,
          shadow: { color: '#000000aa', blur: 0.01, offsetX: 0, offsetY: 0.005 },
        },
      },
    ]);
    clearRenderCaches();
    const cold = shoot(composition, 0, undefined, undefined, size);
    const warm = shoot(composition, 0, undefined, undefined, size);
    clearRenderCaches();
    const again = shoot(composition, 0, undefined, undefined, size);
    expect(diffRatio(cold.data, warm.data)).toBe(0);
    expect(diffRatio(cold.data, again.data)).toBe(0);
  });
});

describe('image and video layers', () => {
  const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }; // 320 × 180 px at 640 × 360
  const image = (overrides: Record<string, unknown> = {}) =>
    shoot(
      one([{ id: 'i', type: 'image', src: PIC, box, ...overrides } as NewLayerInput]),
      0,
      undefined,
      withPic(),
      size,
    );

  it('contains by default, covers on request, and never paints outside the box', () => {
    const contain = image();
    // 2:1 image in a 16:9 box: full width, bars above / below show the background.
    expect(contain.px(170, 96).slice(0, 3)).toEqual(BG);
    expect(near(RED)(...(contain.px(170, 180).slice(0, 3) as Rgb))).toBe(true);
    expect(near([0, 0, 255])(...(contain.px(470, 180).slice(0, 3) as Rgb))).toBe(true);
    const cover = image({ fit: 'cover' });
    expect(near([0, 255, 0])(...(cover.px(170, 96).slice(0, 3) as Rgb))).toBe(true);
    expect(cover.px(150, 180).slice(0, 3)).toEqual(BG);
    expect(cover.px(320, 80).slice(0, 3)).toEqual(BG);
    const inside = cover.count((r, g, b) => !(r === BG[0] && g === BG[1] && b === BG[2]));
    expect(inside).toBeLessThanOrEqual(320 * 180);
    expect(inside).toBeGreaterThan(320 * 180 * 0.98);
  });

  it('rounds corners, applies opacity and rotates around the box centre', () => {
    const rounded = image({ fit: 'cover', radius: 0.1 });
    expect(rounded.px(162, 92).slice(0, 3)).toEqual(BG); // corner cut
    expect(near([0, 255, 0])(...(rounded.px(320, 92).slice(0, 3) as Rgb))).toBe(true);
    const faded = image({ fit: 'fill', opacity: 0.5 });
    const [r, g, b] = faded.px(170, 200);
    expect(r).toBeGreaterThan(125);
    expect(r).toBeLessThan(145);
    expect(Math.abs(g - BG[1] / 2)).toBeLessThan(6);
    expect(Math.abs(b - BG[2] / 2)).toBeLessThan(6);
    const turned = image({ fit: 'fill', rotation: 90 });
    const ink = turned.bbox((rr, gg, bb) => !(rr === BG[0] && gg === BG[1] && bb === BG[2]));
    if (!ink) throw new Error('image was not drawn');
    expect(Math.abs(ink.w - 180)).toBeLessThanOrEqual(2);
    expect(Math.abs(ink.h - 320)).toBeLessThanOrEqual(2);
    // Clockwise: the green top band is now on the right.
    expect(near([0, 255, 0])(...(turned.px(320 + 85, 180).slice(0, 3) as Rgb))).toBe(true);
  });

  it('plays video layers from their own start, trimmed and looped', () => {
    const { source, asked } = indexedVideo(30);
    const assets = new MapRenderAssets().setVideo('stock:clip', source);
    const at = (tMs: number, overrides: Record<string, unknown>) => {
      asked.length = 0;
      const shot = shoot(
        one([
          { id: 'v', type: 'video', src: CLIP, box, fit: 'fill', ...overrides } as NewLayerInput,
        ]),
        tMs,
        undefined,
        assets,
        size,
      );
      return {
        asked: [...asked],
        red: shot.px(W / 2, H / 2)[0],
        corner: shot.px(5, 5).slice(0, 3),
      };
    };
    expect(at(500, {})).toMatchObject({ asked: [15], red: 120, corner: BG });
    // The layer's clock starts when the layer appears.
    expect(at(1500, { timing: { startMs: 1000, endMs: 3000 }, trimStartMs: 100 }).red).toBe(18 * 8);
    expect(at(500, { timing: { startMs: 1000, endMs: 3000 } })).toMatchObject({
      asked: [],
      red: BG[0],
    });
    expect(at(3500, { timing: { startMs: 1000, endMs: 3000 } }).asked).toEqual([]);
    expect(at(1200, { loop: true }).red).toBe(6 * 8);
    expect(at(1200, { loop: false }).red).toBe(29 * 8);
    // An invisible layer is still fed (the media clock stays exact).
    expect(at(500, { opacity: 0 })).toMatchObject({ asked: [15], red: BG[0] });
  });
});

describe('shape layers', () => {
  const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const shape = (overrides: Record<string, unknown>) =>
    shoot(
      one([{ id: 'sh', type: 'shape', box, fill: '#ff0000', ...overrides } as NewLayerInput]),
      0,
      undefined,
      undefined,
      size,
    );
  const isRed = near(RED, 30);

  it('draws rect, rounded rect, ellipse, triangle, star and line', () => {
    const area = 320 * 180;
    expect(shape({ shape: 'rect' }).count(near(RED, 1))).toBe(area);
    const rounded = shape({ shape: 'rect', radius: 0.1 });
    expect(rounded.px(161, 91).slice(0, 3)).toEqual(BG);
    expect(rounded.count(isRed)).toBeLessThan(area);
    expect(rounded.count(isRed)).toBeGreaterThan(area * 0.95);
    const ellipse = shape({ shape: 'ellipse' });
    expect(Math.abs(ellipse.count(isRed) / area - Math.PI / 4)).toBeLessThan(0.01);
    expect(ellipse.px(165, 95).slice(0, 3)).toEqual(BG);
    const triangle = shape({ shape: 'triangle' });
    expect(Math.abs(triangle.count(isRed) / area - 0.5)).toBeLessThan(0.01);
    expect(isRed(...(triangle.px(320, 100).slice(0, 3) as Rgb))).toBe(true); // apex at the top
    expect(triangle.px(170, 100).slice(0, 3)).toEqual(BG);
    const star = shape({ shape: 'star' });
    expect(isRed(...(star.px(320, 180).slice(0, 3) as Rgb))).toBe(true);
    expect(isRed(...(star.px(320, 96).slice(0, 3) as Rgb))).toBe(true); // top point
    expect(star.px(250, 110).slice(0, 3)).toEqual(BG); // between two points
    expect(star.count(isRed) / area).toBeGreaterThan(0.2);
    expect(star.count(isRed) / area).toBeLessThan(0.5);
    // Line: as thick as its stroke (or as its box without one), inside the box.
    const thin = shape({
      shape: 'line',
      fill: null,
      stroke: { color: '#ff0000', width: 0.02 },
    }).bbox(isRed);
    if (!thin) throw new Error('line was not drawn');
    expect(Math.abs(thin.h - 0.02 * H)).toBeLessThanOrEqual(2);
    expect(Math.abs((thin.y0 + thin.y1) / 2 - 180)).toBeLessThanOrEqual(1);
    expect(thin.x0).toBeGreaterThanOrEqual(159);
    expect(thin.x1).toBeLessThanOrEqual(480);
    const bar = shape({ shape: 'line', box: { x: 0.25, y: 0.5, w: 0.5, h: 0.02 } }).bbox(isRed);
    expect(bar?.w).toBeGreaterThan(300);
  });

  it('strokes shapes and keeps partial opacity uniform over fill and stroke', () => {
    const stroked = shape({ shape: 'rect', fill: null, stroke: { color: '#00ff00', width: 0.02 } });
    expect(near([0, 255, 0])(...(stroked.px(160, 180).slice(0, 3) as Rgb))).toBe(true);
    expect(stroked.px(320, 180).slice(0, 3)).toEqual(BG);
    // Half-transparent blue stroke over a red fill: where the stroke covers the fill the
    // result must be "half stroke over background", not "stroke over fill over background".
    const group = shape({ shape: 'rect', opacity: 0.5, stroke: { color: '#0000ff', width: 0.04 } });
    const onStrokeInside = group.px(160 + 4, 180);
    const onStrokeOutside = group.px(160 - 4, 180);
    expect(onStrokeInside).toEqual(onStrokeOutside);
    expect(onStrokeInside[0]).toBeLessThan(20); // no red showing through the stroke
    expect(group.px(320, 180)[0]).toBeGreaterThan(125);
  });

  it('orders layers by z, then by array order', () => {
    const stack = (zRed: number, zBlue: number) =>
      shoot(
        one([
          { id: 'red', type: 'shape', box, fill: '#ff0000', z: zRed },
          { id: 'blue', type: 'shape', box, fill: '#0000ff', z: zBlue },
        ]),
        0,
        undefined,
        undefined,
        size,
      ).px(W / 2, H / 2);
    expect(stack(0, 0).slice(0, 3)).toEqual([0, 0, 255]);
    expect(stack(5, 0).slice(0, 3)).toEqual([255, 0, 0]);
    expect(stack(-3, -7).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('honours the visibility window and the `visible` flag', () => {
    const timed = one([
      { id: 'sh', type: 'shape', box, fill: '#ff0000', timing: { startMs: 1000, endMs: 2000 } },
      { id: 'off', type: 'shape', box: full, fill: '#00ff00', visible: false },
    ]);
    const centre = (tMs: number) =>
      shoot(timed, tMs, undefined, undefined, size)
        .px(W / 2, H / 2)
        .slice(0, 3);
    expect(centre(999)).toEqual(BG);
    expect(centre(1000)).toEqual(RED);
    expect(centre(1999)).toEqual(RED);
    expect(centre(2000)).toEqual(BG);
  });
});

describe('avatar layers', () => {
  const runtime: RenderRuntime = {
    scenes: {
      s: {
        audioDurationMs: 2000,
        visemes: [
          { tMs: 0, viseme: 'rest' },
          { tMs: 400, viseme: 'A' },
          { tMs: 1600, viseme: 'rest' },
        ],
        words: [],
      },
    },
  };
  const box = { x: 0.25, y: 0, w: 0.5, h: 1 };
  const avatar = (overrides: Record<string, unknown> = {}) =>
    one([{ id: 'a', type: 'avatar', avatarId: 'stock_test', box, ...overrides } as NewLayerInput]);

  it('hands the rig its box, pose and options', () => {
    const rig = stubRig('stock_test');
    const assets = new MapRenderAssets().setAvatar('stock_test', rig);
    shoot(avatar({ framing: 'closeup', flip: true }), 1000, runtime, assets, size);
    expect(rig.calls).toHaveLength(1);
    expect(rig.calls[0]).toMatchObject({
      box: { x: 160, y: 0, w: 320, h: 360 },
      options: { framing: 'closeup', flip: true, quality: 'final' },
      state: { viseme: 'A', speaking: true, timeMs: 1000 },
    });
    // Narration starts after the 300 ms padding: before it the mouth rests.
    shoot(avatar(), 100, runtime, assets, size);
    expect(rig.calls[1]).toMatchObject({ state: { viseme: 'rest', speaking: false } });
    const open = shoot(avatar(), 1000, runtime, assets, size);
    const closed = shoot(avatar(), 100, runtime, assets, size);
    expect(diffRatio(open.data, closed.data)).toBeGreaterThan(0);
    shoot(avatar(), 1000, runtime, assets, { ...size, quality: 'preview' });
    expect(rig.calls.at(-1)).toMatchObject({ options: { quality: 'preview' } });
  });

  it('masks with a circle or rounded rectangle over the backdrop', () => {
    const assets = new MapRenderAssets().setAvatar('stock_test', stubRig('stock_test', '#00ff00'));
    const circle = shoot(
      avatar({ shape: 'circle', backdrop: '#ff00ff' }),
      0,
      runtime,
      assets,
      size,
    );
    // Box 320 × 360 → circle of radius 160 centred at (320, 180).
    expect(circle.px(165, 10).slice(0, 3)).toEqual(BG); // box corner, outside the circle
    expect(near([255, 0, 255])(...(circle.px(320, 30).slice(0, 3) as Rgb))).toBe(true); // backdrop
    expect(near([0, 255, 0])(...(circle.px(320, 320).slice(0, 3) as Rgb))).toBe(true); // body
    expect(circle.px(180, 350).slice(0, 3)).toEqual(BG); // body clipped by the circle
    const rounded = shoot(
      avatar({ shape: 'rounded', backdrop: '#ff00ff' }),
      0,
      runtime,
      assets,
      size,
    );
    expect(rounded.px(161, 1).slice(0, 3)).toEqual(BG);
    expect(near([255, 0, 255])(...(rounded.px(175, 12).slice(0, 3) as Rgb))).toBe(true);
    const none = shoot(avatar({ backdrop: '#ff00ff' }), 0, runtime, assets, size);
    expect(none.count(near([255, 0, 255]))).toBe(0); // backdrop only applies with a mask
  });

  it('composites a half-transparent avatar as one image', () => {
    const assets = new MapRenderAssets().setAvatar('stock_test', stubRig('stock_test', '#00ff00'));
    const solid = shoot(avatar(), 0, runtime, assets, size);
    const faded = shoot(avatar({ opacity: 0.5 }), 0, runtime, assets, size);
    // The dark hair mark is drawn over the skin: at 50 % it must be 50 % mark + 50 %
    // background, with no skin showing through.
    const mark = solid.bbox(near([0x3b, 0x2a, 0x1e], 6));
    if (!mark) throw new Error('rig mark not found');
    const x = Math.round((mark.x0 + mark.x1) / 2);
    const y = Math.round((mark.y0 + mark.y1) / 2);
    const expected = [0x3b, 0x2a, 0x1e].map((c, i) => Math.round((c + (BG[i] ?? 0)) / 2));
    faded
      .px(x, y)
      .slice(0, 3)
      .forEach((value, i) => expect(Math.abs(value - (expected[i] ?? 0))).toBeLessThanOrEqual(2));
  });

  it('falls back to a placeholder for unknown avatars', () => {
    const shot = shoot(avatar({ avatarId: 'avt_0123456789abcdef' }), 0, runtime, undefined, size);
    expect(shot.px(320, 20)).toEqual([0x2a, 0x2f, 0x45, 255]);
  });
});

describe('layer animations', () => {
  const box = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }; // 128 × 72 px
  const layer = (overrides: Record<string, unknown>): NewLayerInput =>
    ({ id: 'sh', type: 'shape', box, fill: '#ff0000', ...overrides }) as NewLayerInput;
  const still = shoot(one([layer({})]), 0, undefined, undefined, size);
  const isRedish = (r: number, g: number, b: number) => r > 60 && g < 60 && b < 80;
  const at = (overrides: Record<string, unknown>, tMs: number) =>
    shoot(one([layer(overrides)]), tMs, undefined, undefined, size);

  it('computes poses: hidden before, eased during, exactly at rest after', () => {
    const composition = one([
      layer({ enter: { type: 'slide-up', durationMs: 400, delayMs: 200, easing: 'linear' } }),
    ]);
    const target = composition.scenes[0]?.layers[0];
    if (!target) throw new Error('no layer');
    expect(layerPoseAt(target, 100, 4000, H).alpha).toBe(0);
    const mid = layerPoseAt(target, 400, 4000, H);
    expect(mid.dy).toBe(Math.round(0.5 * 0.14 * H));
    expect(mid.dx).toBe(0);
    expect(mid.alpha).toBeCloseTo(0.8, 6);
    expect(layerPoseAt(target, 600, 4000, H)).toEqual({ alpha: 1, dx: 0, dy: 0, scale: 1 });
    expect(layerPoseAt(target, 3999, 4000, H)).toEqual({ alpha: 1, dx: 0, dy: 0, scale: 1 });
  });

  it('enters: fade, slides, zooms and pop', () => {
    const fade = { type: 'fade', durationMs: 400, easing: 'linear' };
    expect(at({ enter: fade }, 0).count(isRedish)).toBe(0);
    const half = at({ enter: fade }, 200).px(W / 2, H / 2);
    expect(half[0]).toBeGreaterThan(125);
    expect(half[0]).toBeLessThan(145);
    expect(diffRatio(at({ enter: fade }, 400).data, still.data)).toBe(0);

    const rest = still.bbox(isRedish);
    if (!rest) throw new Error('shape was not drawn');
    const moving = (type: string) => {
      const shot = at({ enter: { type, durationMs: 400, easing: 'linear' } }, 200).bbox(isRedish);
      if (!shot) throw new Error(`${type}: nothing drawn`);
      return { dx: shot.x0 - rest.x0, dy: shot.y0 - rest.y0, w: shot.w, h: shot.h };
    };
    const travel = Math.round(0.5 * 0.14 * H);
    expect(moving('slide-up')).toMatchObject({ dx: 0, dy: travel }); // comes from below
    expect(moving('slide-down')).toMatchObject({ dx: 0, dy: -travel });
    expect(moving('slide-left')).toMatchObject({ dx: travel, dy: 0 }); // comes from the right
    expect(moving('slide-right')).toMatchObject({ dx: -travel, dy: 0 });
    expect(moving('zoom-in').w).toBeLessThan(rest.w - 10);
    expect(moving('zoom-out').w).toBeGreaterThan(rest.w + 10);
    // Pop overshoots its resting size before settling.
    let widest = 0;
    for (let t = 0; t <= 400; t += 1000 / 30) {
      const pop = at({ enter: { type: 'pop', durationMs: 400 } }, t).bbox(isRedish);
      widest = Math.max(widest, pop?.w ?? 0);
    }
    expect(widest).toBeGreaterThan(rest.w + 2);
    for (const type of ['slide-up', 'zoom-in', 'zoom-out', 'pop']) {
      expect(diffRatio(at({ enter: { type, durationMs: 400 } }, 400).data, still.data), type).toBe(
        0,
      );
    }
  });

  it('waits for the delay, counted from the moment the layer appears', () => {
    const delayed = {
      timing: { startMs: 1000, endMs: null },
      enter: { type: 'fade', durationMs: 200, delayMs: 300, easing: 'linear' },
    };
    expect(at(delayed, 1250).count(isRedish)).toBe(0);
    const partial = at(delayed, 1400).px(W / 2, H / 2)[0];
    expect(partial).toBeGreaterThan(100);
    expect(partial).toBeLessThan(160);
    expect(diffRatio(at(delayed, 1500).data, still.data)).toBe(0);
  });

  it('exits before the layer disappears and keeps moving in the named direction', () => {
    const exit = { exit: { type: 'slide-up', durationMs: 400, easing: 'linear' } };
    expect(diffRatio(at(exit, 3600).data, still.data)).toBe(0);
    const leaving = at(exit, 3800).bbox(isRedish);
    const rest = still.bbox(isRedish);
    if (!leaving || !rest) throw new Error('shape was not drawn');
    expect(leaving.y0).toBe(rest.y0 - Math.round(0.5 * 0.14 * H)); // keeps going up
    expect(at(exit, 3990).px(W / 2, H / 2)[0]).toBeLessThan(40);
    // With a window and a delay: gone `delayMs` before the window closes.
    const windowed = {
      timing: { startMs: 0, endMs: 2000 },
      exit: { type: 'fade', durationMs: 400, delayMs: 200, easing: 'linear' },
    };
    expect(diffRatio(at(windowed, 1400).data, still.data)).toBe(0);
    expect(at(windowed, 1600).px(W / 2, H / 2)[0]).toBeGreaterThan(110);
    expect(at(windowed, 1600).px(W / 2, H / 2)[0]).toBeLessThan(150);
    expect(at(windowed, 1850).count(isRedish)).toBe(0);
  });

  it('animates text and images through their cached bitmaps without changing the rest frame', () => {
    const textLayer: NewLayerInput = {
      id: 't',
      type: 'text',
      text: 'Animado',
      box: { x: 0.2, y: 0.3, w: 0.6, h: 0.3 },
      style: { fontSize: 0.12, stroke: { color: '#000000', width: 0.006 } },
    };
    const rest = shoot(one([textLayer]), 2000, undefined, undefined, size);
    for (const type of ['fade', 'slide-left', 'zoom-in', 'pop'] as const) {
      const animated = one([{ ...textLayer, enter: { type, durationMs: 500 } }]);
      expect(
        diffRatio(shoot(animated, 2000, undefined, undefined, size).data, rest.data),
        type,
      ).toBe(0);
      const mid = shoot(animated, 250, undefined, undefined, size);
      expect(diffRatio(mid.data, rest.data), type).toBeGreaterThan(0.001);
    }
    const imageLayer: NewLayerInput = {
      id: 'i',
      type: 'image',
      src: PIC,
      box: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 },
    };
    const imageRest = shoot(one([imageLayer]), 2000, undefined, withPic(), size);
    const sliding = one([
      { ...imageLayer, enter: { type: 'slide-right', durationMs: 500, easing: 'linear' } },
    ]);
    expect(diffRatio(shoot(sliding, 2000, undefined, withPic(), size).data, imageRest.data)).toBe(
      0,
    );
    const isImage = (r: number, g: number, b: number) => r > 200 || b > 200 || g > 200;
    const a = imageRest.bbox(isImage);
    const b = shoot(sliding, 250, undefined, withPic(), size).bbox(isImage);
    expect((a?.x0 ?? 0) - (b?.x0 ?? 0)).toBe(Math.round(0.5 * 0.14 * H));
  });
});
