import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AppError } from '@parlante/shared';
import type {
  EngineStatus,
  LipSyncProvider,
  LipSyncRequest,
  LipSyncResult,
  ProviderRef,
} from '@parlante/shared';
import { ffprobe } from '@parlante/shared/node';
import type { FetchLike } from '../engine';
import type { ProviderEnv } from '../env';
import { notConfigured } from '../errors';

/* -------------------------------------------------------------------------------------------
 * `external`: generic adapter for a lip-sync service reachable over HTTP, for operators who
 * run (or rent) a talking-head model elsewhere. Selected with LIPSYNC_PROVIDER=external.
 * It is NOT tied to any vendor: the service — or a thin shim in front of a vendor API — must
 * speak the small contract below.
 *
 *   Configuration
 *     LIPSYNC_ENDPOINT_URL   job collection URL, e.g. https://lipsync.example.com/v1/jobs
 *     LIPSYNC_API_KEY        optional; sent as `Authorization: Bearer <key>` to that origin only
 *     LIPSYNC_STATUS_URL     optional health URL (GET, 2xx = available; may answer
 *                            `{ "device": "gpu", "secondsPerVideoSecond": 0.4 }`)
 *     LIPSYNC_TIMEOUT_SEC    give up (and cancel) after this long, default 1800
 *
 *   Create      POST {LIPSYNC_ENDPOINT_URL}          multipart/form-data
 *                 portrait   image file (PNG / JPEG / WebP): the prepared portrait
 *                 mask       PNG matte of the portrait, white = person (optional)
 *                 audio      WAV PCM 16-bit mono: the narration
 *                 options    JSON string { fps, maxSize, visemes?: [{ tMs, viseme }], clientRef? }
 *               → 200 | 201 | 202 with a Job
 *   Poll        GET {statusUrl}                       → Job
 *   Cancel      DELETE {statusUrl}                    (sent when the caller aborts or times out)
 *
 *   Job = {
 *     id?: string,
 *     status: "queued" | "running" | "succeeded" | "failed" | "canceled",
 *     progress?: number,           // 0..1
 *     etaSec?: number,
 *     statusUrl?: string,          // same origin as the endpoint; default {LIPSYNC_ENDPOINT_URL}/{id}
 *     result?: {                   // when succeeded (a synchronous service answers the POST with it)
 *       videoUrl: string,          // clip exactly as long as the audio, SAME framing and aspect
 *                                  // ratio as the portrait (http/https)
 *       maskUrl?: string,          // greyscale matte clip or image, white = person
 *       alpha?: "none" | "mask-video" | "mask-image",   // default: mask-video when maskUrl is set
 *       width?: number, height?: number, fps?: number, frameCount?: number   // probed when absent
 *     },
 *     error?: { code?: string, message: string }
 *   }
 * ----------------------------------------------------------------------------------------- */

const INFO: ProviderRef = {
  id: 'external',
  name: 'External lip-sync',
  quality: 'premium',
  local: false,
};

const ExternalJobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  progress: z.number().min(0).max(1).optional(),
  etaSec: z.number().min(0).nullable().optional(),
  statusUrl: z.string().optional(),
  result: z
    .object({
      videoUrl: z.string(),
      maskUrl: z.string().nullable().optional(),
      alpha: z.enum(['none', 'mask-video', 'mask-image']).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      frameCount: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  error: z.object({ code: z.string().optional(), message: z.string() }).nullable().optional(),
});
type ExternalJob = z.infer<typeof ExternalJobSchema>;

/** Largest file accepted from the service (a clip of a few minutes is a few megabytes). */
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 20_000;
const MAX_POLL_FAILURES = 5;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

async function fileBlob(filePath: string, type: string): Promise<Blob> {
  return new Blob([await fs.readFile(filePath)], { type });
}

function httpUrl(value: string, base: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AppError('PROVIDER_ERROR', 'The lip-sync service returned an invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('PROVIDER_ERROR', 'The lip-sync service returned a non-HTTP URL');
  }
  return url;
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The lip-sync job was aborted', 'AbortError');
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface ExternalLipSyncOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Milliseconds between polls (default 2000). */
  pollIntervalMs?: number;
}

