import type { Animation } from '@parlante/shared';

export type Easing = Animation['easing'];

/** Standard easing curves; input and output in 0..1 (back-out overshoots slightly). */
export function ease(kind: Easing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (kind) {
    case 'linear':
      return x;
    case 'ease-in':
      return x * x * x;
    case 'ease-out':
      return 1 - (1 - x) ** 3;
    case 'ease-in-out':
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
    case 'back-out': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
    }
  }
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
