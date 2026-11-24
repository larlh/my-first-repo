import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, EngineHealthSchema, EngineJobSchema } from '@parlante/shared';
import type {
  EngineHealth,
  EngineJob,
  EngineJobResult,
  EngineProgress,
  EngineReasonCode,
  EngineStatus,
  ErrorCode,
} from '@parlante/shared';
import { resolveEngineWorkDir } from './env';
import type { ProviderEnv } from './env';

/* -------------------------------------------------------------------------------------------
 * Shared plumbing of the two `local-neural` providers (lipsync, portrait) — the only clients
 * of services/avatar-engine. Contract: packages/shared/src/avatar-engine.ts.
 *
 *  - `createEngineJobDir`      who moves the files: the provider (import → engine → export)
 *  - `fetchEngineHealth` / `engineStatus`   GET /health → EngineStatus (never throws)
 *  - `runEngineJob`            POST a job, poll it with progress + ETA, DELETE it on abort
 * ----------------------------------------------------------------------------------------- */

export type EngineClientEnv = Pick<
  ProviderEnv,
  | 'AVATAR_ENGINE_URL'
  | 'AVATAR_ENGINE_TOKEN'
  | 'AVATAR_ENGINE_WORK_DIR'
  | 'AVATAR_ENGINE_POLL_MS'
  | 'AVATAR_ENGINE_STALL_SEC'
>;

/** Headers of every engine request (`Authorization` when AVATAR_ENGINE_TOKEN is set). */
export function engineRequestHeaders(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_TOKEN'>,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(env.AVATAR_ENGINE_TOKEN ? { authorization: `Bearer ${env.AVATAR_ENGINE_TOKEN}` } : {}),
  };
}

/* ------------------------------------ job directory ------------------------------------ */

export interface EngineJobDir {
  /** Absolute path inside AVATAR_ENGINE_WORK_DIR: pass it to the engine as `outputDir`. */
  readonly dir: string;
  /**
   * Copy a caller's file (any readable path) into the job dir under a fixed, safe name and
   * return the path to send to the engine. `name` is chosen by the provider, never by input.
   */
  importFile(sourcePath: string, name: string): Promise<string>;
  /**
   * Copy a file the engine reported back into the caller's `destDir` and return the new path.
   * Refuses paths outside the job dir (an engine answer is never trusted with arbitrary paths).
   */
  exportFile(enginePath: string, destDir: string, name?: string): Promise<string>;
  /** Delete the job dir. Call it in `finally`: nothing may be left in the shared volume. */
  remove(): Promise<void>;
}

export interface EngineJobDirOptions {
  /**
   * Stable reference of the piece of work (`LipSyncRequest.clientRef`…). The directory name
   * is derived from it, so a worker that restarts and re-submits the same `clientRef` gets the
   * SAME directory — the one the still-running engine job (which the engine hands back
   * instead of starting a new one) is writing its results into.
   */
  clientRef?: string;
}

const JOB_DIR_PREFIX = 'job-';
/** Job dirs older than this are leftovers of crashed workers: nobody will collect them. */
const STALE_JOB_DIR_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const lastSweep = new Map<string, number>();

function assertPlainName(name: string): void {
  if (name === '' || name !== path.basename(name) || name.startsWith('.')) {
    throw new Error(`Invalid engine file name: ${JSON.stringify(name)}`);
  }
}

/**
 * Remove job directories abandoned by crashed processes (older than a day). Called
 * opportunistically (at most once an hour per work dir) when a job dir is created; exported
 * for maintenance scripts. Never throws. Returns how many directories were removed.
 */
export async function sweepStaleEngineJobDirs(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_WORK_DIR'>,
  maxAgeMs: number = STALE_JOB_DIR_MS,
): Promise<number> {
  const root = resolveEngineWorkDir(env);
  let removed = 0;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(JOB_DIR_PREFIX)) continue;
      const full = path.join(root, entry.name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && now - stat.mtimeMs > maxAgeMs) {
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch {
    // The work dir does not exist yet or is not listable: nothing to sweep.
  }
  return removed;
}

