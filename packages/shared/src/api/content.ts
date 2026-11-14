import { z } from 'zod';
import {
  AspectRatioSchema,
  CompositionSchema,
  ResolutionSchema,
  TtsScriptSchema,
} from '../composition/schema';
import {
  BrandColorsPatchSchema,
  BrandColorsSchema,
  BrandFontsPatchSchema,
  BrandFontsSchema,
} from '../composition/brand';
import {
  AgeGroupSchema,
  AssetKindSchema,
  AssetSchema,
  AvatarRenderingSchema,
  AvatarSchema,
  AvatarStyleSchema,
  BrandKitSchema,
  GenderSchema,
  PublicShareSchema,
  RenderJobSchema,
  ShareLinkSchema,
  StockAssetCategorySchema,
  StockAssetSchema,
  SynthesizedSpeechSchema,
  TemplateCategorySchema,
  TemplateDetailSchema,
  TemplateIdSchema,
  TemplateSchema,
  VideoSchema,
  VideoStatusSchema,
  VideoSummarySchema,
  VoiceSchema,
} from '../entities';
import { AvatarIdSchema, VoiceIdSchema, idOf } from '../ids';
import { LanguageCodeSchema } from '../languages';
import { PaginationQuerySchema, paginated } from '../pagination';
import { OkSchema, listOf, route } from './contract';

const search = z.string().trim().max(100).optional();
const TitleSchema = z.string().trim().min(1).max(120);

/* ============================== videos (features 4, 5, 6) ============================== */

const videoParams = z.object({ videoId: idOf('video') });

export const ListVideosQuerySchema = PaginationQuerySchema.extend({
  status: VideoStatusSchema.optional(),
  q: search,
  batchJobId: idOf('batchJob').optional(),
});

/**
 * Create a draft. Exactly one starting point:
 *  - `composition`: full document (e.g. built by the script writer on the client)
 *  - `templateId`:  copy of a built-in or custom template
 *  - neither:       empty one-scene document with `aspect` (default 16:9)
 */
export const CreateVideoBodySchema = z
  .object({
    title: TitleSchema.optional(),
    composition: CompositionSchema.optional(),
    templateId: TemplateIdSchema.optional(),
    aspect: AspectRatioSchema.optional(),
  })
  .refine((b) => !(b.composition && b.templateId), {
    message: 'Provide either composition or templateId, not both',
    path: ['templateId'],
  });

/**
 * Autosave. `baseRevision` enables optimistic concurrency: when it is sent and differs from the
 * stored revision the API answers 409 REVISION_CONFLICT (details: `{ currentRevision }`).
 */
export const UpdateVideoBodySchema = z.object({
  title: TitleSchema.optional(),
  composition: CompositionSchema.optional(),
  baseRevision: z.number().int().optional(),
});

export const RenderVideoBodySchema = z.object({
  resolution: ResolutionSchema.default('720p'),
});

export const RenderStartedSchema = z.object({
  video: VideoSchema,
  renderJob: RenderJobSchema,
});

export const SaveAsTemplateBodySchema = z.object({
  name: TitleSchema,
  description: z.string().max(300).default(''),
  category: TemplateCategorySchema.default('other'),
});

