import { UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { ErrorCodeSchema, QUEUES, toStoredError } from '@parlante/shared';
import type { QueueKey, QueueProgress, StoredError } from '@parlante/shared';
import { createRedisConnection } from '@parlante/jobs';
import { concurrencyFor } from '../config';
import type { WorkerContext } from '../context';
import { isFinalError } from './errors';
import type { JobDefinition, JobHandle } from './job';

const PROGRESS_INTERVAL_MS = 250;

export interface RunningWorkers {
  queues: QueueKey[];
  /** Stop taking jobs, abort handlers after `graceMs`, close connections. */
  close(graceMs?: number): Promise<void>;
}

/**
 * Run a job definition against a BullMQ job: validates payload and result against the queue
 * schemas and turns final errors into BullMQ `UnrecoverableError`s.
 * Exported for tests (`runJob` in ../testing uses the same wrapper).
 */
export async function processJob<K extends QueueKey>(
  ctx: WorkerContext,
  definition: JobDefinition<K>,
  job: Pick<Job, 'id' | 'data' | 'attemptsMade' | 'opts' | 'updateProgress'>,
  signal: AbortSignal,
): Promise<unknown> {
  const queue = QUEUES[definition.queue];
  const log = ctx.logger.child({ queue: queue.name, jobId: job.id });
  const attempts = job.opts.attempts ?? queue.attempts;
  const attempt = job.attemptsMade + 1;
  let lastProgressAt = 0;

  const handle: JobHandle<K> = {
    id: String(job.id),
    payload: queue.payload.parse(job.data) as JobHandle<K>['payload'],
    attempt,
    isLastAttempt: attempt >= attempts,
    signal,
    log,
    progress: async (progress: QueueProgress<K>) => {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      await job.updateProgress(queue.progress.parse(progress) as object);
    },
  };

  const started = Date.now();
  log.info({ attempt, attempts }, 'job started');
  try {
    const result = queue.result.parse(await definition.handler(ctx, handle));
    log.info({ ms: Date.now() - started }, 'job completed');
    return result;
  } catch (err) {
    const stored = toStoredError(err);
    log.error({ err, code: stored.code, attempt, ms: Date.now() - started }, 'job failed');
    if (isFinalError(err)) throw new UnrecoverableError(`${stored.code}: ${stored.message}`);
    throw err;
  }
}

/** `"CODE: message"` (what `processJob` hands to BullMQ for final errors) → StoredError. */
export function storedErrorFromFailedReason(reason: string | undefined): StoredError {
  const text = (reason ?? '').trim();
  const match = /^([A-Z_]+): ([\s\S]*)$/.exec(text);
  const code = match ? ErrorCodeSchema.safeParse(match[1]) : null;
  if (match && code?.success) return { code: code.data, message: (match[2] ?? '').slice(0, 500) };
  if (/stalled/i.test(text)) {
    return {
      code: 'SERVICE_UNAVAILABLE',
      message: 'The worker stopped while processing this job. Nothing was charged; try again.',
    };
  }
  return { code: 'INTERNAL', message: text.slice(0, 500) || 'The job failed' };
}

/**
 * Called for every BullMQ `failed` event. Runs the definition's `onFinalFailure` when the job
 * has no attempts left (exhausted, unrecoverable, or stalled too often — `job` can even be
 * undefined for stalled jobs whose data is gone, in which case nothing can be done).
 * Exported for tests.
 */
export async function handleFailedJob<K extends QueueKey>(
  ctx: WorkerContext,
  definition: JobDefinition<K>,
  job: Pick<Job, 'id' | 'data' | 'attemptsMade' | 'opts' | 'failedReason'> | undefined,
  err: Error,
): Promise<boolean> {
  if (!definition.onFinalFailure || !job) return false;
  const queue = QUEUES[definition.queue];
  const attempts = job.opts.attempts ?? queue.attempts;
  const final = err instanceof UnrecoverableError || job.attemptsMade >= attempts;
  if (!final) return false;
  const payload = queue.payload.safeParse(job.data);
  if (!payload.success) return false;
  try {
    await definition.onFinalFailure(
      ctx,
      payload.data as Parameters<NonNullable<JobDefinition<K>['onFinalFailure']>>[1],
      storedErrorFromFailedReason(job.failedReason ?? err.message),
    );
    return true;
  } catch (hookError) {
    ctx.logger.error(
      { err: hookError, queue: queue.name, jobId: job.id },
      'onFinalFailure hook failed',
    );
    return false;
  }
}

export interface StartWorkersOptions {
  /** Lock a worker holds on an active job (renewed automatically). Default 60 s. */
  lockDurationMs?: number;
  /** How often stalled jobs (expired lock = dead worker) are looked for. Default 30 s. */
  stalledIntervalMs?: number;
  /** Times a stalled job is handed to a worker again before it is failed. Default 1. */
  maxStalledCount?: number;
}

/** Start one BullMQ worker per job definition. */
export function startWorkers(
  ctx: WorkerContext,
  jobs: JobDefinition[],
  options: StartWorkersOptions = {},
): RunningWorkers {
  const connection = createRedisConnection(ctx.config.REDIS_URL);
  connection.on('error', (err) => ctx.logger.error({ err: err.message }, 'redis connection error'));
  const abort = new AbortController();
  const workers = jobs.map((definition) => {
    const queue = QUEUES[definition.queue];
    const worker = new Worker(queue.name, (job) => processJob(ctx, definition, job, abort.signal), {
      connection,
      prefix: ctx.config.QUEUE_PREFIX,
      concurrency: concurrencyFor(ctx.config, definition.queue),
      // Long renders hold the lock while they work; BullMQ renews it automatically.
      lockDuration: options.lockDurationMs ?? 60_000,
      stalledInterval: options.stalledIntervalMs ?? 30_000,
      // A job whose worker died (lock expired) is handed out once more as "stalled"; if it
      // stalls again BullMQ fails it without running the handler (→ onFinalFailure).
      maxStalledCount: options.maxStalledCount ?? 1,
    });
    worker.on('error', (err) =>
      ctx.logger.error({ err: err.message, queue: queue.name }, 'worker error'),
    );
    worker.on('failed', (job, err) => {
      void handleFailedJob(ctx, definition, job, err);
    });
    return worker;
  });
  ctx.logger.info(
    { queues: jobs.map((j) => QUEUES[j.queue].name), prefix: ctx.config.QUEUE_PREFIX },
    'workers started',
  );
  return {
    queues: jobs.map((j) => j.queue),
    close: async (graceMs = 15_000) => {
      const timer = setTimeout(() => abort.abort(), graceMs);
      try {
        // Waits for active jobs (handlers see `signal.aborted` once the grace period ends).
        await Promise.all(workers.map((w) => w.close()));
      } finally {
        clearTimeout(timer);
        abort.abort();
        connection.disconnect();
      }
    },
  };
}