/**
 * Private sub-directory of the engine work dir for ONE engine job. This is how the
 * `local-neural` providers honour "request paths may be anywhere, the engine only sees its
 * work dir" (providers.ts): import inputs → run the engine with `outputDir = dir` → export
 * results to `request.outputDir` → remove.
 */
export async function createEngineJobDir(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_WORK_DIR'>,
  options: EngineJobDirOptions = {},
): Promise<EngineJobDir> {
  const root = resolveEngineWorkDir(env);
  const suffix = options.clientRef
    ? createHash('sha256').update(options.clientRef).digest('hex').slice(0, 24)
    : randomBytes(8).toString('hex');
  const dir = path.join(root, `${JOB_DIR_PREFIX}${suffix}`);
  await fs.mkdir(dir, { recursive: true });
  // Refresh the mtime so a re-attached directory is never swept as stale.
  const now = new Date();
  await fs.utimes(dir, now, now).catch(() => undefined);

  if (Date.now() - (lastSweep.get(root) ?? 0) > SWEEP_EVERY_MS) {
    lastSweep.set(root, Date.now());
    void sweepStaleEngineJobDirs(env);
  }

  return {
    dir,
    async importFile(sourcePath, name) {
      assertPlainName(name);
      const target = path.join(dir, name);
      // Copy + rename: an engine job that is already reading this file (re-attached after a
      // worker restart) never sees a half-written one.
      const tmp = path.join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
      try {
        await fs.copyFile(sourcePath, tmp);
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      return target;
    },
    async exportFile(enginePath, destDir, name) {
      const resolved = path.resolve(enginePath);
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        throw new Error('The avatar engine returned a path outside its job directory');
      }
      const fileName = name ?? path.basename(resolved);
      assertPlainName(fileName);
      await fs.mkdir(destDir, { recursive: true });
      const target = path.join(destDir, fileName);
      await fs.copyFile(resolved, target);
      return target;
    },
    async remove() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/* ---------------------------------------- status ---------------------------------------- */

const WEIGHTS_HINT = 'download the model weights (see services/avatar-engine/README.md)';

/**
 * EngineStatus of one provider from the engine's `GET /health`. Both `local-neural` providers
 * use it so `/api/capabilities` is consistent:
 *  - lipsync:  available ⇔ `capabilities.animate`
 *  - portrait: available ⇔ `capabilities.prepare` (generation is optional: check
 *              `operations.generate` before accepting a text → avatar request)
 */
export function engineStatusFromHealth(
  health: EngineHealth,
  provider: 'lipsync' | 'portrait',
): EngineStatus {
  const operations = { ...health.capabilities };
  const available = provider === 'lipsync' ? operations.animate : operations.prepare;
  const missing = (Object.keys(operations) as (keyof typeof operations)[]).filter(
    (op) => !operations[op],
  );
  const reason = available
    ? missing.length > 0
      ? `Not available yet: ${missing.join(', ')} — ${WEIGHTS_HINT}`
      : null
    : `The avatar engine is running but cannot ${provider === 'lipsync' ? 'animate' : 'prepare portraits'} yet: ${WEIGHTS_HINT}`;
  return {
    available,
    reason,
    // An operation the engine cannot do while it is running = its weights are not there.
    reasonCode: reason === null ? null : 'weights_missing',
    device: health.device,
    secondsPerVideoSecond: health.secondsPerVideoSecond,
    operations,
    models: health.models,
    nonCommercial: health.models.some((model) => model.downloaded && !model.commercialUse),
    secondsPerPortrait: health.secondsPerPortrait ?? null,
  };
}

const START_HINT =
  'Start it with `pnpm avatar-engine` (see services/avatar-engine/README.md); instant 2D avatars work without it.';

/** Status reported while the engine cannot be reached (`reasonCode`: translatable cause). */
export function engineUnavailable(
  reason: string,
  reasonCode: EngineReasonCode = 'unknown',
): EngineStatus {
  return {
    available: false,
    reason,
    reasonCode,
    device: null,
    secondsPerVideoSecond: null,
    operations: { generate: false, prepare: false, animate: false },
    models: [],
    nonCommercial: false,
    secondsPerPortrait: null,
  };
}

export type FetchLike = typeof fetch;

export interface EngineHttpOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

function engineUrl(env: Pick<ProviderEnv, 'AVATAR_ENGINE_URL'>, pathname: string): string {
  return env.AVATAR_ENGINE_URL.replace(/\/+$/, '') + pathname;
}

function timedOut(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Why a request to the engine failed at the network level, as a sentence for the user. */
function unreachableMessage(env: Pick<ProviderEnv, 'AVATAR_ENGINE_URL'>, err: unknown): string {
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  const detail = timedOut(err) ? 'it did not answer in time' : (cause ?? 'connection failed');
  return `The local avatar engine is not reachable at ${env.AVATAR_ENGINE_URL} (${detail}). ${START_HINT}`;
}

/**
 * AppError('SERVICE_UNAVAILABLE') for an engine that cannot be reached. `details.reason` is
 * the stable, translatable code (`engine_unreachable` / `engine_timeout`): it travels to the
 * API error, to `EngineStatus.reasonCode` and to the `StoredError` of a failed job.
 */
function unreachableError(env: Pick<ProviderEnv, 'AVATAR_ENGINE_URL'>, err: unknown): AppError {
  const reason: EngineReasonCode = timedOut(err) ? 'engine_timeout' : 'engine_unreachable';
  return new AppError(
    'SERVICE_UNAVAILABLE',
    unreachableMessage(env, err),
    { reason },
    {
      cause: err,
    },
  );
}

const REASON_CODES: ReadonlySet<string> = new Set<EngineReasonCode>([
  'engine_unreachable',
  'engine_timeout',
  'engine_error',
  'engine_invalid',
  'weights_missing',
  'not_configured',
  'unknown',
]);

/** `details.reason` of an engine AppError as an EngineReasonCode (`unknown` when it has none). */
export function engineReasonCodeOf(err: unknown): EngineReasonCode {
  if (!(err instanceof AppError)) return 'unknown';
  if (err.code === 'PROVIDER_NOT_CONFIGURED') return 'not_configured';
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' && REASON_CODES.has(reason)
    ? (reason as EngineReasonCode)
    : 'unknown';
}

/**
 * `GET /health`, validated against the contract. Throws AppError('SERVICE_UNAVAILABLE') with a
 * user-presentable reason when the engine is stopped or answers something else.
 */
export async function fetchEngineHealth(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_URL' | 'AVATAR_ENGINE_TOKEN'>,
  options: EngineHttpOptions & { timeoutMs?: number } = {},
): Promise<EngineHealth> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(engineUrl(env, '/health'), {
      headers: engineRequestHeaders(env),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
  } catch (err) {
    throw unreachableError(env, err);
  }
  if (!response.ok) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      `The avatar engine at ${env.AVATAR_ENGINE_URL} answered HTTP ${response.status} to its health check`,
      { reason: 'engine_error' satisfies EngineReasonCode, httpStatus: response.status },
    );
  }
  const parsed = EngineHealthSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(
      'SERVICE_UNAVAILABLE',
      `The service at ${env.AVATAR_ENGINE_URL} does not look like the Parlante avatar engine (unexpected /health answer)`,
      { reason: 'engine_invalid' satisfies EngineReasonCode },
    );
  }
  return parsed.data;
}

