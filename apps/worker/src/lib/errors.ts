import { isAppError } from '@parlante/shared';

/**
 * True when an error must not be retried: domain errors caused by the input (AppError with a
 * 4xx status — blocked content, missing consent, invalid media…). Infrastructure and provider
 * failures (5xx, plain Errors) are retried by the queue policy.
 */
export function isFinalError(err: unknown): boolean {
  return isAppError(err) && err.status < 500;
}

/** True when this failure is the last word for the job (final error or last attempt). */
export function finalFailure(err: unknown, job: { isLastAttempt: boolean }): boolean {
  return job.isLastAttempt || isFinalError(err);
}
