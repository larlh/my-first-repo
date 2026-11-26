import pino from 'pino';
import type { Logger } from 'pino';
import { createDb } from '@parlante/db';
import { createFileUrlBuilder, createQueueClient } from '@parlante/jobs';
import { createProviders } from '@parlante/providers';
import { enabledQueues } from './config';
import type { WorkerConfig } from './config';
import type { WorkerContext } from './context';
import { loadJobs } from './lib/loader';
import { startWorkers } from './lib/runner';

export function createLogger(config: WorkerConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export interface RunningWorker {
  ctx: WorkerContext;
  queues: string[];
  /** Graceful shutdown: finish/abort jobs, then close Redis and Postgres. */
  stop(graceMs?: number): Promise<void>;
}

/** Build the context, autoload `src/jobs/*` and start processing. */
export async function startWorker(
  config: WorkerConfig,
  logger: Logger = createLogger(config),
): Promise<RunningWorker> {
  const dbHandle = createDb(config.DATABASE_URL, { applicationName: 'parlante-worker' });
  const queues = createQueueClient({ redisUrl: config.REDIS_URL, prefix: config.QUEUE_PREFIX });
  const providers = createProviders(config);
  const ctx: WorkerContext = {
    config,
    db: dbHandle.db,
    queues,
    providers,
    fileUrl: createFileUrlBuilder({
      storage: providers.storage,
      appSecret: config.APP_SECRET,
      publicApiUrl: config.PUBLIC_API_URL,
    }),
    logger,
  };
  const enabled = enabledQueues(config);
  const jobs = (await loadJobs()).filter((job) => enabled.includes(job.queue));
  const running = startWorkers(ctx, jobs);
  return {
    ctx,
    queues: running.queues,
    stop: async (graceMs) => {
      await running.close(graceMs);
      await queues.close();
      await dbHandle.close();
    },
  };
}
