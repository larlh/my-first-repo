import { UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { QUEUES, toStoredError } from '@parlante/shared';
import type { QueueKey, QueueProgress } from '@parlante/shared';
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

/** Start one BullMQ worker per job definition. */
export function startWorkers(ctx: WorkerContext, jobs: JobDefinition[]): RunningWorkers {
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
      lockDuration: 60_000,
    });
    worker.on('error', (err) =>
      ctx.logger.error({ err: err.message, queue: queue.name }, 'worker error'),
    );
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
