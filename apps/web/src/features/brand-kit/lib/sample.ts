import { DEFAULT_STOCK_AVATAR_ID } from '@parlante/renderer';
import { applyBrandKit, createComposition, defaultVoiceId } from '@parlante/shared';
import type { AspectRatio, Composition, NewLayerInput } from '@parlante/shared';
import type { KitDraft } from './kit';

/* The sample video a brand kit is previewed on. It is an ordinary Composition whose layers
 * carry the same `role` / `brandRole` marks as the built-in templates, and the kit is applied
 * with `applyBrandKit` from @parlante/shared — the function the API runs for "apply brand
 * kit" — so the preview cannot drift from what a real video gets. */

export interface SampleTexts {
  eyebrow: string;
  title: string;
  subtitle: string;
  body: string;
  /** Narration of each scene (drives the subtitle preview). */
  script: [string, string];
  /** Narration language (`es` / `en`). */
  language: string;
}

/** Id used for the kit while previewing (drafts have no id yet; never sent anywhere). */
export const PREVIEW_KIT_ID = 'bk_previewpreview00';
/** Placeholder asset id of the logo layer; `applyBrandKit` swaps in the kit's logo. */
const LOGO_SLOT = 'ast_logoslotpreview0';

interface Layout {
  logo: { x: number; y: number; w: number; h: number };
  eyebrow: { x: number; y: number; w: number; h: number };
  title: { x: number; y: number; w: number; h: number };
  rule: { x: number; y: number; w: number; h: number };
  subtitle: { x: number; y: number; w: number; h: number };
  avatar: { x: number; y: number; w: number; h: number };
  body: { x: number; y: number; w: number; h: number };
  titleSize: number;
  bodySize: number;
  align: 'left' | 'center';
}

const LAYOUTS: Record<AspectRatio, Layout> = {
  '16:9': {
    logo: { x: 0.06, y: 0.07, w: 0.14, h: 0.11 },
    eyebrow: { x: 0.06, y: 0.27, w: 0.3, h: 0.07 },
    title: { x: 0.06, y: 0.36, w: 0.46, h: 0.26 },
    rule: { x: 0.06, y: 0.64, w: 0.1, h: 0.012 },
    subtitle: { x: 0.06, y: 0.67, w: 0.46, h: 0.1 },
    avatar: { x: 0.56, y: 0.12, w: 0.38, h: 0.88 },
    body: { x: 0.12, y: 0.24, w: 0.76, h: 0.4 },
    titleSize: 0.085,
    bodySize: 0.07,
    align: 'left',
  },
  '9:16': {
    logo: { x: 0.34, y: 0.05, w: 0.32, h: 0.06 },
    eyebrow: { x: 0.2, y: 0.14, w: 0.6, h: 0.04 },
    title: { x: 0.08, y: 0.19, w: 0.84, h: 0.14 },
    rule: { x: 0.42, y: 0.335, w: 0.16, h: 0.006 },
    subtitle: { x: 0.1, y: 0.35, w: 0.8, h: 0.06 },
    avatar: { x: 0.08, y: 0.43, w: 0.84, h: 0.57 },
    body: { x: 0.1, y: 0.26, w: 0.8, h: 0.34 },
    titleSize: 0.046,
    bodySize: 0.04,
    align: 'center',
  },
  '1:1': {
    logo: { x: 0.38, y: 0.05, w: 0.24, h: 0.09 },
    eyebrow: { x: 0.25, y: 0.17, w: 0.5, h: 0.055 },
    title: { x: 0.08, y: 0.235, w: 0.84, h: 0.16 },
    rule: { x: 0.44, y: 0.4, w: 0.12, h: 0.008 },
    subtitle: { x: 0.1, y: 0.42, w: 0.8, h: 0.07 },
    avatar: { x: 0.24, y: 0.5, w: 0.52, h: 0.5 },
    body: { x: 0.1, y: 0.24, w: 0.8, h: 0.4 },
    titleSize: 0.066,
    bodySize: 0.058,
    align: 'center',
  },
};

