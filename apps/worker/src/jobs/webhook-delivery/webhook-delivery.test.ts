import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUES, WEBHOOK_TIMEOUT_MS, newId } from '@parlante/shared';
import type { WebhookEvent, WebhookEventType } from '@parlante/shared';
import {
  encryptSecret,
  generateWebhookSecret,
  hmacSha256Hex,
  verifyWebhookSignature,
} from '@parlante/shared/node';
import { eq, webhookDeliveries, webhookEndpoints } from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import { dispatchWebhookEvent } from '@parlante/jobs';
import { createTestWorker } from '../../testing/index';
import type { TestWorker } from '../../testing/index';
import job, { retryDelayMs } from './index';

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let t: TestWorker;
let server: http.Server;
let baseUrl: string;
let received: Received[];
/** What the receiver answers; replaced by each test. */
let respond: (req: Received, res: http.ServerResponse) => void;

beforeAll(async () => {
  t = await createTestWorker();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const entry: Received = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(entry);
      respond(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  received = [];
  respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  t.ctx.config.ALLOW_PRIVATE_URLS = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface SeedOptions {
  url?: string;
  enabled?: boolean;
  type?: WebhookEventType;
  secretEncrypted?: string;
}

/** An endpoint and one pending delivery, as `dispatchWebhookEvent` leaves them. */
async function seedDelivery(options: SeedOptions = {}) {
  const account = await seedAccount(t.ctx.db);
  const workspaceId = account.workspace.id;
  const secret = generateWebhookSecret();
  const endpointId = newId('webhookEndpoint');
  await t.ctx.db.insert(webhookEndpoints).values({
    id: endpointId,
    workspaceId,
    url: options.url ?? `${baseUrl}/hooks/parlante?source=test`,
    events: ['video.completed', 'video.failed'],
    enabled: options.enabled ?? true,
    secretEncrypted: options.secretEncrypted ?? encryptSecret(t.ctx.config.APP_SECRET, secret),
    secretPreview: secret.slice(-4),
  });
  const type = options.type ?? 'video.completed';
  const event: WebhookEvent = {
    id: newId('event'),
    type,
    createdAt: new Date().toISOString(),
    workspaceId,
    data: {},
  };
  const deliveryId = newId('webhookDelivery');
  await t.ctx.db.insert(webhookDeliveries).values({
    id: deliveryId,
    workspaceId,
    endpointId,
    eventId: event.id,
    eventType: type,
    payload: event,
  });
  return {
    workspaceId,
    endpointId,
    deliveryId,
    secret,
    event,
    payload: { deliveryId, workspaceId },
  };
}

async function deliveryRow(deliveryId: string) {
  const [row] = await t.ctx.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row) throw new Error('delivery row is gone');
  return row;
}

describe('webhook-delivery job', () => {
  it('POSTs the event signed with HMAC-SHA256 and records the successful attempt', async () => {
    const seeded = await seedDelivery();
    const before = Math.floor(Date.now() / 1000);
    const { result, progress } = await t.run(job, seeded.payload);

    expect(result).toEqual({
      deliveryId: seeded.deliveryId,
      eventType: 'video.completed',
      responseStatus: 200,
    });
    expect(progress).toEqual([{ attempt: 1 }]);
    expect(received).toHaveLength(1);
    const request = received[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/hooks/parlante?source=test');
    expect(request?.headers['content-type']).toMatch(/^application\/json/);
    expect(request?.headers['parlante-event']).toBe('video.completed');
    expect(request?.headers['parlante-delivery']).toBe(seeded.deliveryId);
    // The body is exactly the stored event…
    expect(JSON.parse(request?.body ?? '')).toEqual(seeded.event);
    // …and the signature is `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`.
    const signature = String(request?.headers['parlante-signature']);
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
    expect(match).not.toBeNull();
    const timestamp = Number(match?.[1]);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(match?.[2]).toBe(hmacSha256Hex(seeded.secret, `${timestamp}.${request?.body ?? ''}`));
    expect(verifyWebhookSignature(seeded.secret, request?.body ?? '', signature)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', request?.body ?? '', signature)).toBe(false);
    expect(verifyWebhookSignature(seeded.secret, `${request?.body ?? ''} `, signature)).toBe(false);

    const row = await deliveryRow(seeded.deliveryId);
    expect(row).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      responseStatus: 200,
      error: null,
      nextRetryAt: null,
    });
    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('delivers what dispatchWebhookEvent queued, only to subscribed endpoints', async () => {
    const seeded = await seedDelivery();
    await t.ctx.db.delete(webhookDeliveries);
    const rows = await dispatchWebhookEvent({
      db: t.ctx.db,
      queues: t.queues,
      workspaceId: seeded.workspaceId,
      type: 'video.failed',
      data: {},
    });
    expect(rows).toHaveLength(1);
    const [queued] = t.queues.jobs('webhookDelivery');
    expect(queued).toEqual({ deliveryId: rows[0]?.id, workspaceId: seeded.workspaceId });
    if (!queued) throw new Error('nothing was queued');

    const { result } = await t.run(job, queued);
    expect(result.eventType).toBe('video.failed');
    expect(received[0]?.headers['parlante-event']).toBe('video.failed');
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({
      type: 'video.failed',
      workspaceId: seeded.workspaceId,
    });
  });

  it('records each failed attempt, retries with the queue backoff and gives up on the last', async () => {
    const seeded = await seedDelivery();
    respond = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream\n\tbusy\u0000');
    };
    const attempts = QUEUES.webhookDelivery.attempts;
    for (let made = 0; made < attempts - 1; made += 1) {
      const startedAt = Date.now();
      await expect(t.run(job, seeded.payload, { attemptsMade: made })).rejects.toThrow(
        'The endpoint answered HTTP 503',
      );
      const row = await deliveryRow(seeded.deliveryId);
      expect(row).toMatchObject({ status: 'pending', attempts: made + 1, responseStatus: 503 });
      expect(row.error).toBe('The endpoint answered HTTP 503: upstream busy');
      // Exponential backoff of the queue: 10 s, 20 s, 40 s, 80 s.
      const delay = (row.nextRetryAt?.getTime() ?? 0) - startedAt;
      expect(delay).toBeGreaterThanOrEqual(retryDelayMs(made + 1) - 50);
      expect(delay).toBeLessThan(retryDelayMs(made + 1) + 5000);
    }
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000]);

    await expect(t.run(job, seeded.payload, { attemptsMade: attempts - 1 })).rejects.toThrow(
      'The endpoint answered HTTP 503',
    );
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      status: 'failed',
      attempts,
      responseStatus: 503,
      nextRetryAt: null,
      deliveredAt: null,
    });
    expect(received).toHaveLength(attempts);

    // A delivery that gave up is not sent again by a stray job (the API re-queues it as pending).
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/INVALID_STATE/);
    expect(received).toHaveLength(attempts);
  });

  it('succeeds on a later attempt and clears the previous error', async () => {
    const seeded = await seedDelivery();
    respond = (_req, res) => {
      res.writeHead(received.length === 1 ? 500 : 204);
      res.end();
    };
    await expect(t.run(job, seeded.payload)).rejects.toThrow('The endpoint answered HTTP 500');
    const { result, progress } = await t.run(job, seeded.payload, { attemptsMade: 1 });
    expect(result.responseStatus).toBe(204);
    expect(progress).toEqual([{ attempt: 2 }]);
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      responseStatus: 204,
      error: null,
      nextRetryAt: null,
    });
    // Each attempt is signed afresh (same body, its own timestamp).
    expect(received[1]?.body).toBe(received[0]?.body);
    expect(
      verifyWebhookSignature(
        seeded.secret,
        received[1]?.body ?? '',
        String(received[1]?.headers['parlante-signature']),
      ),
    ).toBe(true);
  });

  it('is idempotent: an accepted delivery is never sent twice', async () => {
    const seeded = await seedDelivery();
    await t.run(job, seeded.payload);
    const again = await t.run(job, seeded.payload);
    expect(again.result.responseStatus).toBe(200);
    expect(received).toHaveLength(1);
    expect((await deliveryRow(seeded.deliveryId)).attempts).toBe(1);
  });

  it('blocks private addresses at send time (SSRF) without contacting them', async () => {
    t.ctx.config.ALLOW_PRIVATE_URLS = false;
    const targets = [
      `${baseUrl}/hook`, // loopback literal
      baseUrl.replace('127.0.0.1', 'localhost'),
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://[::1]:8080/hook',
      'http://10.0.0.5/hook',
    ];
    for (const url of targets) {
      const seeded = await seedDelivery({ url });
      await expect(t.run(job, seeded.payload)).rejects.toThrow(/UNSAFE_URL/);
      // Final at once: waiting does not make a private address public.
      expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
        status: 'failed',
        attempts: 1,
        responseStatus: null,
        nextRetryAt: null,
        error: 'The URL points to a private or local address',
      });
    }
    expect(received).toHaveLength(0);
  });

  it('blocks a host that resolves to a private address only when the socket connects (DNS rebinding)', async () => {
    t.ctx.config.ALLOW_PRIVATE_URLS = false;
    const port = new URL(baseUrl).port;
    const seeded = await seedDelivery({ url: `http://hooks.rebind.example:${port}/hook` });
    // The check made before connecting sees a public address…
    vi.spyOn(dns.promises, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    // …and the lookup of the connection itself answers with loopback.
    const connectLookup = vi.spyOn(dns, 'lookup').mockImplementation(((
      _host: string,
      _options: unknown,
      callback: (err: null, addresses: dns.LookupAddress[]) => void,
    ) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
    }) as never);

    await expect(t.run(job, seeded.payload)).rejects.toThrow(/UNSAFE_URL/);
    expect(connectLookup).toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('never follows redirects', async () => {
    const seeded = await seedDelivery();
    respond = (req, res) => {
      if (req.url.startsWith('/hooks/')) {
        res.writeHead(302, { location: `${baseUrl}/internal/admin` });
        res.end();
      } else {
        res.writeHead(200);
        res.end('secret');
      }
    };
    await expect(t.run(job, seeded.payload)).rejects.toThrow('The endpoint answered HTTP 302');
    expect(received.map((r) => r.url)).toEqual(['/hooks/parlante?source=test']);
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      status: 'pending',
      responseStatus: 302,
    });
  });

  it('treats 410 Gone as final', async () => {
    const seeded = await seedDelivery();
    respond = (_req, res) => {
      res.writeHead(410);
      res.end();
    };
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/UNPROCESSABLE/);
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      responseStatus: 410,
      nextRetryAt: null,
    });
  });

  it('sends nothing to a disabled endpoint, except the test ping', async () => {
    const event = await seedDelivery({ enabled: false });
    await expect(t.run(job, event.payload)).rejects.toThrow(/INVALID_STATE/);
    expect(received).toHaveLength(0);
    expect(await deliveryRow(event.deliveryId)).toMatchObject({
      status: 'failed',
      error: 'The endpoint is disabled',
    });

    const ping = await seedDelivery({ enabled: false, type: 'ping' });
    const { result } = await t.run(job, ping.payload);
    expect(result).toMatchObject({ eventType: 'ping', responseStatus: 200 });
    expect(received).toHaveLength(1);
    expect(received[0]?.headers['parlante-event']).toBe('ping');
  });

  it('never sends an unsigned event when the secret cannot be decrypted', async () => {
    const seeded = await seedDelivery({
      secretEncrypted: encryptSecret('another-app-secret-another-app-secret-000', 'whsec_x'),
    });
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/UNPROCESSABLE/);
    expect(received).toHaveLength(0);
    expect((await deliveryRow(seeded.deliveryId)).status).toBe('failed');
  });

  it('gives up on a receiver that does not answer within the time limit', async () => {
    const seeded = await seedDelivery();
    respond = () => undefined; // accepts the request and never answers
    const startedAt = Date.now();
    await expect(t.run(job, seeded.payload)).rejects.toThrow('The request timed out');
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(WEBHOOK_TIMEOUT_MS - 200);
    expect(elapsed).toBeLessThan(WEBHOOK_TIMEOUT_MS + 3000);
    const row = await deliveryRow(seeded.deliveryId);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, responseStatus: null });
    expect(row.error).toBe('The request timed out (ETIMEDOUT)');
    expect(row.durationMs).toBeGreaterThanOrEqual(WEBHOOK_TIMEOUT_MS - 200);
  });

  it('records a connection failure and keeps the delivery for the next attempt', async () => {
    // A port nobody listens on.
    const idle = http.createServer();
    await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
    const { port } = idle.address() as AddressInfo;
    await new Promise((resolve) => idle.close(resolve));
    const seeded = await seedDelivery({ url: `http://127.0.0.1:${port}/hook` });

    await expect(t.run(job, seeded.payload)).rejects.toThrow('The request failed');
    expect(await deliveryRow(seeded.deliveryId)).toMatchObject({
      status: 'pending',
      attempts: 1,
      responseStatus: null,
      error: 'The request failed (ECONNREFUSED)',
    });
  });

  it('never loads a delivery through another workspace', async () => {
    const seeded = await seedDelivery();
    const other = await seedAccount(t.ctx.db);
    await expect(
      t.run(job, { deliveryId: seeded.deliveryId, workspaceId: other.workspace.id }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect(received).toHaveLength(0);
    expect((await deliveryRow(seeded.deliveryId)).status).toBe('pending');
  });

  it('onFinalFailure closes a delivery whose worker died, keeping the last recorded error', async () => {
    const stalled = await seedDelivery();
    const error = { code: 'SERVICE_UNAVAILABLE' as const, message: 'The worker stopped' };
    await job.onFinalFailure?.(t.ctx, stalled.payload, error);
    await job.onFinalFailure?.(t.ctx, stalled.payload, error);
    expect(await deliveryRow(stalled.deliveryId)).toMatchObject({
      status: 'failed',
      error: 'The worker stopped',
      nextRetryAt: null,
    });

    // A delivery that already succeeded is left alone.
    const delivered = await seedDelivery();
    await t.run(job, delivered.payload);
    await job.onFinalFailure?.(t.ctx, delivered.payload, error);
    expect((await deliveryRow(delivered.deliveryId)).status).toBe('succeeded');
  });
});
