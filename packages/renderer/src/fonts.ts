import { FONT_FAMILIES, FONT_WEIGHTS } from '@parlante/shared';

/**
 * Font manifest shared by both platforms. Files come from the @fontsource packages
 * (`<package>/files/<slug>-<subset>-<weight>-<style>.woff2`).
 *  - Node: `registerNodeFonts()` registers every existing file under the family name.
 *  - Browser: the web app imports the @fontsource CSS (normal AND italic, every weight) and
 *    `ensureBrowserFonts()` waits for them.
 *
 * Script coverage is the same on both sides: a family that lacks a subset (Poppins has no
 * Cyrillic or Greek, Montserrat no Greek…) falls back, glyph by glyph, to Inter at the same
 * weight and style through the family list `canvasFont` builds — browsers and Skia in Node
 * both honour it. That is why every font string must come from `canvasFont`.
 */
export const FONT_SUBSETS = [
  'latin',
  'latin-ext',
  'cyrillic',
  'cyrillic-ext',
  'greek',
  'greek-ext',
  'vietnamese',
  'devanagari',
] as const;
export const FONT_STYLES = ['normal', 'italic'] as const;

/** Family every other one falls back to for scripts it does not cover. */
export const FALLBACK_FONT_FAMILY = 'Inter';

export interface FontFile {
  family: string;
  package: string;
  /** File name inside `<package>/files/`. Not every combination exists for every family. */
  file: string;
  weight: number;
  style: 'normal' | 'italic';
  subset: string;
}

/** Every font file the renderer may use (missing files are skipped by the Node adapter). */
export function listFontFiles(): FontFile[] {
  const out: FontFile[] = [];
  for (const font of FONT_FAMILIES) {
    for (const weight of FONT_WEIGHTS) {
      for (const style of FONT_STYLES) {
        for (const subset of FONT_SUBSETS) {
          out.push({
            family: font.family,
            package: font.package,
            file: `${font.slug}-${subset}-${weight}-${style}.woff2`,
            weight,
            style,
            subset,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Vertical metrics of each bundled family in em units (hhea ascender / descender of the font
 * files). The renderer positions baselines from THIS table instead of asking the platform, so
 * text sits on the same pixel row in every browser and in Node; it also matches where CSS
 * puts the text of an element with the same font-size and line-height.
 */
export const FONT_METRICS: Record<string, { ascent: number; descent: number }> = {
  Inter: { ascent: 0.96875, descent: 0.2412 },
  Poppins: { ascent: 1.05, descent: 0.35 },
  Montserrat: { ascent: 0.968, descent: 0.251 },
  'Playfair Display': { ascent: 1.082, descent: 0.251 },
  'Roboto Slab': { ascent: 1.048, descent: 0.271 },
  'JetBrains Mono': { ascent: 1.02, descent: 0.3 },
};

export function fontMetrics(family: string): { ascent: number; descent: number } {
  return FONT_METRICS[family] ?? { ascent: 0.96875, descent: 0.2412 };
}

/**
 * Distance from the top of a line box of height `lineHeightPx` to the alphabetic baseline
 * (CSS half-leading model).
 */
export function baselineOffset(family: string, sizePx: number, lineHeightPx: number): number {
  const { ascent, descent } = fontMetrics(family);
  return (lineHeightPx - (ascent + descent) * sizePx) / 2 + ascent * sizePx;
}

/**
 * Canvas `font` shorthand for a bundled family. Always go through this helper so browser and
 * Node build identical strings. `sizePx` is in output pixels.
 */
export function canvasFont(
  family: string,
  sizePx: number,
  weight: number = 400,
  italic = false,
): string {
  return `${italic ? 'italic ' : ''}${weight} ${sizePx}px "${family}", "Inter", sans-serif`;
}
