import { createCanvas } from '@napi-rs/canvas';
import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import { Rng } from './music/synth';

/* -------------------------------------------------------------------------------------------
 * Stock backgrounds, painted by code (Node only, build time). No downloaded media.
 *
 * Every painter draws on a SQUARE of side `s` using fractions of `s`, and keeps what matters
 * inside the central 56 % of both axes. The versioned master is that square (1920 px), so with
 * `fit: 'cover'` the same file fills 16:9, 9:16 and 1:1 canvases at 1080p without upscaling:
 * landscape shows the middle band, portrait the middle column. `renderBackground` can also
 * paint any other size directly (it centres the square and crops) — same picture, any aspect.
 *
 * Deterministic: seeded PRNG only.
 * ----------------------------------------------------------------------------------------- */

type Ctx = SKRSContext2D;
type Painter = (ctx: Ctx, s: number) => void;

export const BACKGROUND_MASTER_SIZE = 1920;

function rgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Fill the square with a linear gradient. 0° = left→right, 90° = top→bottom. */
function linear(ctx: Ctx, s: number, angle: number, stops: readonly [number, string][]): void {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const half = (Math.abs(dx) + Math.abs(dy)) * s * 0.5;
  const gradient = ctx.createLinearGradient(
    s / 2 - dx * half,
    s / 2 - dy * half,
    s / 2 + dx * half,
    s / 2 + dy * half,
  );
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, s, s);
}

/** Soft round glow centred at (x, y), radius r (fractions of the square). */
function glow(ctx: Ctx, s: number, x: number, y: number, r: number, hex: string, alpha: number) {
  const gradient = ctx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s);
  gradient.addColorStop(0, rgba(hex, alpha));
  gradient.addColorStop(0.5, rgba(hex, alpha * 0.45));
  gradient.addColorStop(1, rgba(hex, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, s, s);
}

/** Darken (or tint) towards the edges. */
function vignette(ctx: Ctx, s: number, hex: string, alpha: number, inner = 0.35): void {
  const gradient = ctx.createRadialGradient(s / 2, s / 2, inner * s, s / 2, s / 2, 0.75 * s);
  gradient.addColorStop(0, rgba(hex, 0));
  gradient.addColorStop(1, rgba(hex, alpha));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, s, s);
}

function ellipse(ctx: Ctx, x: number, y: number, rx: number, ry: number, rotation = 0): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** Run `draw` on a scratch layer and composite it blurred (depth of field, soft light). */
function blurred(ctx: Ctx, s: number, radius: number, draw: (layer: Ctx) => void): void {
  const layer = createCanvas(s, s);
  const layerCtx = layer.getContext('2d');
  draw(layerCtx);
  ctx.save();
  ctx.filter = `blur(${Math.max(0.5, radius * s).toFixed(2)}px)`;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/* ---------- gradients ---------- */

const aurora: Painter = (ctx, s) => {
  linear(ctx, s, 135, [
    [0, '#12152e'],
    [1, '#35297f'],
  ]);
  glow(ctx, s, 0.3, 0.36, 0.42, '#6d5efc', 0.75);
  glow(ctx, s, 0.7, 0.32, 0.36, '#ff6b9d', 0.5);
  glow(ctx, s, 0.6, 0.72, 0.46, '#2ec4b6', 0.45);
  vignette(ctx, s, '#080a1c', 0.5);
};

const sunset: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#1f0f4a'],
    [0.3, '#5a1f78'],
    [0.52, '#c2417f'],
    [0.7, '#ff7e5f'],
    [0.86, '#ffb36b'],
    [1, '#ffd9a0'],
  ]);
  glow(ctx, s, 0.5, 0.72, 0.34, '#fff3c4', 0.7);
  // Soft haze near the horizon.
  blurred(ctx, s, 0.015, (layer) => {
    for (let i = 0; i < 3; i += 1) {
      layer.fillStyle = rgba('#fff0d8', 0.16 - i * 0.03);
      ellipse(layer, s * (0.42 + i * 0.09), s * (0.6 + i * 0.05), s * 0.5, s * 0.014);
    }
  });
  vignette(ctx, s, '#2a0f4a', 0.16, 0.45);
};

