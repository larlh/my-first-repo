import { z } from 'zod';
import { QUEUES, QUEUE_KEYS } from '@parlante/shared';
import type { QueueKey } from '@parlante/shared';
import { baseEnvSchema, envBoolean, parseEnv, refuseDevOnlySwitches } from '@parlante/shared/node';
import { providerEnvSchema } from '@parlante/providers';

const concurrency = z.coerce.number().int().min(1).max(64).optional();

/** Worker configuration = shared base + provider variables + worker-specific ones. */
export const workerEnvSchema = baseEnvSchema.extend(providerEnvSchema.shape).extend({
  /** Directory for per-job temp files (default: OS temp dir). */
  WORKER_TMP_DIR: z.string().optional(),
  /** Comma-separated queue keys to process (default: all). E.g. `render,system`. */
  WORKER_QUEUES: z.string().optional(),
  WORKER_CONCURRENCY_RENDER: concurrency,
  WORKER_CONCURRENCY_TRANSLATION: concurrency,
  WORKER_CONCURRENCY_BATCH: concurrency,
  WORKER_CONCURRENCY_PHOTOAVATAR: concurrency,
  WORKER_CONCURRENCY_VOICECLONE: concurrency,
  WORKER_CONCURRENCY_WEBHOOKDELIVERY: concurrency,
  WORKER_CONCURRENCY_SYSTEM: concurrency,
  /**
   * Allow webhook deliveries to private addresses (local development / tests). It lifts the
   * SSRF guard: off by default and refused with NODE_ENV=production.
   */
  ALLOW_PRIVATE_URLS: envBoolean(false),
  /** Keep per-job temp directories after the job (debugging). */
  WORKER_KEEP_TMP: envBoolean(false),
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): WorkerConfig {
  const config = parseEnv(workerEnvSchema, source);
  refuseDevOnlySwitches(config, { ALLOW_PRIVATE_URLS: config.ALLOW_PRIVATE_URLS });
  return config;
}

export function concurrencyFor(config: WorkerConfig, key: QueueKey): number {
  const name = `WORKER_CONCURRENCY_${key.toUpperCase()}` as keyof WorkerConfig;
  const override = config[name];
  return typeof override === 'number' ? override : QUEUES[key].concurrency;
}

export function enabledQueues(config: WorkerConfig): QueueKey[] {
  if (!config.WORKER_QUEUES) return [...QUEUE_KEYS];
  const wanted = config.WORKER_QUEUES.split(',').map((s) => s.trim());
  return QUEUE_KEYS.filter((key) => wanted.includes(key));
}
