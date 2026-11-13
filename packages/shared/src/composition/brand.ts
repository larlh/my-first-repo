import { z } from 'zod';
import { idOf } from '../ids';
import { ColorSchema, FontFamilySchema } from './schema';
import type { Composition } from './schema';

export const BrandColorsSchema = z.object({
  primary: ColorSchema.default('#6d5efc'),
  secondary: ColorSchema.default('#1b1f3b'),
  accent: ColorSchema.default('#ffb547'),
  background: ColorSchema.default('#0f1224'),
  text: ColorSchema.default('#ffffff'),
});
export type BrandColors = z.infer<typeof BrandColorsSchema>;

export const BrandFontsSchema = z.object({
  heading: FontFamilySchema.default('Poppins'),
  body: FontFamilySchema.default('Inter'),
});
export type BrandFonts = z.infer<typeof BrandFontsSchema>;

/** The styling payload of a brand kit (what `applyBrandKit` needs). */
export const BrandStyleSchema = z.object({
  id: idOf('brandKit'),
  logoAssetId: idOf('asset').nullable(),
  colors: BrandColorsSchema,
  fonts: BrandFontsSchema,
});
export type BrandStyle = z.infer<typeof BrandStyleSchema>;

/**
 * Apply a brand kit to a composition (pure; returns a new document).
 *
 * Rules, driven by `layer.role` / `background.brandRole`:
 *  - text layers:   title/subtitle → heading font; body/caption → body font; colour → brand text
 *                   (title keeps brand `primary` when it has a text background pill → pill accent)
 *  - image layers with role `logo` → replaced by the brand logo (when the kit has one)
 *  - shape layers with role `accent` → fill = brand accent
 *  - colour backgrounds with `brandRole` → that brand colour
 *  - subtitles: font → body font, highlight → accent
 * Layers without a role are left untouched so user customisations survive.
 */
export function applyBrandKit(composition: Composition, brand: BrandStyle): Composition {
  const copy = structuredClone(composition);
  copy.brandKitId = brand.id;
  copy.subtitles.fontFamily = brand.fonts.body;
  copy.subtitles.highlightColor = brand.colors.accent;
  for (const scene of copy.scenes) {
    const bg = scene.background;
    if (bg.type === 'color' && bg.brandRole) bg.color = brand.colors[bg.brandRole];
    for (const layer of scene.layers) {
      if (!layer.role) continue;
      if (layer.type === 'text') {
        const heading = layer.role === 'title' || layer.role === 'subtitle';
        layer.style.fontFamily = heading ? brand.fonts.heading : brand.fonts.body;
        layer.style.color = brand.colors.text;
        if (layer.style.background) layer.style.background.color = brand.colors.primary;
      } else if (layer.type === 'image' && layer.role === 'logo') {
        if (brand.logoAssetId) layer.src = { source: 'asset', assetId: brand.logoAssetId };
      } else if (layer.type === 'shape' && layer.role === 'accent') {
        if (layer.fill !== null) layer.fill = brand.colors.accent;
        if (layer.stroke) layer.stroke.color = brand.colors.accent;
      }
    }
  }
  return copy;
}