const ocean: Painter = (ctx, s) => {
  linear(ctx, s, 115, [
    [0, '#021526'],
    [0.5, '#0a4a68'],
    [1, '#12a0a0'],
  ]);
  glow(ctx, s, 0.3, 0.3, 0.42, '#21c1d6', 0.35);
  glow(ctx, s, 0.76, 0.7, 0.5, '#0a3a7a', 0.6);
  blurred(ctx, s, 0.012, (layer) => {
    for (let i = 0; i < 6; i += 1) {
      layer.strokeStyle = rgba('#7df3ff', 0.05 + 0.012 * i);
      layer.lineWidth = s * (0.02 + 0.006 * i);
      layer.beginPath();
      for (let x = -0.05; x <= 1.05; x += 0.01) {
        const y = 0.28 + i * 0.1 + 0.035 * Math.sin(x * (5 + i) + i * 1.7);
        if (x <= -0.05) layer.moveTo(x * s, y * s);
        else layer.lineTo(x * s, y * s);
      }
      layer.stroke();
    }
  });
  vignette(ctx, s, '#010b16', 0.45);
};

const mint: Painter = (ctx, s) => {
  linear(ctx, s, 135, [
    [0, '#effbf5'],
    [1, '#c7f0df'],
  ]);
  glow(ctx, s, 0.28, 0.3, 0.42, '#8fe3c0', 0.7);
  glow(ctx, s, 0.72, 0.7, 0.46, '#b3e4ff', 0.75);
  glow(ctx, s, 0.66, 0.26, 0.3, '#fff5cf', 0.8);
  glow(ctx, s, 0.5, 0.5, 0.35, '#ffffff', 0.35);
};

const paper: Painter = (ctx, s) => {
  linear(ctx, s, 100, [
    [0, '#faf5ea'],
    [1, '#f0e6d2'],
  ]);
  glow(ctx, s, 0.5, 0.45, 0.5, '#fffdf6', 0.8);
  // Two quiet arcs, like a letterhead.
  ctx.strokeStyle = rgba('#c98a4b', 0.2);
  ctx.lineWidth = s * 0.003;
  for (const [x, y, r] of [
    [0.2, 0.24, 0.16],
    [0.8, 0.78, 0.2],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  }
  vignette(ctx, s, '#b89b6a', 0.22, 0.42);
};

const midnight: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#0b1230'],
    [1, '#05070f'],
  ]);
  glow(ctx, s, 0.5, 0.3, 0.5, '#2f55e0', 0.4);
  glow(ctx, s, 0.72, 0.62, 0.3, '#7a3cf0', 0.18);
  vignette(ctx, s, '#000000', 0.55);
};

/* ---------- patterns ---------- */

const dots: Painter = (ctx, s) => {
  linear(ctx, s, 135, [
    [0, '#131a3d'],
    [1, '#0b1026'],
  ]);
  glow(ctx, s, 0.34, 0.36, 0.5, '#4f5bff', 0.35);
  const step = s / 40;
  for (let row = 0; row <= 40; row += 1) {
    for (let col = 0; col <= 40; col += 1) {
      const x = col * step + (row % 2 === 0 ? 0 : step / 2);
      const y = row * step;
      const d = Math.hypot(x / s - 0.34, y / s - 0.36);
      const k = Math.max(0, 1 - d / 0.75);
      ctx.fillStyle = rgba('#aab4ff', 0.08 + 0.5 * k * k);
      ellipse(ctx, x, y, step * (0.06 + 0.12 * k), step * (0.06 + 0.12 * k));
    }
  }
  vignette(ctx, s, '#05071a', 0.5);
};

