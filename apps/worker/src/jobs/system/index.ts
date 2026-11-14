import { defineJob } from '../../lib/job';

/**
 * EXAMPLE JOB (real, autoloaded): answers `ping` jobs queued by
 * `POST /api/system/worker-ping`. Shows the minimal shape of a job:
 *   - one file `jobs/<name>/index.ts` default-exporting `defineJob({ queue, handler })`
 *   - `job.payload` is already validated; the returned value is validated as the queue result
 *   - `job.progress(...)` reports progress; `ctx` carries db, queues, providers, fileUrl, logger
 */
export default defineJob({
  queue: 'system',
  async handler(ctx, job) {
    await job.progress({ percent: 50 });
    job.log.debug({ echo: job.payload.echo }, 'ping');
    await job.progress({ percent: 100 });
    return { kind: 'pong' as const, echo: job.payload.echo, processedAt: new Date().toISOString() };
  },
});
