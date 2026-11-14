import { z } from 'zod';
import { ResolutionSchema } from '../composition/schema';
import {
  AvatarSchema,
  BatchJobDetailSchema,
  BatchJobSchema,
  GenderSchema,
  GeneratedScriptSchema,
  InteractiveMessageSchema,
  InteractivePersonaSchema,
  InteractiveReplySchema,
  InteractiveSessionSchema,
  PhotoLandmarksSchema,
  ScriptToneSchema,
  TranslationJobSchema,
  TranslationOptionsSchema,
  VoiceSchema,
} from '../entities';
import { AvatarIdSchema, VoiceIdSchema, idOf } from '../ids';
import { LanguageCodeSchema } from '../languages';
import { PaginationQuerySchema, paginated } from '../pagination';
import { TranscriptFormatSchema } from '../subtitles';
import { OkSchema, route } from './contract';

/* ============================== AI script writer (feature 11) ============================== */

export const GenerateScriptBodySchema = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('topic'), topic: z.string().trim().min(3).max(2000) }),
    /** The page is fetched server side behind the SSRF guard; only http(s). */
    z.object({ kind: z.literal('url'), url: z.url({ protocol: /^https?$/ }).max(2000) }),
  ]),
  tone: ScriptToneSchema.default('professional'),
  /** Target total duration in seconds. */
  durationSec: z.number().int().min(10).max(600).default(60),
  language: LanguageCodeSchema.default('es'),
  sceneCount: z.number().int().min(1).max(12).optional(),
  audience: z.string().trim().max(200).optional(),
});

export const scriptWriterRoutes = {
  /**
   * Returns scenes only. The client turns them into a draft with the shared composition
   * factories and `POST /api/videos` (so the user can pick avatar/voice/template first).
   */
  generate: route({
    method: 'POST',
    path: '/api/script-writer/generate',
    auth: 'session',
    minRole: 'editor',
    feature: 11,
    tag: 'AI script writer',
    summary: 'Topic or URL + tone + duration + language → script split into scenes',
    body: GenerateScriptBodySchema,
    response: GeneratedScriptSchema,
    errors: ['UNSAFE_URL', 'CONTENT_BLOCKED', 'INSUFFICIENT_CREDITS', 'PROVIDER_ERROR'],
    rateLimit: { max: 20, windowSec: 60 },
  }),
} as const;

/* ============================== video translation (feature 12) ============================== */

const translationParams = z.object({ translationId: idOf('translationJob') });

export const CreateTranslationBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  /** Uploaded video Asset to translate. */
  sourceAssetId: idOf('asset'),
  sourceLanguage: LanguageCodeSchema,
  targetLanguages: z.array(LanguageCodeSchema).min(1).max(13),
  /**
   * Required when the STT provider cannot transcribe (local mode — see
   * `capabilities.sttRequiresTranscript`); optional otherwise (overrides STT).
   */
  transcript: z
    .object({ format: TranscriptFormatSchema, content: z.string().min(1).max(500_000) })
    .optional(),
  /** Voice per target language; languages without an entry get a default stock voice. */
  voices: z.partialRecord(LanguageCodeSchema, VoiceIdSchema).default({}),
  options: TranslationOptionsSchema.default(() => TranslationOptionsSchema.parse({})),
});

