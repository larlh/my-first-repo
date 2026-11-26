import { alpha, darken, lighten, luma, mix, shade } from './color';

/* -------------------------------------------------------------------------------------------
 * Character specification of a stock avatar.
 *
 * All geometry lives in CHARACTER SPACE: 1 unit = the height of the head (chin → top of the
 * skull). The origin is the resting position of the chin, x grows to the avatar's left
 * (screen right), y grows downwards. So the crown is at y = -1, the eye line at about -0.45
 * and the shoulders at about +0.5. `rig.ts` fits a framing window of this space into the layer
 * box.
 * ----------------------------------------------------------------------------------------- */

export type HairStyle =
  | 'long-wavy'
  | 'long-straight'
  | 'short-crop'
  | 'short-neat'
  | 'short-receding'
  | 'curly'
  | 'fringe'
  | 'bob'
  | 'ponytail'
  | 'pixie';

export type OutfitStyle =
  'blazer' | 'suit' | 'hoodie' | 'tee' | 'jacket' | 'sweater' | 'shirt' | 'bomber' | 'blouse';

export interface FaceSpec {
  /** Half width of the head at the cheekbones. */
  width: number;
  /** Half width at the jaw corners. */
  jaw: number;
  /** Half width of the chin. */
  chin: number;
  /** Eye half width. */
  eye: number;
  /** Eye opening (height of the upper lid arc) relative to the default. */
  eyeOpen: number;
  /** Vertical offset of the outer eye corner (negative = upturned). */
  eyeTilt: number;
  /** Brow thickness at its thickest point. */
  brow: number;
  /** Brow arch height. */
  browArch: number;
  /** Mouth half width at rest. */
  mouth: number;
  /** Lip fullness multiplier (1 = default). */
  lips: number;
  /** Nose width multiplier. */
  nose: number;
}

export interface CharacterSpec {
  skin: string;
  hair: string;
  outfit: string;
  accent: string;
  hairStyle: HairStyle;
  outfitStyle: OutfitStyle;
  /** Colour of the garment under a jacket / blazer / hoodie. */
  inner: string;
  /** Half width of the shoulders. */
  shoulders: number;
  /** Half width of the neck. */
  neck: number;
  face: FaceSpec;
  iris: string;
  /** Lip colour; when omitted a natural tone is derived from the skin. */
  lip?: string;
  /** Draw upper lashes with an outer flick. */
  lashes: boolean;
  /** Brow colour; derived from the hair when omitted. */
  browColor?: string;
  beard: 'none' | 'full' | 'stubble';
  glasses: 'none' | 'round';
  earrings: 'none' | 'hoop' | 'stud' | 'pearl';
  freckles: boolean;
  /** Fine age lines (seniors). */
  lines: boolean;
  /** Cheek blush strength 0..1. */
  blush: number;
}

export const DEFAULT_FACE: FaceSpec = {
  width: 0.385,
  jaw: 0.285,
  chin: 0.125,
  eye: 0.078,
  eyeOpen: 1,
  eyeTilt: -0.006,
  brow: 0.024,
  browArch: 0.02,
  mouth: 0.108,
  lips: 1,
  nose: 1,
};

/** Every colour a rig paints with, derived once from the spec. */
export interface Palette {
  skin: string;
  skinLight: string;
  skinShade: string;
  /** Opaque tones of the lit and the shaded side of the face. */
  skinLit: string;
  skinSide: string;
  skinDeep: string;
  skinShadeSoft: string;
  skinShadeClear: string;
  blush: string;
  blushClear: string;
  lip: string;
  lipDark: string;
  lipLight: string;
  seam: string;
  mouthInner: string;
  mouthDeep: string;
  teeth: string;
  teethShade: string;
  tongue: string;
  tongueLight: string;
  eyeWhite: string;
  eyeWhiteShade: string;
  iris: string;
  irisDark: string;
  irisLight: string;
  pupil: string;
  lash: string;
  brow: string;
  hair: string;
  hairShade: string;
  hairDeep: string;
  hairLight: string;
  hairGloss: string;
  outfit: string;
  outfitLight: string;
  outfitShade: string;
  outfitDeep: string;
  outfitLine: string;
  inner: string;
  innerShade: string;
  accent: string;
  accentShade: string;
  accentLight: string;
  metal: string;
}

export function buildPalette(spec: CharacterSpec): Palette {
  const { skin, hair, outfit, accent } = spec;
  const skinL = luma(skin);
  // Darker skins get a deeper, slightly cooler shadow; light skins a warm rosy one.
  const shadowHue = skinL > 0.6 ? '#b0503f' : '#3b1c1c';
  const skinShade = shade(skin, skinL > 0.6 ? 0.26 : 0.3, shadowHue);
  const naturalLip = mix(skin, skinL > 0.6 ? '#c2504f' : '#b0565f', skinL > 0.6 ? 0.46 : 0.5);
  const lip = spec.lip ?? naturalLip;
  const hairL = luma(hair);
  const hairLight = hairL < 0.2 ? mix(hair, '#8a8fa3', 0.34) : lighten(hair, 0.3);
  const brow =
    spec.browColor ?? (hairL > 0.55 ? mix(hair, '#55504c', 0.6) : mix(hair, '#1a1210', 0.35));
  return {
    skin,
    skinLight: lighten(skin, 0.16),
    skinShade,
    skinLit: lighten(skin, 0.07),
    skinSide: mix(skin, skinShade, 0.5),
    skinDeep: shade(skin, 0.5, shadowHue),
    skinShadeSoft: alpha(skinShade, 0.55),
    skinShadeClear: alpha(skinShade, 0),
    blush: alpha(mix(skin, '#e2504f', 0.55), 0.42 * spec.blush),
    blushClear: alpha(mix(skin, '#e2504f', 0.55), 0),
    lip,
    lipDark: shade(lip, 0.24, '#4a1220'),
    lipLight: lighten(lip, 0.3),
    seam: shade(lip, 0.62, '#2a0a10'),
    mouthInner: '#5c1a22',
    mouthDeep: '#35090f',
    teeth: '#fbf8f3',
    teethShade: '#ddd5cd',
    tongue: '#d9646e',
    tongueLight: '#ea8a8f',
    eyeWhite: '#fdfbf8',
    eyeWhiteShade: '#d9d2cf',
    iris: spec.iris,
    irisDark: darken(spec.iris, 0.45),
    irisLight: lighten(spec.iris, 0.3),
    pupil: '#120c0c',
    lash: mix(hairL > 0.55 ? '#4a3f3c' : hair, '#1a0f0d', 0.6),
    brow,
    hair,
    hairShade: hairL < 0.2 ? darken(hair, 0.35) : shade(hair, 0.28, '#2a1a24'),
    hairDeep: hairL < 0.2 ? darken(hair, 0.6) : shade(hair, 0.5, '#20141c'),
    hairLight,
    hairGloss: alpha(hairLight, 0.55),
    outfit,
    outfitLight: lighten(outfit, 0.14),
    outfitShade: shade(outfit, 0.24, '#141026'),
    outfitDeep: shade(outfit, 0.44, '#0d0a1c'),
    outfitLine: alpha(shade(outfit, 0.55, '#0d0a1c'), 0.6),
    inner: spec.inner,
    innerShade: shade(spec.inner, 0.16, '#3b3550'),
    accent,
    accentShade: shade(accent, 0.25, '#2a1626'),
    accentLight: lighten(accent, 0.35),
    metal: '#e8c36a',
  };
}
