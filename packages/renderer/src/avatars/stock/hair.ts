import type { Ctx2D } from '../../types';
import { addBlob, fillBlob, fillEllipse, mirror, strokeCurve } from './paths';
import type { Pt } from './paths';
import type { HairStyle, Palette } from './spec';

/* -------------------------------------------------------------------------------------------
 * Hair styles, in character space (crown of the skull at y = -1, eye line at -0.45, ears at
 * about (±0.385, -0.4), chin at the origin). Each style paints up to three passes:
 *
 *   back   behind the neck and the body (long hair, ponytail, the mass of a bob or an afro)
 *   mid    in front of the shoulders but behind the face (locks resting on the chest)
 *   front  over the skull and forehead
 *
 * `frontPath` only traces the front outline: the head uses it to cast the hair's shadow on
 * the forehead.
 * ----------------------------------------------------------------------------------------- */

export interface HairDrawer {
  back(ctx: Ctx2D, pal: Palette): void;
  mid(ctx: Ctx2D, pal: Palette): void;
  front(ctx: Ctx2D, pal: Palette): void;
  frontPath(ctx: Ctx2D): void;
  /** The style hides the ears (they are then not drawn at all). */
  coversEars: boolean;
}

const none = (): void => {};

function gloss(ctx: Ctx2D, pal: Palette, strokes: readonly (readonly Pt[])[], width = 0.016): void {
  for (const s of strokes) strokeCurve(ctx, s, pal.hairGloss, width);
}

function lines(
  ctx: Ctx2D,
  color: string,
  strokes: readonly (readonly Pt[])[],
  width = 0.007,
): void {
  ctx.save();
  ctx.globalAlpha *= 0.55;
  for (const s of strokes) strokeCurve(ctx, s, color, width);
  ctx.restore();
}

function simple(
  frontPts: readonly Pt[],
  extras: {
    back?: (ctx: Ctx2D, pal: Palette) => void;
    mid?: (ctx: Ctx2D, pal: Palette) => void;
    detail?: (ctx: Ctx2D, pal: Palette) => void;
    coversEars?: boolean;
    clipDetail?: boolean;
  } = {},
): HairDrawer {
  const frontPath = (ctx: Ctx2D): void => {
    ctx.beginPath();
    addBlob(ctx, frontPts);
  };
  return {
    back: extras.back ?? none,
    mid: extras.mid ?? none,
    front(ctx, pal) {
      frontPath(ctx);
      ctx.fillStyle = pal.hair;
      ctx.fill();
      if (extras.detail) {
        // Only styles whose detail reaches the outline (fades, undercuts) pay for a clip.
        ctx.save();
        if (extras.clipDetail) {
          frontPath(ctx);
          ctx.clip();
        }
        extras.detail(ctx, pal);
        ctx.restore();
      }
    },
    frontPath,
    coversEars: extras.coversEars ?? false,
  };
}

/** Lighter band low on the sides: the faded / tapered look of short cuts. */
function fade(ctx: Ctx2D, pal: Palette, from: number, to: number): void {
  const g = ctx.createLinearGradient(0, from, 0, to);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, pal.skin);
  ctx.save();
  ctx.globalAlpha *= 0.34;
  ctx.fillStyle = g;
  ctx.fillRect(-0.47, from, 0.94, to - from + 0.06);
  ctx.restore();
}

/* ------------------------------------------------------------------------------ short cuts */

const shortCrop = (): HairDrawer =>
  simple(
    [
      [-0.398, -0.5, 1],
      [-0.425, -0.72],
      [-0.39, -0.93],
      [-0.25, -1.075],
      [-0.04, -1.12],
      [0.2, -1.1],
      [0.36, -0.98],
      [0.425, -0.76],
      [0.398, -0.5, 1],
      [0.36, -0.6],
      [0.342, -0.72],
      [0.29, -0.81, 1],
      [0.16, -0.842],
      [0.02, -0.826],
      [-0.12, -0.846],
      [-0.27, -0.812, 1],
      [-0.34, -0.72],
      [-0.36, -0.6],
    ],
    {
      clipDetail: true,
      detail(ctx, pal) {
        fade(ctx, pal, -0.82, -0.5);
        gloss(ctx, pal, [
          [
            [-0.24, -0.98],
            [-0.08, -1.05],
            [0.1, -1.045],
          ],
          [
            [-0.3, -0.9],
            [-0.2, -0.95],
          ],
        ]);
        lines(ctx, pal.hairDeep, [
          [
            [0.05, -0.84],
            [0.12, -0.95],
            [0.26, -1.0],
          ],
          [
            [-0.1, -0.85],
            [-0.02, -0.96],
          ],
        ]);
      },
    },
  );