export const translationRoutes = {
  list: route({
    method: 'GET',
    path: '/api/translations',
    auth: 'session',
    feature: 12,
    tag: 'Translation',
    summary: 'Translation jobs, newest first',
    query: PaginationQuerySchema,
    response: paginated(TranslationJobSchema),
  }),
  create: route({
    method: 'POST',
    path: '/api/translations',
    auth: 'session',
    minRole: 'editor',
    feature: 12,
    tag: 'Translation',
    summary:
      'Queue a translation: transcript → translation → TTS dub → mix → subtitles, per target language',
    body: CreateTranslationBodySchema,
    response: TranslationJobSchema,
    status: 202,
    errors: [
      'TRANSCRIPT_REQUIRED',
      'INSUFFICIENT_CREDITS',
      'PLAN_LIMIT_EXCEEDED',
      'CONTENT_BLOCKED',
      'UNPROCESSABLE',
    ],
  }),
  get: route({
    method: 'GET',
    path: '/api/translations/:translationId',
    auth: 'session',
    feature: 12,
    tag: 'Translation',
    summary: 'Translation job with per-language outputs (poll while processing)',
    params: translationParams,
    response: TranslationJobSchema,
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/translations/:translationId',
    auth: 'session',
    minRole: 'editor',
    feature: 12,
    tag: 'Translation',
    summary: 'Delete a translation job and its outputs (cancels it when still running)',
    params: translationParams,
    response: OkSchema,
  }),
} as const;

/* ============================== batch personalisation (feature 15) ============================== */

const batchParams = z.object({ batchId: idOf('batchJob') });
const RowsSchema = z
  .array(z.record(z.string(), z.string().max(500)))
  .min(1)
  .max(500);
const CsvSchema = z.string().min(1).max(1_000_000);

export const BatchPreviewBodySchema = z.object({
  sourceVideoId: idOf('video'),
  /** CSV text with a header row; column names map to `{{variables}}`. */
  csv: CsvSchema,
  resolution: ResolutionSchema.default('720p'),
});

export const BatchPreviewSchema = z.object({
  /** Variables used by the source video. */
  variables: z.array(z.string()),
  /** Header columns found in the CSV. */
  columns: z.array(z.string()),
  /** Parsed rows (values trimmed). */
  rows: z.array(z.record(z.string(), z.string())),
  /** Variables with no CSV column and no default value (blocking). */
  missingColumns: z.array(z.string()),
  /** CSV columns that match no variable (ignored). */
  unknownColumns: z.array(z.string()),
  estimatedCredits: z.number().int(),
  /** Plan limit for rows per batch. */
  maxRows: z.number().int(),
});

export const CreateBatchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sourceVideoId: idOf('video'),
    /** Provide rows (already parsed) or raw CSV text. */
    rows: RowsSchema.optional(),
    csv: CsvSchema.optional(),
    resolution: ResolutionSchema.default('720p'),
  })
  .refine((b) => (b.rows ? !b.csv : !!b.csv), {
    message: 'Provide exactly one of rows or csv',
    path: ['rows'],
  });

export const batchRoutes = {
  preview: route({
    method: 'POST',
    path: '/api/batches/preview',
    auth: 'session',
    minRole: 'editor',
    feature: 15,
    tag: 'Batch',
    summary: 'Parse a CSV and check it against the variables of the source video',
    body: BatchPreviewBodySchema,
    response: BatchPreviewSchema,
    errors: ['UNPROCESSABLE'],
  }),
  create: route({
    method: 'POST',
    path: '/api/batches',
    auth: 'session',
    minRole: 'editor',
    feature: 15,
    tag: 'Batch',
    summary: 'Queue one personalised video per row',
    body: CreateBatchBodySchema,
    response: BatchJobSchema,
    status: 202,
    errors: ['INSUFFICIENT_CREDITS', 'PLAN_LIMIT_EXCEEDED', 'CONTENT_BLOCKED', 'UNPROCESSABLE'],
  }),
  list: route({
    method: 'GET',
    path: '/api/batches',
    auth: 'session',
    feature: 15,
    tag: 'Batch',
    summary: 'Batch jobs, newest first',
    query: PaginationQuerySchema,
    response: paginated(BatchJobSchema),
  }),
  get: route({
    method: 'GET',
    path: '/api/batches/:batchId',
    auth: 'session',
    feature: 15,
    tag: 'Batch',
    summary: 'Batch job with its items and their videos (poll while processing)',
    params: batchParams,
    response: BatchJobDetailSchema,
  }),
  cancel: route({
    method: 'POST',
    path: '/api/batches/:batchId/cancel',
    auth: 'session',
    minRole: 'editor',
    feature: 15,
    tag: 'Batch',
    summary: 'Cancel pending items of a batch (finished videos are kept)',
    params: batchParams,
    response: BatchJobSchema,
    errors: ['INVALID_STATE'],
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/batches/:batchId',
    auth: 'session',
    minRole: 'editor',
    feature: 15,
    tag: 'Batch',
    summary: 'Delete a batch job record (its videos are kept)',
    params: batchParams,
    response: OkSchema,
  }),
} as const;

