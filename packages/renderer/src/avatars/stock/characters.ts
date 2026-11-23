import type { StockAvatarMeta } from '@parlante/shared';
import { DEFAULT_FACE } from './spec';
import type { CharacterSpec, FaceSpec, HairStyle, OutfitStyle } from './spec';

/* -------------------------------------------------------------------------------------------
 * The cast. Colours come from the catalogue (`traits`: skin, hair, outfit, accent — the same
 * values the UI shows as chips); everything else that makes each person distinct is here.
 * ----------------------------------------------------------------------------------------- */

const FEMININE: FaceSpec = {
  ...DEFAULT_FACE,
  width: 0.376,
  jaw: 0.262,
  chin: 0.088,
  eye: 0.083,
  eyeOpen: 1.06,
  eyeTilt: -0.01,
  brow: 0.019,
  browArch: 0.028,
  mouth: 0.104,
  lips: 1.08,
  nose: 0.9,
};

const MASCULINE: FaceSpec = {
  ...DEFAULT_FACE,
  width: 0.39,
  jaw: 0.31,
  chin: 0.145,
  eye: 0.075,
  eyeOpen: 0.92,
  eyeTilt: -0.003,
  brow: 0.03,
  browArch: 0.019,
  mouth: 0.114,
  lips: 0.84,
  nose: 1.12,
};

const NEUTRAL: FaceSpec = {
  ...DEFAULT_FACE,
  width: 0.38,
  jaw: 0.285,
  chin: 0.115,
  eye: 0.079,
  eyeOpen: 1,
  brow: 0.023,
  browArch: 0.02,
  mouth: 0.108,
  lips: 0.92,
};

type Look = Partial<Omit<CharacterSpec, 'face' | 'skin' | 'hair' | 'outfit' | 'accent'>> & {
  face?: Partial<FaceSpec>;
};

const LOOKS: Readonly<Record<string, Look>> = {
  stock_lucia: {
    hairStyle: 'long-wavy',
    outfitStyle: 'blazer',
    inner: '#f6efe4',
    iris: '#6b4423',
    lip: '#c4575f',
    blush: 0.7,
  },
  stock_mateo: {
    hairStyle: 'short-crop',
    outfitStyle: 'hoodie',
    inner: '#f3f1ea',
    iris: '#3d2715',
    beard: 'stubble',
    blush: 0.35,
    face: { jaw: 0.302, chin: 0.14 },
  },
  stock_amara: {
    hairStyle: 'curly',
    outfitStyle: 'jacket',
    inner: '#fff4dc',
    iris: '#2f1b10',
    lip: '#a2414c',
    earrings: 'hoop',
    blush: 0.5,
    face: {
      width: 0.38,
      jaw: 0.272,
      chin: 0.095,
      eye: 0.086,
      lips: 1.22,
      nose: 1.08,
      browArch: 0.032,
    },
  },
  stock_kenji: {
    hairStyle: 'fringe',
    outfitStyle: 'tee',
    iris: '#2b1a12',
    blush: 0.4,
    face: {
      width: 0.396,
      jaw: 0.3,
      chin: 0.118,
      eyeOpen: 0.84,
      eyeTilt: -0.013,
      brow: 0.024,
      lips: 0.86,
      nose: 0.95,
    },
  },
  stock_elena: {
    hairStyle: 'bob',
    outfitStyle: 'blazer',
    inner: '#efe8d8',
    iris: '#5f7f9c',
    lip: '#b9606a',
    browColor: '#8d8a8c',
    lines: true,
    blush: 0.55,
    face: { width: 0.37, jaw: 0.268, chin: 0.098, eyeOpen: 0.95, lips: 0.9, browArch: 0.024 },
  },
  stock_omar: {
    hairStyle: 'short-neat',
    outfitStyle: 'suit',
    inner: '#f5f4ef',
    iris: '#3b2414',
    beard: 'full',
    blush: 0.25,
    shoulders: 0.95,
    face: { jaw: 0.326, chin: 0.16, brow: 0.033, mouth: 0.118 },
  },
  stock_sofia: {
    hairStyle: 'ponytail',
    outfitStyle: 'sweater',
    iris: '#4f8257',
    lip: '#d67b80',
    freckles: true,
    blush: 0.8,
    face: {
      width: 0.38,
      jaw: 0.275,
      chin: 0.082,
      eye: 0.086,
      eyeOpen: 1.08,
      lips: 0.98,
      nose: 0.82,
    },
  },
  stock_david: {
    hairStyle: 'short-receding',
    outfitStyle: 'shirt',
    iris: '#3a2618',
    browColor: '#77767c',
    glasses: 'round',
    lines: true,
    blush: 0.2,
    face: { width: 0.385, jaw: 0.298, chin: 0.138, eyeOpen: 0.9, nose: 1.2, lips: 0.92 },
  },
  stock_noa: {
    hairStyle: 'pixie',
    outfitStyle: 'bomber',
    inner: '#221d33',
    iris: '#6d5a2f',
    browColor: '#3a2a22',
    earrings: 'stud',
    blush: 0.45,
    face: { jaw: 0.276, chin: 0.1, eyeTilt: -0.011, browArch: 0.024 },
  },
  stock_priya: {
    hairStyle: 'long-straight',
    outfitStyle: 'blouse',
    iris: '#35210f',
    lip: '#a6414f',
    earrings: 'stud',
    blush: 0.45,
    face: {
      width: 0.372,
      jaw: 0.258,
      chin: 0.09,
      eye: 0.085,
      browArch: 0.03,
      brow: 0.021,
      lips: 1.12,
    },
  },
};

