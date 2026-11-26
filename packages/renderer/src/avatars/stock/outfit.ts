import type { Ctx2D } from '../../types';
import {
  addBlob,
  fillBlob,
  fillEllipse,
  fillPoly,
  softSpot,
  strokeCurve,
  symmetric,
} from './paths';
import type { Pt } from './paths';
import type { CharacterSpec, Palette } from './spec';

/* -------------------------------------------------------------------------------------------
 * Body and clothes, in character space (chin at the origin, shoulders at about y = 0.5,
 * waist at about y = 2.5). The torso always extends far below the framing window, so the
 * figure meets the bottom edge of the box in every framing.
 * ----------------------------------------------------------------------------------------- */

const BOTTOM = 4.6;

function torsoOutline(spec: CharacterSpec): Pt[] {
  const s = spec.shoulders;
  const n = spec.neck;
  return symmetric([
    [0, 0.33],
    [n * 1.35, 0.315],
    [s * 0.55, 0.365],
    [s * 0.9, 0.425],
    [s + 0.05, 0.6],
    [s + 0.1, 0.98],
    [s + 0.115, 1.7],
    [s + 0.085, 2.5],
    [s + 0.06, BOTTOM, 1],
    [0, BOTTOM, 1],
  ]);
}

function line(ctx: Ctx2D, pal: Palette, pts: readonly Pt[], width = 0.011): void {
  strokeCurve(ctx, pts, pal.outfitLine, width);
}

/** Skin showing inside a neckline, with the shadow the chin casts on it. */
function skinPatch(ctx: Ctx2D, pal: Palette, pts: readonly Pt[], smooth = true): void {
  ctx.save();
  ctx.beginPath();
  if (smooth) addBlob(ctx, pts);
  else {
    const first = pts[0] as Pt;
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo((pts[i] as Pt)[0], (pts[i] as Pt)[1]);
    ctx.closePath();
  }
  ctx.fillStyle = pal.skin;
  ctx.fill();
  ctx.clip();
  softSpot(ctx, 0, 0.2, 0.34, 0.2, pal.skinShadeSoft, pal.skinShadeClear);
  ctx.restore();
}

function mirrored(ctx: Ctx2D, draw: () => void): void {
  draw();
  ctx.save();
  ctx.scale(-1, 1);
  draw();
  ctx.restore();
}

/** Sleeve seams and the line between arm and torso (visible in `half` framing). */
function sleeves(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const s = spec.shoulders;
  mirrored(ctx, () => {
    // The arm hangs in front of the flank: a soft shadow on the torso side of the line.
    ctx.beginPath();
    ctx.moveTo(s - 0.17, 1.04);
    ctx.bezierCurveTo(s - 0.13, 1.6, s - 0.16, 2.3, s - 0.17, BOTTOM);
    ctx.lineTo(s - 0.33, BOTTOM);
    ctx.bezierCurveTo(s - 0.3, 2.3, s - 0.24, 1.6, s - 0.17, 1.04);
    ctx.closePath();
    const fold = ctx.createLinearGradient(s - 0.16, 0, s - 0.32, 0);
    fold.addColorStop(0, 'rgba(8,6,26,0.26)');
    fold.addColorStop(1, 'rgba(8,6,26,0)');
    ctx.fillStyle = fold;
    ctx.fill();
    line(
      ctx,
      pal,
      [
        [s - 0.17, 1.04],
        [s - 0.14, 1.7],
        [s - 0.16, 2.5],
        [s - 0.17, BOTTOM],
      ],
      0.013,
    );
    line(
      ctx,
      pal,
      [
        [s * 0.93, 0.5],
        [s - 0.07, 0.74],
        [s - 0.16, 1.06],
      ],
      0.008,
    );
  });
}

function button(ctx: Ctx2D, x: number, y: number, r: number, fill: string, rim: string): void {
  fillEllipse(ctx, x, y + r * 0.2, r, r, rim);
  fillEllipse(ctx, x, y, r, r, fill);
}

