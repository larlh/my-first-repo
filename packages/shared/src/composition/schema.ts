import { z } from 'zod';
import { AvatarIdSchema, VoiceIdSchema, idOf } from '../ids';
import { LocaleSchema } from '../languages';

/* -------------------------------------------------------------------------------------------
 * Composition — the ONLY video document format. Editor, API, templates and worker speak it.
 *
 * Conventions
 *  - All layer geometry is normalised to the canvas: x/y/w/h in 0..1 (may overflow the canvas).
 *  - Sizes that are not boxes (font size, stroke width, radius, margins) are fractions of the
 *    canvas HEIGHT, so a composition renders identically at 720p and 1080p.
 *  - Times are integer milliseconds. The frame rate is fixed at 30 fps.
 *  - Text fields (`TextLayer.text`, `TtsScript.text`) may contain `{{variable}}` placeholders.
 * ----------------------------------------------------------------------------------------- */

export const COMPOSITION_VERSION = 1 as const;
export const FPS = 30 as const;

export const COMPOSITION_LIMITS = {
  maxScenes: 50,
  maxLayersPerScene: 30,
  maxScriptChars: 5000,
  maxTextChars: 2000,
  maxVariables: 50,
  maxFixedSceneSeconds: 300,
  minSceneMs: 500,
} as const;

/* ---------- primitives ---------- */

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. */
export const ColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Expected a hex colour');

export const AspectRatioSchema = z.enum(['16:9', '9:16', '1:1']);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const ResolutionSchema = z.enum(['720p', '1080p']);
export type Resolution = z.infer<typeof ResolutionSchema>;

/** Design-size canvas (720p class) for each aspect ratio. */
export const CANVAS_PRESETS: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
};

/** Output pixel size for an aspect ratio and export resolution (always even numbers). */
export function resolutionSize(
  aspect: AspectRatio,
  resolution: Resolution,
): { width: number; height: number } {
  const base = CANVAS_PRESETS[aspect];
  const scale = resolution === '1080p' ? 1.5 : 1;
  return { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };
}

/** Fonts bundled through @fontsource and registered identically in browser and Node. */
export const FONT_FAMILIES = [
  { family: 'Inter', package: '@fontsource/inter', slug: 'inter', kind: 'sans' },
  { family: 'Poppins', package: '@fontsource/poppins', slug: 'poppins', kind: 'sans' },
  { family: 'Montserrat', package: '@fontsource/montserrat', slug: 'montserrat', kind: 'sans' },
  {
    family: 'Playfair Display',
    package: '@fontsource/playfair-display',
    slug: 'playfair-display',
    kind: 'serif',
  },
  { family: 'Roboto Slab', package: '@fontsource/roboto-slab', slug: 'roboto-slab', kind: 'slab' },
  {
    family: 'JetBrains Mono',
    package: '@fontsource/jetbrains-mono',
    slug: 'jetbrains-mono',
    kind: 'mono',
  },
] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number]['family'];
export const FONT_FAMILY_NAMES = FONT_FAMILIES.map((f) => f.family) as [
  FontFamily,
  ...FontFamily[],
];
export const FontFamilySchema = z.enum(FONT_FAMILY_NAMES);
/** Weights guaranteed to be registered for every bundled family. */
export const FONT_WEIGHTS = [400, 500, 600, 700, 800] as const;
export const FontWeightSchema = z.union([
  z.literal(400),
  z.literal(500),
  z.literal(600),
  z.literal(700),
  z.literal(800),
]);
export type FontWeight = z.infer<typeof FontWeightSchema>;

/* ---------- media references ---------- */

/**
 * Reference to a media file. Never a free URL (SSRF / privacy): either an uploaded Asset of the
 * workspace or a built-in stock asset (packages/stock-assets).
 */
export const MediaRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('asset'), assetId: idOf('asset') }),
  z.object({
    source: z.literal('stock'),
    stockId: z
      .string()
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
  }),
]);
export type MediaRef = z.infer<typeof MediaRefSchema>;

/** Stable string key for a MediaRef: `asset:<id>` or `stock:<id>`. Used to index loaded assets. */
export function mediaRefKey(ref: MediaRef): string {
  return ref.source === 'asset' ? `asset:${ref.assetId}` : `stock:${ref.stockId}`;
}

