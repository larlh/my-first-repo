import { z } from 'zod';
import { ResolutionSchema } from './composition/schema';
import {
  ProvenanceSchema,
  RenderStageSchema,
  TranslationStageSchema,
  WebhookEventTypeSchema,
} from './entities';
import { idOf } from './ids';
import { LanguageCodeSchema } from './languages';

/* -------------------------------------------------------------------------------------------
 * BullMQ queues. The API enqueues; the worker processes. Payloads carry IDS ONLY — the job
 * handler loads the row (which is the source of truth for inputs such as the composition
 * snapshot) and checks `workspaceId` on every query.
 *
 * Conventions
 *  - BullMQ jobId = the id of the row the job works on (idempotent enqueue, easy lookup).
 *  - Handlers report progress with `ctx.progress(...)` (schema below) AND persist status /
 *    progress on the row; clients poll the REST resource.
 *  - On final failure the handler stores `{code, message}` on the row and refunds credits.
 * ----------------------------------------------------------------------------------------- */

export const QUEUE_NAMES = {
  render: 'render',
  translation: 'translation',
  batch: 'batch',
  photoAvatar: 'photo-avatar',
  voiceClone: 'voice-clone',
  webhookDelivery: 'webhook-delivery',
  /** Internal queue used by the example job and worker liveness checks. */
  system: 'system',
} as const;

export type QueueKey = keyof typeof QUEUE_NAMES;
export type QueueName = (typeof QUEUE_NAMES)[QueueKey];

const percent = z.number().min(0).max(100);

/* ---------- render ---------- */

export const RenderJobPayloadSchema = z.object({
  /** `render_jobs` row: holds the composition snapshot, resolution and credits reserved. */
  renderJobId: idOf('renderJob'),
  videoId: idOf('video'),
  workspaceId: idOf('workspace'),
});
export const RenderJobProgressSchema = z.object({
  stage: RenderStageSchema,
  percent,
  /** Estimated seconds remaining (measured). */
  etaSec: z.number().int().min(0).optional(),
  message: z.string().optional(),
});
export const RenderJobResultSchema = z.object({
  videoId: idOf('video'),
  durationMs: z.number().int(),
  resolution: ResolutionSchema,
  /** Storage keys of the produced files. */
  videoKey: z.string(),
  thumbnailKey: z.string(),
  srtKey: z.string(),
  vttKey: z.string(),
  providers: ProvenanceSchema,
});

/* ---------- translation ---------- */

export const TranslationJobPayloadSchema = z.object({
  translationJobId: idOf('translationJob'),
  workspaceId: idOf('workspace'),
});
export const TranslationJobProgressSchema = z.object({
  stage: TranslationStageSchema,
  percent,
  language: LanguageCodeSchema.optional(),
});
export const TranslationJobResultSchema = z.object({
  translationJobId: idOf('translationJob'),
  completedLanguages: z.array(LanguageCodeSchema),
  failedLanguages: z.array(LanguageCodeSchema),
});

/* ---------- batch ---------- */

/**
 * Fan-out job: for every pending `batch_items` row it creates a Video (composition with the
 * row's variables applied), reserves credits and enqueues a render job. Item/batch status then
 * follows the videos (see worker `notifyVideoFinished`).
 */
export const BatchJobPayloadSchema = z.object({
  batchJobId: idOf('batchJob'),
  workspaceId: idOf('workspace'),
});
export const BatchJobProgressSchema = z.object({
  /** Items already fanned out. */
  enqueued: z.number().int(),
  total: z.number().int(),
});
export const BatchJobResultSchema = z.object({
  batchJobId: idOf('batchJob'),
  enqueued: z.number().int(),
  skipped: z.number().int(),
});

/* ---------- photo avatar ---------- */

export const PhotoAvatarJobPayloadSchema = z.object({
  avatarId: idOf('avatar'),
  workspaceId: idOf('workspace'),
});
/**
 * Prepares a workspace avatar with the avatar engine. What it does depends on the row:
 *  - origin `photo`:     face detection + crop + alpha matte of the uploaded photo
 *  - origin `generated`: text → photorealistic portrait of a synthetic person, then the same
 *                        preparation
 */
export const PhotoAvatarJobProgressSchema = z.object({
  percent,
  etaSec: z.number().int().min(0).optional(),
});
export const PhotoAvatarJobResultSchema = z.object({
  avatarId: idOf('avatar'),
  landmarksSource: z.enum(['detected', 'user', 'estimated']),
});

/* ---------- voice clone ---------- */

