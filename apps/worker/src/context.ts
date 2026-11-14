import type { Logger } from 'pino';
import type { Providers } from '@parlante/shared';
import type { Db } from '@parlante/db';
import type { FileUrlBuilder, QueueClient } from '@parlante/jobs';
import type { WorkerConfig } from './config';

/** Dependencies handed to every job handler. Never create your own pools/clients in a job. */
export interface WorkerContext {
  config: WorkerConfig;
  db: Db;
  /** Enqueue follow-up jobs (batch → render, video finished → webhooks…). */
  queues: QueueClient;
  providers: Providers;
  /** Storage key → absolute, signed URL. */
  fileUrl: FileUrlBuilder;
  logger: Logger;
}