export const FitSchema = z.enum(['cover', 'contain', 'fill']);
export type Fit = z.infer<typeof FitSchema>;

/* ---------- canvas ---------- */

export const CanvasSchema = z
  .object({
    aspect: AspectRatioSchema,
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    fps: z.literal(FPS).default(FPS),
  })
  .refine(
    (c) => {
      const [a, b] = c.aspect.split(':').map(Number) as [number, number];
      return Math.abs(c.width / c.height - a / b) < 0.01;
    },
    { message: 'width/height do not match the aspect ratio', path: ['width'] },
  );
export type Canvas = z.infer<typeof CanvasSchema>;

/* ---------- script ---------- */

export const TtsScriptSchema = z.object({
  kind: z.literal('tts'),
  /** Text to speak. May contain `{{variables}}`. Empty text ⇒ the scene is silent. */
  text: z.string().max(COMPOSITION_LIMITS.maxScriptChars),
  voiceId: VoiceIdSchema,
  /** Speech rate multiplier. */
  speed: z.number().min(0.5).max(2).default(1),
  /** Pitch shift in semitones. */
  pitch: z.number().min(-12).max(12).default(0),
  language: LocaleSchema,
});
export type TtsScript = z.infer<typeof TtsScriptSchema>;

export const AudioScriptSchema = z.object({
  kind: z.literal('audio'),
  /** Uploaded audio Asset used as the scene narration. */
  assetId: idOf('asset'),
  /** Optional transcript: drives subtitles (words are spread evenly over the audio). */
  transcript: z.string().max(COMPOSITION_LIMITS.maxScriptChars).default(''),
  language: LocaleSchema.optional(),
});
export type AudioScript = z.infer<typeof AudioScriptSchema>;

export const NoScriptSchema = z.object({ kind: z.literal('none') });

export const ScriptSchema = z.discriminatedUnion('kind', [
  TtsScriptSchema,
  AudioScriptSchema,
  NoScriptSchema,
]);
export type Script = z.infer<typeof ScriptSchema>;

/* ---------- duration ---------- */

/**
 * `auto`: scene lasts paddingStartMs + narration + paddingEndMs (3 s when there is no narration).
 * `fixed`: scene lasts exactly `seconds`; narration that does not fit is cut with a short fade.
 */
export const SceneDurationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({
    mode: z.literal('fixed'),
    seconds: z.number().min(0.5).max(COMPOSITION_LIMITS.maxFixedSceneSeconds),
  }),
]);
export type SceneDuration = z.infer<typeof SceneDurationSchema>;

/* ---------- background ---------- */

export const GradientSchema = z.object({
  kind: z.enum(['linear', 'radial']).default('linear'),
  /** Degrees, 0 = left→right, 90 = top→bottom. Ignored for radial. */
  angle: z.number().min(0).max(360).default(135),
  stops: z
    .array(z.object({ offset: z.number().min(0).max(1), color: ColorSchema }))
    .min(2)
    .max(6),
});
export type Gradient = z.infer<typeof GradientSchema>;

export const BrandColorRoleSchema = z.enum([
  'primary',
  'secondary',
  'accent',
  'background',
  'text',
]);
export type BrandColorRole = z.infer<typeof BrandColorRoleSchema>;

export const BackgroundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('color'),
    color: ColorSchema,
    /** When set, applying a brand kit replaces `color` with that brand colour. */
    brandRole: BrandColorRoleSchema.optional(),
  }),
  z.object({ type: z.literal('gradient'), gradient: GradientSchema }),
  z.object({
    type: z.literal('image'),
    src: MediaRefSchema,
    fit: FitSchema.default('cover'),
    /** Blur radius as a fraction of canvas height (0 = none). */
    blur: z.number().min(0).max(0.1).default(0),
    /** Black overlay opacity 0..1 to improve contrast. */
    dim: z.number().min(0).max(1).default(0),
  }),
  z.object({
    type: z.literal('video'),
    src: MediaRefSchema,
    fit: FitSchema.default('cover'),
    loop: z.boolean().default(true),
    /** 0 = muted. Background video audio is mixed under the narration. */
    volume: z.number().min(0).max(1).default(0),
    trimStartMs: z.number().int().min(0).default(0),
    dim: z.number().min(0).max(1).default(0),
  }),
]);
export type Background = z.infer<typeof BackgroundSchema>;