const shortNeat = (): HairDrawer =>
  simple(
    [
      [-0.396, -0.46, 1],
      [-0.418, -0.72],
      [-0.38, -0.92],
      [-0.24, -1.052],
      [-0.02, -1.085],
      [0.2, -1.07],
      [0.36, -0.95],
      [0.418, -0.74],
      [0.396, -0.46, 1],
      [0.358, -0.52],
      [0.348, -0.68],
      [0.31, -0.79, 1],
      [0.18, -0.83],
      [0.0, -0.822],
      [-0.17, -0.84],
      [-0.285, -0.8, 1],
      [-0.345, -0.68],
      [-0.358, -0.52],
    ],
    {
      clipDetail: true,
      detail(ctx, pal) {
        fade(ctx, pal, -0.74, -0.42);
        gloss(ctx, pal, [
          [
            [-0.2, -1.0],
            [0.0, -1.04],
            [0.2, -1.01],
          ],
        ]);
        // side part
        lines(ctx, pal.hairDeep, [
          [
            [-0.2, -0.83],
            [-0.22, -0.95],
            [-0.16, -1.04],
          ],
        ]);
      },
    },
  );

const shortReceding = (): HairDrawer =>
  simple(
    [
      [-0.4, -0.47, 1],
      [-0.428, -0.7],
      [-0.39, -0.9],
      [-0.25, -1.035],
      [0, -1.06],
      [0.25, -1.035],
      [0.39, -0.9],
      [0.428, -0.7],
      [0.4, -0.47, 1],
      [0.36, -0.56],
      [0.348, -0.7],
      [0.3, -0.84],
      [0.21, -0.915, 1],
      [0.12, -0.875],
      [0, -0.862],
      [-0.12, -0.875],
      [-0.21, -0.915, 1],
      [-0.3, -0.84],
      [-0.348, -0.7],
      [-0.36, -0.56],
    ],
    {
      clipDetail: true,
      detail(ctx, pal) {
        fade(ctx, pal, -0.7, -0.4);
        gloss(ctx, pal, [
          [
            [-0.3, -0.93],
            [-0.14, -1.0],
            [0.06, -1.015],
          ],
          [
            [0.36, -0.7],
            [0.385, -0.8],
          ],
        ]);
        lines(ctx, pal.hairShade, [
          [
            [-0.37, -0.62],
            [-0.39, -0.76],
            [-0.33, -0.9],
          ],
          [
            [0.02, -0.87],
            [0.1, -0.97],
            [0.24, -1.0],
          ],
        ]);
      },
    },
  );

const fringe = (): HairDrawer =>
  simple(
    [
      [-0.405, -0.44, 1],
      [-0.45, -0.7],
      [-0.4, -0.95],
      [-0.24, -1.095],
      [0, -1.135],
      [0.24, -1.1],
      [0.405, -0.95],
      [0.45, -0.7],
      [0.405, -0.44, 1],
      [0.372, -0.55],
      [0.345, -0.61, 1],
      [0.27, -0.585],
      [0.2, -0.625, 1],
      [0.11, -0.59],
      [0.03, -0.63, 1],
      [-0.07, -0.596],
      [-0.16, -0.632, 1],
      [-0.25, -0.59],
      [-0.335, -0.615, 1],
      [-0.372, -0.55],
    ],
    {
      detail(ctx, pal) {
        gloss(
          ctx,
          pal,
          [
            [
              [-0.3, -0.86],
              [-0.16, -0.97],
              [0.04, -1.0],
              [0.22, -0.95],
            ],
          ],
          0.03,
        );
        lines(ctx, pal.hairDeep, [
          [
            [0.03, -0.63],
            [0.05, -0.76],
            [0.0, -0.9],
          ],
          [
            [0.2, -0.625],
            [0.23, -0.74],
            [0.2, -0.86],
          ],
          [
            [-0.16, -0.632],
            [-0.17, -0.75],
            [-0.12, -0.88],
          ],
          [
            [-0.335, -0.615],
            [-0.345, -0.72],
          ],
        ]);
      },
    },
  );

