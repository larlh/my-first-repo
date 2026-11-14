import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { AppError, api } from '@parlante/shared';
import { sql } from '@parlante/db';
import { isSafeStorageKey, sanitizeFilename, verifyFileAccess } from '@parlante/shared/node';
import { defineRoute } from '../lib/define-route';

const startedAt = Date.now();
export const API_VERSION = '0.1.0';

/** Infrastructure routes owned by the skeleton: health and signed file serving. */
export function registerCoreRoutes(app: FastifyInstance): void {
  defineRoute(app, api.system.health, async ({ app: instance }) => {
    let db: 'ok' | 'error' = 'ok';
    try {
      await instance.db.execute(sql`select 1`);
    } catch {
      db = 'error';
    }
    const redis: 'ok' | 'error' = (await instance.queues.ping()) ? 'ok' : 'error';
    return {
      status: 'ok' as const,
      service: 'parlante-api' as const,
      version: API_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      time: new Date().toISOString(),
      checks: { db, redis },
    };
  });

  defineRoute(app, api.system.file, async ({ request, reply, query, app: instance }) => {
    const key = (request.params as { '*': string })['*'];
    // The signature covers the exact key, so a valid signature for a malformed key cannot
    // exist; checking the shape first just avoids touching storage with junk.
    if (
      !isSafeStorageKey(key) ||
      !verifyFileAccess(instance.config.APP_SECRET, key, query.exp, query.sig)
    ) {
      throw AppError.forbidden('This link is invalid or has expired');
    }
    const storage = instance.providers.storage;
    const info = await storage.stat(key);
    if (!info) throw AppError.notFound('File');

    void reply
      .header('Content-Type', info.contentType ?? 'application/octet-stream')
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      // Stored files are never allowed to run as active content.
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (query.download) {
      const name = sanitizeFilename(query.download, 'download');
      void reply.header('Content-Disposition', `attachment; filename="${name}"`);
    }

    const range = parseRange(request.headers.range, info.size);
    if (range === 'invalid') {
      return reply.status(416).header('Content-Range', `bytes */${info.size}`).send();
    }
    if (range) {
      void reply
        .status(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
        .header('Content-Length', range.end - range.start + 1);
      return reply.send(Readable.from(await storage.getStream(key, range)));
    }
    void reply.header('Content-Length', info.size);
    if (request.method === 'HEAD') return reply.send();
    return reply.send(Readable.from(await storage.getStream(key)));
  });
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}
