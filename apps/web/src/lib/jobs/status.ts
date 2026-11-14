/**
 * One vocabulary for every asynchronous thing the product does (renders, translations,
 * batches, photo avatars, cloned voices…). The API uses slightly different status words per
 * resource; `jobPhaseOf` maps all of them.
 */
export type JobPhase =
  'idle' | 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled';

const PHASES: Record<string, JobPhase> = {
  draft: 'idle',
  idle: 'idle',
  queued: 'queued',
  pending: 'queued',
  waiting: 'queued',
  delayed: 'queued',
  running: 'running',
  rendering: 'running',
  processing: 'running',
  active: 'running',
  completed: 'completed',
  ready: 'completed',
  succeeded: 'completed',
  partial: 'partial',
  failed: 'failed',
  canceled: 'canceled',
  cancelled: 'canceled',
};

export function jobPhaseOf(status: string | null | undefined): JobPhase {
  return (status && PHASES[status]) || 'idle';
}

/** Still going: worth polling. */
export function isJobActive(phase: JobPhase): boolean {
  return phase === 'queued' || phase === 'running';
}

/** Reached an end state (success or not). */
export function isJobSettled(phase: JobPhase): boolean {
  return phase === 'completed' || phase === 'partial' || phase === 'failed' || phase === 'canceled';
}
