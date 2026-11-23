import { BrandColorsSchema, BrandFontsSchema } from '@parlante/shared';
import type { BrandColors, BrandFonts, BrandKit } from '@parlante/shared';

/* The brand kit being edited (a draft of the form) and how it maps to the API bodies. */

export const BRAND_COLOR_ROLES = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
export type BrandColorRole = (typeof BRAND_COLOR_ROLES)[number];

export interface KitDraft {
  name: string;
  logoAssetId: string | null;
  /** URL of the chosen logo, only to draw it (never sent: the API stores the asset id). */
  logoUrl: string | null;
  colors: BrandColors;
  fonts: BrandFonts;
  isDefault: boolean;
}

export const NAME_MAX = 60;

/** A new kit: the contract defaults, default when it is the first kit of the workspace. */
export function emptyDraft(name: string, isDefault: boolean): KitDraft {
  return {
    name,
    logoAssetId: null,
    logoUrl: null,
    colors: BrandColorsSchema.parse({}),
    fonts: BrandFontsSchema.parse({}),
    isDefault,
  };
}

export function draftFromKit(kit: BrandKit): KitDraft {
  return {
    name: kit.name,
    logoAssetId: kit.logoAssetId,
    logoUrl: kit.logoUrl,
    colors: { ...kit.colors },
    fonts: { ...kit.fonts },
    isDefault: kit.isDefault,
  };
}

function sameColors(a: BrandColors, b: BrandColors): boolean {
  return BRAND_COLOR_ROLES.every((role) => a[role].toLowerCase() === b[role].toLowerCase());
}

/** True when the draft differs from what is stored (the logo URL is not part of the kit). */
export function isDirty(draft: KitDraft, saved: KitDraft): boolean {
  return (
    draft.name.trim() !== saved.name.trim() ||
    draft.logoAssetId !== saved.logoAssetId ||
    draft.isDefault !== saved.isDefault ||
    draft.fonts.heading !== saved.fonts.heading ||
    draft.fonts.body !== saved.fonts.body ||
    !sameColors(draft.colors, saved.colors)
  );
}

export type KitProblem = 'nameRequired' | 'nameTooLong';

export function draftProblem(draft: KitDraft): KitProblem | null {
  const name = draft.name.trim();
  if (name === '') return 'nameRequired';
  if (name.length > NAME_MAX) return 'nameTooLong';
  return null;
}

/** Body of `POST /api/brand-kits` and of `PATCH /api/brand-kits/:id` (the whole kit). */
export function kitBody(draft: KitDraft) {
  return {
    name: draft.name.trim(),
    logoAssetId: draft.logoAssetId,
    colors: { ...draft.colors },
    fonts: { ...draft.fonts },
    isDefault: draft.isDefault,
  };
}

/* ---------- contrast ---------- */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of `#rgb`, `#rrggbb` (alpha ignored), or null when not a hex colour. */
export function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{3,8})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1] as string;
  if (digits.length === 3 || digits.length === 4) {
    digits = [...digits.slice(0, 3)].map((d) => d + d).join('');
  } else if (digits.length === 6 || digits.length === 8) {
    digits = digits.slice(0, 6);
  } else return null;
  const r = Number.parseInt(digits.slice(0, 2), 16);
  const g = Number.parseInt(digits.slice(2, 4), 16);
  const b = Number.parseInt(digits.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio (1..21) between two hex colours, or null when one is not a colour. */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Large on-screen text reads well from 3:1 (WCAG AA for large text). */
export const MIN_VIDEO_CONTRAST = 3;

export interface ContrastWarning {
  /** The text colour and the surface it sits on in the sample scenes. */
  pair: 'textOnBackground' | 'textOnSecondary' | 'textOnPrimary';
  ratio: number;
}

/** Pairs of the kit that will be hard to read in a video. */
export function contrastWarnings(colors: BrandColors): ContrastWarning[] {
  const pairs: [ContrastWarning['pair'], string][] = [
    ['textOnBackground', colors.background],
    ['textOnSecondary', colors.secondary],
    ['textOnPrimary', colors.primary],
  ];
  const warnings: ContrastWarning[] = [];
  for (const [pair, surface] of pairs) {
    const ratio = contrastRatio(colors.text, surface);
    if (ratio !== null && ratio < MIN_VIDEO_CONTRAST) warnings.push({ pair, ratio });
  }
  return warnings;
}