const HEALTH_CACHE_MS = 2000;
const healthCache = new Map<string, { at: number; value: Promise<EngineHealth> }>();

/**
 * EngineStatus of a `local-neural` provider. NEVER throws: a stopped engine is reported as
 * `available: false` with the reason. The two providers ask at the same moment
 * (`describeCapabilities`), so identical calls within two seconds share one request.
 */
export async function engineStatus(
  env: Pick<ProviderEnv, 'AVATAR_ENGINE_URL' | 'AVATAR_ENGINE_TOKEN'>,
  provider: 'lipsync' | 'portrait',
  options: EngineHttpOptions = {},
): Promise<EngineStatus> {
  const key = `${env.AVATAR_ENGINE_URL}\n${env.AVATAR_ENGINE_TOKEN ?? ''}`;
  const now = Date.now();
  let entry = options.fetch ? undefined : healthCache.get(key);
  if (!entry || now - entry.at > HEALTH_CACHE_MS) {
    entry = { at: now, value: fetchEngineHealth(env, options) };
    if (!options.fetch) healthCache.set(key, entry);
  }
  try {
    return engineStatusFromHealth(await entry.value, provider);
  } catch (err) {
    return engineUnavailable(
      err instanceof Error
        ? err.message
        : `The local avatar engine is not available. ${START_HINT}`,
      engineReasonCodeOf(err),
    );
  }
}

