import { z } from 'zod';
import { CapabilitiesSchema } from '../entities';
import { route } from './contract';

export const HealthSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('parlante-api'),
  version: z.string(),
  uptimeSec: z.number(),
  time: z.string(),
  checks: z.object({
    db: z.enum(['ok', 'error']),
    redis: z.enum(['ok', 'error', 'skipped']),
  }),
});
export type Health = z.infer<typeof HealthSchema>;

export const FileQuerySchema = z.object({
  /** Expiry, unix seconds. */
  exp: z.coerce.number().int(),
  /** HMAC signature of `key.exp` (see `signFileUrl` in @parlante/shared/node). */
  sig: z.string().min(16).max(128),
  /** When present the file is served as an attachment with this name. */
  download: z.string().max(200).optional(),
});

export const WorkerPingSchema = z.object({
  jobId: z.string(),
  state: z.enum(['waiting', 'delayed', 'active', 'completed', 'failed', 'unknown']),
  /** Present once the worker has processed the job. */
  result: z
    .object({ kind: z.literal('pong'), echo: z.string(), processedAt: z.string() })
    .nullable(),
});
export type WorkerPing = z.infer<typeof WorkerPingSchema>;

export const systemRoutes = {
  health: route({
    method: 'GET',
    path: '/health',
    auth: 'public',
    feature: 0,
    tag: 'System',
    summary: 'Liveness and dependency check',
    response: HealthSchema,
  }),
  capabilities: route({
    method: 'GET',
    path: '/api/capabilities',
    auth: 'session',
    feature: 0,
    tag: 'System',
    summary: 'Active provider per AI capability (drives "modo básico" labels in the UI)',
    response: CapabilitiesSchema,
  }),
  /** Example of the API → queue → worker round trip (also a worker liveness probe). */
  pingWorker: route({
    method: 'POST',
    path: '/api/system/worker-ping',
    auth: 'session',
    minRole: 'admin',
    feature: 0,
    tag: 'System',
    summary: 'Queue a ping job for the worker',
    body: z.object({ echo: z.string().max(200).default('') }),
    response: WorkerPingSchema,
    status: 202,
  }),
  workerPingStatus: route({
    method: 'GET',
    path: '/api/system/worker-ping/:jobId',
    auth: 'session',
    minRole: 'admin',
    feature: 0,
    tag: 'System',
    summary: 'State and result of a ping job',
    params: z.object({
      jobId: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9_-]+$/),
    }),
    response: WorkerPingSchema,
  }),
  /**
   * Serves stored objects from local storage through signed, expiring URLs. The API builds
   * these URLs (`app.storage.url(key)`); clients never construct them. Supports HTTP Range.
   */
  file: route({
    method: 'GET',
    path: '/api/files/*',
    auth: 'public',
    feature: 0,
    tag: 'System',
    summary: 'Download a stored file via signed URL',
    query: FileQuerySchema,
    response: z.unknown(),
    binary: true,
  }),
} as const;