const HAIR_BY_TRAIT: Readonly<Record<string, HairStyle>> = {
  long: 'long-wavy',
  short: 'short-crop',
  curly: 'curly',
  fringe: 'fringe',
  bob: 'bob',
  ponytail: 'ponytail',
  pixie: 'pixie',
};

const OUTFIT_BY_STYLE: Readonly<Record<StockAvatarMeta['style'], OutfitStyle>> = {
  professional: 'blazer',
  casual: 'tee',
  creative: 'jacket',
};

/**
 * Full character spec of a stock avatar: catalogue palette + its look. An avatar added to the
 * catalogue without an entry in `LOOKS` still gets a complete character derived from its
 * traits (hairStyle, beard, glasses) and style.
 */
export function characterSpec(meta: StockAvatarMeta): CharacterSpec {
  const look = LOOKS[meta.id] ?? {};
  const t = meta.traits;
  const base = meta.gender === 'female' ? FEMININE : meta.gender === 'male' ? MASCULINE : NEUTRAL;
  const feminine = meta.gender === 'female';
  return {
    skin: t.skin ?? '#d9a57e',
    hair: t.hair ?? '#2b1d16',
    outfit: t.outfit ?? '#6d5efc',
    accent: t.accent ?? '#ffb547',
    hairStyle: look.hairStyle ?? HAIR_BY_TRAIT[t.hairStyle ?? ''] ?? 'short-crop',
    outfitStyle: look.outfitStyle ?? OUTFIT_BY_STYLE[meta.style],
    inner: look.inner ?? '#f4f1ea',
    shoulders: look.shoulders ?? (feminine ? 0.78 : meta.gender === 'male' ? 0.9 : 0.83),
    neck: look.neck ?? (feminine ? 0.15 : meta.gender === 'male' ? 0.19 : 0.165),
    face: { ...base, ...look.face },
    iris: look.iris ?? '#4a2f1b',
    ...(look.lip ? { lip: look.lip } : {}),
    lashes: look.lashes ?? meta.gender !== 'male',
    ...(look.browColor ? { browColor: look.browColor } : {}),
    beard: look.beard ?? (t.beard === 'full' ? 'full' : 'none'),
    glasses: look.glasses ?? (t.glasses ? 'round' : 'none'),
    earrings: look.earrings ?? 'none',
    freckles: look.freckles ?? false,
    lines: look.lines ?? meta.ageGroup === 'senior',
    blush: look.blush ?? 0.4,
  };
}
