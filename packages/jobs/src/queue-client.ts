import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES } from '@parlante/shared';
import type {
  QueueKey,
  QueuePayload,
  QueuePayloadInput,
  QueueProgress,
  QueueResult,
} from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Typed queue client shared by the API (enqueue) and the worker (enqueue follow-up jobs).
 * Queue names, payload schemas and retry policy come from QUEUES in @parlante/shared.
 * ----------------------------------------------------------------------------------------- */

export interface EnqueueOptions {
  /**
   * BullMQ job id. Convention: the id of the row the job works on (`renderJobId`, …), which
   * makes enqueueing idempotent. A finished job with the same id is replaced.
   */
  jobId?: string;
  delayMs?: number;
}

export type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown';

export interface JobSnapshot<K extends QueueKey = QueueKey> {
  id: string;
  state: JobState;
  payload: QueuePayload<K>;
  progress: QueueProgress<K> | null;
  result: QueueResult<K> | null;
  failedReason: string | null;
  attemptsMade: number;
}

export interface QueueClient {
  /** Validate the payload against the queue schema and add the job. */
  enqueue<K extends QueueKey>(
    key: K,
    payload: QueuePayloadInput<K>,
    options?: EnqueueOptions,
  ): Promise<{ jobId: string }>;
  getJob<K extends QueueKey>(key: K, jobId: string): Promise<JobSnapshot<K> | null>;
  /** Remove a job that has not started (cancel). Returns false when it is active or missing. */
  remove(key: QueueKey, jobId: string): Promise<boolean>;
  /** True when the queue backend answers. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface RedisQueueOptions {
  redisUrl: string;
  /** BullMQ key prefix (QUEUE_PREFIX). Isolates environments and test runs. */
  prefix: string;
}

/** ioredis connection configured for BullMQ (`maxRetriesPerRequest: null` is required). */
export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

function normaliseState(state: string): JobState {
  switch (state) {
    case 'waiting':
    case 'waiting-children':
    case 'prioritized':
      return 'waiting';
    case 'delayed':
    case 'active':
    case 'completed':
    case 'failed':
      return state;
    default:
      return 'unknown';
  }
}

export class BullQueueClient implements QueueClient {
  private readonly connection: Redis;
  private readonly prefix: string;
  private readonly queues = new Map<QueueKey, Queue>();

  constructor(options: RedisQueueOptions) {
    this.connection = createRedisConnection(options.redisUrl);
    // Connection problems surface through `ping()` / failed calls, never as a process crash.
    this.connection.on('error', () => undefined);
    this.prefix = options.prefix;
  }

  private queue(key: QueueKey): Queue {
    let queue = this.queues.get(key);
    if (!queue) {
      const def = QUEUES[key];
      const defaultJobOptions: JobsOptions = {
        attempts: def.attempts,
        ...(def.backoffMs > 0 ? { backoff: { type: 'exponential', delay: def.backoffMs } } : {}),
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 5000 },
      };
      queue = new Queue(def.name, {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions,
      });
      queue.on('error', () => undefined);
      this.queues.set(key, queue);
    }
    return queue;
  }

  async enqueue<K extends QueueKey>(
    key: K,
    payload: QueuePayloadInput<K>,
    options: EnqueueOptions = {},
  ): Promise<{ jobId: string }> {
    const data = QUEUES[key].payload.parse(payload);
    const queue = this.queue(key);
    if (options.jobId) {
      // BullMQ ignores `add` when a job with the same id exists: clear finished ones first.
      const existing = await queue.getJob(options.jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed') await existing.remove();
      }
    }
    const job = await queue.add(QUEUES[key].name, data, {
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.delayMs ? { delay: options.delayMs } : {}),
    });
    return { jobId: String(job.id) };
  }

  async getJob<K extends QueueKey>(key: K, jobId: string): Promise<JobSnapshot<K> | null> {
    const job = await this.queue(key).getJob(jobId);
    if (!job) return null;
    const state = normaliseState(await job.getState());
    const progress = job.progress;
    return {
      id: String(job.id),
      state,
      payload: job.data as QueuePayload<K>,
      progress:
        typeof progress === 'object' && progress !== null ? (progress as QueueProgress<K>) : null,
      result: state === 'completed' ? ((job.returnvalue ?? null) as QueueResult<K> | null) : null,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
    };
  }

  async remove(key: QueueKey, jobId: string): Promise<boolean> {
    const job = await this.queue(key).getJob(jobId);
    if (!job) return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false; // locked by a worker (active)
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
    this.connection.disconnect();
  }
}

export function createQueueClient(options: RedisQueueOptions): QueueClient {
  return new BullQueueClient(options);
}

interface MemoryJob {
  key: QueueKey;
  id: string;
  payload: unknown;
  options: EnqueueOptions;
}

/**
 * In-memory QueueClient for tests: records what was enqueued (payloads are validated exactly
 * like the real client) and never touches Redis.
 *
 *   const queues = new InMemoryQueueClient();
 *   … exercise code …
 *   expect(queues.jobs('render')).toEqual([{ renderJobId, videoId, workspaceId }]);
 */
export class InMemoryQueueClient implements QueueClient {
  private readonly store: MemoryJob[] = [];
  private counter = 0;

  async enqueue<K extends QueueKey>(
    key: K,
    payload: QueuePayloadInput<K>,
    options: EnqueueOptions = {},
  ): Promise<{ jobId: string }> {
    const data = QUEUES[key].payload.parse(payload);
    this.counter += 1;
    const id = options.jobId ?? `mem-${this.counter}`;
    const existing = this.store.findIndex((j) => j.key === key && j.id === id);
    if (existing >= 0) this.store.splice(existing, 1);
    this.store.push({ key, id, payload: data, options });
    return { jobId: id };
  }

  async getJob<K extends QueueKey>(key: K, jobId: string): Promise<JobSnapshot<K> | null> {
    const job = this.store.find((j) => j.key === key && j.id === jobId);
    if (!job) return null;
    return {
      id: job.id,
      state: 'waiting',
      payload: job.payload as QueuePayload<K>,
      progress: null,
      result: null,
      failedReason: null,
      attemptsMade: 0,
    };
  }

  async remove(key: QueueKey, jobId: string): Promise<boolean> {
    const index = this.store.findIndex((j) => j.key === key && j.id === jobId);
    if (index < 0) return false;
    this.store.splice(index, 1);
    return true;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    return undefined;
  }

  /** Payloads enqueued on a queue, oldest first. */
  jobs<K extends QueueKey>(key: K): QueuePayload<K>[] {
    return this.store.filter((j) => j.key === key).map((j) => j.payload as QueuePayload<K>);
  }

  /** Job ids enqueued on a queue, oldest first. */
  jobIds(key: QueueKey): string[] {
    return this.store.filter((j) => j.key === key).map((j) => j.id);
  }

  get size(): number {
    return this.store.length;
  }

  clear(): void {
    this.store.length = 0;
  }
}