/** Notched lapels of a blazer / suit jacket, closing at `closeY`. */
function lapels(ctx: Ctx2D, pal: Palette, spec: CharacterSpec, closeY: number): void {
  const n = spec.neck;
  mirrored(ctx, () => {
    const lapel: Pt[] = [
      [n * 0.95, 0.2, 1],
      [0.3, 0.37],
      [0.4, 0.6, 1],
      [0.325, 0.615, 1],
      [0.38, 0.76, 1],
      [0.03, closeY, 1],
      [0.105, 0.78],
      [0.175, 0.44],
    ];
    ctx.beginPath();
    addBlob(ctx, lapel);
    ctx.fillStyle = pal.outfitLight;
    ctx.fill();
    ctx.strokeStyle = pal.outfitLine;
    ctx.lineWidth = 0.009;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

/** Front edge of a closed jacket below its closure. */
function frontEdge(ctx: Ctx2D, pal: Palette, closeY: number): void {
  line(ctx, pal, [
    [0.03, closeY],
    [0.02, closeY + 0.5],
    [0.03, BOTTOM],
  ]);
}

function shirtCollar(ctx: Ctx2D, pal: Palette, spec: CharacterSpec, fill: string): void {
  const n = spec.neck;
  mirrored(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(n * 0.98, 0.17);
    ctx.quadraticCurveTo(0.235, 0.26, 0.225, 0.42);
    ctx.lineTo(0.092, 0.555);
    ctx.lineTo(0.0, 0.365);
    ctx.quadraticCurveTo(n * 0.6, 0.33, n * 0.98, 0.17);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,36,60,0.28)';
    ctx.lineWidth = 0.008;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

function drawBlazer(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // Blouse inside the V, with a soft round neckline.
  fillPoly(
    ctx,
    [
      [-0.3, 0.28],
      [0.3, 0.28],
      [0.07, 1.22],
      [-0.07, 1.22],
    ],
    pal.inner,
  );
  skinPatch(ctx, pal, [
    [-0.21, 0.2],
    [-0.17, 0.36],
    [0, 0.475],
    [0.17, 0.36],
    [0.21, 0.2],
    [0, 0.1],
  ]);
  strokeCurve(
    ctx,
    [
      [-0.2, 0.27],
      [-0.165, 0.37],
      [0, 0.482],
      [0.165, 0.37],
      [0.2, 0.27],
    ],
    pal.innerShade,
    0.012,
  );
  frontEdge(ctx, pal, 1.2);
  button(ctx, 0.03, 1.36, 0.03, pal.accent, pal.outfitDeep);
  button(ctx, 0.03, 1.72, 0.03, pal.accent, pal.outfitDeep);
  sleeves(ctx, pal, spec);
  // breast welt pocket
  line(ctx, pal, [
    [0.34, 1.04],
    [0.56, 1.015],
  ]);
}

function drawSuit(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  fillPoly(
    ctx,
    [
      [-0.3, 0.26],
      [0.3, 0.26],
      [0.07, 1.26],
      [-0.07, 1.26],
    ],
    pal.inner,
  );
  // Tie: blade first, then the knot.
  fillPoly(
    ctx,
    [
      [-0.036, 0.46],
      [0.036, 0.46],
      [0.092, 1.12],
      [0, 1.25],
      [-0.092, 1.12],
    ],
    pal.accent,
  );
  fillPoly(
    ctx,
    [
      [0, 0.46],
      [0.036, 0.46],
      [0.092, 1.12],
      [0, 1.25],
    ],
    pal.accentShade,
  );
  fillPoly(
    ctx,
    [
      [-0.058, 0.36],
      [0.058, 0.36],
      [0.036, 0.475],
      [-0.036, 0.475],
    ],
    pal.accent,
  );
  strokeCurve(
    ctx,
    [
      [-0.04, 0.47],
      [0, 0.482],
      [0.04, 0.47],
    ],
    pal.accentShade,
    0.008,
  );
  frontEdge(ctx, pal, 1.24);
  button(ctx, 0.03, 1.42, 0.03, pal.outfitDeep, pal.outfitDeep);
  sleeves(ctx, pal, spec);
  // pocket square
  fillPoly(
    ctx,
    [
      [0.36, 1.03],
      [0.4, 0.97],
      [0.45, 1.01],
      [0.5, 0.965],
      [0.55, 1.012],
    ],
    pal.accent,
  );
  line(ctx, pal, [
    [0.34, 1.035],
    [0.57, 1.012],
  ]);
}

function shirtOpenCollar(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const n = spec.neck;
  mirrored(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(n * 0.98, 0.16);
    ctx.quadraticCurveTo(0.27, 0.27, 0.275, 0.43);
    ctx.lineTo(0.165, 0.66);
    ctx.lineTo(0.0, 0.6);
    ctx.quadraticCurveTo(n * 0.55, 0.42, n * 0.98, 0.16);
    ctx.closePath();
    ctx.fillStyle = pal.outfitLight;
    ctx.fill();
    ctx.strokeStyle = pal.outfitLine;
    ctx.lineWidth = 0.009;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

function drawShirt(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  skinPatch(
    ctx,
    pal,
    [
      [-0.15, 0.18],
      [0.15, 0.18],
      [0, 0.6],
    ],
    false,
  );
  // Placket and buttons.
  line(
    ctx,
    pal,
    [
      [-0.045, 0.62],
      [-0.045, BOTTOM],
    ],
    0.008,
  );
  line(
    ctx,
    pal,
    [
      [0.045, 0.62],
      [0.045, BOTTOM],
    ],
    0.008,
  );
  for (let y = 0.78; y < BOTTOM; y += 0.36) {
    button(ctx, 0, y, 0.02, pal.accent, pal.outfitDeep);
  }
  sleeves(ctx, pal, spec);
  // Chest pocket with a pen.
  ctx.strokeStyle = pal.outfitLine;
  ctx.lineWidth = 0.009;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0.31, 0.98);
  ctx.lineTo(0.56, 0.98);
  ctx.lineTo(0.56, 1.22);
  ctx.quadraticCurveTo(0.435, 1.3, 0.31, 1.22);
  ctx.closePath();
  ctx.stroke();
  fillPoly(
    ctx,
    [
      [0.49, 0.9],
      [0.515, 0.9],
      [0.515, 1.06],
      [0.49, 1.06],
    ],
    pal.accent,
  );
  // yoke
  mirrored(ctx, () =>
    line(
      ctx,
      pal,
      [
        [0.26, 0.4],
        [spec.shoulders * 0.92, 0.56],
      ],
      0.007,
    ),
  );
}

function drawTee(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // Ribbed crew collar around a round neckline.
  fillBlob(
    ctx,
    [
      [-0.26, 0.2],
      [-0.225, 0.38],
      [0, 0.52],
      [0.225, 0.38],
      [0.26, 0.2],
      [0, 0.08],
    ],
    pal.accent,
  );
  skinPatch(ctx, pal, [
    [-0.2, 0.18],
    [-0.168, 0.345],
    [0, 0.452],
    [0.168, 0.345],
    [0.2, 0.18],
    [0, 0.08],
  ]);
  sleeves(ctx, pal, spec);
  // Small chest mark and a few folds.
  fillEllipse(ctx, 0.4, 1.0, 0.055, 0.055, pal.accent);
  fillPoly(
    ctx,
    [
      [0.383, 0.972],
      [0.43, 1.0],
      [0.383, 1.028],
    ],
    pal.outfit,
  );
  line(
    ctx,
    pal,
    [
      [-0.3, 0.62],
      [-0.18, 0.72],
      [-0.02, 0.74],
    ],
    0.007,
  );
  line(
    ctx,
    pal,
    [
      [0.34, 0.6],
      [0.24, 0.69],
    ],
    0.007,
  );
}

function hoodieCollar(ctx: Ctx2D, pal: Palette): void {
  // Hood folded around the neck: two overlapping bands.
  mirrored(ctx, () => {
    ctx.beginPath();
    addBlob(ctx, [
      [0.2, 0.12, 1],
      [0.36, 0.2],
      [0.47, 0.4],
      [0.3, 0.62],
      [0.02, 0.84, 1],
      [0.03, 0.62],
      [0.17, 0.44],
    ]);
    ctx.fillStyle = pal.outfitLight;
    ctx.fill();
    ctx.strokeStyle = pal.outfitLine;
    ctx.lineWidth = 0.009;
    ctx.stroke();
  });
  // Drawstrings.
  mirrored(ctx, () => {
    strokeCurve(
      ctx,
      [
        [0.09, 0.7],
        [0.1, 0.9],
        [0.115, 1.16],
      ],
      pal.accent,
      0.02,
    );
    fillEllipse(ctx, 0.117, 1.19, 0.016, 0.034, pal.accentShade);
  });
}

function drawHoodie(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // T-shirt at the neck.
  fillBlob(
    ctx,
    [
      [-0.25, 0.2],
      [-0.2, 0.42],
      [0, 0.6],
      [0.2, 0.42],
      [0.25, 0.2],
      [0, 0.08],
    ],
    pal.inner,
  );
  skinPatch(ctx, pal, [
    [-0.2, 0.18],
    [-0.165, 0.34],
    [0, 0.44],
    [0.165, 0.34],
    [0.2, 0.18],
    [0, 0.08],
  ]);
  sleeves(ctx, pal, spec);
  // Kangaroo pocket (half framing).
  ctx.strokeStyle = pal.outfitLine;
  ctx.lineWidth = 0.011;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-0.42, 2.9);
  ctx.lineTo(-0.34, 2.0);
  ctx.lineTo(0.34, 2.0);
  ctx.lineTo(0.42, 2.9);
  ctx.stroke();
}

function jacketCollar(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const n = spec.neck;
  mirrored(ctx, () => {
    // wide soft collar
    ctx.beginPath();
    addBlob(ctx, [
      [n * 0.96, 0.18, 1],
      [0.33, 0.33],
      [0.47, 0.56, 1],
      [0.34, 0.8, 1],
      [0.2, 0.62],
      [0.185, 0.42],
    ]);
    ctx.fillStyle = pal.outfitLight;
    ctx.fill();
    ctx.strokeStyle = pal.outfitLine;
    ctx.lineWidth = 0.009;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

function drawJacket(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // Open jacket over a round-neck top.
  fillPoly(
    ctx,
    [
      [-0.3, 0.26],
      [0.3, 0.26],
      [0.2, BOTTOM],
      [-0.2, BOTTOM],
    ],
    pal.inner,
  );
  skinPatch(ctx, pal, [
    [-0.21, 0.18],
    [-0.175, 0.36],
    [0, 0.49],
    [0.175, 0.36],
    [0.21, 0.18],
    [0, 0.08],
  ]);
  strokeCurve(
    ctx,
    [
      [-0.2, 0.27],
      [-0.17, 0.37],
      [0, 0.498],
      [0.17, 0.37],
      [0.2, 0.27],
    ],
    pal.innerShade,
    0.014,
  );
  mirrored(ctx, () => {
    // front panel edge
    line(ctx, pal, [
      [0.2, 0.62],
      [0.19, 1.6],
      [0.2, BOTTOM],
    ]);
    // chest pocket flap
    ctx.beginPath();
    ctx.moveTo(0.31, 1.06);
    ctx.lineTo(0.58, 1.04);
    ctx.lineTo(0.58, 1.14);
    ctx.lineTo(0.445, 1.2);
    ctx.lineTo(0.31, 1.16);
    ctx.closePath();
    ctx.stroke();
    button(ctx, 0.445, 1.13, 0.018, pal.accent, pal.outfitDeep);
  });
  sleeves(ctx, pal, spec);
  // pendant
  strokeCurve(
    ctx,
    [
      [-0.16, 0.3],
      [-0.08, 0.5],
      [0, 0.58],
      [0.08, 0.5],
      [0.16, 0.3],
    ],
    pal.accent,
    0.009,
  );
  fillEllipse(ctx, 0, 0.6, 0.03, 0.03, pal.accent);
}

function drawSweater(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // Chest stripes in the accent colour (clipped to the torso by the caller).
  ctx.fillStyle = pal.accent;
  ctx.fillRect(-2, 1.02, 4, 0.13);
  ctx.fillRect(-2, 1.23, 4, 0.045);
  // Thick ribbed collar.
  fillBlob(
    ctx,
    [
      [-0.27, 0.18],
      [-0.24, 0.39],
      [0, 0.54],
      [0.24, 0.39],
      [0.27, 0.18],
      [0, 0.06],
    ],
    pal.outfitShade,
  );
  skinPatch(ctx, pal, [
    [-0.2, 0.16],
    [-0.165, 0.33],
    [0, 0.43],
    [0.165, 0.33],
    [0.2, 0.16],
    [0, 0.06],
  ]);
  // Rib lines.
  ctx.strokeStyle = pal.outfitLine;
  ctx.lineWidth = 0.007;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = -5; i <= 5; i += 1) {
    const a = (i / 5) * 1.05;
    const sx = Math.sin(a);
    const cy = Math.cos(a);
    ctx.moveTo(sx * 0.178, 0.25 + cy * 0.19);
    ctx.lineTo(sx * 0.236, 0.27 + cy * 0.262);
  }
  ctx.stroke();
  sleeves(ctx, pal, spec);
}

function bomberCollar(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const n = spec.neck;
  // Ribbed stand collar with two accent stripes.
  // The band hugs the neck and closes at the zip.
  const collar: Pt[] = [
    [-n - 0.045, 0.275],
    [-n - 0.02, 0.37],
    [-0.09, 0.455],
    [0, 0.485],
  ];
  mirrored(ctx, () => {
    strokeCurve(ctx, collar, pal.outfitDeep, 0.1);
    strokeCurve(ctx, collar, pal.accent, 0.046);
    strokeCurve(ctx, collar, pal.outfitDeep, 0.02);
  });
  fillPoly(
    ctx,
    [
      [-0.022, 0.56],
      [0.022, 0.56],
      [0.016, 0.69],
      [-0.016, 0.69],
    ],
    pal.accent,
  );
}

function drawBomber(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // T-shirt and skin inside the collar.
  fillBlob(
    ctx,
    [
      [-0.24, 0.2],
      [-0.2, 0.38],
      [0, 0.5],
      [0.2, 0.38],
      [0.24, 0.2],
      [0, 0.08],
    ],
    pal.inner,
  );
  skinPatch(ctx, pal, [
    [-0.2, 0.18],
    [-0.16, 0.31],
    [0, 0.385],
    [0.16, 0.31],
    [0.2, 0.18],
    [0, 0.08],
  ]);
  // Zip.
  strokeCurve(
    ctx,
    [
      [0, 0.52],
      [0, BOTTOM],
    ],
    pal.outfitDeep,
    0.03,
  );
  strokeCurve(
    ctx,
    [
      [0, 0.52],
      [0, BOTTOM],
    ],
    pal.metal,
    0.008,
  );
  // Raglan seams.
  const s = spec.shoulders;
  mirrored(ctx, () =>
    line(ctx, pal, [
      [0.25, 0.4],
      [s * 0.62, 0.7],
      [s - 0.16, 1.06],
    ]),
  );
  sleeves(ctx, pal, spec);
  // Chest zip pocket.
  strokeCurve(
    ctx,
    [
      [0.3, 1.12],
      [0.56, 1.08],
    ],
    pal.outfitDeep,
    0.018,
  );
  fillEllipse(ctx, 0.31, 1.12, 0.018, 0.018, pal.accent);
}

function blouseCollar(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  // Soft collar bands along the V.
  const n = spec.neck;
  mirrored(ctx, () => {
    ctx.beginPath();
    addBlob(ctx, [
      [n * 0.98, 0.17, 1],
      [0.32, 0.31],
      [0.34, 0.46],
      [0.04, 0.99, 1],
      [0.0, 0.86, 1],
      [0.14, 0.52],
    ]);
    ctx.fillStyle = pal.outfitLight;
    ctx.fill();
    ctx.strokeStyle = pal.outfitLine;
    ctx.lineWidth = 0.008;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

function drawBlouse(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  skinPatch(
    ctx,
    pal,
    [
      [-0.24, 0.16],
      [0.24, 0.16],
      [0, 0.86],
    ],
    false,
  );
  // Necklace with a small pendant.
  strokeCurve(
    ctx,
    [
      [-0.15, 0.27],
      [-0.08, 0.44],
      [0, 0.5],
      [0.08, 0.44],
      [0.15, 0.27],
    ],
    pal.metal,
    0.007,
  );
  fillEllipse(ctx, 0, 0.525, 0.022, 0.028, pal.metal);
  sleeves(ctx, pal, spec);
  // Drape folds from the shoulders.
  mirrored(ctx, () => {
    line(
      ctx,
      pal,
      [
        [0.36, 0.56],
        [0.25, 0.9],
        [0.1, 1.2],
      ],
      0.007,
    );
    line(
      ctx,
      pal,
      [
        [0.5, 0.7],
        [0.4, 1.0],
      ],
      0.007,
    );
  });
  // button below the V
  button(ctx, 0.0, 1.16, 0.018, pal.accent, pal.outfitDeep);
  button(ctx, 0.0, 1.5, 0.018, pal.accent, pal.outfitDeep);
}

/** What goes BEHIND the neck (the hood of a hoodie, the back of a collar). */
export function drawOutfitBack(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  if (spec.outfitStyle === 'hoodie') {
    fillBlob(
      ctx,
      [
        [-0.54, 0.5],
        [-0.46, 0.16],
        [-0.25, -0.02],
        [0, -0.06],
        [0.25, -0.02],
        [0.46, 0.16],
        [0.54, 0.5],
        [0, 0.6],
      ],
      pal.outfitShade,
    );
  } else if (spec.outfitStyle === 'suit' || spec.outfitStyle === 'shirt') {
    // Back of the shirt collar hugging the neck.
    const n = spec.neck;
    fillBlob(
      ctx,
      [
        [-n - 0.03, 0.34],
        [-n - 0.018, 0.17],
        [0, 0.13],
        [n + 0.018, 0.17],
        [n + 0.03, 0.34],
      ],
      spec.outfitStyle === 'suit' ? pal.innerShade : pal.outfitShade,
    );
  }
}

/** Torso silhouette with its shading, then the garment on top. */
export function drawOutfit(ctx: Ctx2D, pal: Palette, spec: CharacterSpec): void {
  const s = spec.shoulders;
  ctx.save();
  ctx.beginPath();
  addBlob(ctx, torsoOutline(spec));
  const body = ctx.createLinearGradient(0, 0.3, 0, 3.2);
  body.addColorStop(0, pal.outfitLight);
  body.addColorStop(0.25, pal.outfit);
  body.addColorStop(1, pal.outfitShade);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.clip();
  // Rounded form: the sides fall into shadow, the far side a little more.
  // (Two narrow translucent strips: blending a gradient over the whole torso is far dearer.)
  const near = ctx.createLinearGradient(-s - 0.13, 0, -s + 0.22, 0);
  near.addColorStop(0, 'rgba(10,8,30,0.22)');
  near.addColorStop(1, 'rgba(10,8,30,0)');
  ctx.fillStyle = near;
  ctx.fillRect(-s - 0.2, 0.2, 0.42, BOTTOM);
  const far = ctx.createLinearGradient(s - 0.36, 0, s + 0.13, 0);
  far.addColorStop(0, 'rgba(10,8,30,0)');
  far.addColorStop(1, 'rgba(10,8,30,0.3)');
  ctx.fillStyle = far;
  ctx.fillRect(s - 0.36, 0.2, 0.56, BOTTOM);

  switch (spec.outfitStyle) {
    case 'blazer':
      drawBlazer(ctx, pal, spec);
      break;
    case 'suit':
      drawSuit(ctx, pal, spec);
      break;
    case 'shirt':
      drawShirt(ctx, pal, spec);
      break;
    case 'tee':
      drawTee(ctx, pal, spec);
      break;
    case 'hoodie':
      drawHoodie(ctx, pal, spec);
      break;
    case 'jacket':
      drawJacket(ctx, pal, spec);
      break;
    case 'sweater':
      drawSweater(ctx, pal, spec);
      break;
    case 'bomber':
      drawBomber(ctx, pal, spec);
      break;
    case 'blouse':
      drawBlouse(ctx, pal, spec);
      break;
  }
  // Shadow of the head on the chest.
  softSpot(ctx, 0.02, 0.36, 0.36, 0.13, 'rgba(12,8,28,0.2)', 'rgba(12,8,28,0)');
  ctx.restore();

  // Collars rise above the shoulder line, so they are not clipped to the torso.
  switch (spec.outfitStyle) {
    case 'blazer':
      lapels(ctx, pal, spec, 1.2);
      break;
    case 'suit':
      shirtCollar(ctx, pal, spec, pal.inner);
      lapels(ctx, pal, spec, 1.24);
      break;
    case 'shirt':
      shirtOpenCollar(ctx, pal, spec);
      break;
    case 'hoodie':
      hoodieCollar(ctx, pal);
      break;
    case 'jacket':
      jacketCollar(ctx, pal, spec);
      break;
    case 'bomber':
      bomberCollar(ctx, pal, spec);
      break;
    case 'blouse':
      blouseCollar(ctx, pal, spec);
      break;
    case 'tee':
    case 'sweater':
      break;
  }
}
