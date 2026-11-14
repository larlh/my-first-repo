import { z } from 'zod';
import { EngineModelInfoSchema, PhotoLandmarksSchema } from './entities';
import { VisemeCueSchema, WordCueSchema } from './runtime';

/* -------------------------------------------------------------------------------------------
 * HTTP contract of the local neural avatar engine (`services/avatar-engine`, Python — master
 * prompt §2b). The `local-neural` providers in packages/providers are its only client.
 *
 * Transport
 *  - JSON over HTTP on AVATAR_ENGINE_URL (default http://127.0.0.1:8090). The engine binds to
 *    loopback by default. When it must listen on another interface (docker compose: the worker
 *    reaches it as http://avatar-engine:8090 over the compose network) it MUST be started with
 *    AVATAR_ENGINE_TOKEN and then requires `Authorization: Bearer <token>` on every request
 *    except GET /health (401 otherwise). The providers send the header whenever the variable is
 *    set (packages/providers `providerEnvSchema.AVATAR_ENGINE_TOKEN`).
 *  - FILES ARE EXCHANGED BY PATH inside a directory both processes can read and write
 *    (AVATAR_ENGINE_WORK_DIR). Requests name input files and an `outputDir`; the engine writes
 *    results there and answers with paths. The engine must refuse paths outside the work dir.
 *    The directory MUST be mounted at the SAME ABSOLUTE PATH in both processes (paths travel
 *    verbatim in the JSON bodies; docker-compose mounts the `engine` volume at
 *    /data/avatar-engine in api, worker and avatar-engine).
 *  - WHO MOVES THE FILES: the `local-neural` providers, never their callers. Callers (worker
 *    jobs) pass any path readable by the Node process; the provider copies inputs into a
 *    private sub-directory of the work dir, asks the engine to write there, copies the results
 *    to the caller's `outputDir` and removes the sub-directory (helper `createEngineJobDir` in
 *    packages/providers). The engine never sees paths outside the work dir.
 *  - Long operations are jobs: POST creates one (202 + EngineJob), GET polls it, DELETE cancels.
 *    The provider MUST call DELETE /v1/jobs/:jobId when its `signal` is aborted or it gives up
 *    polling, so an abandoned job does not keep burning CPU for minutes.
 *  - Idempotent retries: requests may carry `clientRef` (opaque, ≤ 200 chars). When a job with
 *    the same `clientRef` and kind is still queued or running, the engine SHOULD answer the
 *    POST with THAT job instead of starting an identical one (a restarted worker re-attaches to
 *    it). Engines that ignore the field stay correct, only slower.
 *
 * Output geometry (normative): `prepare` returns a portrait and, when it can, a matte of the
 * same pixel size. `animate` returns frames with THE SAME FRAMING AND ASPECT RATIO AS
 * `portraitPath` (the animated face is pasted back onto the full prepared portrait; frames may
 * be uniformly scaled down to `maxSize`). The renderer therefore places clip frames with the
 * same function and landmarks as the Canvas stand-in (`photoAvatarPlacement`).
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

/* `EngineModelInfoSchema` (one entry of `EngineHealth.models`) lives in ./entities because
 * `GET /api/capabilities` exposes the same objects; it is exported from the package root. */

/** Opaque caller reference for idempotent retries (see "Idempotent retries" above). */
const ClientRefSchema = z.string().min(1).max(200).optional();

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
  /** Measured seconds to generate ONE portrait on this machine; null/absent until measured. */
  secondsPerPortrait: z.number().positive().nullable().optional(),
  /**
   * Additive, optional: which animation drivers are usable. `audio` needs extra weights
   * (requests WITHOUT `visemes` fail with SERVICE_UNAVAILABLE while it is false).
   */
  drivers: z.object({ visemes: z.boolean(), audio: z.boolean() }).optional(),
});
export type EngineHealth = z.infer<typeof EngineHealthSchema>;

export const EngineGenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(1000),
  seed: z.number().int().min(0),
  /** Portrait size in pixels (the engine may round to what the model supports). */
  width: z.number().int().min(256).max(1024).default(512),
  height: z.number().int().min(256).max(1024).default(512),
  outputDir: z.string().min(1),
  clientRef: ClientRefSchema,
  /* ---- additive, optional (engines that ignore it stay correct) ---- */
  /** Steers the presenter template and the negative prompt; otherwise guessed from `prompt`. */
  gender: z.enum(['female', 'male', 'neutral']).optional(),
});
export type EngineGenerateRequest = z.infer<typeof EngineGenerateRequestSchema>;

export const EnginePrepareRequestSchema = z.object({
  imagePath: z.string().min(1),
  /** Marked by the user on `imagePath` (normalised to THAT image); skips face detection. */
  landmarks: PhotoLandmarksSchema.optional(),
  outputDir: z.string().min(1),
  clientRef: ClientRefSchema,
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
  /** E.g. `${renderJobId}:${sceneId}:${layerId}`. */
  clientRef: ClientRefSchema,
  /* ---- additive, optional (engines that ignore them stay correct) ---- */
  /** Word timeline of the narration: head nods and brow raises follow word onsets. */
  words: z.array(WordCueSchema).optional(),
  /**
   * `visemes` = deterministic animation from the viseme timeline (default when `visemes` is
   * sent); `audio` = audio-driven model, for audio without a timeline (default otherwise);
   * `auto` = that default.
   */
  driver: z.enum(['auto', 'visemes', 'audio']).optional(),
  /** Same request + seed ⇒ identical frames. Default: derived from portrait + timeline. */
  seed: z.number().int().min(0).max(2147483647).optional(),
});
export type EngineAnimateRequest = z.infer<typeof EngineAnimateRequestSchema>;

export const EngineJobResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('generate'),
    imagePath: z.string(),
    model: z.string(),
    /* ---- additive, optional: provenance and automatic quality control of the portrait ---- */
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    /** Seed of the attempt that was kept (the engine retries with derived seeds when QC fails). */
    seedUsed: z.number().int().optional(),
    attempts: z.number().int().optional(),
    /** false = no attempt passed every check; the least bad one is returned with `qcIssues`. */
    qcPassed: z.boolean().optional(),
    /** e.g. `mouth_open`, `head_tilted`, `not_frontal`, `pose_asymmetric`. */
    qcIssues: z.array(z.string()).optional(),
  }),
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
  /**
   * `reason` (additive, optional): stable snake_case key for i18n of user-facing failures,
   * e.g. `no_face`, `multiple_faces`, `face_too_small`, `not_frontal`, `weights_missing`.
   */
  error: z
    .object({ code: z.string(), message: z.string(), reason: z.string().optional() })
    .nullable(),
});
export type EngineJob = z.infer<typeof EngineJobSchema>;