const grid: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#071a2b'],
    [1, '#04101c'],
  ]);
  glow(ctx, s, 0.5, 0.46, 0.5, '#0fb8a0', 0.22);
  const cells = 32;
  const step = s / cells;
  for (let i = 0; i <= cells; i += 1) {
    const major = i % 4 === 0;
    ctx.strokeStyle = rgba('#3ff0cf', major ? 0.22 : 0.08);
    ctx.lineWidth = s * (major ? 0.0014 : 0.0008);
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, s);
    ctx.moveTo(0, i * step);
    ctx.lineTo(s, i * step);
    ctx.stroke();
  }
  // A few lit nodes and traces on the major grid.
  const rng = new Rng(8);
  for (let i = 0; i < 26; i += 1) {
    const col = Math.floor(rng.range(0, cells / 4 + 1)) * 4;
    const row = Math.floor(rng.range(0, cells / 4 + 1)) * 4;
    const length = Math.floor(rng.range(1, 4)) * 4 * step;
    const horizontal = rng.next() < 0.5;
    ctx.strokeStyle = rgba('#5ffbe0', 0.4);
    ctx.lineWidth = s * 0.002;
    ctx.beginPath();
    ctx.moveTo(col * step, row * step);
    ctx.lineTo(col * step + (horizontal ? length : 0), row * step + (horizontal ? 0 : length));
    ctx.stroke();
    ctx.fillStyle = rgba('#b5fff2', 0.85);
    ellipse(ctx, col * step, row * step, s * 0.004, s * 0.004);
  }
  vignette(ctx, s, '#01060c', 0.7, 0.3);
};

const waves: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#171a3a'],
    [0.6, '#272a6e'],
    [1, '#2f2a7a'],
  ]);
  glow(ctx, s, 0.5, 0.3, 0.45, '#5a4ff0', 0.3);
  const layers: [number, string, number][] = [
    [0.6, '#3b2f8f', 0.9],
    [0.66, '#5145c9', 0.85],
    [0.72, '#6d5efc', 0.85],
    [0.78, '#a66bf0', 0.8],
    [0.85, '#ff6b9d', 0.75],
  ];
  layers.forEach(([base, color, alpha], i) => {
    ctx.fillStyle = rgba(color, alpha);
    ctx.beginPath();
    ctx.moveTo(0, s);
    for (let x = 0; x <= 1.001; x += 0.005) {
      const y =
        base +
        0.03 * Math.sin(x * 6.3 * (1 + i * 0.22) + i * 1.3) +
        0.014 * Math.sin(x * 15 + i * 2.4);
      ctx.lineTo(x * s, y * s);
    }
    ctx.lineTo(s, s);
    ctx.closePath();
    ctx.fill();
  });
  vignette(ctx, s, '#0a0b22', 0.35, 0.45);
};

const confetti: Painter = (ctx, s) => {
  linear(ctx, s, 120, [
    [0, '#fff6dc'],
    [1, '#ffe2b8'],
  ]);
  glow(ctx, s, 0.5, 0.5, 0.45, '#ffffff', 0.7);
  const colors = ['#ff5d73', '#ffb547', '#2ec4b6', '#6d5efc', '#3aa0ff', '#ff8fb1'];
  const rng = new Rng(21);
  for (let i = 0; i < 420; i += 1) {
    const x = rng.next();
    const y = rng.next();
    // Keep the middle calm so a presenter and a headline stay readable.
    const calm = Math.max(Math.abs(x - 0.5) / 0.3, Math.abs(y - 0.5) / 0.3);
    if (calm < 1 && rng.next() > calm * calm * 0.25) continue;
    const size = s * rng.range(0.008, 0.02);
    const color = rng.pick(colors);
    ctx.save();
    ctx.translate(x * s, y * s);
    ctx.rotate(rng.range(0, Math.PI * 2));
    ctx.fillStyle = rgba(color, rng.range(0.75, 1));
    const kind = Math.floor(rng.range(0, 4));
    if (kind === 0) {
      ctx.fillRect(-size, -size * 0.35, size * 2, size * 0.7);
    } else if (kind === 1) {
      ellipse(ctx, 0, 0, size * 0.6, size * 0.6);
    } else if (kind === 2) {
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.8);
      ctx.lineTo(size * 0.8, size * 0.6);
      ctx.lineTo(-size * 0.8, size * 0.6);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = size * 0.3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-size * 1.4, 0);
      ctx.bezierCurveTo(-size * 0.7, -size, 0, size, size * 1.4, 0);
      ctx.stroke();
    }
    ctx.restore();
  }
};