/* ---------- transitions & animations ---------- */

export const TRANSITION_TYPES = [
  'none',
  'fade',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
  'wipe',
  'zoom',
] as const;
/**
 * Transition INTO this scene from the previous one. It plays during the first `durationMs` of
 * the incoming scene while the previous scene is held on its last frame; the total timeline
 * length is unaffected and audio never overlaps. Ignored on the first scene.
 */
export const TransitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES).default('none'),
  durationMs: z.number().int().min(0).max(2000).default(500),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const ANIMATION_TYPES = [
  'none',
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'zoom-in',
  'zoom-out',
  'pop',
] as const;
export const EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back-out'] as const;
export const AnimationSchema = z.object({
  type: z.enum(ANIMATION_TYPES).default('none'),
  durationMs: z.number().int().min(0).max(5000).default(400),
  /** Delay after the layer becomes visible (enter) / before it disappears (exit). */
  delayMs: z.number().int().min(0).max(60000).default(0),
  easing: z.enum(EASINGS).default('ease-out'),
});
export type Animation = z.infer<typeof AnimationSchema>;

/* ---------- layers ---------- */

/** Top-left anchored box, normalised to the canvas. */
export const BoxSchema = z.object({
  x: z.number().min(-2).max(3),
  y: z.number().min(-2).max(3),
  w: z.number().gt(0).max(4),
  h: z.number().gt(0).max(4),
});
export type Box = z.infer<typeof BoxSchema>;

/** Optional visibility window inside the scene (scene-local ms). `endMs: null` = until scene end. */
export const LayerTimingSchema = z.object({
  startMs: z.number().int().min(0).default(0),
  endMs: z.number().int().min(0).nullable().default(null),
});
export type LayerTiming = z.infer<typeof LayerTimingSchema>;

/** Semantic role used by brand kits to restyle layers. */
export const LayerRoleSchema = z.enum(['title', 'subtitle', 'body', 'caption', 'logo', 'accent']);
export type LayerRole = z.infer<typeof LayerRoleSchema>;

const layerBase = {
  id: z.string().min(1).max(64),
  name: z.string().max(80).default(''),
  box: BoxSchema,
  /** Clockwise degrees around the box centre. */
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  /** Paint order inside the scene: higher z is drawn on top. Ties keep array order. */
  z: z.number().int().min(-1000).max(1000).default(0),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  enter: AnimationSchema.optional(),
  exit: AnimationSchema.optional(),
  timing: LayerTimingSchema.optional(),
  role: LayerRoleSchema.optional(),
};

export const AvatarFramingSchema = z.enum(['bust', 'half', 'closeup']);
export type AvatarFraming = z.infer<typeof AvatarFramingSchema>;

export const AvatarLayerSchema = z.object({
  ...layerBase,
  type: z.literal('avatar'),
  avatarId: AvatarIdSchema,
  /** How much of the character is shown inside the box. */
  framing: AvatarFramingSchema.default('bust'),
  /** Mask applied to the box. `circle` and `rounded` paint `backdrop` behind the avatar. */
  shape: z.enum(['none', 'circle', 'rounded']).default('none'),
  backdrop: ColorSchema.nullable().default(null),
  flip: z.boolean().default(false),
});
export type AvatarLayer = z.infer<typeof AvatarLayerSchema>;

