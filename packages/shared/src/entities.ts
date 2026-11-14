import { z } from 'zod';
import {
  AspectRatioSchema,
  CompositionSchema,
  ResolutionSchema,
  SubtitleStyleSchema,
} from './composition/schema';
import { BrandColorsSchema, BrandFontsSchema } from './composition/brand';
import { ConsentKindSchema, ConsentRelationshipSchema } from './consent';
import { StoredErrorSchema } from './errors';
import { AvatarIdSchema, VoiceIdSchema, idOf } from './ids';
import { LanguageCodeSchema, LocaleSchema, UiLocaleSchema } from './languages';
import { LedgerReasonSchema, PlanIdSchema, RoleSchema } from './plans';
import { SceneRuntimeSchema } from './runtime';

/* -------------------------------------------------------------------------------------------
 * Entities as they travel over the API (DTOs). Dates are ISO-8601 strings. DB rows live in
 * packages/db; API modules map row → DTO. URLs are ready to use (signed when needed) and may
 * expire: never persist them client side.
 * ----------------------------------------------------------------------------------------- */

export const IsoDateSchema = z.iso.datetime();
/** Absolute or root-relative URL produced by the API. */
export const UrlSchema = z.string().min(1);

/* ---------- providers & provenance (honesty rule) ---------- */

