import { AppError } from '@parlante/shared';
import type { QueueKey, QueuePayloadInput } from '@parlante/shared';
import type { EnqueueOptions, QueueClient } from './queue-client';

/**
 * Enqueue a job for a row that is ALREADY committed (API pattern: transaction first, enqueue
 * after). If the queue backend refuses, the row would otherwise stay `queued` / `processing`
 * forever with its credits held, so `compensate` runs (mark the row failed + refund) and the
 * caller gets SERVICE_UNAVAILABLE.
 *
 *   await enqueueOrCompensate(queues, 'translation', { translationJobId, workspaceId },
 *     { jobId: translationJobId },
 *     async (error) => { …set status 'failed', error; refundCredits(…) },
 *   );
 */
export async function enqueueOrCompensate<K extends QueueKey>(
  queues: QueueClient,
  key: K,
  payload: QueuePayloadInput<K>,
  options: EnqueueOptions,
  compensate: (error: { code: 'SERVICE_UNAVAILABLE'; message: string }) => Promise<void>,
): Promise<{ jobId: string }> {
  try {
    return await queues.enqueue(key, payload, options);
  } catch (err) {
    const message = 'The job queue is not available right now; nothing was charged. Try again';
    await compensate({ code: 'SERVICE_UNAVAILABLE', message });
    throw new AppError('SERVICE_UNAVAILABLE', message, undefined, { cause: err });
  }
}
