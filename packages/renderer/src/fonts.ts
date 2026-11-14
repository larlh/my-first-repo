import { FONT_FAMILIES, FONT_WEIGHTS } from '@parlante/shared';

/**
 * Font manifest shared by both platforms. Files come from the @fontsource packages
 * (`<package>/files/<slug>-<subset>-<weight>-<style>.woff2`).
 *  - Node: `registerNodeFonts()` registers every existing file under the family name.
 *  - Browser: the web app imports the @fontsource CSS and `ensureFonts()` waits for them.
 */
export const FONT_SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'greek'] as const;
export const FONT_STYLES = ['normal', 'italic'] as const;

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
