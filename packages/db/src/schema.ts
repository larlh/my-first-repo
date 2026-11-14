import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type {
  AspectRatio,
  AssetKind,
  AsyncJobStatus,
  AsyncResourceStatus,
  BrandColors,
  BrandFonts,
  Composition,
  ConsentKind,
  ConsentRelationship,
  Gender,
  InteractivePersona,
  LanguageCode,
  LedgerReason,
  PhotoAvatarRig,
  PlanId,
  Provenance,
  ProviderRef,
  RenderJobStatus,
  RenderStage,
  Resolution,
  Role,
  StoredError,
  TemplateCategory,
  TimedText,
  TranslationOptions,
  TranslationStage,
  UiLocale,
  VideoSource,
  VideoStatus,
  VoiceProfile,
  WebhookDeliveryStatus,
  WebhookEvent,
  WebhookEventType,
} from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Conventions
 *  - Primary keys are prefixed random text ids generated in the app (`newId(kind)`).
 *  - Every workspace-owned table has `workspace_id` (FK, ON DELETE CASCADE) and every query on
 *    it MUST filter by workspace_id.
 *  - Enumerations are stored as text and typed with `$type<…>()`; zod validates at the edges.
 *  - Timestamps are `timestamptz`. `created_at` defaults to now().
 *  - Files are referenced by storage key (never by URL).
 * ----------------------------------------------------------------------------------------- */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

/* ---------- identity ---------- */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  /** Lower-cased. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /** `scrypt$N$r$p$salt$hash` (see hashPassword in @parlante/shared/node). */
  passwordHash: text('password_hash').notNull(),
  locale: text('locale').$type<UiLocale>().notNull().default('es'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').$type<PlanId>().notNull().default('free'),
  /** Credit balance. Only change it through the helpers in credits.ts (ledger + balance). */
  credits: integer('credits').notNull().default(0),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie token. */
    tokenHash: text('token_hash').notNull().unique(),
    activeWorkspaceId: text('active_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const members = pgTable(
  'members',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<Role>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('members_workspace_user_uq').on(t.workspaceId, t.userId),
    index('members_user_idx').on(t.userId),
  ],
);