const pixie = (): HairDrawer =>
  simple(
    [
      [-0.395, -0.5, 1],
      [-0.425, -0.72],
      [-0.4, -0.94],
      [-0.27, -1.1],
      [-0.03, -1.17],
      [0.22, -1.15],
      [0.4, -1.02],
      [0.462, -0.8],
      [0.43, -0.6],
      [0.385, -0.52, 1],
      [0.36, -0.6],
      [0.33, -0.64, 1],
      [0.22, -0.63],
      [0.07, -0.69],
      [-0.1, -0.79],
      [-0.25, -0.86, 1],
      [-0.33, -0.76],
      [-0.358, -0.62],
    ],
    {
      clipDetail: true,
      detail(ctx, pal) {
        // Undercut on the avatar's right side.
        fillBlob(
          ctx,
          [
            [-0.44, -0.5],
            [-0.44, -0.8],
            [-0.36, -0.88],
            [-0.3, -0.8],
            [-0.34, -0.5],
          ],
          pal.hairShade,
        );
        fade(ctx, pal, -0.7, -0.42);
        gloss(
          ctx,
          pal,
          [
            [
              [-0.2, -0.98],
              [0.0, -1.08],
              [0.22, -1.04],
              [0.36, -0.9],
            ],
            [
              [-0.08, -0.84],
              [0.12, -0.9],
              [0.3, -0.8],
            ],
          ],
          0.024,
        );
        lines(ctx, pal.hairDeep, [
          [
            [-0.25, -0.86],
            [-0.05, -0.95],
            [0.2, -0.93],
            [0.38, -0.78],
          ],
          [
            [-0.1, -0.79],
            [0.1, -0.8],
            [0.3, -0.7],
          ],
        ]);
      },
    },
  );

/* ------------------------------------------------------------------------------ longer cuts */

const BOB_FRONT: readonly Pt[] = [
  [-0.42, -0.94],
  [-0.24, -1.09],
  [0, -1.125],
  [0.24, -1.09],
  [0.42, -0.94],
  [0.485, -0.68],
  [0.5, -0.38],
  [0.455, -0.13],
  [0.35, -0.075, 1],
  [0.378, -0.28],
  [0.392, -0.5],
  [0.355, -0.68],
  [0.27, -0.81],
  [0.15, -0.885, 1],
  [0.0, -0.83],
  [-0.17, -0.75],
  [-0.31, -0.67],
  [-0.392, -0.5],
  [-0.378, -0.28],
  [-0.35, -0.075, 1],
  [-0.455, -0.13],
  [-0.5, -0.38],
  [-0.485, -0.68],
];

const bob = (): HairDrawer =>
  simple(BOB_FRONT, {
    coversEars: true,
    back(ctx, pal) {
      fillBlob(
        ctx,
        [
          [0, -1.1],
          [0.3, -1.04],
          [0.47, -0.8],
          [0.505, -0.42],
          [0.46, -0.12],
          [0.33, -0.03],
          [0, -0.02],
          [-0.33, -0.03],
          [-0.46, -0.12],
          [-0.505, -0.42],
          [-0.47, -0.8],
          [-0.3, -1.04],
        ],
        pal.hairShade,
      );
    },
    detail(ctx, pal) {
      gloss(
        ctx,
        pal,
        [
          [
            [-0.3, -0.84],
            [-0.12, -0.96],
            [0.1, -1.02],
          ],
          [
            [0.43, -0.7],
            [0.46, -0.45],
            [0.43, -0.22],
          ],
          [
            [-0.44, -0.62],
            [-0.465, -0.4],
            [-0.43, -0.2],
          ],
        ],
        0.024,
      );
      lines(ctx, pal.hairShade, [
        [
          [0.15, -0.885],
          [0.0, -0.96],
          [-0.2, -0.93],
          [-0.38, -0.76],
        ],
        [
          [0.1, -0.86],
          [-0.1, -0.86],
          [-0.3, -0.74],
        ],
        [
          [0.3, -0.84],
          [0.41, -0.6],
          [0.42, -0.3],
        ],
      ]);
    },
  });