export const VoiceCloneJobPayloadSchema = z.object({
  voiceId: idOf('voice'),
  workspaceId: idOf('workspace'),
});
export const VoiceCloneJobProgressSchema = z.object({ percent });
export const VoiceCloneJobResultSchema = z.object({
  voiceId: idOf('voice'),
  provider: z.string(),
});

/* ---------- webhook delivery ---------- */

/** One attempt cycle for one `webhook_deliveries` row (BullMQ retries with backoff). */
export const WebhookDeliveryJobPayloadSchema = z.object({
  deliveryId: idOf('webhookDelivery'),
  workspaceId: idOf('workspace'),
});
export const WebhookDeliveryJobProgressSchema = z.object({ attempt: z.number().int() });
export const WebhookDeliveryJobResultSchema = z.object({
  deliveryId: idOf('webhookDelivery'),
  eventType: WebhookEventTypeSchema,
  responseStatus: z.number().int(),
});

/* ---------- system (example / liveness) ---------- */

export const SystemJobPayloadSchema = z.object({
  kind: z.literal('ping'),
  echo: z.string().max(200).default(''),
});
export const SystemJobProgressSchema = z.object({ percent });
export const SystemJobResultSchema = z.object({
  kind: z.literal('pong'),
  echo: z.string(),
  processedAt: z.string(),
});

/* ---------- registry ---------- */

export interface QueueDefinition<
  P extends z.ZodType = z.ZodType,
  G extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  name: QueueName;
  payload: P;
  progress: G;
  result: R;
  /** Total attempts (1 = no retry). */
  attempts: number;
  /** Exponential backoff base delay (ms) between attempts. */
  backoffMs: number;
  /** Default worker concurrency (overridable by env `WORKER_CONCURRENCY_<KEY>`). */
  concurrency: number;
}

function defineQueue<P extends z.ZodType, G extends z.ZodType, R extends z.ZodType>(
  def: QueueDefinition<P, G, R>,
): QueueDefinition<P, G, R> {
  return def;
}

export const QUEUES = {
  render: defineQueue({
    name: QUEUE_NAMES.render,
    payload: RenderJobPayloadSchema,
    progress: RenderJobProgressSchema,
    result: RenderJobResultSchema,
    attempts: 1,
    backoffMs: 0,
    concurrency: 1,
  }),
  translation: defineQueue({
    name: QUEUE_NAMES.translation,
    payload: TranslationJobPayloadSchema,
    progress: TranslationJobProgressSchema,
    result: TranslationJobResultSchema,
    attempts: 1,
    backoffMs: 0,
    concurrency: 1,
  }),
  batch: defineQueue({
    name: QUEUE_NAMES.batch,
    payload: BatchJobPayloadSchema,
    progress: BatchJobProgressSchema,
    result: BatchJobResultSchema,
    attempts: 2,
    backoffMs: 5000,
    concurrency: 2,
  }),
  photoAvatar: defineQueue({
    name: QUEUE_NAMES.photoAvatar,
    payload: PhotoAvatarJobPayloadSchema,
    progress: PhotoAvatarJobProgressSchema,
    result: PhotoAvatarJobResultSchema,
    attempts: 2,
    backoffMs: 3000,
    concurrency: 2,
  }),
  voiceClone: defineQueue({
    name: QUEUE_NAMES.voiceClone,
    payload: VoiceCloneJobPayloadSchema,
    progress: VoiceCloneJobProgressSchema,
    result: VoiceCloneJobResultSchema,
    attempts: 2,
    backoffMs: 3000,
    concurrency: 2,
  }),
  webhookDelivery: defineQueue({
    name: QUEUE_NAMES.webhookDelivery,
    payload: WebhookDeliveryJobPayloadSchema,
    progress: WebhookDeliveryJobProgressSchema,
    result: WebhookDeliveryJobResultSchema,
    attempts: 5,
    backoffMs: 10_000,
    concurrency: 5,
  }),
  system: defineQueue({
    name: QUEUE_NAMES.system,
    payload: SystemJobPayloadSchema,
    progress: SystemJobProgressSchema,
    result: SystemJobResultSchema,
    attempts: 1,
    backoffMs: 0,
    concurrency: 2,
  }),
} as const;

export type QueuePayload<K extends QueueKey> = z.output<(typeof QUEUES)[K]['payload']>;
export type QueuePayloadInput<K extends QueueKey> = z.input<(typeof QUEUES)[K]['payload']>;
export type QueueProgress<K extends QueueKey> = z.output<(typeof QUEUES)[K]['progress']>;
export type QueueResult<K extends QueueKey> = z.output<(typeof QUEUES)[K]['result']>;

export const QUEUE_KEYS = Object.keys(QUEUES) as QueueKey[];

/** Webhook retry policy: attempts are spaced by `backoffMs * 2^(attempt-1)`. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