export const videoRoutes = {
  list: route({
    method: 'GET',
    path: '/api/videos',
    auth: 'session',
    feature: 6,
    tag: 'Videos',
    summary: 'Videos of the workspace, newest first',
    query: ListVideosQuerySchema,
    response: paginated(VideoSummarySchema),
  }),
  create: route({
    method: 'POST',
    path: '/api/videos',
    auth: 'session',
    minRole: 'editor',
    feature: 4,
    tag: 'Videos',
    summary: 'Create a draft video',
    body: CreateVideoBodySchema,
    response: VideoSchema,
    status: 201,
  }),
  get: route({
    method: 'GET',
    path: '/api/videos/:videoId',
    auth: 'session',
    feature: 6,
    tag: 'Videos',
    summary: 'Video with composition, status, progress and output URLs (poll while rendering)',
    params: videoParams,
    response: VideoSchema,
  }),
  update: route({
    method: 'PATCH',
    path: '/api/videos/:videoId',
    auth: 'session',
    minRole: 'editor',
    feature: 4,
    tag: 'Videos',
    summary: 'Autosave title and/or composition',
    params: videoParams,
    body: UpdateVideoBodySchema,
    response: VideoSchema,
    errors: ['REVISION_CONFLICT'],
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/videos/:videoId',
    auth: 'session',
    minRole: 'editor',
    feature: 6,
    tag: 'Videos',
    summary: 'Delete a video, its files and share link',
    params: videoParams,
    response: OkSchema,
  }),
  duplicate: route({
    method: 'POST',
    path: '/api/videos/:videoId/duplicate',
    auth: 'session',
    minRole: 'editor',
    feature: 6,
    tag: 'Videos',
    summary: 'Copy a video as a new draft',
    params: videoParams,
    response: VideoSchema,
    status: 201,
  }),
  render: route({
    method: 'POST',
    path: '/api/videos/:videoId/render',
    auth: 'session',
    minRole: 'editor',
    feature: 5,
    tag: 'Videos',
    summary:
      'Moderate the script, reserve credits, snapshot the composition and queue a render job',
    params: videoParams,
    body: RenderVideoBodySchema,
    response: RenderStartedSchema,
    status: 202,
    errors: [
      'INSUFFICIENT_CREDITS',
      'PLAN_LIMIT_EXCEEDED',
      'CONTENT_BLOCKED',
      'INVALID_STATE',
      'PROVIDER_NOT_CONFIGURED',
    ],
  }),
  cancelRender: route({
    method: 'POST',
    path: '/api/videos/:videoId/cancel-render',
    auth: 'session',
    minRole: 'editor',
    feature: 5,
    tag: 'Videos',
    summary: 'Cancel the queued/running render and refund its credits',
    params: videoParams,
    response: VideoSchema,
    errors: ['INVALID_STATE'],
  }),
  renderJobs: route({
    method: 'GET',
    path: '/api/videos/:videoId/render-jobs',
    auth: 'session',
    feature: 5,
    tag: 'Videos',
    summary: 'Render history of a video, newest first',
    params: videoParams,
    response: listOf(RenderJobSchema),
  }),
  saveAsTemplate: route({
    method: 'POST',
    path: '/api/videos/:videoId/save-as-template',
    auth: 'session',
    minRole: 'editor',
    feature: 7,
    tag: 'Videos',
    summary: 'Save the composition as a custom workspace template',
    params: videoParams,
    body: SaveAsTemplateBodySchema,
    response: TemplateDetailSchema,
    status: 201,
  }),
  applyBrandKit: route({
    method: 'POST',
    path: '/api/videos/:videoId/apply-brand-kit',
    auth: 'session',
    minRole: 'editor',
    feature: 13,
    tag: 'Videos',
    summary: 'Apply a brand kit to the composition (see `applyBrandKit` in shared)',
    params: videoParams,
    body: z.object({ brandKitId: idOf('brandKit') }),
    response: VideoSchema,
  }),
} as const;

/* ============================== share links (feature 6) ============================== */

export const UpsertShareBodySchema = z.object({
  enabled: z.boolean().default(true),
  allowDownload: z.boolean().default(true),
  expiresAt: z.iso.datetime().nullable().default(null),
});

export const shareRoutes = {
  get: route({
    method: 'GET',
    path: '/api/videos/:videoId/share',
    auth: 'session',
    feature: 6,
    tag: 'Share',
    summary: 'Share link of a video, if any',
    params: videoParams,
    response: z.object({ share: ShareLinkSchema.nullable() }),
  }),
  upsert: route({
    method: 'PUT',
    path: '/api/videos/:videoId/share',
    auth: 'session',
    minRole: 'editor',
    feature: 6,
    tag: 'Share',
    summary: 'Create or update the public share link (video must be completed)',
    params: videoParams,
    body: UpsertShareBodySchema,
    response: ShareLinkSchema,
    errors: ['INVALID_STATE'],
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/videos/:videoId/share',
    auth: 'session',
    minRole: 'editor',
    feature: 6,
    tag: 'Share',
    summary: 'Delete the share link (the public page stops working)',
    params: videoParams,
    response: OkSchema,
  }),
  public: route({
    method: 'GET',
    path: '/api/public/shares/:token',
    auth: 'public',
    feature: 6,
    tag: 'Share',
    summary: 'Public data of a shared video (increments the view counter)',
    params: z.object({ token: z.string().min(8).max(64) }),
    response: PublicShareSchema,
    rateLimit: { max: 120, windowSec: 60 },
  }),
} as const;

/* ============================== assets (feature 8) ============================== */

const assetParams = z.object({ assetId: idOf('asset') });