/** Optional external lip-sync endpoint. Contract: the header of this file. */
export function createExternalLipSyncProvider(
  env: ProviderEnv,
  options: ExternalLipSyncOptions = {},
): LipSyncProvider {
  if (!env.LIPSYNC_ENDPOINT_URL) throw notConfigured('external', 'LIPSYNC_ENDPOINT_URL');
  const endpoint = httpUrl(env.LIPSYNC_ENDPOINT_URL, env.LIPSYNC_ENDPOINT_URL);
  const doFetch = options.fetch ?? fetch;
  const pollMs = options.pollIntervalMs ?? 2000;

  /** The API key only ever travels to the configured origin. */
  const headersFor = (url: URL): Record<string, string> =>
    env.LIPSYNC_API_KEY && url.origin === endpoint.origin
      ? { authorization: `Bearer ${env.LIPSYNC_API_KEY}` }
      : {};

  const parseJob = async (response: Response, what: string): Promise<ExternalJob> => {
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        'The external lip-sync service rejected the credentials (check LIPSYNC_API_KEY)',
        { httpStatus: response.status },
      );
    }
    if (!response.ok) {
      const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
      throw new AppError(
        'PROVIDER_ERROR',
        `External lip-sync: ${typeof message === 'string' && message ? message : `${what} failed with HTTP ${response.status}`}`,
        { httpStatus: response.status },
      );
    }
    const parsed = ExternalJobSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('PROVIDER_ERROR', `External lip-sync: unexpected answer to ${what}`);
    }
    return parsed.data;
  };

  const download = async (url: URL, target: string): Promise<void> => {
    const response = await doFetch(url, {
      headers: headersFor(url),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new AppError(
        'PROVIDER_ERROR',
        `External lip-sync: downloading the result failed with HTTP ${response.status}`,
      );
    }
    let received = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          callback(new AppError('PROVIDER_ERROR', 'External lip-sync: the result is too large'));
        } else {
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        limit,
        createWriteStream(target),
      );
    } catch (err) {
      await fs.rm(target, { force: true });
      throw err;
    }
  };

  return {
    info: INFO,

    async status(): Promise<EngineStatus> {
      if (!env.LIPSYNC_STATUS_URL) {
        return { available: true, reason: null, device: null, secondsPerVideoSecond: null };
      }
      try {
        const url = httpUrl(env.LIPSYNC_STATUS_URL, env.LIPSYNC_ENDPOINT_URL ?? '');
        const response = await doFetch(url, {
          headers: headersFor(url),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          return {
            available: false,
            reason: `The external lip-sync service answered HTTP ${response.status} to its health check`,
            reasonCode:
              response.status === 401 || response.status === 403
                ? 'not_configured'
                : 'engine_error',
            device: null,
            secondsPerVideoSecond: null,
          };
        }
        const body = (await response.json().catch(() => null)) as {
          device?: unknown;
          secondsPerVideoSecond?: unknown;
        } | null;
        const speed = body?.secondsPerVideoSecond;
        return {
          available: true,
          reason: null,
          device: body?.device === 'cpu' || body?.device === 'gpu' ? body.device : null,
          secondsPerVideoSecond: typeof speed === 'number' && speed > 0 ? speed : null,
        };
      } catch (err) {
        return {
          available: false,
          reason: `The external lip-sync service is not reachable (${err instanceof Error ? err.message : 'connection failed'})`,
          reasonCode:
            err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
              ? 'engine_timeout'
              : 'engine_unreachable',
          device: null,
          secondsPerVideoSecond: null,
        };
      }
    },

    async animate(request: LipSyncRequest): Promise<LipSyncResult> {
      const { signal } = request;
      if (signal?.aborted) throw abortError(signal);
      const deadline = Date.now() + env.LIPSYNC_TIMEOUT_SEC * 1000;

      const form = new FormData();
      const portraitExt = path.extname(request.portraitPath).toLowerCase();
      form.set(
        'portrait',
        await fileBlob(request.portraitPath, IMAGE_TYPES[portraitExt] ?? 'image/png'),
        `portrait${IMAGE_TYPES[portraitExt] ? portraitExt : '.png'}`,
      );
      if (request.maskPath) {
        form.set('mask', await fileBlob(request.maskPath, 'image/png'), 'mask.png');
      }
      form.set('audio', await fileBlob(request.audioPath, 'audio/wav'), 'audio.wav');
      form.set(
        'options',
        JSON.stringify({
          fps: request.fps,
          maxSize: request.maxSize,
          ...(request.visemes && request.visemes.length > 0 ? { visemes: request.visemes } : {}),
          ...(request.clientRef ? { clientRef: request.clientRef } : {}),
        }),
      );

      let job: ExternalJob;
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: headersFor(endpoint),
          body: form,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        job = await parseJob(response, 'the job request');
      } catch (err) {
        if (signal?.aborted) throw abortError(signal);
        if (err instanceof AppError) throw err;
        throw new AppError(
          'PROVIDER_ERROR',
          `The external lip-sync service is not reachable (${err instanceof Error ? err.message : 'connection failed'})`,
          undefined,
          { cause: err },
        );
      }

      const statusUrl = (current: ExternalJob): URL | null => {
        if (current.statusUrl) {
          const url = httpUrl(current.statusUrl, endpoint.href);
          if (url.origin !== endpoint.origin) {
            throw new AppError(
              'PROVIDER_ERROR',
              'External lip-sync: statusUrl must be on the same origin as LIPSYNC_ENDPOINT_URL',
            );
          }
          return url;
        }
        if (current.id === undefined) return null;
        return new URL(`${endpoint.href.replace(/\/+$/, '')}/${encodeURIComponent(current.id)}`);
      };
      const pollUrl = statusUrl(job);

      const cancel = async (): Promise<void> => {
        if (!pollUrl) return;
        try {
          await doFetch(pollUrl, {
            method: 'DELETE',
            headers: headersFor(pollUrl),
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          // Best effort.
        }
      };

      let failures = 0;
      while (job.status === 'queued' || job.status === 'running') {
        request.onProgress?.({
          fraction: job.progress ?? 0,
          ...(typeof job.etaSec === 'number' ? { etaSec: job.etaSec } : {}),
        });
        if (!pollUrl) {
          throw new AppError(
            'PROVIDER_ERROR',
            'External lip-sync: the job is not finished and has neither id nor statusUrl to poll',
          );
        }
        if (Date.now() > deadline) {
          await cancel();
          throw new AppError(
            'PROVIDER_ERROR',
            `External lip-sync: no result after ${env.LIPSYNC_TIMEOUT_SEC} seconds; the job was cancelled`,
          );
        }
        await delay(pollMs, signal);
        if (signal?.aborted) {
          await cancel();
          throw abortError(signal);
        }
        try {
          const response = await doFetch(pollUrl, {
            headers: headersFor(pollUrl),
            signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
          });
          job = await parseJob(response, 'the job status');
          failures = 0;
        } catch (err) {
          if (err instanceof AppError) {
            await cancel();
            throw err;
          }
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            await cancel();
            throw new AppError(
              'PROVIDER_ERROR',
              'The external lip-sync service stopped answering; the job was cancelled',
              undefined,
              { cause: err },
            );
          }
        }
      }

      if (job.status === 'failed') {
        throw new AppError(
          job.error?.code === 'UNPROCESSABLE' ? 'UNPROCESSABLE' : 'PROVIDER_ERROR',
          `External lip-sync: ${job.error?.message ?? 'the job failed'}`,
        );
      }
      if (job.status === 'canceled') {
        if (signal?.aborted) throw abortError(signal);
        throw new AppError('PROVIDER_ERROR', 'External lip-sync: the job was cancelled');
      }
      const result = job.result;
      if (!result) {
        throw new AppError(
          'PROVIDER_ERROR',
          'External lip-sync: the job succeeded without a result',
        );
      }

      await fs.mkdir(request.outputDir, { recursive: true });
      const videoPath = path.join(request.outputDir, 'avatar.mp4');
      await download(httpUrl(result.videoUrl, endpoint.href), videoPath);
      const alpha = result.maskUrl ? (result.alpha ?? 'mask-video') : 'none';
      let maskPath: string | null = null;
      if (result.maskUrl && alpha !== 'none') {
        maskPath = path.join(
          request.outputDir,
          alpha === 'mask-image' ? 'avatar-matte.png' : 'avatar-matte.mp4',
        );
        await download(httpUrl(result.maskUrl, endpoint.href), maskPath);
      }

      // Services that do not describe their clip: measure it.
      let { width, height, fps, frameCount } = result;
      if (!width || !height || !fps || !frameCount) {
        const probe = await ffprobe(videoPath);
        width ??= probe.width ?? undefined;
        height ??= probe.height ?? undefined;
        fps ??= probe.fps ?? request.fps;
        frameCount ??=
          probe.durationMs !== null
            ? Math.max(1, Math.round((probe.durationMs / 1000) * fps))
            : undefined;
      }
      if (!width || !height || !frameCount) {
        throw new AppError(
          'PROVIDER_ERROR',
          'External lip-sync: the result is not a readable video clip',
        );
      }
      request.onProgress?.({ fraction: 1, etaSec: 0 });
      return {
        videoPath,
        alpha: maskPath ? alpha : 'none',
        maskPath,
        width,
        height,
        fps,
        frameCount,
        provider: INFO,
      };
    },
  };
}