export const TextStyleSchema = z.object({
  fontFamily: FontFamilySchema.default('Inter'),
  /** Fraction of canvas height. */
  fontSize: z.number().min(0.005).max(0.5).default(0.06),
  fontWeight: FontWeightSchema.default(700),
  italic: z.boolean().default(false),
  color: ColorSchema.default('#ffffff'),
  align: z.enum(['left', 'center', 'right']).default('center'),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).default('middle'),
  lineHeight: z.number().min(0.8).max(3).default(1.2),
  /** Em units. */
  letterSpacing: z.number().min(-0.1).max(0.5).default(0),
  uppercase: z.boolean().default(false),
  /** Optional pill/box painted behind the text block. */
  background: z
    .object({
      color: ColorSchema,
      /** Fractions of canvas height. */
      padding: z.number().min(0).max(0.2).default(0.015),
      radius: z.number().min(0).max(0.5).default(0.01),
    })
    .nullable()
    .default(null),
  stroke: z
    .object({ color: ColorSchema, width: z.number().min(0).max(0.05).default(0.004) })
    .nullable()
    .default(null),
  shadow: z
    .object({
      color: ColorSchema.default('#00000080'),
      blur: z.number().min(0).max(0.1).default(0.01),
      offsetX: z.number().min(-0.1).max(0.1).default(0),
      offsetY: z.number().min(-0.1).max(0.1).default(0.004),
    })
    .nullable()
    .default(null),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TextLayerSchema = z.object({
  ...layerBase,
  type: z.literal('text'),
  /** May contain `{{variables}}` and line breaks. Text wraps inside the box. */
  text: z.string().max(COMPOSITION_LIMITS.maxTextChars),
  style: TextStyleSchema.default(() => TextStyleSchema.parse({})),
});
export type TextLayer = z.infer<typeof TextLayerSchema>;

export const ImageLayerSchema = z.object({
  ...layerBase,
  type: z.literal('image'),
  src: MediaRefSchema,
  fit: FitSchema.default('contain'),
  /** Corner radius as a fraction of canvas height. */
  radius: z.number().min(0).max(0.5).default(0),
});
export type ImageLayer = z.infer<typeof ImageLayerSchema>;

export const VideoLayerSchema = z.object({
  ...layerBase,
  type: z.literal('video'),
  src: MediaRefSchema,
  fit: FitSchema.default('cover'),
  radius: z.number().min(0).max(0.5).default(0),
  trimStartMs: z.number().int().min(0).default(0),
  loop: z.boolean().default(true),
  /** 0 = muted. */
  volume: z.number().min(0).max(1).default(0),
});
export type VideoLayer = z.infer<typeof VideoLayerSchema>;

export const SHAPE_KINDS = ['rect', 'ellipse', 'triangle', 'line', 'star'] as const;
export const ShapeLayerSchema = z.object({
  ...layerBase,
  type: z.literal('shape'),
  shape: z.enum(SHAPE_KINDS).default('rect'),
  fill: ColorSchema.nullable().default('#6d5efc'),
  stroke: z
    .object({ color: ColorSchema, width: z.number().min(0).max(0.1).default(0.004) })
    .nullable()
    .default(null),
  /** Corner radius for `rect`, fraction of canvas height. */
  radius: z.number().min(0).max(0.5).default(0),
});
export type ShapeLayer = z.infer<typeof ShapeLayerSchema>;

export const LayerSchema = z.discriminatedUnion('type', [
  AvatarLayerSchema,
  TextLayerSchema,
  ImageLayerSchema,
  VideoLayerSchema,
  ShapeLayerSchema,
]);
export type Layer = z.infer<typeof LayerSchema>;
export type LayerType = Layer['type'];
export const LAYER_TYPES = ['avatar', 'text', 'image', 'video', 'shape'] as const;

/* ---------- scene ---------- */

export const SceneSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(80).default(''),
  duration: SceneDurationSchema.default({ mode: 'auto' }),
  script: ScriptSchema.default({ kind: 'none' }),
  background: BackgroundSchema.default({ type: 'color', color: '#101322' }),
  transition: TransitionSchema.default({ type: 'none', durationMs: 500 }),
  layers: z.array(LayerSchema).max(COMPOSITION_LIMITS.maxLayersPerScene).default([]),
  /** Silence before the narration starts / after it ends (auto duration). */
  paddingStartMs: z.number().int().min(0).max(10000).default(300),
  paddingEndMs: z.number().int().min(0).max(10000).default(500),
});
export type Scene = z.infer<typeof SceneSchema>;

/* ---------- subtitles ---------- */