const diagonal: Painter = (ctx, s) => {
  linear(ctx, s, 45, [
    [0, '#ff4f6d'],
    [0.55, '#ff8a4c'],
    [1, '#ffc65c'],
  ]);
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(-Math.PI / 4);
  for (let i = -24; i <= 24; i += 1) {
    ctx.fillStyle = rgba('#ffffff', i % 2 === 0 ? 0.07 : 0);
    ctx.fillRect(-s, i * s * 0.045, s * 2, s * 0.045);
  }
  ctx.restore();
  ctx.fillStyle = rgba('#ffffff', 0.12);
  ellipse(ctx, s * 0.2, s * 0.2, s * 0.2, s * 0.2);
  ctx.fillStyle = rgba('#7a1035', 0.14);
  ellipse(ctx, s * 0.82, s * 0.82, s * 0.26, s * 0.26);
  ctx.strokeStyle = rgba('#ffffff', 0.35);
  ctx.lineWidth = s * 0.004;
  ctx.beginPath();
  ctx.arc(s * 0.2, s * 0.2, s * 0.235, 0, Math.PI * 2);
  ctx.stroke();
  vignette(ctx, s, '#7a1035', 0.25, 0.45);
};

const bokeh: Painter = (ctx, s) => {
  linear(ctx, s, 110, [
    [0, '#120d2b'],
    [0.6, '#2d1650'],
    [1, '#4a1d58'],
  ]);
  const colors = ['#ffd27a', '#ff8fb1', '#b39bff', '#7fd8ff', '#fff1c9'];
  const rng = new Rng(34);
  blurred(ctx, s, 0.004, (layer) => {
    for (let i = 0; i < 70; i += 1) {
      const x = rng.next();
      const y = rng.next();
      const r = s * rng.range(0.015, 0.075);
      const color = rng.pick(colors);
      const alpha = rng.range(0.06, 0.22);
      const gradient = layer.createRadialGradient(x * s, y * s, 0, x * s, y * s, r);
      gradient.addColorStop(0, rgba(color, alpha * 0.7));
      gradient.addColorStop(0.82, rgba(color, alpha));
      gradient.addColorStop(0.92, rgba(color, alpha * 1.5));
      gradient.addColorStop(1, rgba(color, 0));
      layer.fillStyle = gradient;
      layer.fillRect(x * s - r, y * s - r, r * 2, r * 2);
    }
  });
  glow(ctx, s, 0.5, 0.45, 0.45, '#ff9ecb', 0.12);
  vignette(ctx, s, '#07041a', 0.6);
};

const rays: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#1746d1'],
    [1, '#2b7bff'],
  ]);
  const cx = s * 0.5;
  const cy = s * 0.6;
  const count = 28;
  for (let i = 0; i < count; i += 2) {
    const a0 = (i / count) * Math.PI * 2;
    const a1 = ((i + 1) / count) * Math.PI * 2;
    ctx.fillStyle = rgba('#ffffff', 0.08);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * s * 1.5, cy + Math.sin(a0) * s * 1.5);
    ctx.lineTo(cx + Math.cos(a1) * s * 1.5, cy + Math.sin(a1) * s * 1.5);
    ctx.closePath();
    ctx.fill();
  }
  glow(ctx, s, 0.5, 0.6, 0.42, '#bfe0ff', 0.6);
  vignette(ctx, s, '#081c66', 0.45, 0.4);
};

/* ---------- abstract sets ---------- */