const LONG_WAVY_FRONT: readonly Pt[] = [
  [-0.41, -0.95],
  [-0.24, -1.095],
  [0, -1.13],
  [0.25, -1.095],
  [0.43, -0.94],
  [0.5, -0.68],
  [0.505, -0.4],
  [0.47, -0.2],
  [0.37, -0.12, 1],
  [0.382, -0.34],
  [0.392, -0.52],
  [0.36, -0.69],
  [0.27, -0.8],
  [0.1, -0.86],
  [-0.1, -0.9, 1],
  [-0.2, -0.82],
  [-0.31, -0.7],
  [-0.392, -0.54],
  [-0.382, -0.34],
  [-0.37, -0.12, 1],
  [-0.465, -0.2],
  [-0.5, -0.4],
  [-0.49, -0.68],
];

const longWavy = (): HairDrawer => {
  const lock: Pt[] = [
    [0.36, -0.3],
    [0.5, -0.24],
    [0.56, 0.02],
    [0.53, 0.26],
    [0.59, 0.5],
    [0.53, 0.74],
    [0.4, 0.88],
    [0.31, 0.7],
    [0.34, 0.44],
    [0.27, 0.2],
    [0.31, -0.04],
  ];
  return simple(LONG_WAVY_FRONT, {
    coversEars: true,
    back(ctx, pal) {
      fillBlob(
        ctx,
        [
          [0, -1.1],
          [0.3, -1.05],
          [0.48, -0.82],
          [0.53, -0.4],
          [0.5, -0.05],
          [0.58, 0.3],
          [0.55, 0.62],
          [0.42, 0.84],
          [0, 0.8],
          [-0.42, 0.84],
          [-0.55, 0.62],
          [-0.58, 0.3],
          [-0.5, -0.05],
          [-0.53, -0.4],
          [-0.48, -0.82],
          [-0.3, -1.05],
        ],
        pal.hairShade,
      );
    },
    mid(ctx, pal) {
      fillBlob(ctx, lock, pal.hair);
      fillBlob(ctx, mirror(lock), pal.hair);
      gloss(
        ctx,
        pal,
        [
          [
            [0.47, -0.1],
            [0.5, 0.1],
            [0.45, 0.3],
            [0.5, 0.52],
          ],
          [
            [-0.46, -0.12],
            [-0.49, 0.1],
            [-0.44, 0.3],
            [-0.48, 0.5],
          ],
        ],
        0.02,
      );
      lines(ctx, pal.hairShade, [
        [
          [0.41, -0.1],
          [0.42, 0.14],
          [0.46, 0.4],
          [0.43, 0.66],
        ],
        [
          [-0.41, -0.1],
          [-0.42, 0.14],
          [-0.46, 0.4],
          [-0.43, 0.66],
        ],
      ]);
    },
    detail(ctx, pal) {
      gloss(
        ctx,
        pal,
        [
          [
            [-0.04, -0.94],
            [0.16, -0.99],
            [0.34, -0.9],
          ],
          [
            [0.44, -0.72],
            [0.468, -0.5],
            [0.45, -0.3],
          ],
          [
            [-0.3, -0.92],
            [-0.41, -0.76],
            [-0.455, -0.55],
          ],
        ],
        0.024,
      );
      lines(ctx, pal.hairShade, [
        [
          [-0.1, -0.9],
          [-0.12, -1.0],
          [-0.06, -1.1],
        ],
        [
          [-0.08, -0.9],
          [0.12, -0.93],
          [0.33, -0.84],
          [0.43, -0.62],
        ],
        [
          [-0.13, -0.9],
          [-0.3, -0.84],
          [-0.42, -0.64],
        ],
      ]);
    },
  });
};

