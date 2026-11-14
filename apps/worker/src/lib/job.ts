import type { Logger } from 'pino';
import type { QueueKey, QueuePayload, QueueProgress, QueueResult } from '@parlante/shared';
import type { WorkerContext } from '../context';

/** What a handler knows about the job it is processing. */
export interface JobHandle<K extends QueueKey> {
  id: string;
  /** Payload already validated against the queue schema. */
  payload: QueuePayload<K>;
  /** 1-based attempt number. */
  attempt: number;
  /** True when a failure now is final (no more retries): persist the failure and refund. */
  isLastAttempt: boolean;
  /** Report progress (validated; BullMQ updates are throttled to ~4/s). */
  progress(progress: QueueProgress<K>): Promise<void>;
  /** Aborted when the worker is shutting down: stop long work and throw. */
  signal: AbortSignal;
  /** Logger bound to the queue and job id. */
  log: Logger;
}

/**
 * A job processor: `apps/worker/src/jobs/<name>/index.ts` must default-export one of these.
 * Jobs are discovered and started automatically — one processor per queue.
 *
 * Handler contract
 *  - Load your rows by the ids in the payload and ALWAYS filter by `payload.workspaceId`.
 *  - Be idempotent: the job may run again after a crash (check the row status first).
 *  - On failure throw. `AppError`s with a 4xx status are final (no retry); anything else is
 *    retried according to the queue policy. When `job.isLastAttempt` (or the error is final),
 *    store `{code, message}` on the row and refund credits BEFORE rethrowing — see
 *    `finalFailure()` in ./errors.
 *  - Return the queue's result object.
 */
export interface JobDefinition<K extends QueueKey = QueueKey> {
  queue: K;
  handler(ctx: WorkerContext, job: JobHandle<K>): Promise<QueueResult<K>>;
}

/** Type helper: `export default defineJob({ queue: 'render', async handler(ctx, job) { … } })`. */
export function defineJob<K extends QueueKey>(definition: JobDefinition<K>): JobDefinition<K> {
  return definition;
}
