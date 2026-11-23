/**
 * Tiny colour helpers for the stock rigs. Everything is computed ONCE when a rig is created
 * (palettes are plain strings afterwards), so drawing a frame never parses a colour.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp255 = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

/** Parse `#rgb` / `#rrggbb`. Anything else falls back to mid grey (never throws). */
export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) return { r: 128, g: 128, b: 128 };
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const n = Number.parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const n = (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b);
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Linear mix of two hex colours (`t` 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

export const lighten = (hex: string, t: number): string => mix(hex, '#ffffff', t);
export const darken = (hex: string, t: number): string => mix(hex, '#000000', t);

/** `rgba()` string of a hex colour with the given opacity. */
export function alpha(hex: string, a: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r},${g},${b},${Math.min(1, Math.max(0, a)).toFixed(3)})`;
}

/** Perceived lightness 0..1 (Rec. 601 luma). */
export function luma(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Shadow tone of a colour: darker AND shifted towards a warm/cool hue instead of plain black,
 * which keeps skin and fabric shadows from looking dirty.
 */
export function shade(hex: string, amount: number, towards = '#3a1f2b'): string {
  return mix(hex, towards, amount);
}