/** Floor line shared by the sets: 0.64 of the square = ~0.75 of a 16:9 crop. */
const HORIZON = 0.64;

const studioDark: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#1b1f2a'],
    [HORIZON, '#232836'],
    [HORIZON, '#14161d'],
    [1, '#07080b'],
  ]);
  glow(ctx, s, 0.5, 0.4, 0.46, '#7f93c9', 0.42);
  blurred(ctx, s, 0.012, (layer) => {
    layer.fillStyle = rgba('#aebcdf', 0.22);
    ellipse(layer, s * 0.5, s * (HORIZON + 0.07), s * 0.3, s * 0.035);
    layer.fillStyle = rgba('#000000', 0.5);
    layer.fillRect(0, s * (HORIZON - 0.004), s, s * 0.008);
  });
  vignette(ctx, s, '#000000', 0.7, 0.3);
};

const studioLight: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#f6f7f9'],
    [HORIZON - 0.05, '#e8ebf0'],
    [HORIZON + 0.03, '#dfe3ea'],
    [1, '#c9ced8'],
  ]);
  linear(ctx, s, 0, [
    [0, rgba('#ffffff', 0.5)],
    [0.5, rgba('#ffffff', 0)],
    [1, rgba('#9aa3b5', 0.18)],
  ]);
  blurred(ctx, s, 0.02, (layer) => {
    layer.fillStyle = rgba('#6b7385', 0.22);
    ellipse(layer, s * 0.5, s * (HORIZON + 0.085), s * 0.26, s * 0.03);
  });
  glow(ctx, s, 0.5, 0.36, 0.42, '#ffffff', 0.6);
};

const newsroom: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#04102b'],
    [HORIZON, '#0a2b6b'],
    [HORIZON, '#06183d'],
    [1, '#020916'],
  ]);
  // Video wall, out of focus.
  blurred(ctx, s, 0.006, (layer) => {
    const rng = new Rng(55);
    const cols = 9;
    const rows = 3;
    const w = s / cols;
    const h = s * 0.11;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const x = col * w + w * 0.06;
        const y = s * (0.24 + row * 0.125);
        const tone = rng.pick(['#1e63d8', '#2a86ff', '#134aa8', '#35b6ff']);
        layer.fillStyle = rgba(tone, rng.range(0.25, 0.6));
        roundRect(layer, x, y, w * 0.88, h, s * 0.006);
        layer.fillStyle = rgba('#ffffff', 0.12);
        for (let line = 0; line < 3; line += 1) {
          layer.fillRect(
            x + w * 0.08,
            y + h * (0.22 + line * 0.22),
            w * rng.range(0.3, 0.7),
            h * 0.07,
          );
        }
      }
    }
  });
  // Light streaks and the desk line.
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(-0.32);
  for (const [offset, width, alpha] of [
    [-0.34, 0.07, 0.07],
    [-0.1, 0.03, 0.09],
    [0.22, 0.1, 0.05],
  ] as const) {
    ctx.fillStyle = rgba('#8fd0ff', alpha);
    ctx.fillRect(s * offset, -s, s * width, s * 2);
  }
  ctx.restore();
  blurred(ctx, s, 0.004, (layer) => {
    layer.fillStyle = rgba('#e23b4e', 0.95);
    layer.fillRect(0, s * HORIZON, s, s * 0.008);
    layer.fillStyle = rgba('#7fd0ff', 0.9);
    layer.fillRect(0, s * (HORIZON + 0.014), s, s * 0.004);
  });
  glow(ctx, s, 0.5, HORIZON + 0.1, 0.4, '#2a86ff', 0.25);
  vignette(ctx, s, '#00040d', 0.65, 0.32);
};

