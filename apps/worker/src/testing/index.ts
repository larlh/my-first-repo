import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { QUEUES } from '@parlante/shared';
import type { QueueKey, QueuePayloadInput, QueueProgress, QueueResult } from '@parlante/shared';
import type { DbHandle } from '@parlante/db';
import { connectTestDb, resetDatabase } from '@parlante/db/testing';
import { InMemoryQueueClient, createFileUrlBuilder } from '@parlante/jobs';
import { createProviders } from '@parlante/providers';
import { loadConfig } from '../config';
import type { WorkerContext } from '../context';
import type { JobDefinition } from '../lib/job';
import { processJob } from '../lib/runner';

/* -------------------------------------------------------------------------------------------
 * Test harness for jobs: a WorkerContext on the per-run test database, an in-memory queue and
 * temp storage — no Redis needed. Run a job with `t.run(definition, payload)`.
 *
 *   const t = await createTestWorker();              // beforeAll
 *   beforeEach(() => t.reset());  afterAll(() => t.close());
 *   const { result, progress } = await t.run(renderJob, { renderJobId, videoId, workspaceId });
 * ----------------------------------------------------------------------------------------- */

export interface RunJobOptions {
  /** Attempts already made (default 0 = first attempt). */
  attemptsMade?: number;
  /** Total attempts allowed (default: the queue policy). */
  attempts?: number;
  signal?: AbortSignal;
}

export interface TestWorker {
  ctx: WorkerContext;
  queues: InMemoryQueueClient;
  storageDir: string;
  reset(): Promise<void>;
  close(): Promise<void>;
  /**
   * Run a job handler exactly like the real runner does (payload/result validation, final
   * error mapping). Resolves with the result and the progress updates it reported.
   */
  run<K extends QueueKey>(
    definition: JobDefinition<K>,
    payload: QueuePayloadInput<K>,
    options?: RunJobOptions,
  ): Promise<{ result: QueueResult<K>; progress: QueueProgress<K>[] }>;
}

export async function createTestWorker(env: Record<string, string> = {}): Promise<TestWorker> {
  const handle: DbHandle = connectTestDb();
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-worker-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.DATABASE_URL,
    APP_SECRET: 'test-app-secret-test-app-secret-0123456789',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    WORKER_TMP_DIR: path.join(storageDir, '_tmp'),
    PUBLIC_API_URL: 'http://api.test',
    PUBLIC_WEB_URL: 'http://web.test',
    ALLOW_PRIVATE_URLS: 'true',
    ...env,
  });
  const queues = new InMemoryQueueClient();
  const providers = createProviders(config);
  const ctx: WorkerContext = {
    config,
    db: handle.db,
    queues,
    providers,
    fileUrl: createFileUrlBuilder({
      storage: providers.storage,
      appSecret: config.APP_SECRET,
      publicApiUrl: config.PUBLIC_API_URL,
    }),
    logger: pino({ level: 'silent' }),
  };
  let counter = 0;
  return {
    ctx,
    queues,
    storageDir,
    async reset() {
      await resetDatabase(handle.db);
      queues.clear();
      await fs.rm(storageDir, { recursive: true, force: true });
      await fs.mkdir(storageDir, { recursive: true });
    },
    async close() {
      await handle.close();
      await fs.rm(storageDir, { recursive: true, force: true });
    },
    async run(definition, payload, options = {}) {
      const progress: QueueProgress<typeof definition.queue>[] = [];
      counter += 1;
      const result = await processJob(
        ctx,
        definition,
        {
          id: `test-${counter}`,
          data: payload,
          attemptsMade: options.attemptsMade ?? 0,
          opts: { attempts: options.attempts ?? QUEUES[definition.queue].attempts },
          updateProgress: async (value) => {
            progress.push(value as QueueProgress<typeof definition.queue>);
          },
        },
        options.signal ?? new AbortController().signal,
      );
      return { result: result as QueueResult<typeof definition.queue>, progress };
    },
  };
}