export const assetRoutes = {
  list: route({
    method: 'GET',
    path: '/api/assets',
    auth: 'session',
    feature: 8,
    tag: 'Assets',
    summary: 'Uploaded assets, newest first',
    query: PaginationQuerySchema.extend({ kind: AssetKindSchema.optional(), q: search }),
    response: paginated(AssetSchema),
  }),
  upload: route({
    method: 'POST',
    path: '/api/assets',
    auth: 'session',
    minRole: 'editor',
    feature: 8,
    tag: 'Assets',
    summary:
      'Upload an image, video or audio file. The real file type is detected from its bytes; size is limited by the plan',
    multipart: {
      fileField: 'file',
      fields: z.object({ name: z.string().max(120).optional() }),
      description: 'multipart/form-data with one `file` part and an optional `name` field',
    },
    response: AssetSchema,
    status: 201,
    errors: ['PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'PLAN_LIMIT_EXCEEDED'],
  }),
  get: route({
    method: 'GET',
    path: '/api/assets/:assetId',
    auth: 'session',
    feature: 8,
    tag: 'Assets',
    summary: 'One asset',
    params: assetParams,
    response: AssetSchema,
  }),
  update: route({
    method: 'PATCH',
    path: '/api/assets/:assetId',
    auth: 'session',
    minRole: 'editor',
    feature: 8,
    tag: 'Assets',
    summary: 'Rename an asset',
    params: assetParams,
    body: z.object({ name: z.string().trim().min(1).max(120) }),
    response: AssetSchema,
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/assets/:assetId',
    auth: 'session',
    minRole: 'editor',
    feature: 8,
    tag: 'Assets',
    summary: 'Delete an asset and its file',
    params: assetParams,
    response: OkSchema,
  }),
  listStock: route({
    method: 'GET',
    path: '/api/stock-assets',
    auth: 'session',
    feature: 8,
    tag: 'Assets',
    summary: 'Built-in backgrounds and music (generated by code, free to use)',
    query: z.object({
      kind: AssetKindSchema.optional(),
      category: StockAssetCategorySchema.optional(),
    }),
    response: listOf(StockAssetSchema),
  }),
  stockFile: route({
    method: 'GET',
    path: '/api/stock-assets/:stockId/file',
    auth: 'public',
    feature: 8,
    tag: 'Assets',
    summary: 'Bytes of a built-in stock asset (cacheable)',
    params: z.object({ stockId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }),
    response: z.unknown(),
    binary: true,
  }),
} as const;

/* ============================== avatars (feature 2) ============================== */

export const avatarRoutes = {
  list: route({
    method: 'GET',
    path: '/api/avatars',
    auth: 'session',
    feature: 2,
    tag: 'Avatars',
    summary:
      'Instant (2D) and photorealistic stock avatars plus the photo / generated avatars of the workspace',
    query: z.object({
      kind: z.enum(['stock', 'photo', 'generated']).optional(),
      rendering: AvatarRenderingSchema.optional(),
      gender: GenderSchema.optional(),
      ageGroup: AgeGroupSchema.optional(),
      style: AvatarStyleSchema.optional(),
      q: search,
    }),
    response: listOf(AvatarSchema),
  }),
  get: route({
    method: 'GET',
    path: '/api/avatars/:avatarId',
    auth: 'session',
    feature: 2,
    tag: 'Avatars',
    summary: 'One avatar',
    params: z.object({ avatarId: AvatarIdSchema }),
    response: AvatarSchema,
  }),
} as const;

/* ============================== voices & speech (feature 3) ============================== */

/** Same fields as a TTS script; used for previews, the Studio live preview and the worker. */
export const SynthesizeBodySchema = TtsScriptSchema.omit({ kind: true }).extend({
  text: z
    .string()
    .trim()
    .min(1)
    .max(TtsScriptSchema.shape.text.maxLength ?? 5000),
});

export const voiceRoutes = {
  list: route({
    method: 'GET',
    path: '/api/voices',
    auth: 'session',
    feature: 3,
    tag: 'Voices',
    summary: 'Stock voices of every active TTS provider plus cloned voices of the workspace',
    query: z.object({
      kind: z.enum(['stock', 'cloned']).optional(),
      language: LanguageCodeSchema.optional(),
      gender: GenderSchema.optional(),
      provider: z.string().max(24).optional(),
      q: search,
    }),
    response: listOf(VoiceSchema),
  }),
  get: route({
    method: 'GET',
    path: '/api/voices/:voiceId',
    auth: 'session',
    feature: 3,
    tag: 'Voices',
    summary: 'One voice',
    params: z.object({ voiceId: VoiceIdSchema }),
    response: VoiceSchema,
  }),
  /**
   * Synthesize speech on demand. Results are cached by content hash (`ttsCacheKey`), so the
   * Studio can call it on every script edit and the render job reuses the same audio.
   */
  synthesize: route({
    method: 'POST',
    path: '/api/tts/synthesize',
    auth: 'session',
    feature: 3,
    tag: 'Voices',
    summary: 'Text → WAV + viseme/word timeline (voice preview and Studio live preview)',
    body: SynthesizeBodySchema,
    response: SynthesizedSpeechSchema,
    errors: ['CONTENT_BLOCKED', 'PROVIDER_ERROR'],
    rateLimit: { max: 120, windowSec: 60 },
  }),
} as const;

/* ============================== templates (feature 7) ============================== */

const templateParams = z.object({ templateId: TemplateIdSchema });

export const templateRoutes = {
  list: route({
    method: 'GET',
    path: '/api/templates',
    auth: 'session',
    feature: 7,
    tag: 'Templates',
    summary: 'Built-in templates plus custom templates of the workspace',
    query: z.object({
      kind: z.enum(['builtin', 'custom']).optional(),
      category: TemplateCategorySchema.optional(),
      aspect: AspectRatioSchema.optional(),
      q: search,
    }),
    response: listOf(TemplateSchema),
  }),
  get: route({
    method: 'GET',
    path: '/api/templates/:templateId',
    auth: 'session',
    feature: 7,
    tag: 'Templates',
    summary: 'Template with its composition',
    params: templateParams,
    response: TemplateDetailSchema,
  }),
  use: route({
    method: 'POST',
    path: '/api/templates/:templateId/use',
    auth: 'session',
    minRole: 'editor',
    feature: 7,
    tag: 'Templates',
    summary: 'Create a draft video from the template',
    params: templateParams,
    body: z.object({ title: TitleSchema.optional() }),
    response: VideoSchema,
    status: 201,
  }),
  update: route({
    method: 'PATCH',
    path: '/api/templates/:templateId',
    auth: 'session',
    minRole: 'editor',
    feature: 7,
    tag: 'Templates',
    summary: 'Edit a custom template (built-in templates are read-only)',
    params: templateParams,
    body: z.object({
      name: TitleSchema.optional(),
      description: z.string().max(300).optional(),
      category: TemplateCategorySchema.optional(),
    }),
    response: TemplateSchema,
    errors: ['FORBIDDEN'],
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/templates/:templateId',
    auth: 'session',
    minRole: 'editor',
    feature: 7,
    tag: 'Templates',
    summary: 'Delete a custom template',
    params: templateParams,
    response: OkSchema,
    errors: ['FORBIDDEN'],
  }),
} as const;

/* ============================== brand kits (feature 13) ============================== */

const brandKitParams = z.object({ brandKitId: idOf('brandKit') });

export const CreateBrandKitBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  logoAssetId: idOf('asset').nullable().default(null),
  colors: BrandColorsSchema.default(() => BrandColorsSchema.parse({})),
  fonts: BrandFontsSchema.default(() => BrandFontsSchema.parse({})),
  isDefault: z.boolean().default(false),
});
export const UpdateBrandKitBodySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  logoAssetId: idOf('asset').nullable().optional(),
  colors: BrandColorsPatchSchema.optional(),
  fonts: BrandFontsPatchSchema.optional(),
  isDefault: z.boolean().optional(),
});