const LONG_STRAIGHT_FRONT: readonly Pt[] = [
  [-0.4, -0.95],
  [-0.23, -1.085],
  [0, -1.115],
  [0.23, -1.085],
  [0.4, -0.95],
  [0.462, -0.72],
  [0.445, -0.52],
  [0.4, -0.47, 1],
  [0.372, -0.6],
  [0.31, -0.73],
  [0.17, -0.85],
  [0.0, -0.935, 1],
  [-0.17, -0.85],
  [-0.31, -0.73],
  [-0.372, -0.6],
  [-0.4, -0.47, 1],
  [-0.445, -0.52],
  [-0.462, -0.72],
];

const longStraight = (): HairDrawer => {
  const lock: Pt[] = [
    [0.4, -0.22],
    [0.5, -0.1],
    [0.54, 0.3],
    [0.53, 0.7],
    [0.47, 1.0],
    [0.31, 0.95],
    [0.3, 0.6],
    [0.32, 0.2],
  ];
  return simple(LONG_STRAIGHT_FRONT, {
    back(ctx, pal) {
      fillBlob(
        ctx,
        [
          [0, -1.09],
          [0.3, -1.03],
          [0.455, -0.8],
          [0.48, -0.4],
          [0.5, 0.2],
          [0.52, 0.7],
          [0.46, 1.0],
          [0, 0.96],
          [-0.46, 1.0],
          [-0.52, 0.7],
          [-0.5, 0.2],
          [-0.48, -0.4],
          [-0.455, -0.8],
          [-0.3, -1.03],
        ],
        pal.hairShade,
      );
    },
    mid(ctx, pal) {
      fillBlob(ctx, lock, pal.hair);
      fillBlob(ctx, mirror(lock), pal.hair);
      gloss(
        ctx,
        pal,
        [
          [
            [0.455, 0.0],
            [0.475, 0.3],
            [0.455, 0.62],
          ],
          [
            [-0.455, 0.0],
            [-0.475, 0.3],
            [-0.455, 0.62],
          ],
        ],
        0.018,
      );
    },
    detail(ctx, pal) {
      gloss(
        ctx,
        pal,
        [
          [
            [0.08, -0.98],
            [0.26, -0.93],
            [0.39, -0.78],
          ],
          [
            [-0.08, -0.98],
            [-0.26, -0.93],
            [-0.39, -0.78],
          ],
        ],
        0.026,
      );
      lines(ctx, pal.hairDeep, [
        [
          [0, -0.935],
          [0, -1.03],
          [0, -1.115],
        ],
      ]);
    },
  });
};

const ponytail = (): HairDrawer =>
  simple(
    [
      [-0.392, -0.5, 1],
      [-0.412, -0.72],
      [-0.375, -0.92],
      [-0.23, -1.055],
      [0, -1.09],
      [0.23, -1.06],
      [0.38, -0.92],
      [0.415, -0.72],
      [0.392, -0.5, 1],
      [0.366, -0.6],
      [0.33, -0.72],
      [0.24, -0.83],
      [0.1, -0.895, 1],
      [-0.04, -0.83],
      [-0.19, -0.765],
      [-0.31, -0.69],
      [-0.362, -0.6],
    ],
    {
      back(ctx, pal) {
        // The tail swings behind the avatar's left shoulder.
        fillBlob(
          ctx,
          [
            [0.26, -0.98],
            [0.47, -0.96],
            [0.6, -0.72],
            [0.63, -0.36],
            [0.58, -0.04],
            [0.5, 0.2],
            [0.44, 0.02],
            [0.47, -0.3],
            [0.42, -0.6],
            [0.3, -0.78],
          ],
          pal.hairShade,
        );
        gloss(
          ctx,
          pal,
          [
            [
              [0.5, -0.8],
              [0.565, -0.5],
              [0.55, -0.2],
            ],
          ],
          0.022,
        );
        // scrunchie
        fillEllipse(ctx, 0.37, -0.9, 0.06, 0.085, pal.accent, -0.7);
        fillEllipse(ctx, 0.355, -0.915, 0.022, 0.05, pal.accentLight, -0.7);
      },
      detail(ctx, pal) {
        gloss(
          ctx,
          pal,
          [
            [
              [-0.26, -0.9],
              [-0.08, -1.01],
              [0.14, -1.02],
            ],
          ],
          0.026,
        );
        lines(ctx, pal.hairShade, [
          [
            [0.14, -0.885],
            [0.0, -0.95],
            [-0.2, -0.9],
            [-0.36, -0.72],
          ],
          [
            [0.16, -0.89],
            [0.3, -0.96],
            [0.38, -0.92],
          ],
          [
            [0.08, -0.84],
            [-0.1, -0.84],
            [-0.28, -0.74],
          ],
        ]);
      },
    },
  );

