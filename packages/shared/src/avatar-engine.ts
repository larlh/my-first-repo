import { z } from 'zod';
import { PhotoLandmarksSchema } from './entities';
import { VisemeCueSchema } from './runtime';

/* -------------------------------------------------------------------------------------------
 * HTTP contract of the local neural avatar engine (`services/avatar-engine`, Python — master
 * prompt §2b). The `local-neural` providers in packages/providers are its only client.
 *
 * Transport
 *  - JSON over HTTP on AVATAR_ENGINE_URL (default http://127.0.0.1:8090), loopback only.
 *  - FILES ARE EXCHANGED BY PATH inside a directory both processes can read and write
 *    (AVATAR_ENGINE_WORK_DIR). Requests name input files and an `outputDir`; the engine writes
 *    results there and answers with paths. The engine must refuse paths outside the work dir.
 *  - Long operations are jobs: POST creates one (202 + EngineJob), GET polls it, DELETE cancels.
 *
 * Endpoints
 *   GET    /health                    → EngineHealth
 *   POST   /v1/portraits/generate     body EngineGenerateRequest   → 202 EngineJob
 *   POST   /v1/portraits/prepare      body EnginePrepareRequest    → 202 EngineJob
 *   POST   /v1/animations             body EngineAnimateRequest    → 202 EngineJob
 *   GET    /v1/jobs/:jobId            → EngineJob   (result set when status = "succeeded")
 *   DELETE /v1/jobs/:jobId            → EngineJob   (status "canceled")
 * Errors: non-2xx with `{ error: { code, message } }` using the shared error codes
 * (UNPROCESSABLE = no usable face; SERVICE_UNAVAILABLE = weights missing; VALIDATION_ERROR).
 * ----------------------------------------------------------------------------------------- */

export const EngineModelInfoSchema = z.object({
  /** Stable id used in docs/MODELS.md. */
  id: z.string(),
  role: z.enum(['portrait-generation', 'face-detection', 'matting', 'animation', 'other']),
  /** Weights present in the cache directory (checksums verified). */
  downloaded: z.boolean(),
  license: z.string(),
  commercialUse: z.boolean(),
});

export const EngineHealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  device: z.enum(['cpu', 'gpu']),
  /** Which capabilities are usable right now (all their weights are downloaded). */
  capabilities: z.object({
    generate: z.boolean(),
    prepare: z.boolean(),
    animate: z.boolean(),
  }),
  models: z.array(EngineModelInfoSchema),
  /** Measured on this machine by the engine's benchmark; null until it has run. */
  secondsPerVideoSecond: z.number().positive().nullable(),
});
export type EngineHealth = z.infer<typeof EngineHealthSchema>;

export const EngineGenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(1000),
  seed: z.number().int().min(0),
  /** Portrait size in pixels (the engine may round to what the model supports). */
  width: z.number().int().min(256).max(1024).default(512),
  height: z.number().int().min(256).max(1024).default(512),
  outputDir: z.string().min(1),
});
export type EngineGenerateRequest = z.infer<typeof EngineGenerateRequestSchema>;

export const EnginePrepareRequestSchema = z.object({
  imagePath: z.string().min(1),
  landmarks: PhotoLandmarksSchema.optional(),
  outputDir: z.string().min(1),
});
export type EnginePrepareRequest = z.infer<typeof EnginePrepareRequestSchema>;

export const EngineAnimateRequestSchema = z.object({
  portraitPath: z.string().min(1),
  maskPath: z.string().nullable().default(null),
  /** WAV PCM 16-bit mono. */
  audioPath: z.string().min(1),
  visemes: z.array(VisemeCueSchema).optional(),
  fps: z.number().int().min(1).max(60).default(30),
  maxSize: z.number().int().min(128).max(1024).default(512),
  outputDir: z.string().min(1),
});
export type EngineAnimateRequest = z.infer<typeof EngineAnimateRequestSchema>;

export const EngineJobResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('generate'), imagePath: z.string(), model: z.string() }),
  z.object({
    kind: z.literal('prepare'),
    portraitPath: z.string(),
    maskPath: z.string().nullable(),
    width: z.number().int(),
    height: z.number().int(),
    landmarks: PhotoLandmarksSchema,
    landmarksSource: z.enum(['detected', 'user', 'estimated']),
  }),
  z.object({
    kind: z.literal('animate'),
    videoPath: z.string(),
    alpha: z.enum(['none', 'mask-video', 'mask-image']),
    maskPath: z.string().nullable(),
    width: z.number().int(),
    height: z.number().int(),
    fps: z.number(),
    frameCount: z.number().int(),
    model: z.string(),
  }),
]);
export type EngineJobResult = z.infer<typeof EngineJobResultSchema>;

export const EngineJobSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  /** 0..1 */
  progress: z.number().min(0).max(1),
  etaSec: z.number().min(0).nullable(),
  result: EngineJobResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type EngineJob = z.infer<typeof EngineJobSchema>;
