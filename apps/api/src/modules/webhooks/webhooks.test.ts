import dns from 'node:dns';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLANS, WebhookEventSchema, api } from '@parlante/shared';
import { decryptSecret, signWebhookPayload, verifyWebhookSignature } from '@parlante/shared/node';
import { eq, webhookDeliveries, webhookEndpoints } from '@parlante/db';
import { loadConfig } from '../../config';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import webhooksModule from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [webhooksModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A literal public address: accepted without any DNS query (the sandbox has no resolver). */
const PUBLIC_URL = 'https://93.184.216.34/hooks/parlante';

/** Make `dns.promises.lookup` answer with the given addresses (or fail when empty). */
function resolveTo(...addresses: string[]) {
  return vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => {
    if (addresses.length === 0) {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    }
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as unknown as typeof dns.promises.lookup);
}

async function createEndpoint(actor: TestActor, body: Record<string, unknown> = {}) {
  const res = await t.call(api.webhooks.create, { as: actor, body: { url: PUBLIC_URL, ...body } });
  expect(res.status).toBe(201);
  return res.body;
}

describe('webhook endpoints', () => {
  it('registers an endpoint with a signing secret shown once and stored encrypted', async () => {
    const owner = await t.signUp();
    const created = await t.call(api.webhooks.create, {
      as: owner,
      body: { url: PUBLIC_URL, description: 'CRM' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      url: PUBLIC_URL,
      description: 'CRM',
      events: ['video.completed', 'video.failed'],
      enabled: true,
      workspaceId: owner.workspace.id,
    });
    expect(created.body.secret).toMatch(/^whsec_[a-z0-9]{32}$/);
    expect(created.body.secretPreview).toBe(created.body.secret.slice(-4));

    const [row] = await t.db.select().from(webhookEndpoints);
    expect(row?.secretEncrypted).not.toContain(created.body.secret);
    expect(decryptSecret(t.config.APP_SECRET, row?.secretEncrypted ?? '')).toBe(
      created.body.secret,
    );

    // A payload signed with the stored secret (what the delivery job does) verifies with the
    // secret the user was shown.
    const header = signWebhookPayload(
      decryptSecret(t.config.APP_SECRET, row?.secretEncrypted ?? ''),
      '{"type":"ping"}',
    );
    expect(verifyWebhookSignature(created.body.secret, '{"type":"ping"}', header)).toBe(true);
    expect(verifyWebhookSignature('whsec_wrong', '{"type":"ping"}', header)).toBe(false);

    const list = await t.call(api.webhooks.list, { as: owner });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      id: created.body.id,
      secretPreview: created.body.secretPreview,
    });
    expect(list.raw.body).not.toContain(created.body.secret);
    expect(list.raw.body).not.toContain(row?.secretEncrypted);
    expect(list.raw.body).not.toMatch(/secretEncrypted|"secret"/);
  });

  it('rejects private, loopback and metadata destinations (SSRF)', async () => {
    const owner = await t.signUp({ plan: 'team' });
    const lookup = resolveTo();
    for (const url of [
      'http://127.0.0.1:8080/hook',
      'http://localhost/hook',
      'http://internal.localhost/hook',
      'http://10.0.0.5/hook',
      'http://172.16.3.4/hook',
      'http://192.168.1.10/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/hook',
      'http://0.0.0.0/hook',
      'http://2130706433/hook', // 127.0.0.1 written as one integer
      'http://[::1]/hook',
      'http://[::ffff:127.0.0.1]/hook',
      'http://[fd00::1]/hook',
      'http://[fe80::1]/hook',
      'https://user:secret@93.184.216.34/hook',
    ]) {
      const res = await t.call(api.webhooks.create, { as: owner, body: { url } });
      expect([url, res.status, res.error.code]).toEqual([url, 422, 'UNSAFE_URL']);
    }
    expect(lookup).not.toHaveBeenCalled();
    // Not http(s) at all: refused by the schema.
    const ftp = await t.call(api.webhooks.create, {
      as: owner,
      body: { url: 'ftp://93.184.216.34/x' },
    });
    expect(ftp.status).toBe(400);
    expect(await t.db.select().from(webhookEndpoints)).toHaveLength(0);
  });

  it('resolves host names and rejects those that point inside (SSRF after DNS)', async () => {
    const owner = await t.signUp({ plan: 'team' });
    const url = 'https://hooks.customer.example/parlante';

    const lookup = resolveTo('10.1.2.3');
    const internal = await t.call(api.webhooks.create, { as: owner, body: { url } });
    expect(internal.status).toBe(422);
    expect(internal.error.code).toBe('UNSAFE_URL');
    expect(lookup).toHaveBeenCalledWith('hooks.customer.example', { all: true });

    // One private address among public ones is enough to refuse (split-horizon tricks).
    resolveTo('93.184.216.34', '127.0.0.1');
    expect((await t.call(api.webhooks.create, { as: owner, body: { url } })).status).toBe(422);
    resolveTo('2606:2800:220:1:248:1893:25c8:1946', '::1');
    expect((await t.call(api.webhooks.create, { as: owner, body: { url } })).status).toBe(422);
    // Unresolvable hosts are refused too.
    resolveTo();
    expect((await t.call(api.webhooks.create, { as: owner, body: { url } })).status).toBe(422);
    expect(await t.db.select().from(webhookEndpoints)).toHaveLength(0);

    resolveTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    const ok = await t.call(api.webhooks.create, { as: owner, body: { url } });
    expect(ok.status).toBe(201);
    expect(ok.body.url).toBe(url);

    // The same guard applies when the URL is changed later.
    resolveTo('192.168.0.7');
    const moved = await t.call(api.webhooks.update, {
      as: owner,
      params: { webhookId: ok.body.id },
      body: { url: 'https://rebound.customer.example/hook' },
    });
    expect(moved.status).toBe(422);
    const [row] = await t.db.select().from(webhookEndpoints);
    expect(row?.url).toBe(url);
  });

  it('never starts in production with the private-destination switch on', () => {
    const secret = { APP_SECRET: 'a-private-secret-of-at-least-32-characters' };
    expect(loadConfig({}).ALLOW_PRIVATE_URLS).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', ...secret }).ALLOW_PRIVATE_URLS).toBe(false);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', ALLOW_PRIVATE_URLS: 'true', ...secret }),
    ).toThrow(/ALLOW_PRIVATE_URLS is a development-only switch/);
  });

  it('accepts private destinations only when the deployment allows them explicitly', async () => {
    const dev = await createTestApp({
      modules: [webhooksModule],
      env: { ALLOW_PRIVATE_URLS: 'true' },
    });
    try {
      const owner = await dev.signUp();
      const res = await dev.call(api.webhooks.create, {
        as: owner,
        body: { url: 'http://127.0.0.1:4999/hook' },
      });
      expect(res.status).toBe(201);
      // Credentials in the URL are refused regardless.
      const creds = await dev.call(api.webhooks.create, {
        as: owner,
        body: { url: 'http://u:p@127.0.0.1:4999/hook' },
      });
      expect(creds.status).toBe(422);
    } finally {
      await dev.close();
    }
  });

  it('applies the plan limit', async () => {
    const owner = await t.signUp();
    const max = PLANS.free.limits.maxWebhookEndpoints;
    for (let i = 0; i < max; i += 1) await createEndpoint(owner);
    const over = await t.call(api.webhooks.create, { as: owner, body: { url: PUBLIC_URL } });
    expect(over.status).toBe(403);
    expect(over.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(over.error.details).toMatchObject({ limit: 'maxWebhookEndpoints', max });
  });

  it('updates, rotates the secret and deletes', async () => {
    const owner = await t.signUp();
    const endpoint = await createEndpoint(owner);
    const params = { webhookId: endpoint.id };

    const updated = await t.call(api.webhooks.update, {
      as: owner,
      params,
      body: {
        events: ['video.completed', 'video.completed'],
        description: 'only ok',
        enabled: false,
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      url: PUBLIC_URL,
      events: ['video.completed'],
      description: 'only ok',
      enabled: false,
      secretPreview: endpoint.secretPreview,
    });
    expect(updated.raw.body).not.toMatch(/whsec_/);
    const noEvents = await t.call(api.webhooks.update, { as: owner, params, body: { events: [] } });
    expect(noEvents.status).toBe(400);
    const badEvent = await t.call(api.webhooks.update, {
      as: owner,
      params,
      body: { events: ['video.exploded'] },
    });
    expect(badEvent.status).toBe(400);

    const rotated = await t.call(api.webhooks.rotateSecret, { as: owner, params });
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(endpoint.secret);
    expect(rotated.body.secretPreview).toBe(rotated.body.secret.slice(-4));
    const [row] = await t.db.select().from(webhookEndpoints);
    expect(decryptSecret(t.config.APP_SECRET, row?.secretEncrypted ?? '')).toBe(
      rotated.body.secret,
    );

    await t.call(api.webhooks.test, { as: owner, params });
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(1);
    expect((await t.call(api.webhooks.remove, { as: owner, params })).body).toEqual({ ok: true });
    expect(await t.db.select().from(webhookEndpoints)).toHaveLength(0);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(0);
    expect((await t.call(api.webhooks.remove, { as: owner, params })).status).toBe(404);
  });

  it('is for admins and owners and never crosses workspaces', async () => {
    const owner = await t.signUp();
    const admin = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const other = await t.signUp();
    const endpoint = await createEndpoint(admin);
    const params = { webhookId: endpoint.id };
    await t.call(api.webhooks.test, { as: owner, params });
    const [delivery] = await t.db.select().from(webhookDeliveries);
    const deliveryParams = { deliveryId: delivery?.id ?? '' };

    expect((await t.call(api.webhooks.list)).status).toBe(401);
    expect((await t.call(api.webhooks.list, { as: editor })).status).toBe(403);
    expect(
      (await t.call(api.webhooks.create, { as: editor, body: { url: PUBLIC_URL } })).status,
    ).toBe(403);
    expect((await t.call(api.webhooks.test, { as: editor, params })).status).toBe(403);
    expect((await t.call(api.webhooks.listDeliveries, { as: editor, params })).status).toBe(403);

    expect((await t.call(api.webhooks.list, { as: other })).body.items).toHaveLength(0);
    expect(
      (await t.call(api.webhooks.update, { as: other, params, body: { enabled: false } })).status,
    ).toBe(404);
    expect((await t.call(api.webhooks.remove, { as: other, params })).status).toBe(404);
    expect((await t.call(api.webhooks.rotateSecret, { as: other, params })).status).toBe(404);
    expect((await t.call(api.webhooks.test, { as: other, params })).status).toBe(404);
    expect((await t.call(api.webhooks.listDeliveries, { as: other, params })).status).toBe(404);
    expect(
      (await t.call(api.webhooks.retryDelivery, { as: other, params: deliveryParams })).status,
    ).toBe(404);
    const [row] = await t.db.select().from(webhookEndpoints);
    expect(row?.enabled).toBe(true);
    expect(row?.secretPreview).toBe(endpoint.secretPreview);
    expect(
      (await t.call(api.webhooks.update, { as: owner, params: { webhookId: 'nope' }, body: {} }))
        .status,
    ).toBe(400);
  });
});

