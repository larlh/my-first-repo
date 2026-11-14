import type { Logger } from 'pino';
import type {
  QueueKey,
  QueuePayload,
  QueueProgress,
  QueueResult,
  StoredError,
} from '@parlante/shared';
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
 *  - Define `onFinalFailure` whenever the job owns a row with a status (render, translation,
 *    batch, photo-avatar, voice-clone): see below.
 */
export interface JobDefinition<K extends QueueKey = QueueKey> {
  queue: K;
  handler(ctx: WorkerContext, job: JobHandle<K>): Promise<QueueResult<K>>;
  /**
   * Safety net for failures the handler could not record itself. The runner calls it from the
   * BullMQ `failed` event once the job has NO attempts left — which includes jobs that never
   * reached (or never finished) the handler: a worker process killed mid-job is detected by
   * BullMQ as a stalled job and failed without running any of your code. Without this hook the
   * row would stay `rendering` / `processing` forever with its credits held.
   *
   * It also runs after ordinary final failures, right after the handler's own failure path, so
   * it MUST be idempotent: mark the row failed and refund only if it is still in a
   * non-terminal status (e.g. `markRenderFailed`, `markAvatarFailed`). Errors it throws are
   * logged and swallowed.
   */
  onFinalFailure?(ctx: WorkerContext, payload: QueuePayload<K>, error: StoredError): Promise<void>;
}

/** Type helper: `export default defineJob({ queue: 'render', async handler(ctx, job) { … } })`. */
export function defineJob<K extends QueueKey>(definition: JobDefinition<K>): JobDefinition<K> {
  return definition;
}