/* ============================== interactive avatar (feature 16) ============================== */

const interactiveParams = z.object({ sessionId: idOf('interactiveSession') });

export const CreateInteractiveSessionBodySchema = z.object({
  avatarId: AvatarIdSchema,
  voiceId: VoiceIdSchema,
  language: LanguageCodeSchema.default('es'),
  persona: InteractivePersonaSchema,
});

export const InteractiveSessionDetailSchema = z.object({
  session: InteractiveSessionSchema,
  messages: z.array(InteractiveMessageSchema),
});

export const interactiveRoutes = {
  createSession: route({
    method: 'POST',
    path: '/api/interactive/sessions',
    auth: 'session',
    minRole: 'editor',
    feature: 16,
    tag: 'Interactive avatar',
    summary: 'Start a real-time conversation with an avatar',
    body: CreateInteractiveSessionBodySchema,
    response: InteractiveSessionSchema,
    status: 201,
    errors: ['INSUFFICIENT_CREDITS', 'CONTENT_BLOCKED'],
  }),
  listSessions: route({
    method: 'GET',
    path: '/api/interactive/sessions',
    auth: 'session',
    feature: 16,
    tag: 'Interactive avatar',
    summary: 'Interactive sessions, newest first',
    query: PaginationQuerySchema,
    response: paginated(InteractiveSessionSchema),
  }),
  getSession: route({
    method: 'GET',
    path: '/api/interactive/sessions/:sessionId',
    auth: 'session',
    feature: 16,
    tag: 'Interactive avatar',
    summary: 'Session with its message history',
    params: interactiveParams,
    response: InteractiveSessionDetailSchema,
  }),
  /**
   * One conversational turn: user text → moderation → LLM reply → TTS. The client plays
   * `speech.audioUrl` and drives the avatar rig with `speech.runtime` (same renderer as export).
   */
  sendMessage: route({
    method: 'POST',
    path: '/api/interactive/sessions/:sessionId/messages',
    auth: 'session',
    minRole: 'editor',
    feature: 16,
    tag: 'Interactive avatar',
    summary: 'Send a user message and receive the spoken reply with its lip-sync timeline',
    params: interactiveParams,
    body: z.object({ text: z.string().trim().min(1).max(1000) }),
    response: InteractiveReplySchema,
    errors: ['CONTENT_BLOCKED', 'INVALID_STATE', 'PROVIDER_ERROR'],
  }),
  endSession: route({
    method: 'POST',
    path: '/api/interactive/sessions/:sessionId/end',
    auth: 'session',
    minRole: 'editor',
    feature: 16,
    tag: 'Interactive avatar',
    summary: 'End the session',
    params: interactiveParams,
    response: InteractiveSessionSchema,
  }),
} as const;

/* ====================== photorealistic avatars (feature 14, §2b) ====================== */

const photoAvatarParams = z.object({ avatarId: idOf('avatar') });
const AvatarNameSchema = z.string().trim().min(1).max(60);

export const CreatePhotoAvatarBodySchema = z.object({
  name: AvatarNameSchema,
  /** Uploaded image Asset with one clearly visible, front-facing face. */
  imageAssetId: idOf('asset'),
  /** ConsentRecord of kind `photo_avatar` created by the same user, not yet used. */
  consentId: idOf('consent'),
  gender: GenderSchema.default('neutral'),
  /** Landmarks marked by the user; when omitted the engine detects the face. */
  landmarks: PhotoLandmarksSchema.optional(),
});