/* ----------------------------------------------------------------------------------- curls */

interface Curl {
  x: number;
  y: number;
  r: number;
}

/** Curls laid out on rings around the head — fixed, hand-tuned positions (no randomness). */
function curlRing(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  count: number,
  r: number,
  wobble: number,
): Curl[] {
  const out: Curl[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = ((from + ((to - from) * i) / (count - 1)) * Math.PI) / 180;
    const k = 1 + wobble * (i % 2 === 0 ? 1 : -1);
    out.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k, r: r * (2 - k) });
  }
  return out;
}

const curly = (): HairDrawer => {
  const outer = curlRing(0, -0.65, 0.455, 0.455, 158, 382, 13, 0.16, 0.035);
  const inner = curlRing(0, -0.66, 0.3, 0.32, 180, 360, 8, 0.19, 0.03);
  const fringeCurls = curlRing(0, -0.6, 0.355, 0.305, 204, 336, 8, 0.092, 0.04);
  const circles = (ctx: Ctx2D, curls: readonly Curl[]): void => {
    for (const c of curls) {
      ctx.moveTo(c.x + c.r, c.y);
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    }
  };
  const frontPath = (ctx: Ctx2D): void => {
    ctx.beginPath();
    circles(ctx, fringeCurls);
  };
  const highlights = (ctx: Ctx2D, pal: Palette, curls: readonly Curl[], every: number): void => {
    ctx.strokeStyle = pal.hairGloss;
    ctx.lineWidth = 0.014;
    ctx.lineCap = 'round';
    curls.forEach((c, i) => {
      if (i % every !== 0) return;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r * 0.62, Math.PI * 1.08, Math.PI * 1.62);
      ctx.stroke();
    });
  };
  return {
    back(ctx, pal) {
      ctx.beginPath();
      circles(ctx, outer);
      circles(ctx, inner);
      ctx.moveTo(0.46, -0.66);
      ctx.ellipse(0, -0.66, 0.46, 0.46, 0, 0, Math.PI * 2);
      ctx.fillStyle = pal.hair;
      ctx.fill();
      // Inner shadow gives the mass some depth behind the face.
      ctx.beginPath();
      ctx.ellipse(0, -0.55, 0.43, 0.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = pal.hairDeep;
      ctx.fill();
      highlights(ctx, pal, outer, 1);
    },
    mid: none,
    front(ctx, pal) {
      frontPath(ctx);
      ctx.fillStyle = pal.hair;
      ctx.fill();
      highlights(ctx, pal, fringeCurls, 1);
    },
    frontPath,
    coversEars: false,
  };
};

export function createHair(style: HairStyle): HairDrawer {
  switch (style) {
    case 'long-wavy':
      return longWavy();
    case 'long-straight':
      return longStraight();
    case 'short-crop':
      return shortCrop();
    case 'short-neat':
      return shortNeat();
    case 'short-receding':
      return shortReceding();
    case 'curly':
      return curly();
    case 'fringe':
      return fringe();
    case 'bob':
      return bob();
    case 'ponytail':
      return ponytail();
    case 'pixie':
      return pixie();
  }
}