export const invites = pgTable(
  'invites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<Role>().notNull(),
    /** SHA-256 of the invite token (the plain token only travels in the accept link). */
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: ts('accepted_at'),
    createdAt: createdAt(),
  },
  (t) => [index('invites_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/* ---------- assets ---------- */

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AssetKind>().notNull(),
    name: text('name').notNull(),
    /** Detected from the file bytes. */
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    storageKey: text('storage_key').notNull(),
    thumbnailKey: text('thumbnail_key'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('assets_workspace_idx').on(t.workspaceId, t.createdAt),
    index('assets_workspace_kind_idx').on(t.workspaceId, t.kind),
  ],
);

/* ---------- consent ---------- */

export const consentRecords = pgTable(
  'consent_records',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').$type<ConsentKind>().notNull(),
    subjectName: text('subject_name').notNull(),
    relationship: text('relationship').$type<ConsentRelationship>().notNull(),
    statementVersion: text('statement_version').notNull(),
    /** Exact text accepted by the user. */
    statement: text('statement').notNull(),
    locale: text('locale').$type<UiLocale>().notNull(),
    ip: text('ip').notNull(),
    userAgent: text('user_agent'),
    /** Avatar / voice id created with this consent. Set when the consent is consumed. */
    resourceId: text('resource_id'),
    usedAt: ts('used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('consent_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/* ---------- avatars (workspace photoreal avatars; stock avatars live in code/files) ---------- */

export const avatars = pgTable(
  'avatars',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    gender: text('gender').$type<Gender>().notNull().default('neutral'),
    status: text('status').$type<AsyncResourceStatus>().notNull().default('processing'),
    /** `photo` = from an uploaded photo of a real person; `generated` = synthetic, from text. */
    origin: text('origin').$type<'photo' | 'generated'>().notNull(),
    /** origin `generated`: description and seed the portrait is generated from. */
    prompt: text('prompt'),
    seed: integer('seed'),
    /** origin `photo`: uploaded source image. */
    sourceAssetId: text('source_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    /** Prepared portrait PNG and its alpha matte (written by the photo-avatar job). */
    imageKey: text('image_key'),
    maskKey: text('mask_key'),
    thumbnailKey: text('thumbnail_key'),
    /** Landmarks supplied by the user at creation (null = estimate). */
    requestedLandmarks: jsonb('requested_landmarks').$type<PhotoAvatarRig['landmarks']>(),
    rig: jsonb('rig').$type<PhotoAvatarRig>(),
    provider: jsonb('provider').$type<ProviderRef>(),
    /**
     * REQUIRED for origin `photo` (enforced by the API with `consumeConsent` and by the
     * check constraint below); null for synthetic `generated` avatars.
     */
    consentId: text('consent_id').references(() => consentRecords.id, { onDelete: 'restrict' }),
    error: jsonb('error').$type<StoredError>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('avatars_workspace_idx').on(t.workspaceId, t.createdAt),
    check(
      'avatars_photo_requires_consent',
      sql`${t.origin} <> 'photo' OR ${t.consentId} IS NOT NULL`,
    ),
  ],
);

/* ---------- voices (cloned voices only; stock voices come from TTS providers) ---------- */

export const voices = pgTable(
  'voices',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    language: text('language').$type<LanguageCode>().notNull(),
    gender: text('gender').$type<Gender>().notNull().default('neutral'),
    status: text('status').$type<AsyncResourceStatus>().notNull().default('processing'),
    /** TTS provider that speaks with this voice (set by the voice-clone job). */
    ttsProviderId: text('tts_provider_id'),
    providerVoiceId: text('provider_voice_id'),
    /** Local cloning: estimated parameters. */
    profile: jsonb('profile').$type<VoiceProfile>(),
    /** Provider that performed the cloning. */
    provider: jsonb('provider').$type<ProviderRef>(),
    sampleAssetId: text('sample_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    consentId: text('consent_id')
      .notNull()
      .references(() => consentRecords.id, { onDelete: 'restrict' }),
    error: jsonb('error').$type<StoredError>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('voices_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/* ---------- batch jobs (declared before videos: videos.batch_job_id) ---------- */

export const batchJobs = pgTable(
  'batch_jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceVideoId: text('source_video_id').references((): AnyPgColumn => videos.id, {
      onDelete: 'set null',
    }),
    /** Snapshot of the source composition (with `{{variables}}`) taken at creation. */
    composition: jsonb('composition').$type<Composition>().notNull(),
    variables: jsonb('variables').$type<string[]>().notNull().default([]),
    resolution: text('resolution').$type<Resolution>().notNull(),
    status: text('status').$type<AsyncJobStatus>().notNull().default('queued'),
    total: integer('total').notNull(),
    completed: integer('completed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    creditsCharged: integer('credits_charged').notNull().default(0),
    error: jsonb('error').$type<StoredError>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('batch_jobs_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/* ---------- videos & render jobs ---------- */

export const videos = pgTable(
  'videos',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').$type<VideoStatus>().notNull().default('draft'),
    progress: integer('progress').notNull().default(0),
    composition: jsonb('composition').$type<Composition>().notNull(),
    /** Bumped on every title/composition change. */
    revision: integer('revision').notNull().default(1),
    renderedRevision: integer('rendered_revision'),
    aspect: text('aspect').$type<AspectRatio>().notNull(),
    resolution: text('resolution').$type<Resolution>(),
    durationMs: integer('duration_ms'),
    videoKey: text('video_key'),
    thumbnailKey: text('thumbnail_key'),
    srtKey: text('srt_key'),
    vttKey: text('vtt_key'),
    providers: jsonb('providers').$type<Provenance>(),
    error: jsonb('error').$type<StoredError>(),
    source: text('source').$type<VideoSource>().notNull().default('studio'),
    /** Template the video was created from (`builtin_…` or `tpl_…`), informational. */
    templateId: text('template_id'),
    batchJobId: text('batch_job_id').references(() => batchJobs.id, { onDelete: 'set null' }),
    /** Latest render job (queued/running/finished). */
    currentRenderJobId: text('current_render_job_id'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    renderedAt: ts('rendered_at'),
  },
  (t) => [
    index('videos_workspace_idx').on(t.workspaceId, t.createdAt),
    index('videos_workspace_status_idx').on(t.workspaceId, t.status),
    index('videos_batch_idx').on(t.batchJobId),
  ],
);

export const renderJobs = pgTable(
  'render_jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    status: text('status').$type<RenderJobStatus>().notNull().default('queued'),
    stage: text('stage').$type<RenderStage>(),
    progress: integer('progress').notNull().default(0),
    /** Estimated seconds remaining (measured by the job), null when unknown. */
    etaSec: integer('eta_sec'),
    resolution: text('resolution').$type<Resolution>().notNull(),
    /** Exact document being rendered (the video may be edited meanwhile). */
    composition: jsonb('composition').$type<Composition>().notNull(),
    /** Video revision the snapshot was taken from. */
    revision: integer('revision').notNull(),
    /** Whether the plan requires a watermark (decided at enqueue time). */
    watermark: boolean('watermark').notNull().default(false),
    creditsCharged: integer('credits_charged').notNull().default(0),
    error: jsonb('error').$type<StoredError>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('render_jobs_video_idx').on(t.videoId, t.createdAt),
    index('render_jobs_workspace_status_idx').on(t.workspaceId, t.status),
  ],
);

export const batchItems = pgTable(
  'batch_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    batchJobId: text('batch_job_id')
      .notNull()
      .references(() => batchJobs.id, { onDelete: 'cascade' }),
    /** Zero-based row index. */
    index: integer('index').notNull(),
    values: jsonb('values').$type<Record<string, string>>().notNull(),
    status: text('status')
      .$type<'pending' | 'queued' | 'rendering' | 'completed' | 'failed' | 'canceled'>()
      .notNull()
      .default('pending'),
    videoId: text('video_id').references(() => videos.id, { onDelete: 'set null' }),
    error: jsonb('error').$type<StoredError>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('batch_items_job_index_uq').on(t.batchJobId, t.index),
    index('batch_items_video_idx').on(t.videoId),
  ],
);

/* ---------- templates (custom only; built-ins live in packages/templates) ---------- */

export const templates = pgTable(
  'templates',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').$type<TemplateCategory>().notNull().default('other'),
    aspect: text('aspect').$type<AspectRatio>().notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    composition: jsonb('composition').$type<Composition>().notNull(),
    thumbnailKey: text('thumbnail_key'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('templates_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/* ---------- brand kits ---------- */

export const brandKits = pgTable(
  'brand_kits',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    logoAssetId: text('logo_asset_id').references(() => assets.id, { onDelete: 'set null' }),
    colors: jsonb('colors').$type<BrandColors>().notNull(),
    fonts: jsonb('fonts').$type<BrandFonts>().notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('brand_kits_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/* ---------- API keys & webhooks ---------- */

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Display prefix `plk_xxxxxxxx`. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full key. The key itself is never stored. */
    keyHash: text('key_hash').notNull().unique(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    events: jsonb('events').$type<WebhookEventType[]>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Signing secret encrypted with APP_SECRET (`encryptSecret`). */
    secretEncrypted: text('secret_encrypted').notNull(),
    secretPreview: text('secret_preview').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('webhook_endpoints_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').$type<WebhookEventType>().notNull(),
    /** Exact event body to POST (file URLs inside are pre-signed for 7 days). */
    payload: jsonb('payload').$type<WebhookEvent>().notNull(),
    status: text('status').$type<WebhookDeliveryStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    nextRetryAt: ts('next_retry_at'),
    deliveredAt: ts('delivered_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt),
    index('webhook_deliveries_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

/* ---------- translation ---------- */

export const translationJobs = pgTable(
  'translation_jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sourceAssetId: text('source_asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'restrict' }),
    sourceDurationMs: integer('source_duration_ms'),
    sourceLanguage: text('source_language').$type<LanguageCode>().notNull(),
    targetLanguages: jsonb('target_languages').$type<LanguageCode[]>().notNull(),
    status: text('status').$type<AsyncJobStatus>().notNull().default('queued'),
    stage: text('stage').$type<TranslationStage>(),
    progress: integer('progress').notNull().default(0),
    transcriptSource: text('transcript_source').$type<'user' | 'stt'>().notNull(),
    /** Source-language segments: supplied by the user at creation or written by the STT stage. */
    transcript: jsonb('transcript').$type<TimedText[]>(),
    options: jsonb('options').$type<TranslationOptions>().notNull(),
    providers: jsonb('providers').$type<Provenance>(),
    creditsCharged: integer('credits_charged').notNull().default(0),
    error: jsonb('error').$type<StoredError>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('translation_jobs_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const translationOutputs = pgTable(
  'translation_outputs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => translationJobs.id, { onDelete: 'cascade' }),
    language: text('language').$type<LanguageCode>().notNull(),
    voiceId: text('voice_id').notNull(),
    status: text('status')
      .$type<'pending' | 'processing' | 'completed' | 'failed'>()
      .notNull()
      .default('pending'),
    /** Translated, timed segments. */
    segments: jsonb('segments').$type<TimedText[]>(),
    videoKey: text('video_key'),
    srtKey: text('srt_key'),
    vttKey: text('vtt_key'),
    error: jsonb('error').$type<StoredError>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('translation_outputs_job_lang_uq').on(t.jobId, t.language)],
);

/* ---------- credits ---------- */

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Positive = added, negative = spent. */
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason').$type<LedgerReason>().notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    description: text('description').notNull().default(''),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_ledger_workspace_idx').on(t.workspaceId, t.createdAt),
    index('credit_ledger_ref_idx').on(t.workspaceId, t.refType, t.refId),
  ],
);

/* ---------- share links ---------- */

export const shareLinks = pgTable(
  'share_links',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    videoId: text('video_id')
      .notNull()
      .unique()
      .references(() => videos.id, { onDelete: 'cascade' }),
    /** Random public token (URL slug). */
    token: text('token').notNull().unique(),
    enabled: boolean('enabled').notNull().default(true),
    allowDownload: boolean('allow_download').notNull().default(true),
    viewCount: integer('view_count').notNull().default(0),
    expiresAt: ts('expires_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('share_links_workspace_idx').on(t.workspaceId)],
);

/* ---------- interactive avatar ---------- */

export const interactiveSessions = pgTable(
  'interactive_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    avatarId: text('avatar_id').notNull(),
    voiceId: text('voice_id').notNull(),
    language: text('language').$type<LanguageCode>().notNull(),
    persona: jsonb('persona').$type<InteractivePersona>().notNull(),
    status: text('status').$type<'active' | 'ended'>().notNull().default('active'),
    providers: jsonb('providers').$type<Provenance>().notNull(),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: createdAt(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('interactive_sessions_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const interactiveMessages = pgTable(
  'interactive_messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => interactiveSessions.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('interactive_messages_session_idx').on(t.sessionId, t.createdAt)],
);

/* ---------- row types ---------- */

export type UserRow = typeof users.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type ConsentRecordRow = typeof consentRecords.$inferSelect;
export type AvatarRow = typeof avatars.$inferSelect;
export type VoiceRow = typeof voices.$inferSelect;
export type VideoRow = typeof videos.$inferSelect;
export type RenderJobRow = typeof renderJobs.$inferSelect;
export type BatchJobRow = typeof batchJobs.$inferSelect;
export type BatchItemRow = typeof batchItems.$inferSelect;
export type TemplateRow = typeof templates.$inferSelect;
export type BrandKitRow = typeof brandKits.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type TranslationJobRow = typeof translationJobs.$inferSelect;
export type TranslationOutputRow = typeof translationOutputs.$inferSelect;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type InteractiveSessionRow = typeof interactiveSessions.$inferSelect;
export type InteractiveMessageRow = typeof interactiveMessages.$inferSelect;
