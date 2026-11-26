/** Colour helpers for the renderer (documents store `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** Parse a hex colour; anything else yields opaque black (documents are validated upstream). */
export function parseHexColor(color: string): Rgba {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  const expand = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
  if (!/^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(expand)) return { r: 0, g: 0, b: 0, a: 1 };
  const channel = (index: number) => parseInt(expand.slice(index, index + 2), 16);
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: expand.length === 8 ? channel(6) / 255 : 1,
  };
}

export function rgbaString({ r, g, b, a }: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(Math.min(1, Math.max(0, a)) * 1000) / 1000})`;
}

/** `color` with its alpha multiplied by `factor`. */
export function fadeColor(color: string, factor: number): string {
  const parsed = parseHexColor(color);
  return rgbaString({ ...parsed, a: parsed.a * factor });
}

/** Perceived lightness 0..1 (Rec. 709 luma on gamma-encoded channels — enough to pick contrast). */
export function colorLuma(color: string): number {
  const { r, g, b } = parseHexColor(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Near-black or near-white, whichever contrasts with `color` (outlines, shadows). */
export function contrastColor(color: string): string {
  return colorLuma(color) > 0.45 ? '#0b0d17' : '#ffffff';
}
