import { CompositionSchema, createComposition, defaultVoiceId } from '@parlante/shared';
import type {
  AspectRatio,
  Composition,
  CompositionInput,
  NewLayerInput,
  NewSceneInput,
  TemplateCategory,
  VariableDef,
} from '@parlante/shared';
import type { StockBackgroundId, StockMusicId } from '@parlante/stock-assets';

/* -------------------------------------------------------------------------------------------
 * How built-in templates are written. Owner: content.
 *
 * A template is a `TemplateDefinition`: metadata in Spanish and English plus a pure `build`
 * function that returns the document for one language (`t('texto', 'text')` picks the string).
 * The registry builds every template once per language at load time.
 *
 * Conventions:
 *  - Scenes and layers get STABLE, readable ids (new ones are generated when a video is
 *    created from the template).
 *  - Only stock avatars (`stock_…`), local voices (`defaultVoiceId`) and stock assets
 *    (`stockBackground`, `music`) — never workspace assets. The ids are type-checked against
 *    the @parlante/stock-assets catalogue.
 *  - Restylable layers carry a `role` and brandable colour backgrounds a `brandRole`, so brand
 *    kits apply cleanly. Text painted straight onto a LIGHT image keeps no role (a brand kit
 *    would turn it white); text with a pill or on a `brandRole` background does.
 *  - `{{variables}}` mark what users personalise; they are declared in `variables` with a
 *    label and an example value in the template's language.
 *  - Keep the lower ~20 % of the canvas free of text: burned-in subtitles live there.
 * ----------------------------------------------------------------------------------------- */

export const TEMPLATE_LOCALES = ['es', 'en'] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

/** Picks the Spanish or the English string for the document being built. */
export type Translate = (es: string, en: string) => string;

export interface TemplateDocument {
  scenes: NewSceneInput[];
  variables: VariableDef[];
  music?: { stockId: StockMusicId; volume?: number };
  subtitles?: CompositionInput['subtitles'];
}

export interface TemplateDefinition {
  id: `builtin_${string}`;
  category: TemplateCategory;
  aspect: AspectRatio;
  name: Record<TemplateLocale, string>;
  description: Record<TemplateLocale, string>;
  tags: Record<TemplateLocale, string[]>;
  build(t: Translate, locale: TemplateLocale): TemplateDocument;
}

/** Validated, fully-defaulted Composition of a template in one language. */
export function buildComposition(def: TemplateDefinition, locale: TemplateLocale): Composition {
  const t: Translate = (es, en) => (locale === 'es' ? es : en);
  const doc = def.build(t, locale);
  const base = createComposition({ aspect: def.aspect, scenes: doc.scenes });
  return CompositionSchema.parse({
    ...base,
    subtitles: doc.subtitles ?? {},
    music: doc.music
      ? {
          src: { source: 'stock', stockId: doc.music.stockId },
          volume: doc.music.volume ?? 0.14,
          ducking: true,
          fadeInMs: 600,
          fadeOutMs: 1800,
          loop: true,
        }
      : null,
    variables: doc.variables,
  });
}

/* ---------- palette (matches the default brand kit) ---------- */

export const INK = '#0f1224';
export const NAVY = '#1b1f3b';
export const VIOLET = '#6d5efc';
export const AMBER = '#ffb547';
export const WHITE = '#ffffff';

/* ---------- building blocks ---------- */

type Box = { x: number; y: number; w: number; h: number };
export const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });

/** Narration with the always-available local voice of the template's language. */
export function narration(
  locale: TemplateLocale,
  gender: 'female' | 'male',
  text: string,
  speed = 1,
): NonNullable<NewSceneInput['script']> {
  return { kind: 'tts', text, voiceId: defaultVoiceId(locale, gender), language: locale, speed };
}

/** Stock picture as scene background (square master, `cover` fits every aspect ratio). */
export function stockBackground(
  stockId: StockBackgroundId,
  options: { dim?: number; blur?: number } = {},
): NonNullable<NewSceneInput['background']> {
  return { type: 'image', src: { source: 'stock', stockId }, fit: 'cover', ...options };
}

/**
 * Box of a standing (bust) presenter: from `top` down to the bottom edge, centred on `cx`.
 * It is deliberately wider than the figure (and may overflow the canvas) so the shoulders are
 * never cut by the edge of the layer; the avatar is sized by the box HEIGHT.
 */
export function stand(aspect: AspectRatio, cx: number, top: number): Box {
  const [aw, ah] = aspect.split(':').map(Number) as [number, number];
  const h = 1 - top;
  const w = (h * 1.15 * ah) / aw;
  return box(Number((cx - w / 2).toFixed(4)), top, Number(w.toFixed(4)), h);
}

type LayerOf<T extends NewLayerInput['type']> = Extract<NewLayerInput, { type: T }>;
type Extra<T extends NewLayerInput['type']> = Partial<Omit<LayerOf<T>, 'type' | 'id' | 'box'>>;

export function avatar(
  id: string,
  avatarId: `stock_${string}`,
  at: Box,
  extra: Extra<'avatar'> = {},
): NewLayerInput {
  return { type: 'avatar', id, name: 'Avatar', avatarId, box: at, framing: 'bust', ...extra };
}

/** Avatar inside a circle (square in pixels: pass the canvas aspect to keep it round). */
export function avatarBadge(
  id: string,
  avatarId: `stock_${string}`,
  aspect: AspectRatio,
  x: number,
  y: number,
  h: number,
  extra: Extra<'avatar'> = {},
): NewLayerInput {
  const [aw, ah] = aspect.split(':').map(Number) as [number, number];
  return avatar(id, avatarId, box(x, y, (h * ah) / aw, h), {
    framing: 'closeup',
    shape: 'circle',
    backdrop: '#ffffff26',
    ...extra,
  });
}

type TextStyleInput = NonNullable<LayerOf<'text'>['style']>;

export function text(
  id: string,
  content: string,
  at: Box,
  style: TextStyleInput,
  extra: Extra<'text'> = {},
): NewLayerInput {
  return { type: 'text', id, text: content, box: at, style, ...extra };
}

export function shape(
  id: string,
  kind: NonNullable<LayerOf<'shape'>['shape']>,
  at: Box,
  fill: string | null,
  extra: Extra<'shape'> = {},
): NewLayerInput {
  return { type: 'shape', id, shape: kind, box: at, fill, ...extra };
}

/**
 * Fixed-size pill with a centred label: a rounded rectangle plus its text (two layers, ids
 * `<id>` and `<id>-label`). Unlike a text background, every chip of a row has the same size.
 */
export function chip(
  id: string,
  label: string,
  at: Box,
  options: {
    fill: string;
    style: TextStyleInput;
    /** Corner radius, fraction of the canvas height. Default: fully rounded for 16:9 rows. */
    radius?: number;
    role?: Extra<'text'>['role'];
    enter?: Extra<'text'>['enter'];
  },
): NewLayerInput[] {
  const appear = options.enter ? { enter: options.enter } : {};
  return [
    shape(id, 'rect', at, options.fill, { radius: options.radius ?? at.h / 2, ...appear }),
    text(`${id}-label`, label, at, options.style, {
      ...(options.role ? { role: options.role } : {}),
      ...appear,
    }),
  ];
}

/** Enter animation shorthand. */
export function enter(
  type: 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'zoom-in' | 'pop',
  delayMs = 0,
  durationMs = 450,
): { type: typeof type; delayMs: number; durationMs: number } {
  return { type, delayMs, durationMs };
}

export function variable(name: string, label: string, defaultValue: string): VariableDef {
  return { name, label, defaultValue };
}