/** The unbranded sample document (neutral greys), before a kit is applied. */
export function sampleComposition(aspect: AspectRatio, texts: SampleTexts): Composition {
  const layout = LAYOUTS[aspect];
  const voiceId = defaultVoiceId(texts.language);
  const logo: NewLayerInput = {
    id: 'logo',
    type: 'image',
    role: 'logo',
    box: layout.logo,
    src: { source: 'asset', assetId: LOGO_SLOT },
    fit: 'contain',
    z: 5,
  };
  return createComposition({
    aspect,
    scenes: [
      {
        id: 'cover',
        name: texts.title,
        background: { type: 'color', color: '#22252e', brandRole: 'background' },
        script: { kind: 'tts', text: texts.script[0], voiceId, language: texts.language },
        layers: [
          logo,
          {
            id: 'eyebrow',
            type: 'text',
            role: 'caption',
            box: layout.eyebrow,
            text: texts.eyebrow,
            z: 3,
            style: {
              fontSize: layout.titleSize * 0.3,
              fontWeight: 700,
              uppercase: true,
              letterSpacing: 0.08,
              align: layout.align,
              background: { color: '#55596a', padding: 0.012, radius: 0.012 },
            },
          },
          {
            id: 'title',
            type: 'text',
            role: 'title',
            box: layout.title,
            text: texts.title,
            z: 3,
            style: {
              fontSize: layout.titleSize,
              fontWeight: 800,
              align: layout.align,
              verticalAlign: 'top',
              lineHeight: 1.08,
            },
          },
          {
            id: 'rule',
            type: 'shape',
            role: 'accent',
            shape: 'rect',
            box: layout.rule,
            fill: '#9aa0b4',
            radius: 0.006,
            z: 2,
          },
          {
            id: 'subtitle',
            type: 'text',
            role: 'subtitle',
            box: layout.subtitle,
            text: texts.subtitle,
            z: 3,
            style: {
              fontSize: layout.titleSize * 0.4,
              fontWeight: 500,
              align: layout.align,
              verticalAlign: 'top',
            },
          },
          {
            id: 'presenter',
            type: 'avatar',
            avatarId: DEFAULT_STOCK_AVATAR_ID,
            box: layout.avatar,
            framing: 'bust',
            z: 1,
          },
        ],
      },
      {
        id: 'message',
        name: texts.body,
        background: { type: 'color', color: '#2f3340', brandRole: 'secondary' },
        transition: { type: 'fade', durationMs: 400 },
        script: { kind: 'tts', text: texts.script[1], voiceId, language: texts.language },
        layers: [
          { ...logo, id: 'logo-2' },
          {
            id: 'dot',
            type: 'shape',
            role: 'accent',
            shape: 'ellipse',
            box: {
              x: layout.body.x,
              y: layout.body.y - 0.07,
              w: aspect === '16:9' ? 0.028 : 0.05,
              h: aspect === '9:16' ? 0.028 : 0.05,
            },
            fill: '#9aa0b4',
            z: 2,
          },
          {
            id: 'body',
            type: 'text',
            role: 'body',
            box: layout.body,
            text: texts.body,
            z: 3,
            style: {
              fontSize: layout.bodySize,
              fontWeight: 600,
              align: 'left',
              verticalAlign: 'top',
              lineHeight: 1.2,
            },
          },
        ],
      },
    ],
  });
}

/** Media key of the logo of a draft, for the preview player (`extraMedia`). */
export function logoMediaKey(draft: Pick<KitDraft, 'logoAssetId'>): string | null {
  return draft.logoAssetId ? `asset:${draft.logoAssetId}` : null;
}

/**
 * The sample with the draft kit applied. Without a logo the logo layers are removed (a real
 * video keeps whatever image the layer had; the sample has none to show).
 */
export function brandedSample(
  aspect: AspectRatio,
  texts: SampleTexts,
  draft: Pick<KitDraft, 'logoAssetId' | 'colors' | 'fonts'>,
): Composition {
  const branded = applyBrandKit(sampleComposition(aspect, texts), {
    id: PREVIEW_KIT_ID,
    logoAssetId: draft.logoAssetId,
    colors: draft.colors,
    fonts: draft.fonts,
  });
  if (draft.logoAssetId === null) {
    for (const scene of branded.scenes) {
      scene.layers = scene.layers.filter((layer) => layer.role !== 'logo');
    }
  }
  return branded;
}