const office: Painter = (ctx, s) => {
  // Wall and wooden floor.
  linear(ctx, s, 90, [
    [0, '#eef1f5'],
    [HORIZON + 0.04, '#e2e7ee'],
    [HORIZON + 0.04, '#c8a57f'],
    [1, '#a98660'],
  ]);
  blurred(ctx, s, 0.011, (layer) => {
    // Window with sky and a soft skyline.
    const wx = s * 0.3;
    const wy = s * 0.2;
    const ww = s * 0.4;
    const wh = s * 0.36;
    const sky = layer.createLinearGradient(0, wy, 0, wy + wh);
    sky.addColorStop(0, '#bfe0ff');
    sky.addColorStop(1, '#f3fbff');
    layer.fillStyle = sky;
    layer.fillRect(wx, wy, ww, wh);
    const rng = new Rng(89);
    for (let i = 0; i < 9; i += 1) {
      const bw = ww * rng.range(0.07, 0.13);
      const bh = wh * rng.range(0.18, 0.48);
      layer.fillStyle = rgba('#8aa2bd', rng.range(0.35, 0.6));
      layer.fillRect(wx + (i / 9) * ww, wy + wh - bh, bw, bh);
    }
    layer.strokeStyle = '#ffffff';
    layer.lineWidth = s * 0.012;
    layer.strokeRect(wx, wy, ww, wh);
    layer.lineWidth = s * 0.006;
    layer.beginPath();
    layer.moveTo(wx + ww / 2, wy);
    layer.lineTo(wx + ww / 2, wy + wh);
    layer.moveTo(wx, wy + wh * 0.5);
    layer.lineTo(wx + ww, wy + wh * 0.5);
    layer.stroke();
    // Shelf with books (left) and a plant (right).
    layer.fillStyle = '#b08d68';
    layer.fillRect(s * 0.06, s * 0.44, s * 0.19, s * 0.012);
    layer.fillRect(s * 0.06, s * 0.3, s * 0.19, s * 0.012);
    const bookColors = ['#6d5efc', '#ff6b5e', '#2ec4b6', '#ffb547', '#3a4a6b', '#e8e2d0'];
    for (let shelf = 0; shelf < 2; shelf += 1) {
      let x = s * 0.07;
      const base = s * (shelf === 0 ? 0.44 : 0.3);
      for (let i = 0; i < 8 && x < s * 0.23; i += 1) {
        const bw = s * rng.range(0.012, 0.022);
        const bh = s * rng.range(0.06, 0.1);
        layer.fillStyle = rng.pick(bookColors);
        layer.fillRect(x, base - bh, bw, bh);
        x += bw + s * 0.003;
      }
    }
    layer.fillStyle = '#d9d2c5';
    roundRect(layer, s * 0.805, s * 0.54, s * 0.07, s * 0.14, s * 0.012);
    layer.fillStyle = '#3f9b6b';
    for (let i = 0; i < 9; i += 1) {
      const angle = -Math.PI / 2 + (i - 4) * 0.28;
      ellipse(
        layer,
        s * 0.84 + Math.cos(angle) * s * 0.075,
        s * 0.545 + Math.sin(angle) * s * 0.1,
        s * 0.09,
        s * 0.022,
        angle,
      );
    }
    // Sunlight falling on the floor.
    layer.fillStyle = rgba('#fff4d6', 0.5);
    layer.beginPath();
    layer.moveTo(s * 0.34, s * (HORIZON + 0.06));
    layer.lineTo(s * 0.62, s * (HORIZON + 0.06));
    layer.lineTo(s * 0.8, s);
    layer.lineTo(s * 0.4, s);
    layer.closePath();
    layer.fill();
  });
  glow(ctx, s, 0.5, 0.36, 0.5, '#ffffff', 0.25);
  vignette(ctx, s, '#5b4a3a', 0.22, 0.45);
};