export const SUBTITLE_PRESETS = ['classic', 'boxed', 'karaoke', 'minimal'] as const;
/**
 * Burned-in subtitle style. Cues are derived from `SceneRuntime.words` (see renderer
 * `buildSubtitleCues`); the same cues are exported as SRT/VTT.
 *  - classic: white text with dark outline
 *  - boxed:   text on a solid rounded box
 *  - karaoke: like boxed, the word being spoken is painted with `highlightColor`
 *  - minimal: small text, no box, soft shadow
 */
export const SubtitleStyleSchema = z.object({
  enabled: z.boolean().default(true),
  preset: z.enum(SUBTITLE_PRESETS).default('boxed'),
  fontFamily: FontFamilySchema.default('Inter'),
  /** Fraction of canvas height. */
  fontSize: z.number().min(0.015).max(0.15).default(0.045),
  fontWeight: FontWeightSchema.default(600),
  color: ColorSchema.default('#ffffff'),
  highlightColor: ColorSchema.default('#ffd84d'),
  backgroundColor: ColorSchema.default('#000000b3'),
  position: z.enum(['top', 'middle', 'bottom']).default('bottom'),
  /** Distance from the canvas edge, fraction of canvas height. */
  margin: z.number().min(0).max(0.4).default(0.07),
  maxCharsPerLine: z.number().int().min(10).max(80).default(38),
  maxLines: z.number().int().min(1).max(3).default(2),
  uppercase: z.boolean().default(false),
});
export type SubtitleStyle = z.infer<typeof SubtitleStyleSchema>;

/* ---------- music ---------- */

export const MusicTrackSchema = z.object({
  src: MediaRefSchema,
  volume: z.number().min(0).max(1).default(0.18),
  /** Lower the music while narration is playing. */
  ducking: z.boolean().default(true),
  fadeInMs: z.number().int().min(0).max(10000).default(500),
  fadeOutMs: z.number().int().min(0).max(10000).default(1500),
  loop: z.boolean().default(true),
});
export type MusicTrack = z.infer<typeof MusicTrackSchema>;

/* ---------- variables ---------- */

export const VARIABLE_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
export const VariableDefSchema = z.object({
  name: z.string().regex(VARIABLE_NAME_REGEX, 'Invalid variable name'),
  label: z.string().max(80).default(''),
  defaultValue: z.string().max(500).default(''),
});
export type VariableDef = z.infer<typeof VariableDefSchema>;

/* ---------- composition ---------- */

export const CompositionSchema = z
  .object({
    version: z.literal(COMPOSITION_VERSION),
    canvas: CanvasSchema,
    scenes: z.array(SceneSchema).min(1).max(COMPOSITION_LIMITS.maxScenes),
    subtitles: SubtitleStyleSchema.default(() => SubtitleStyleSchema.parse({})),
    music: MusicTrackSchema.nullable().default(null),
    /** Brand kit last applied to this document (informational; styles are already baked in). */
    brandKitId: idOf('brandKit').nullable().default(null),
    /** Declared `{{variables}}` for batch personalisation. */
    variables: z.array(VariableDefSchema).max(COMPOSITION_LIMITS.maxVariables).default([]),
  })
  .superRefine((comp, ctx) => {
    const sceneIds = new Set<string>();
    comp.scenes.forEach((scene, si) => {
      if (sceneIds.has(scene.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate scene id "${scene.id}"`,
          path: ['scenes', si, 'id'],
        });
      }
      sceneIds.add(scene.id);
      const layerIds = new Set<string>();
      scene.layers.forEach((layer, li) => {
        if (layerIds.has(layer.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate layer id "${layer.id}"`,
            path: ['scenes', si, 'layers', li, 'id'],
          });
        }
        layerIds.add(layer.id);
      });
    });
    const names = new Set<string>();
    comp.variables.forEach((v, vi) => {
      if (names.has(v.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate variable "${v.name}"`,
          path: ['variables', vi, 'name'],
        });
      }
      names.add(v.name);
    });
  });

/** Fully-defaulted document (what the renderer, worker and DB handle). */
export type Composition = z.infer<typeof CompositionSchema>;
/** Sparse document accepted as input (defaults not yet applied). */
export type CompositionInput = z.input<typeof CompositionSchema>;