export const GenerateAvatarBodySchema = z.object({
  name: AvatarNameSchema,
  /**
   * Description of a SYNTHETIC person ("mujer de unos 40 años, pelo corto canoso, chaqueta
   * azul, fondo neutro"). Prompts naming real people are rejected by moderation.
   */
  prompt: z.string().trim().min(10).max(500),
  gender: GenderSchema.default('neutral'),
  /** Fix the seed to reproduce a portrait; random when omitted. */
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

export const photoAvatarRoutes = {
  create: route({
    method: 'POST',
    path: '/api/photo-avatars',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Photorealistic avatars',
    summary:
      'Create a photorealistic avatar from a photo of a real person (consent required). Preparation is asynchronous',
    body: CreatePhotoAvatarBodySchema,
    response: AvatarSchema,
    status: 202,
    errors: [
      'CONSENT_REQUIRED',
      'INSUFFICIENT_CREDITS',
      'PLAN_LIMIT_EXCEEDED',
      'CONTENT_BLOCKED',
      'PROVIDER_NOT_CONFIGURED',
    ],
  }),
  generate: route({
    method: 'POST',
    path: '/api/photo-avatars/generate',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Photorealistic avatars',
    summary:
      'Generate a photorealistic avatar of a synthetic person from a text description with the local engine. Asynchronous',
    body: GenerateAvatarBodySchema,
    response: AvatarSchema,
    status: 202,
    errors: [
      'INSUFFICIENT_CREDITS',
      'PLAN_LIMIT_EXCEEDED',
      'CONTENT_BLOCKED',
      'PROVIDER_NOT_CONFIGURED',
    ],
  }),
  update: route({
    method: 'PATCH',
    path: '/api/photo-avatars/:avatarId',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Photorealistic avatars',
    summary: 'Rename a workspace avatar or adjust its landmarks',
    params: photoAvatarParams,
    body: z.object({
      name: AvatarNameSchema.optional(),
      landmarks: PhotoLandmarksSchema.optional(),
    }),
    response: AvatarSchema,
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/photo-avatars/:avatarId',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Photorealistic avatars',
    summary: 'Delete a workspace avatar and its images',
    params: photoAvatarParams,
    response: OkSchema,
  }),
} as const;

/* ============================== voice clones (feature 14) ============================== */

const voiceCloneParams = z.object({ voiceId: idOf('voice') });

export const CreateVoiceCloneBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Uploaded audio Asset: 10 s – 5 min of clean speech from a single speaker. */
  sampleAssetId: idOf('asset'),
  /** ConsentRecord of kind `voice_clone` created by the same user, not yet used. */
  consentId: idOf('consent'),
  language: LanguageCodeSchema,
  gender: GenderSchema.default('neutral'),
});

export const voiceCloneRoutes = {
  create: route({
    method: 'POST',
    path: '/api/voice-clones',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Voice clones',
    summary: 'Clone a voice from a sample (consent required). Processing is asynchronous',
    body: CreateVoiceCloneBodySchema,
    response: VoiceSchema,
    status: 202,
    errors: ['CONSENT_REQUIRED', 'INSUFFICIENT_CREDITS', 'PLAN_LIMIT_EXCEEDED', 'CONTENT_BLOCKED'],
  }),
  update: route({
    method: 'PATCH',
    path: '/api/voice-clones/:voiceId',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Voice clones',
    summary: 'Rename a cloned voice',
    params: voiceCloneParams,
    body: z.object({ name: z.string().trim().min(1).max(60) }),
    response: VoiceSchema,
  }),
  remove: route({
    method: 'DELETE',
    path: '/api/voice-clones/:voiceId',
    auth: 'session',
    minRole: 'editor',
    feature: 14,
    tag: 'Voice clones',
    summary: 'Delete a cloned voice (also removed from the external provider)',
    params: voiceCloneParams,
    response: OkSchema,
  }),
} as const;