/* ----------------------------------------- jobs ----------------------------------------- */

type ResultOfKind<K extends EngineJobResult['kind']> = Extract<EngineJobResult, { kind: K }>;

export interface RunEngineJobOptions<K extends EngineJobResult['kind']> extends EngineHttpOptions {
  /** `/v1/animations`, `/v1/portraits/generate` or `/v1/portraits/prepare`. */
  path: string;
  /** JSON body of the POST (already holds `outputDir` and, when given, `clientRef`). */
  body: Record<string, unknown>;
  /** Expected `result.kind`; anything else is a contract violation. */
  kind: K;
  onProgress?: (progress: EngineProgress) => void;
  signal?: AbortSignal;
  /** Override of AVATAR_ENGINE_POLL_MS (tests). */
  pollIntervalMs?: number;
}

/** Engine error codes that mean something to the user and travel unchanged. */
const PASS_THROUGH_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'UNPROCESSABLE',
  'SERVICE_UNAVAILABLE',
  'CONTENT_BLOCKED',
]);

function engineError(
  error: { code?: unknown; message?: unknown; reason?: unknown } | null | undefined,
  httpStatus: number | null,
  fallback: string,
): AppError {
  const engineCode = typeof error?.code === 'string' ? error.code : null;
  const message = typeof error?.message === 'string' && error.message ? error.message : fallback;
  const reason = typeof error?.reason === 'string' ? error.reason : undefined;
  const details = { engineCode, reason, httpStatus };
  if (httpStatus === 401 || httpStatus === 403) {
    return new AppError(
      'PROVIDER_NOT_CONFIGURED',
      'The avatar engine rejected the request: AVATAR_ENGINE_TOKEN is missing or does not match the engine',
      details,
    );
  }
  // Descriptions the engine refuses (minors) are a content decision, not a malfunction.
  if (reason === 'minor_not_allowed') return new AppError('CONTENT_BLOCKED', message, details);
  if (engineCode && PASS_THROUGH_CODES.has(engineCode)) {
    return new AppError(engineCode as ErrorCode, message, details);
  }
  // VALIDATION_ERROR and anything else: OUR request was wrong or the engine broke — never the
  // end user's input, so it must not surface as a 400.
  return new AppError('PROVIDER_ERROR', `Avatar engine: ${message}`, details);
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The avatar engine job was aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const POST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 5_000;
/** Consecutive failed polls tolerated (the engine is busy on every core while it renders). */
const MAX_POLL_FAILURES = 6;

/**
 * Run ONE engine job to completion: POST it, poll `GET /v1/jobs/:id` reporting progress and
 * ETA, and return its validated result.
 *  - `body.clientRef` makes the POST idempotent: the engine answers with the job that is
 *    already queued or running for that reference, so a restarted worker re-attaches to it.
 *  - When `signal` aborts, or polling is given up (engine unreachable / no progress for
 *    AVATAR_ENGINE_STALL_SEC), the job is cancelled with `DELETE /v1/jobs/:id` before
 *    throwing, so an abandoned job does not keep burning CPU for minutes.
 *  - Failures are AppErrors: `UNPROCESSABLE` (no usable face…) and `SERVICE_UNAVAILABLE`
 *    (weights missing, engine stopped) keep their code and the engine's message;
 *    `details.reason` carries the engine's stable reason key.
 */
export async function runEngineJob<K extends EngineJobResult['kind']>(
  env: EngineClientEnv,
  options: RunEngineJobOptions<K>,
): Promise<ResultOfKind<K>> {
  const doFetch = options.fetch ?? fetch;
  const { signal } = options;
  const headers = engineRequestHeaders(env);
  const pollMs = options.pollIntervalMs ?? env.AVATAR_ENGINE_POLL_MS;
  const stallMs = env.AVATAR_ENGINE_STALL_SEC * 1000;

  const cancel = async (jobId: string): Promise<void> => {
    try {
      await doFetch(engineUrl(env, `/v1/jobs/${encodeURIComponent(jobId)}`), {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      });
    } catch {
      // Best effort: the engine may already be gone.
    }
  };

  const readJob = async (response: Response, what: string): Promise<EngineJob> => {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw engineError(error, response.status, `${what} failed with HTTP ${response.status}`);
    }
    const parsed = EngineJobSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', `Avatar engine: unexpected answer to ${what}`, {
        httpStatus: response.status,
      });
    }
    return parsed.data;
  };

  if (signal?.aborted) throw abortError(signal);

  /* ---- submit ---- */
  let job: EngineJob;
  try {
    const response = await doFetch(engineUrl(env, options.path), {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(POST_TIMEOUT_MS)])
        : AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    job = await readJob(response, `POST ${options.path}`);
  } catch (err) {
    if (signal?.aborted) throw abortError(signal);
    if (err instanceof AppError) throw err;
    throw unreachableError(env, err);
  }

  /* ---- poll ---- */
  const jobUrl = engineUrl(env, `/v1/jobs/${encodeURIComponent(job.jobId)}`);
  let lastReported = '';
  let lastChange = Date.now();
  let lastProgress = -1;
  let failures = 0;

  const report = (current: EngineJob): void => {
    const key = `${current.progress.toFixed(4)}|${current.etaSec ?? ''}`;
    if (key === lastReported) return;
    lastReported = key;
    options.onProgress?.({
      fraction: current.progress,
      ...(current.etaSec !== null ? { etaSec: current.etaSec } : {}),
    });
  };

  for (;;) {
    if (job.progress !== lastProgress || job.status === 'queued') {
      lastProgress = job.progress;
      lastChange = Date.now();
    }

    if (job.status === 'succeeded') {
      if (!job.result || job.result.kind !== options.kind) {
        throw new AppError(
          'PROVIDER_ERROR',
          `Avatar engine: job ${job.jobId} finished without a "${options.kind}" result`,
        );
      }
      options.onProgress?.({ fraction: 1, etaSec: 0 });
      return job.result as ResultOfKind<K>;
    }
    if (job.status === 'failed') {
      throw engineError(job.error, null, `The avatar engine job ${job.jobId} failed`);
    }
    if (job.status === 'canceled') {
      if (signal?.aborted) throw abortError(signal);
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The avatar engine job was cancelled before it finished',
        { jobId: job.jobId, reason: 'engine_canceled' },
      );
    }

    report(job);

    if (Date.now() - lastChange > stallMs) {
      await cancel(job.jobId);
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        `The avatar engine made no progress for ${env.AVATAR_ENGINE_STALL_SEC} seconds; the job was cancelled`,
        { jobId: job.jobId, reason: 'engine_stalled' },
      );
    }

    await sleep(pollMs, signal);
    if (signal?.aborted) {
      await cancel(job.jobId);
      throw abortError(signal);
    }

    try {
      const response = await doFetch(jobUrl, {
        headers,
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      if (response.status === 404) {
        throw new AppError(
          'SERVICE_UNAVAILABLE',
          'The avatar engine no longer knows this job (it was restarted); retry the operation',
          { jobId: job.jobId, reason: 'engine_restarted' },
        );
      }
      job = await readJob(response, `GET /v1/jobs/${job.jobId}`);
      failures = 0;
    } catch (err) {
      if (err instanceof AppError) {
        // The engine answered, but not with the job: do not leave it running unattended.
        if ((err.details as { jobId?: string } | undefined)?.jobId === undefined) {
          await cancel(job.jobId);
        }
        throw err;
      }
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        await cancel(job.jobId);
        throw unreachableError(env, err);
      }
    }
  }
}

/** Extension of a caller's image, limited to what the engine reads (`png` when unknown). */
export function engineImageExtension(filePath: string): 'png' | 'jpg' | 'webp' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.webp') return 'webp';
  return 'png';
}