export const CAPABILITIES = [
  'tts',
  'stt',
  'llm',
  'translation',
  'voiceClone',
  'lipsync',
  'portrait',
  'moderation',
  'storage',
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * Quality tier shown in the UI next to every AI result:
 *  - basic:    local, offline implementation ("modo básico") — never presented as high quality
 *  - premium:  external high-quality service
 */
export const ProviderQualitySchema = z.enum(['basic', 'premium']);
export type ProviderQuality = z.infer<typeof ProviderQualitySchema>;

export const ProviderRefSchema = z.object({
  /** Stable id, e.g. `espeak`, `elevenlabs`, `anthropic`, `local`, `canvas2d`. */
  id: z.string(),
  /** Human readable name, e.g. "eSpeak NG (local)". */
  name: z.string(),
  quality: ProviderQualitySchema,
  /** True when it runs on this machine without network access or keys. */
  local: z.boolean(),
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

/** Which provider produced each part of a result. Stored on videos, translations, replies… */
export const ProvenanceSchema = z.partialRecord(CapabilitySchema, ProviderRefSchema);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** One model of the local avatar engine, as reported by its `GET /health` (docs/MODELS.md). */
export const EngineModelInfoSchema = z.object({
  /** Stable id used in docs/MODELS.md. */
  id: z.string(),
  role: z.enum(['portrait-generation', 'face-detection', 'matting', 'animation', 'other']),
  /** Weights present in the cache directory (checksums verified). */
  downloaded: z.boolean(),
  license: z.string(),
  commercialUse: z.boolean(),
});
export type EngineModelInfo = z.infer<typeof EngineModelInfoSchema>;

/** Which operations of the avatar engine are usable right now (all their weights present). */
export const EngineOperationsSchema = z.object({
  /** Text → portrait of a synthetic person. */
  generate: z.boolean(),
  /** Photo → prepared portrait (face detection, crop, matte). */
  prepare: z.boolean(),
  /** Portrait + audio → talking clip. */
  animate: z.boolean(),
});
export type EngineOperations = z.infer<typeof EngineOperationsSchema>;

export const CapabilitiesSchema = z.object({
  /** Active provider per capability. */
  active: z.record(CapabilitySchema, ProviderRefSchema),
  /** Every TTS provider with voices available (stock voices come from all of them). */
  ttsProviders: z.array(ProviderRefSchema),
  /** True when the STT provider needs the user to supply the transcript (local mode). */
  sttRequiresTranscript: z.boolean(),
  /**
   * State of the photorealistic avatar engine (master prompt §2b). When `available` is false
   * the UI explains `reason` and photoreal avatars cannot be created or rendered; the
   * "instant" 2D avatars always work.
   */
  avatarEngine: z.object({
    available: z.boolean(),
    /** Why it is not available (service not running, weights not downloaded…). */
    reason: z.string().nullable(),
    device: z.enum(['cpu', 'gpu']).nullable(),
    /**
     * MEASURED cost of animating: seconds of computation per second of video on this machine
     * (null until measured). Shown to the user as an honest time estimate.
     */
    secondsPerVideoSecond: z.number().positive().nullable(),
    /**
     * Availability PER OPERATION. `available` is true when at least one is usable; endpoints
     * check the one they need (generate → POST /api/photo-avatars/generate, prepare → POST
     * /api/photo-avatars, animate → renders with photorealistic avatars) BEFORE charging.
     */
    operations: EngineOperationsSchema.default({ generate: false, prepare: false, animate: false }),
    /** Models of the engine with their licence (drives the licence notice of §2b). */
    models: z.array(EngineModelInfoSchema).default([]),
    /**
     * True when any DOWNLOADED model forbids commercial use: the UI must show a visible
     * "non-commercial model" notice wherever photorealistic avatars are created or rendered.
     */
    nonCommercial: z.boolean().default(false),
    /** MEASURED seconds to generate one portrait on this machine (null until measured). */
    secondsPerPortrait: z.number().positive().nullable().default(null),
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/* ---------- users, sessions, workspaces, members ---------- */

export const UserSchema = z.object({
  id: idOf('user'),
  email: z.email(),
  name: z.string(),
  locale: UiLocaleSchema,
  createdAt: IsoDateSchema,
});
export type User = z.infer<typeof UserSchema>;

export const UserRefSchema = z.object({ id: idOf('user'), name: z.string() });
export type UserRef = z.infer<typeof UserRefSchema>;

export const WorkspaceSchema = z.object({
  id: idOf('workspace'),
  name: z.string(),
  plan: PlanIdSchema,
  /** Current credit balance. */
  credits: z.number().int(),
  createdAt: IsoDateSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceWithRoleSchema = WorkspaceSchema.extend({ role: RoleSchema });
export type WorkspaceWithRole = z.infer<typeof WorkspaceWithRoleSchema>;

export const SessionSchema = z.object({
  id: idOf('session'),
  expiresAt: IsoDateSchema,
  createdAt: IsoDateSchema,
});
export type Session = z.infer<typeof SessionSchema>;

/** Answer of register / login / me / switch-workspace: everything the app shell needs. */
export const SessionInfoSchema = z.object({
  user: UserSchema,
  session: SessionSchema,
  workspaces: z.array(WorkspaceWithRoleSchema),
  /** Workspace every workspace-scoped request of this session operates on. */
  currentWorkspaceId: idOf('workspace'),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const MemberSchema = z.object({
  id: idOf('member'),
  workspaceId: idOf('workspace'),
  userId: idOf('user'),
  name: z.string(),
  email: z.email(),
  role: RoleSchema,
  createdAt: IsoDateSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const InviteSchema = z.object({
  id: idOf('invite'),
  workspaceId: idOf('workspace'),
  email: z.email(),
  role: RoleSchema,
  invitedBy: UserRefSchema.nullable(),
  expiresAt: IsoDateSchema,
  acceptedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type Invite = z.infer<typeof InviteSchema>;

/** Returned once, on creation. No e-mail is sent: the inviter shares `acceptUrl` manually. */
export const InviteCreatedSchema = InviteSchema.extend({
  token: z.string(),
  acceptUrl: UrlSchema,
});
export type InviteCreated = z.infer<typeof InviteCreatedSchema>;

/* ---------- avatars ---------- */

export const GenderSchema = z.enum(['female', 'male', 'neutral']);
export type Gender = z.infer<typeof GenderSchema>;
export const AgeGroupSchema = z.enum(['young', 'adult', 'senior']);
export type AgeGroup = z.infer<typeof AgeGroupSchema>;
export const AvatarStyleSchema = z.enum(['professional', 'casual', 'creative']);
export type AvatarStyle = z.infer<typeof AvatarStyleSchema>;

export const PointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type Point = z.infer<typeof PointSchema>;

/**
 * Five face landmarks, normalised (0..1) to THE IMAGE THEY WERE MARKED ON. Which image that is
 * depends on where the value travels:
 *  - `CreatePhotoAvatarBody.landmarks` (create): the UPLOADED source image (`imageAssetId`).
 *    The photo-avatar job maps them onto the prepared portrait.
 *  - `PhotoAvatarRig.landmarks`, `PreparedPortrait.landmarks`, `Avatar.rig`, and the body of
 *    `PATCH /api/photo-avatars/:id` (update): the PREPARED portrait (`Avatar.imageUrl`, same
 *    size and framing as `Avatar.cutoutUrl`).
 * "left"/"right" are image-space (leftEye.x < rightEye.x), not the person's anatomical side.
 */
export const PhotoLandmarksSchema = z
  .object({
    leftEye: PointSchema,
    rightEye: PointSchema,
    mouthLeft: PointSchema,
    mouthRight: PointSchema,
    chin: PointSchema,
  })
  .describe(
    'Face landmarks normalised 0..1. On create: relative to the uploaded image. On update and in every response: relative to the prepared portrait (Avatar.imageUrl).',
  );
export type PhotoLandmarks = z.infer<typeof PhotoLandmarksSchema>;

/**
 * Geometry of a prepared portrait, used by the Canvas2D STAND-IN rig that previews
 * photorealistic avatars in real time (Studio preview, interactive avatar). The final render
 * uses the neural engine instead. `landmarksSource`: `detected` = face detector of the avatar
 * engine, `user` = marked by hand, `estimated` = centred-face heuristic (the UI says so).
 */
export const PhotoAvatarRigSchema = z.object({
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  landmarks: PhotoLandmarksSchema,
  landmarksSource: z.enum(['detected', 'user', 'estimated']),
});
export type PhotoAvatarRig = z.infer<typeof PhotoAvatarRigSchema>;

/**
 * Optional English texts of a catalogue entry. Catalogues are written in Spanish (the default
 * UI language); the API picks `en` values when `user.locale === 'en'` (see
 * `localizeCatalogEntry`) and searches (`q`) match both languages.
 */
export const CatalogEnglishSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type CatalogEnglish = z.infer<typeof CatalogEnglishSchema>;

/** Name / description / tags of a catalogue entry in the given UI language. */
export function localizeCatalogEntry<
  T extends { name: string; description?: string; tags: string[]; en?: CatalogEnglish | undefined },
>(entry: T, locale: string): { name: string; description: string; tags: string[] } {
  const en = locale === 'en' ? entry.en : undefined;
  return {
    name: en?.name ?? entry.name,
    description: en?.description ?? entry.description ?? '',
    tags: en?.tags ?? entry.tags,
  };
}

/** Static catalogue entry of a stock avatar (lives in packages/renderer/src/avatars). */
export const StockAvatarMetaSchema = z.object({
  id: AvatarIdSchema,
  name: z.string(),
  gender: GenderSchema,
  ageGroup: AgeGroupSchema,
  style: AvatarStyleSchema,
  description: z.string(),
  tags: z.array(z.string()),
  /** Free-form visual traits for filters/chips, e.g. `{ skin: 'dark', hair: 'curly black' }`. */
  traits: z.record(z.string(), z.string()),
  en: CatalogEnglishSchema.optional(),
});
export type StockAvatarMeta = z.infer<typeof StockAvatarMetaSchema>;

export const AsyncResourceStatusSchema = z.enum(['processing', 'ready', 'failed']);
export type AsyncResourceStatus = z.infer<typeof AsyncResourceStatusSchema>;

/**
 * How an avatar is animated:
 *  - instant:   2D parametric Canvas rig, real time, identical in preview and export
 *  - photoreal: neural engine clip rendered at export time (slow on CPU); previews use a
 *               Canvas stand-in over the portrait
 */
export const AvatarRenderingSchema = z.enum(['instant', 'photoreal']);
export type AvatarRendering = z.infer<typeof AvatarRenderingSchema>;

/** Catalogue entry of a photorealistic STOCK avatar: a synthetic person, versioned as images. */
export const StockPhotorealAvatarMetaSchema = z.object({
  /** `real_<slug>`. */
  id: AvatarIdSchema,
  name: z.string(),
  gender: GenderSchema,
  ageGroup: AgeGroupSchema,
  style: AvatarStyleSchema,
  description: z.string(),
  tags: z.array(z.string()),
  traits: z.record(z.string(), z.string()),
  /** Text prompt and seed the portrait was generated from (provenance of the synthetic person). */
  prompt: z.string(),
  seed: z.number().int(),
  /** Model that generated it (see docs/MODELS.md). */
  model: z.string(),
  /** Files inside packages/stock-assets/assets/avatars/: prepared portrait and alpha matte. */
  portraitFile: z.string(),
  maskFile: z.string().nullable(),
  rig: PhotoAvatarRigSchema,
  en: CatalogEnglishSchema.optional(),
});
export type StockPhotorealAvatarMeta = z.infer<typeof StockPhotorealAvatarMetaSchema>;

export const AvatarSchema = z.object({
  id: AvatarIdSchema,
  /**
   * Origin: `stock` = built-in (instant `stock_…` or photoreal `real_…`); `photo` = created by
   * the workspace from a photo of a real person (consent required); `generated` = synthetic
   * person generated by the workspace from a text description (no consent needed).
   */
  kind: z.enum(['stock', 'photo', 'generated']),
  rendering: AvatarRenderingSchema,
  name: z.string(),
  gender: GenderSchema,
  ageGroup: AgeGroupSchema.nullable(),
  style: AvatarStyleSchema.nullable(),
  description: z.string(),
  tags: z.array(z.string()),
  traits: z.record(z.string(), z.string()),
  status: AsyncResourceStatusSchema,
  /**
   * Preparation / generation progress 0..100 and MEASURED seconds remaining, persisted by the
   * photo-avatar job (clients poll `GET /api/avatars/:id` while `status` is `processing`).
   * Stock and `ready` avatars report 100 / null.
   */
  progress: z.number().min(0).max(100).default(100),
  etaSec: z.number().int().min(0).nullable().default(null),
  /** Instant stock avatars have no image: clients draw them with the renderer rig. */
  thumbnailUrl: UrlSchema.nullable(),
  /**
   * Photoreal avatars — all null for instant ones and until `status` is `ready`:
   *  - imageUrl:  prepared portrait (PNG, with its ORIGINAL background)
   *  - maskUrl:   alpha matte of the portrait (greyscale PNG, same size), null if none
   *  - cutoutUrl: portrait with the matte already applied (RGBA PNG, same size and framing).
   *               THIS is the image the Canvas stand-in rig is built from
   *               (`createPhotoAvatarRig(id, cutout, rig)`), so previews show the person cut
   *               out over the scene background exactly like the exported neural clip.
   * Workspace avatars (`avt_…`): signed storage URLs. Stock `real_…` avatars:
   * `GET /api/stock-avatars/:avatarId/{portrait|mask|cutout|thumb}` (public, cacheable).
   */
  imageUrl: UrlSchema.nullable(),
  maskUrl: UrlSchema.nullable(),
  cutoutUrl: UrlSchema.nullable().default(null),
  rig: PhotoAvatarRigSchema.nullable(),
  /** `generated` avatars (and stock `real_…`): the description they were generated from. */
  prompt: z.string().nullable(),
  /** Seed actually used to generate the portrait (reuse it to reproduce the person). */
  seed: z.number().int().nullable().default(null),
  /** Model that generated the portrait (provenance / licence, see docs/MODELS.md). */
  model: z.string().nullable().default(null),
  /**
   * Never null in the DTO. DB rows have `provider` null until the job finishes: the API
   * writes `providers.portrait.info` when it inserts the row (and mappers fall back to it).
   */
  provider: ProviderRefSchema,
  /** null for stock avatars. */
  workspaceId: idOf('workspace').nullable(),
  consentId: idOf('consent').nullable(),
  error: StoredErrorSchema.nullable(),
  createdAt: IsoDateSchema.nullable(),
});
export type Avatar = z.infer<typeof AvatarSchema>;

/* ---------- voices ---------- */

/** Result of local voice cloning: parameters applied on top of a local base voice. */
export const VoiceProfileSchema = z.object({
  /** Provider voice id of the base voice (e.g. an eSpeak voice). */
  baseVoiceId: z.string(),
  /** Pitch offset in semitones applied on top of the request pitch. */
  pitchSemitones: z.number().min(-12).max(12),
  /** Speed multiplier applied on top of the request speed. */
  speed: z.number().min(0.5).max(2),
  /** Measured mean fundamental frequency of the sample, if detected. */
  meanF0Hz: z.number().positive().nullable(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const VoiceSchema = z.object({
  id: VoiceIdSchema,
  kind: z.enum(['stock', 'cloned']),
  name: z.string(),
  /**
   * Never null in the DTO. Cloned voices: the API writes `providers.voiceClone.info` when it
   * inserts the row; the voice-clone job overwrites it with the provider that did the work.
   */
  provider: ProviderRefSchema,
  /** Primary language of the voice. */
  language: LocaleSchema,
  /**
   * True when the voice speaks every supported language (e.g. OpenAI TTS, ElevenLabs
   * multilingual): `GET /api/voices?language=xx` ALWAYS includes multilingual voices, and a
   * TTS script may use them with any `language`. `languages` optionally lists them.
   */
  multilingual: z.boolean().default(false),
  languages: z.array(LocaleSchema).optional(),
  gender: GenderSchema,
  description: z.string(),
  tags: z.array(z.string()),
  status: AsyncResourceStatusSchema,
  /** null for stock voices. */
  workspaceId: idOf('workspace').nullable(),
  consentId: idOf('consent').nullable(),
  profile: VoiceProfileSchema.nullable(),
  error: StoredErrorSchema.nullable(),
  createdAt: IsoDateSchema.nullable(),
});
export type Voice = z.infer<typeof VoiceSchema>;

/** Sample sentence used for voice previews, per language. */
export const VOICE_PREVIEW_TEXTS: Record<string, string> = {
  es: 'Hola, soy una de las voces de Parlante. Así sonará tu vídeo.',
  en: 'Hi, I am one of the Parlante voices. This is how your video will sound.',
  fr: 'Bonjour, je suis l’une des voix de Parlante. Voici comment sonnera votre vidéo.',
  de: 'Hallo, ich bin eine der Stimmen von Parlante. So wird Ihr Video klingen.',
  it: 'Ciao, sono una delle voci di Parlante. Ecco come suonerà il tuo video.',
  pt: 'Olá, sou uma das vozes da Parlante. É assim que o seu vídeo vai soar.',
  ca: 'Hola, soc una de les veus de Parlante. Així sonarà el teu vídeo.',
  nl: 'Hallo, ik ben een van de stemmen van Parlante. Zo klinkt je video.',
  pl: 'Cześć, jestem jednym z głosów Parlante. Tak będzie brzmieć twoje wideo.',
  sv: 'Hej, jag är en av Parlantes röster. Så här kommer din video att låta.',
  tr: 'Merhaba, ben Parlante seslerinden biriyim. Videonuz böyle duyulacak.',
  ru: 'Здравствуйте, я один из голосов Parlante. Так будет звучать ваше видео.',
  el: 'Γεια σας, είμαι μία από τις φωνές του Parlante. Έτσι θα ακούγεται το βίντεό σας.',
};

/** Result of on-demand speech synthesis (Studio preview, voice preview, interactive avatar). */
export const SynthesizedSpeechSchema = z.object({
  /** WAV audio (signed URL, cacheable). */
  audioUrl: UrlSchema,
  mimeType: z.literal('audio/wav'),
  /** Viseme and word timeline for the renderer (`audioDurationMs` included). */
  runtime: SceneRuntimeSchema,
  provider: ProviderRefSchema,
});
export type SynthesizedSpeech = z.infer<typeof SynthesizedSpeechSchema>;

/**
 * Content of `cache/tts/<sha>.json`, the sidecar of the cached WAV `cache/tts/<sha>.wav`
 * (`storageKeys.ttsCacheMeta/Audio`, hash from `ttsCacheKey`). The API
 * (`POST /api/tts/synthesize`) and the worker (render, translation) SHARE this cache, so both
 * read and write it only through `synthesizeCached` in @parlante/jobs. An entry that does not
 * parse is treated as a miss and rewritten.
 */
export const TtsCacheMetaSchema = z.object({
  v: z.literal(1),
  runtime: SceneRuntimeSchema,
  provider: ProviderRefSchema,
  /** Sample rate of the cached WAV (PCM 16-bit mono). */
  sampleRate: z.number().int().positive(),
});
export type TtsCacheMeta = z.infer<typeof TtsCacheMetaSchema>;

/**
 * Content of the `meta.json` of a cached neural avatar clip
 * (`storageKeys.avatarClipCache`, hash from `avatarClipCacheKey`). Written by the render job
 * after `lipsync.animate`, read before calling it again.
 */
export const AvatarClipCacheMetaSchema = z.object({
  v: z.literal(1),
  alpha: z.enum(['none', 'mask-video', 'mask-image']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  frameCount: z.number().int().min(0),
  provider: ProviderRefSchema,
});
export type AvatarClipCacheMeta = z.infer<typeof AvatarClipCacheMetaSchema>;

/* ---------- videos & render jobs ---------- */

/** Stages of the render pipeline, in order. */
/** `avatars` = neural animation of photorealistic avatar layers (skipped when there are none). */
export const RENDER_STAGES = [
  'prepare',
  'audio',
  'avatars',
  'frames',
  'encode',
  'finalize',
] as const;
export const RenderStageSchema = z.enum(RENDER_STAGES);
export type RenderStage = z.infer<typeof RenderStageSchema>;

export const VIDEO_STATUSES = ['draft', 'queued', 'rendering', 'completed', 'failed'] as const;
export const VideoStatusSchema = z.enum(VIDEO_STATUSES);
export type VideoStatus = z.infer<typeof VideoStatusSchema>;

export const VideoSourceSchema = z.enum(['studio', 'template', 'api', 'batch', 'script']);
export type VideoSource = z.infer<typeof VideoSourceSchema>;

export const VideoSummarySchema = z.object({
  id: idOf('video'),
  workspaceId: idOf('workspace'),
  title: z.string(),
  /** State of the LATEST render (draft = never rendered). */
  status: VideoStatusSchema,
  /** 0..100, meaningful while queued/rendering. */
  progress: z.number().min(0).max(100),
  aspect: AspectRatioSchema,
  /** Resolution of the latest render. */
  resolution: ResolutionSchema.nullable(),
  /** Real duration of the rendered file; null until completed. */
  durationMs: z.number().int().nullable(),
  thumbnailUrl: UrlSchema.nullable(),
  source: VideoSourceSchema,
  batchJobId: idOf('batchJob').nullable(),
  createdBy: UserRefSchema.nullable(),
  error: StoredErrorSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  renderedAt: IsoDateSchema.nullable(),
  /** While queued/rendering: current pipeline stage and estimated seconds remaining. */
  renderStage: RenderStageSchema.nullable(),
  renderEtaSec: z.number().int().nullable(),
  /**
   * True when the composition uses photorealistic avatars (`usesPhotorealAvatars(composition)`):
   * slow neural render on CPU, and the output is labelled as AI-generated in the UI.
   */
  usesPhotorealAvatars: z.boolean(),
});
export type VideoSummary = z.infer<typeof VideoSummarySchema>;

export const VideoSchema = VideoSummarySchema.extend({
  composition: CompositionSchema,
  /** Incremented on every composition/title change (optimistic concurrency for autosave). */
  revision: z.number().int(),
  /** Revision that produced the current output. `revision > renderedRevision` ⇒ outdated. */
  renderedRevision: z.number().int().nullable(),
  /** Estimated duration of the current composition (before rendering). */
  estimatedDurationMs: z.number().int(),
  /** MP4 (H.264 + AAC), for playback. */
  videoUrl: UrlSchema.nullable(),
  /**
   * Same MP4 served as an attachment named after the title
   * (`fileUrl(videoKey, { downloadName })`). File URLs are cross-origin, where browsers ignore
   * `<a download>`, so "Download" buttons MUST use this URL instead of `videoUrl`.
   */
  downloadUrl: UrlSchema.nullable(),
  srtUrl: UrlSchema.nullable(),
  vttUrl: UrlSchema.nullable(),
  /** Which providers produced the current output. */
  providers: ProvenanceSchema.nullable(),
  templateId: z.string().nullable(),
});
export type Video = z.infer<typeof VideoSchema>;

/**
 * Metadata written into every exported MP4 that contains photorealistic (neural) avatars, so
 * the file itself declares it is AI-generated (master prompt §2b). Applied by the render job
 * with `-movflags +faststart+use_metadata_tags -metadata key=value`.
 */
export const AI_GENERATED_METADATA: Readonly<Record<string, string>> = {
  comment: 'AI-generated video: contains a synthetic, AI-animated presenter. Made with Parlante.',
  'com.parlante.ai_generated': 'true',
  'com.parlante.generator': 'Parlante',
};

export const RENDER_JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
] as const;
export const RenderJobStatusSchema = z.enum(RENDER_JOB_STATUSES);
export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const RenderJobSchema = z.object({
  id: idOf('renderJob'),
  videoId: idOf('video'),
  status: RenderJobStatusSchema,
  stage: RenderStageSchema.nullable(),
  progress: z.number().min(0).max(100),
  /** Estimated seconds remaining (measured, null when unknown). */
  etaSec: z.number().int().nullable(),
  resolution: ResolutionSchema,
  /** Credits currently charged for this job (reservation, later settled to the real cost). */
  creditsCharged: z.number().int(),
  error: StoredErrorSchema.nullable(),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

/* ---------- assets ---------- */

export const AssetKindSchema = z.enum(['image', 'video', 'audio']);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/** Accepted upload types (checked against the REAL file signature, not the client header). */
export const ALLOWED_UPLOAD_MIME: Record<AssetKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: [
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/vnd.wave',
    'audio/ogg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/aac',
    'audio/flac',
    'audio/x-flac',
    'audio/webm',
  ],
};

export function assetKindForMime(mime: string): AssetKind | null {
  for (const kind of ['image', 'video', 'audio'] as const) {
    if (ALLOWED_UPLOAD_MIME[kind].includes(mime)) return kind;
  }
  return null;
}

/**
 * Why an asset was uploaded:
 *  - library:            media for compositions (the default; what the asset library lists)
 *  - avatar_source:      photo of a real person for a photo avatar (consent required)
 *  - voice_sample:       voice sample for a clone (consent required)
 *  - translation_source: video to translate
 * Non-library assets are hidden from `GET /api/assets` unless asked for, and `avatar_source` /
 * `voice_sample` assets are DELETED with their avatar / voice or when its consent is revoked.
 */
export const ASSET_PURPOSES = [
  'library',
  'avatar_source',
  'voice_sample',
  'translation_source',
] as const;
export const AssetPurposeSchema = z.enum(ASSET_PURPOSES);
export type AssetPurpose = z.infer<typeof AssetPurposeSchema>;

export const AssetSchema = z.object({
  id: idOf('asset'),
  workspaceId: idOf('workspace'),
  kind: AssetKindSchema,
  purpose: AssetPurposeSchema.default('library'),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  url: UrlSchema,
  thumbnailUrl: UrlSchema.nullable(),
  createdBy: UserRefSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type Asset = z.infer<typeof AssetSchema>;

/** Built-in media generated by code (packages/stock-assets). */
export const StockAssetCategorySchema = z.enum(['background', 'music', 'overlay']);
export const StockAssetSchema = z.object({
  /** Slug used in `MediaRef { source: 'stock', stockId }`. */
  id: z.string(),
  kind: AssetKindSchema,
  category: StockAssetCategorySchema,
  name: z.string(),
  tags: z.array(z.string()),
  mimeType: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  url: UrlSchema,
});
export type StockAsset = z.infer<typeof StockAssetSchema>;
/** Catalogue entry without the URL (what packages/stock-assets exports). */
export const StockAssetMetaSchema = StockAssetSchema.omit({ url: true }).extend({
  en: CatalogEnglishSchema.pick({ name: true, tags: true }).optional(),
});
export type StockAssetMeta = z.infer<typeof StockAssetMetaSchema>;

/* ---------- templates ---------- */

export const TEMPLATE_CATEGORIES = [
  'explainer',
  'ad',
  'training',
  'news',
  'product',
  'greeting',
  'other',
] as const;
export const TemplateCategorySchema = z.enum(TEMPLATE_CATEGORIES);
export type TemplateCategory = z.infer<typeof TemplateCategorySchema>;

/** Built-in templates: `builtin_<slug>`; custom (saved by a workspace): `tpl_…`. */
export const TemplateIdSchema = z
  .string()
  .max(64)
  .regex(/^(builtin_[a-z0-9-]{1,40}|tpl_[a-z0-9]{8,32})$/, 'Invalid template id');

export const TemplateSchema = z.object({
  id: TemplateIdSchema,
  kind: z.enum(['builtin', 'custom']),
  /** null for built-in templates. */
  workspaceId: idOf('workspace').nullable(),
  name: z.string(),
  description: z.string(),
  category: TemplateCategorySchema,
  aspect: AspectRatioSchema,
  tags: z.array(z.string()),
  sceneCount: z.number().int(),
  /**
   * Poster of the first scene. Built-in: `GET /api/templates/:templateId/thumbnail`; custom:
   * signed URL of `storageKeys.templateThumb` (rendered by "save as template").
   */
  thumbnailUrl: UrlSchema.nullable(),
  createdAt: IsoDateSchema.nullable(),
});
export type Template = z.infer<typeof TemplateSchema>;

export const TemplateDetailSchema = TemplateSchema.extend({ composition: CompositionSchema });
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

/** Shape of a built-in template definition (packages/templates). */
export const BuiltinTemplateSchema = z.object({
  id: TemplateIdSchema,
  name: z.object({ es: z.string(), en: z.string() }),
  description: z.object({ es: z.string(), en: z.string() }),
  category: TemplateCategorySchema,
  tags: z.array(z.string()),
  composition: CompositionSchema,
});
export type BuiltinTemplate = z.infer<typeof BuiltinTemplateSchema>;

/* ---------- brand kits ---------- */

export const BrandKitSchema = z.object({
  id: idOf('brandKit'),
  workspaceId: idOf('workspace'),
  name: z.string(),
  logoAssetId: idOf('asset').nullable(),
  logoUrl: UrlSchema.nullable(),
  colors: BrandColorsSchema,
  fonts: BrandFontsSchema,
  /** The default kit is pre-selected for new videos. At most one per workspace. */
  isDefault: z.boolean(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

/* ---------- API keys & webhooks ---------- */

/** Plain keys look like `plk_<8-char prefix>_<32-char secret>`; only a SHA-256 hash is stored. */
export const API_KEY_PREFIX = 'plk';

export const ApiKeySchema = z.object({
  id: idOf('apiKey'),
  workspaceId: idOf('workspace'),
  name: z.string(),
  /** First part of the key, safe to display: `plk_ab12cd34`. */
  prefix: z.string(),
  createdBy: UserRefSchema.nullable(),
  lastUsedAt: IsoDateSchema.nullable(),
  revokedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** Returned once, on creation. */
export const ApiKeyCreatedSchema = ApiKeySchema.extend({ key: z.string() });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;

export const WEBHOOK_EVENT_TYPES = ['video.completed', 'video.failed', 'ping'] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);
export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

export const WebhookEndpointSchema = z.object({
  id: idOf('webhookEndpoint'),
  workspaceId: idOf('workspace'),
  url: z.url(),
  description: z.string(),
  /** Subscribed events (`ping` is always deliverable via the test action). */
  events: z.array(WebhookEventTypeSchema),
  enabled: z.boolean(),
  /** Last 4 characters of the signing secret. */
  secretPreview: z.string(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

/** Returned on creation and on secret rotation: the only time the full secret is visible. */
export const WebhookEndpointCreatedSchema = WebhookEndpointSchema.extend({ secret: z.string() });
export type WebhookEndpointCreated = z.infer<typeof WebhookEndpointCreatedSchema>;

export const WebhookDeliveryStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookDeliverySchema = z.object({
  id: idOf('webhookDelivery'),
  endpointId: idOf('webhookEndpoint'),
  eventId: idOf('event'),
  eventType: WebhookEventTypeSchema,
  status: WebhookDeliveryStatusSchema,
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  nextRetryAt: IsoDateSchema.nullable(),
  deliveredAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

/* ---------- public API v1 video ---------- */

/** Video as exposed by the public API v1 and inside webhook payloads. */
export const PublicVideoSchema = z.object({
  id: idOf('video'),
  title: z.string(),
  status: VideoStatusSchema,
  progress: z.number().min(0).max(100),
  aspect: AspectRatioSchema,
  resolution: ResolutionSchema.nullable(),
  durationMs: z.number().int().nullable(),
  videoUrl: UrlSchema.nullable(),
  /** `videoUrl` served as an attachment (Content-Disposition) named after the title. */
  downloadUrl: UrlSchema.nullable().default(null),
  thumbnailUrl: UrlSchema.nullable(),
  srtUrl: UrlSchema.nullable(),
  vttUrl: UrlSchema.nullable(),
  providers: ProvenanceSchema.nullable(),
  /** True when the video contains a synthetic, AI-animated photorealistic presenter. */
  aiGenerated: z.boolean().default(false),
  error: StoredErrorSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  renderedAt: IsoDateSchema.nullable(),
});
export type PublicVideo = z.infer<typeof PublicVideoSchema>;

/**
 * Body POSTed to webhook endpoints. Headers:
 *   Parlante-Event: <type>
 *   Parlante-Delivery: <delivery id>
 *   Parlante-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 */
export const WebhookEventSchema = z.object({
  id: idOf('event'),
  type: WebhookEventTypeSchema,
  createdAt: IsoDateSchema,
  workspaceId: idOf('workspace'),
  data: z.object({
    /** Present for `video.*` events. URLs inside are valid for 7 days. */
    video: PublicVideoSchema.optional(),
  }),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/* ---------- translation ---------- */

export const TRANSLATION_STAGES = [
  'transcribing',
  'translating',
  'dubbing',
  'mixing',
  'finalizing',
] as const;
export const TranslationStageSchema = z.enum(TRANSLATION_STAGES);
export type TranslationStage = z.infer<typeof TranslationStageSchema>;

/** `partial` = some target languages completed and some failed. */
export const AsyncJobStatusSchema = z.enum([
  'queued',
  'processing',
  'completed',
  'partial',
  'failed',
  'canceled',
]);
export type AsyncJobStatus = z.infer<typeof AsyncJobStatusSchema>;

export const TranslationOutputSchema = z.object({
  id: idOf('translationOutput'),
  language: LanguageCodeSchema,
  voiceId: VoiceIdSchema,
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  /** Dubbed MP4 (playback) and the same file as an attachment (see `Video.downloadUrl`). */
  videoUrl: UrlSchema.nullable(),
  downloadUrl: UrlSchema.nullable().default(null),
  srtUrl: UrlSchema.nullable(),
  vttUrl: UrlSchema.nullable(),
  error: StoredErrorSchema.nullable(),
});
export type TranslationOutput = z.infer<typeof TranslationOutputSchema>;

export const TranslationOptionsSchema = z.object({
  /** Volume of the original audio kept under the dub (0 = remove). */
  originalAudioVolume: z.number().min(0).max(1).default(0.08),
  /** Burn translated subtitles into the picture (SRT/VTT are always produced). */
  burnSubtitles: z.boolean().default(false),
  /**
   * Look of the burned-in subtitles (default: `SubtitleStyleSchema` defaults). The translation
   * job paints them with `drawSubtitleCue` from @parlante/renderer — the same routine as
   * Studio videos — never with an ffmpeg subtitles filter.
   */
  subtitleStyle: SubtitleStyleSchema.optional(),
});
export type TranslationOptions = z.infer<typeof TranslationOptionsSchema>;

export const TranslationJobSchema = z.object({
  id: idOf('translationJob'),
  workspaceId: idOf('workspace'),
  name: z.string(),
  sourceAssetId: idOf('asset'),
  sourceUrl: UrlSchema.nullable(),
  sourceDurationMs: z.number().int().nullable(),
  sourceLanguage: LanguageCodeSchema,
  targetLanguages: z.array(LanguageCodeSchema),
  status: AsyncJobStatusSchema,
  stage: TranslationStageSchema.nullable(),
  progress: z.number().min(0).max(100),
  /** `user` = transcript supplied by the user; `stt` = produced by the STT provider. */
  transcriptSource: z.enum(['user', 'stt']),
  options: TranslationOptionsSchema,
  outputs: z.array(TranslationOutputSchema),
  providers: ProvenanceSchema.nullable(),
  creditsCharged: z.number().int(),
  error: StoredErrorSchema.nullable(),
  createdBy: UserRefSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type TranslationJob = z.infer<typeof TranslationJobSchema>;

/* ---------- batch ---------- */

export const BatchItemSchema = z.object({
  id: idOf('batchItem'),
  /** Zero-based row index in the source data. */
  index: z.number().int(),
  values: z.record(z.string(), z.string()),
  status: z.enum(['pending', 'queued', 'rendering', 'completed', 'failed', 'canceled']),
  videoId: idOf('video').nullable(),
  videoUrl: UrlSchema.nullable(),
  /** `videoUrl` as an attachment (see `Video.downloadUrl`). */
  downloadUrl: UrlSchema.nullable().default(null),
  thumbnailUrl: UrlSchema.nullable(),
  error: StoredErrorSchema.nullable(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;

export const BatchJobSchema = z.object({
  id: idOf('batchJob'),
  workspaceId: idOf('workspace'),
  name: z.string(),
  /** Video whose composition (with `{{variables}}`) is the template of the batch. */
  sourceVideoId: idOf('video').nullable(),
  resolution: ResolutionSchema,
  status: AsyncJobStatusSchema,
  total: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  progress: z.number().min(0).max(100),
  /**
   * Sum of `render_jobs.credits_charged` of the batch's videos (kept by `recomputeBatchStatus`).
   * The batch itself is never charged: every render is, with refType `renderJob`.
   */
  creditsCharged: z.number().int(),
  error: StoredErrorSchema.nullable(),
  createdBy: UserRefSchema.nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type BatchJob = z.infer<typeof BatchJobSchema>;

export const BatchJobDetailSchema = BatchJobSchema.extend({
  variables: z.array(z.string()),
  items: z.array(BatchItemSchema),
});
export type BatchJobDetail = z.infer<typeof BatchJobDetailSchema>;

/* ---------- consent ---------- */

export const ConsentRecordSchema = z.object({
  id: idOf('consent'),
  workspaceId: idOf('workspace'),
  user: UserRefSchema.nullable(),
  kind: ConsentKindSchema,
  /** Full name of the person giving consent. */
  subjectName: z.string(),
  relationship: ConsentRelationshipSchema,
  statementVersion: z.string(),
  /** Exact text that was accepted. */
  statement: z.string(),
  /** Avatar or voice created with this consent (null until used). */
  resourceId: z.string().nullable(),
  revokedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/* ---------- credits ---------- */

export const CreditLedgerEntrySchema = z.object({
  id: idOf('ledgerEntry'),
  workspaceId: idOf('workspace'),
  /** Positive = credits added, negative = credits spent. */
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: LedgerReasonSchema,
  /** Entity the entry refers to, e.g. `renderJob` + id. */
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  description: z.string(),
  createdAt: IsoDateSchema,
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntrySchema>;

/* ---------- share links ---------- */

export const ShareLinkSchema = z.object({
  id: idOf('shareLink'),
  videoId: idOf('video'),
  token: z.string(),
  /** Public page URL (web app): `${PUBLIC_WEB_URL}/s/<token>`. */
  url: UrlSchema,
  enabled: z.boolean(),
  allowDownload: z.boolean(),
  viewCount: z.number().int(),
  expiresAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

/** What the public share page receives (no workspace internals). */
export const PublicShareSchema = z.object({
  title: z.string(),
  aspect: AspectRatioSchema,
  durationMs: z.number().int().nullable(),
  videoUrl: UrlSchema,
  thumbnailUrl: UrlSchema.nullable(),
  vttUrl: UrlSchema.nullable(),
  /** null when downloads are disabled. */
  downloadUrl: UrlSchema.nullable(),
  workspaceName: z.string(),
  providers: ProvenanceSchema.nullable(),
  /**
   * True when the video contains a synthetic, AI-animated photorealistic presenter: the public
   * page shows an "AI-generated" label (the MP4 also carries `AI_GENERATED_METADATA`).
   */
  aiGenerated: z.boolean().default(false),
  createdAt: IsoDateSchema,
});
export type PublicShare = z.infer<typeof PublicShareSchema>;

/* ---------- AI script writer ---------- */

export const ScriptToneSchema = z.enum([
  'professional',
  'friendly',
  'enthusiastic',
  'educational',
  'persuasive',
  'humorous',
]);
export type ScriptTone = z.infer<typeof ScriptToneSchema>;

export const GeneratedSceneSchema = z.object({
  title: z.string(),
  /** Narration text of the scene. */
  text: z.string(),
  /** Short on-screen headline suggested for a text layer. */
  headline: z.string(),
  estimatedSec: z.number(),
});
export type GeneratedScene = z.infer<typeof GeneratedSceneSchema>;

export const GeneratedScriptSchema = z.object({
  title: z.string(),
  language: LanguageCodeSchema,
  scenes: z.array(GeneratedSceneSchema).min(1),
  provider: ProviderRefSchema,
  /** True when produced by the local heuristic ("modo básico"). The UI must say so. */
  basicMode: z.boolean(),
  /** For URL sources: title of the page the script is based on. */
  sourceTitle: z.string().nullable(),
});
export type GeneratedScript = z.infer<typeof GeneratedScriptSchema>;

/* ---------- interactive avatar ---------- */

export const InteractivePersonaSchema = z.object({
  /** Name the avatar introduces itself with. */
  name: z.string().min(1).max(60),
  /** What the avatar is for / how it should answer (system instructions). */
  instructions: z.string().max(4000).default(''),
  /** Optional knowledge the avatar can draw on (FAQ text). */
  knowledge: z.string().max(20000).default(''),
});
export type InteractivePersona = z.infer<typeof InteractivePersonaSchema>;

export const InteractiveSessionSchema = z.object({
  id: idOf('interactiveSession'),
  workspaceId: idOf('workspace'),
  avatarId: AvatarIdSchema,
  voiceId: VoiceIdSchema,
  language: LanguageCodeSchema,
  persona: InteractivePersonaSchema,
  status: z.enum(['active', 'ended']),
  messageCount: z.number().int(),
  providers: ProvenanceSchema,
  createdAt: IsoDateSchema,
  endedAt: IsoDateSchema.nullable(),
});
export type InteractiveSession = z.infer<typeof InteractiveSessionSchema>;

export const InteractiveMessageSchema = z.object({
  id: idOf('interactiveMessage'),
  sessionId: idOf('interactiveSession'),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: IsoDateSchema,
});
export type InteractiveMessage = z.infer<typeof InteractiveMessageSchema>;

/** Answer to one user turn: text + speech + lip-sync timeline, ready for the client renderer. */
export const InteractiveReplySchema = z.object({
  userMessage: InteractiveMessageSchema,
  assistantMessage: InteractiveMessageSchema,
  /** null when the reply is empty or speech synthesis failed (text is still shown). */
  speech: SynthesizedSpeechSchema.nullable(),
  providers: ProvenanceSchema,
});
export type InteractiveReply = z.infer<typeof InteractiveReplySchema>;