export const brandKitRoutes = {
  list: route({
    method: 'GET',
    path: '/api/brand-kits',
    auth: 'session',
    feature: 13,
    tag: 'Brand kits',
    summary: 'Brand kits of the workspace',
    response: listOf(BrandKitSchema),
  }),
  create: route({
    method: 'POST',
    path: '/api/brand-kits',
    auth: 'session',
    minRole: 'editor',
    feature: 13,
    tag: 'Brand kits',
    summary: 'Create a brand kit',
    body: CreateBrandKitBodySchema,
    response: BrandKitSchema,
    status: 201,
  }),
  get: route({
    method: 'GET',
    path: '/api/brand-kits/:brandKitId',
    auth: 'session',
    feature: 13,
    tag: 'Brand kits',
    summary: 'One brand kit',
    params: brandKitParams,
    response: BrandKitSchema,
  }),
  update: route({
    method: 'PATCH',
    path: '/api/brand-kits/:brandKitId',
    auth: 'session',
    minRole: 'editor',
    feature: 13,
    tag: 'Brand kits',
    summary: 'Update a brand kit',
    params: brandKitParams,
    body: UpdateBrandKitBodySchema,
    response: BrandKitSchema,
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/brand-kits/:brandKitId',
    auth: 'session',
    minRole: 'editor',
    feature: 13,
    tag: 'Brand kits',
    summary: 'Delete a brand kit',
    params: brandKitParams,
    response: OkSchema,
  }),
} as const;