const stage: Painter = (ctx, s) => {
  linear(ctx, s, 90, [
    [0, '#07070d'],
    [HORIZON, '#12121d'],
    [HORIZON, '#0c0c14'],
    [1, '#040407'],
  ]);
  blurred(ctx, s, 0.02, (layer) => {
    const beams: [number, number, string][] = [
      [0.18, 0.56, '#7a5cff'],
      [0.82, 0.44, '#22d3ee'],
    ];
    for (const [from, to, color] of beams) {
      const gradient = layer.createLinearGradient(from * s, 0, to * s, s * (HORIZON + 0.08));
      gradient.addColorStop(0, rgba(color, 0.55));
      gradient.addColorStop(1, rgba(color, 0.04));
      layer.fillStyle = gradient;
      layer.beginPath();
      layer.moveTo(s * (from - 0.02), 0);
      layer.lineTo(s * (from + 0.02), 0);
      layer.lineTo(s * (to + 0.16), s * (HORIZON + 0.1));
      layer.lineTo(s * (to - 0.16), s * (HORIZON + 0.1));
      layer.closePath();
      layer.fill();
    }
    layer.fillStyle = rgba('#b9a8ff', 0.3);
    ellipse(layer, s * 0.5, s * (HORIZON + 0.08), s * 0.3, s * 0.04);
  });
  glow(ctx, s, 0.5, HORIZON + 0.06, 0.3, '#8f7bff', 0.25);
  vignette(ctx, s, '#000000', 0.6, 0.35);
};

/** Painter and film-grain amount (0 = none) of every stock background, keyed by stock id. */
export const BACKGROUND_PAINTERS = {
  'bg-aurora': { paint: aurora, grain: 3 },
  'bg-sunset': { paint: sunset, grain: 3 },
  'bg-ocean': { paint: ocean, grain: 3 },
  'bg-mint': { paint: mint, grain: 2 },
  'bg-paper': { paint: paper, grain: 5 },
  'bg-midnight': { paint: midnight, grain: 3 },
  'bg-dots': { paint: dots, grain: 2 },
  'bg-grid': { paint: grid, grain: 2 },
  'bg-waves': { paint: waves, grain: 2 },
  'bg-confetti': { paint: confetti, grain: 2 },
  'bg-diagonal': { paint: diagonal, grain: 2 },
  'bg-bokeh': { paint: bokeh, grain: 3 },
  'bg-rays': { paint: rays, grain: 2 },
  'bg-studio-dark': { paint: studioDark, grain: 3 },
  'bg-studio-light': { paint: studioLight, grain: 2 },
  'bg-newsroom': { paint: newsroom, grain: 3 },
  'bg-office': { paint: office, grain: 2 },
  'bg-stage': { paint: stage, grain: 3 },
} as const satisfies Record<string, { paint: Painter; grain: number }>;

export type BackgroundId = keyof typeof BACKGROUND_PAINTERS;

/** Luma noise that hides gradient banding after 8-bit quantisation and JPEG. */
function addGrain(ctx: Ctx, width: number, height: number, amount: number, seed: number): void {
  if (amount <= 0) return;
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const rng = new Rng(seed);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng.next() + rng.next() - 1) * amount;
    data[i] = (data[i] as number) + n;
    data[i + 1] = (data[i + 1] as number) + n;
    data[i + 2] = (data[i + 2] as number) + n;
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Paint a stock background at any size. The square design is centred and cropped ("cover"),
 * so `renderBackground(id, 1920, 1080)` shows exactly what the 16:9 crop of the master shows.
 */
export function renderBackground(id: BackgroundId, width: number, height: number): Canvas {
  const entry = BACKGROUND_PAINTERS[id];
  const w = Math.round(width);
  const h = Math.round(height);
  const side = Math.max(w, h);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate((w - side) / 2, (h - side) / 2);
  ctx.beginPath();
  ctx.rect(0, 0, side, side);
  ctx.clip();
  entry.paint(ctx, side);
  ctx.restore();
  let seed = 7;
  for (let i = 0; i < id.length; i += 1) seed = (Math.imul(seed, 31) + id.charCodeAt(i)) >>> 0;
  addGrain(ctx, w, h, entry.grain * (side / BACKGROUND_MASTER_SIZE) ** 0.5, seed);
  return canvas;
}