describe('webhook deliveries', () => {
  it('queues a signed ping, even for a disabled endpoint, and lists deliveries newest first', async () => {
    const owner = await t.signUp();
    const endpoint = await createEndpoint(owner, { events: ['video.failed'] });
    const params = { webhookId: endpoint.id };
    await t.call(api.webhooks.update, { as: owner, params, body: { enabled: false } });

    const sent = await t.call(api.webhooks.test, { as: owner, params });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({
      endpointId: endpoint.id,
      eventType: 'ping',
      status: 'pending',
      attempts: 0,
      responseStatus: null,
      deliveredAt: null,
    });
    // One job, whose id is the delivery row (idempotent enqueue).
    expect(t.queues.jobs('webhookDelivery')).toEqual([
      { deliveryId: sent.body.id, workspaceId: owner.workspace.id },
    ]);
    expect(t.queues.jobIds('webhookDelivery')).toEqual([sent.body.id]);
    const [row] = await t.db.select().from(webhookDeliveries);
    const event = WebhookEventSchema.parse(row?.payload);
    expect(event).toMatchObject({ type: 'ping', workspaceId: owner.workspace.id, data: {} });
    expect(event.id).toBe(sent.body.eventId);

    const second = await t.call(api.webhooks.test, { as: owner, params });
    await t.db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 60_000) })
      .where(eq(webhookDeliveries.id, sent.body.id));
    const page1 = await t.call(api.webhooks.listDeliveries, {
      as: owner,
      params,
      query: { limit: 1 },
    });
    expect(page1.body.items.map((d) => d.id)).toEqual([second.body.id]);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await t.call(api.webhooks.listDeliveries, {
      as: owner,
      params,
      query: { limit: 1, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((d) => d.id)).toEqual([sent.body.id]);
    expect(page2.body.nextCursor).toBeNull();
    // The stored payload (with its file URLs) is not exposed in the listing.
    expect(page1.raw.body).not.toContain('payload');
    const badCursor = await t.call(api.webhooks.listDeliveries, {
      as: owner,
      params,
      query: { cursor: 'garbage' },
    });
    expect(badCursor.status).toBe(400);
  });

  it('re-queues only deliveries that failed', async () => {
    const owner = await t.signUp();
    const endpoint = await createEndpoint(owner);
    const sent = await t.call(api.webhooks.test, { as: owner, params: { webhookId: endpoint.id } });
    const params = { deliveryId: sent.body.id };

    const pending = await t.call(api.webhooks.retryDelivery, { as: owner, params });
    expect(pending.status).toBe(409);
    expect(pending.error.code).toBe('INVALID_STATE');

    // The worker gave up.
    t.queues.clear();
    await t.db.update(webhookDeliveries).set({
      status: 'failed',
      attempts: 5,
      responseStatus: 500,
      error: 'HTTP 500',
      durationMs: 120,
    });
    const [first, second] = await Promise.all([
      t.call(api.webhooks.retryDelivery, { as: owner, params }),
      t.call(api.webhooks.retryDelivery, { as: owner, params }),
    ]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    const retried = first.status === 202 ? first : second;
    expect(retried.body).toMatchObject({
      id: sent.body.id,
      status: 'pending',
      attempts: 5,
      responseStatus: null,
      error: null,
    });
    expect(t.queues.jobIds('webhookDelivery')).toEqual([sent.body.id]);

    await t.db.update(webhookDeliveries).set({ status: 'succeeded', deliveredAt: new Date() });
    const done = await t.call(api.webhooks.retryDelivery, { as: owner, params });
    expect(done.status).toBe(409);
    expect(
      (
        await t.call(api.webhooks.retryDelivery, {
          as: owner,
          params: { deliveryId: 'whd_0000000000000000' },
        })
      ).status,
    ).toBe(404);
  });

  it('leaves nothing pending when the queue is down', async () => {
    const owner = await t.signUp();
    const endpoint = await createEndpoint(owner);
    const params = { webhookId: endpoint.id };

    vi.spyOn(t.queues, 'ping').mockResolvedValue(false);
    const down = await t.call(api.webhooks.test, { as: owner, params });
    expect(down.status).toBe(503);
    expect(down.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(0);
    vi.restoreAllMocks();

    const sent = await t.call(api.webhooks.test, { as: owner, params });
    await t.db.update(webhookDeliveries).set({ status: 'failed', error: 'HTTP 500' });
    vi.spyOn(t.queues, 'enqueue').mockRejectedValue(new Error('redis is gone'));
    const retry = await t.call(api.webhooks.retryDelivery, {
      as: owner,
      params: { deliveryId: sent.body.id },
    });
    expect(retry.status).toBe(503);
    const [row] = await t.db.select().from(webhookDeliveries);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/queue is not available/);
  });
});
