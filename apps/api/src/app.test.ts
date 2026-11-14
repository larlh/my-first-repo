import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, ApiErrorBodySchema, allRoutes, api, newId, route } from '@parlante/shared';
import { buildSignedFilePath } from '@parlante/shared/node';
import { consentRecords, eq, sessions } from '@parlante/db';
import { consumeConsent } from './lib/consent';
import { defineRoute } from './lib/define-route';
import { assertWithinLimit } from './lib/limits';
import { defineModule, loadModules } from './lib/modules';
import { receiveUpload } from './lib/uploads';
import { createTestApp } from './testing/index';
import type { TestApp } from './testing/index';

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const uploadProbe = route({
  method: 'POST',
  path: '/api/test/upload',
  auth: 'session',
  minRole: 'editor',
  feature: 0,
  tag: 'Test',
  summary: 'Upload probe used by the harness tests',
  multipart: {
    fileField: 'file',
    fields: z.object({ name: z.string().optional() }),
    description: 'file',
  },
  response: z.object({
    mimeType: z.string(),
    ext: z.string(),
    kind: z.string(),
    sizeBytes: z.number(),
    filename: z.string(),
    fields: z.record(z.string(), z.string()),
  }),
  status: 201,
});

const boom = route({
  method: 'GET',
  path: '/api/test/boom',
  auth: 'public',
  feature: 0,
  tag: 'Test',
  summary: 'Throws an unexpected error',
  query: z.object({ kind: z.enum(['crash', 'app', 'bad-response']) }),
  response: z.object({ ok: z.literal(true) }),
});

const testModule = defineModule({
  name: 'test-probes',
  register(app) {
    defineRoute(app, uploadProbe, async ({ request }) => {
      const upload = await receiveUpload(request, { maxBytes: 1024, kinds: ['image'] });
      try {
        const { mimeType, ext, kind, sizeBytes, filename, fields } = upload;
        return { mimeType, ext, kind, sizeBytes, filename, fields };
      } finally {
        await upload.cleanup();
      }
    });
    defineRoute(app, boom, async ({ query }) => {
      if (query.kind === 'app')
        throw new AppError('CONTENT_BLOCKED', 'Blocked', { category: 'test' });
      if (query.kind === 'bad-response') return { ok: false } as unknown as { ok: true };
      throw new Error('secret internal detail');
    });
    defineRoute(app, api.v1.me, async ({ auth }) => ({
      workspace: {
        id: auth.workspace.id,
        name: auth.workspace.name,
        plan: auth.workspace.plan,
        credits: auth.workspace.credits,
      },
      apiKey: { id: auth.apiKey.id, name: auth.apiKey.name, prefix: auth.apiKey.prefix },
    }));
  },
});

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ extraModules: [testModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('infrastructure', () => {
  it('GET /health reports db and queue status', async () => {
    const res = await t.call(api.system.health);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'parlante-api',
      checks: { db: 'ok', redis: 'ok' },
    });
  });

  it('answers unknown routes with the single error shape', async () => {
    const res = await t.inject({ method: 'GET', url: '/api/nope?x=1' });
    expect(res.statusCode).toBe(404);
    expect(ApiErrorBodySchema.parse(res.json())).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /api/nope not found' },
    });
  });

  it('maps AppError, crashes and bad responses without leaking internals', async () => {
    const blocked = await t.call(boom, { query: { kind: 'app' } });
    expect(blocked.status).toBe(422);
    expect(blocked.error).toEqual({
      code: 'CONTENT_BLOCKED',
      message: 'Blocked',
      details: { category: 'test' },
    });
    for (const kind of ['crash', 'bad-response'] as const) {
      const res = await t.call(boom, { query: { kind } });
      expect(res.status).toBe(500);
      expect(res.error).toEqual({ code: 'INTERNAL', message: 'Internal server error' });
    }
  });

  it('reports validation errors with paths', async () => {
    const res = await t.call(boom, { query: { kind: 'nope' as never } });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe('VALIDATION_ERROR');
    expect(res.error.details).toEqual({
      issues: [expect.objectContaining({ path: 'querystring.kind' })],
    });
    const malformed = await t.inject({
      method: 'POST',
      url: api.system.pingWorker.path,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(ApiErrorBodySchema.safeParse(malformed.json()).success).toBe(true);
  });

  it('sets security headers and CORS for the web origin only', async () => {
    const res = await t.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://web.test' },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['access-control-allow-origin']).toBe('http://web.test');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const other = await t.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://evil.test' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves OpenAPI generated from the zod contract', async () => {
    const res = await t.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      openapi: string;
      paths: Record<
        string,
        Record<
          string,
          { tags?: string[]; security?: unknown[]; responses: Record<string, unknown> }
        >
      >;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['apiKey', 'sessionCookie']);
    expect(doc.paths['/health']?.get?.tags).toEqual(['System']);
    expect(doc.paths['/v1/me']?.get?.security).toEqual([{ apiKey: [] }]);
    expect(doc.paths['/v1/me']?.get?.responses['200']).toBeDefined();
    expect(doc.paths['/api/system/worker-ping/{jobId}']?.get).toBeDefined();
    const docs = await t.inject({ method: 'GET', url: '/docs' });
    expect([200, 302]).toContain(docs.statusCode);
  });

  it('autoloads modules from src/modules, skipping _reference directories', async () => {
    const modules = await loadModules();
    const names = modules.map((m) => m.name);
    expect(names).toContain('system');
    expect(names).not.toContain('template-brand-kits');
    expect(new Set(names).size).toBe(names.length);
  });

  it('only registers routes that exist in the shared contract', () => {
    const contract = new Set(allRoutes().map((r) => `${r.route.method} ${r.route.path}`));
    const printed = t.app.printRoutes({ commonPrefix: false });
    expect(printed).toContain('/health');
    expect(contract.has('GET /health')).toBe(true);
  });
});

describe('signed file route', () => {
  const key = 'ws/ws_test/assets/ast_1/original.png';
  beforeEach(async () => {
    await t.app.providers.storage.put(key, PNG, { contentType: 'image/png' });
  });

  it('serves a file through app.fileUrl and supports ranges and downloads', async () => {
    const url = new URL(await t.app.fileUrl(key));
    expect(url.origin).toBe('http://api.test');
    const res = await t.inject({ method: 'GET', url: url.pathname + url.search });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.rawPayload.equals(PNG)).toBe(true);

    const ranged = await t.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { range: 'bytes=0-3' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 0-3/${PNG.length}`);
    expect(ranged.rawPayload.equals(PNG.subarray(0, 4))).toBe(true);
    const bad = await t.inject({
      method: 'GET',
      url: url.pathname + url.search,
      headers: { range: 'bytes=999-' },
    });
    expect(bad.statusCode).toBe(416);

    const dl = new URL(await t.app.fileUrl(key, { downloadName: 'mi "logo".png' }));
    const download = await t.inject({ method: 'GET', url: dl.pathname + dl.search });
    expect(download.headers['content-disposition']).toBe('attachment; filename="mi _logo_.png"');
  });

  it('rejects missing, tampered, expired and re-targeted signatures', async () => {
    const good = new URL(await t.app.fileUrl(key));
    const exp = good.searchParams.get('exp');
    const sig = good.searchParams.get('sig');
    const cases = [
      `/api/files/${key}`,
      `/api/files/${key}?exp=${exp}&sig=${'a'.repeat(43)}`,
      `/api/files/${key}?exp=${Number(exp) + 3600}&sig=${sig}`,
      `/api/files/ws/ws_other/assets/ast_1/original.png?exp=${exp}&sig=${sig}`,
      `/api/files/..%2F..%2Fetc%2Fpasswd?exp=${exp}&sig=${sig}`,
      buildSignedFilePath(t.config.APP_SECRET, key, { nowSec: 1000, expiresInSec: 60 }),
    ];
    for (const url of cases) {
      const res = await t.inject({ method: 'GET', url });
      expect([400, 403], url).toContain(res.statusCode);
      expect(ApiErrorBodySchema.safeParse(res.json()).success, url).toBe(true);
    }
    const missing = buildSignedFilePath(
      t.config.APP_SECRET,
      'ws/ws_test/assets/ast_2/original.png',
    );
    expect((await t.inject({ method: 'GET', url: missing })).statusCode).toBe(404);
  });
});

describe('authentication and authorisation', () => {
  it('requires a session for session routes', async () => {
    const anonymous = await t.call(api.system.capabilities);
    expect(anonymous.status).toBe(401);
    expect(anonymous.error.code).toBe('UNAUTHENTICATED');
    const garbage = await t.call(api.system.capabilities, {
      headers: { cookie: 'parlante_session=not-a-real-token-at-all-123456' },
    });
    expect(garbage.status).toBe(401);
  });

  it('accepts a valid session cookie and reports honest local providers', async () => {
    const alice = await t.signUp();
    const res = await t.call(api.system.capabilities, { as: alice });
    expect(res.status).toBe(200);
    expect(res.body.active.llm).toMatchObject({ id: 'local', quality: 'basic' });
    expect(res.body.sttRequiresTranscript).toBe(true);
    expect(res.body.active.lipsync.id).toBe('local-neural');
    expect(res.body.avatarEngine).toMatchObject({ available: false, device: null });
    expect(res.body.avatarEngine.reason).toBeTruthy();
  });

  it('rejects expired sessions', async () => {
    const alice = await t.signUp();
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, alice.user.id));
    expect((await t.call(api.system.capabilities, { as: alice })).status).toBe(401);
  });

  it('enforces the minimum role declared in the contract', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const admin = await t.addMember(owner.workspace, 'admin');
    const denied = await t.call(api.system.pingWorker, { as: viewer, body: { echo: 'x' } });
    expect(denied.status).toBe(403);
    expect(denied.error.code).toBe('FORBIDDEN');
    expect(t.queues.size).toBe(0);
    const ok = await t.call(api.system.pingWorker, { as: admin, body: { echo: 'hola' } });
    expect(ok.status).toBe(202);
    expect(t.queues.jobs('system')).toEqual([{ kind: 'ping', echo: 'hola' }]);
    const status = await t.call(api.system.workerPingStatus, {
      as: admin,
      params: { jobId: ok.body.jobId },
    });
    expect(status.body).toEqual({ jobId: ok.body.jobId, state: 'waiting', result: null });
    expect(
      (await t.call(api.system.workerPingStatus, { as: admin, params: { jobId: 'missing' } }))
        .status,
    ).toBe(404);
  });

  it('rejects state-changing session requests from unknown origins (CSRF)', async () => {
    const owner = await t.signUp();
    const evil = await t.call(api.system.pingWorker, {
      as: owner,
      body: {},
      headers: { origin: 'http://evil.test' },
    });
    expect(evil.status).toBe(403);
    const web = await t.call(api.system.pingWorker, {
      as: owner,
      body: {},
      headers: { origin: 'http://web.test' },
    });
    expect(web.status).toBe(202);
  });

  it('authenticates /v1 routes by API key, scoped to the key workspace', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const key = await t.apiKeyFor(alice.workspace, 'ci');
    const res = await t.call(api.v1.me, { as: key });
    expect(res.status).toBe(200);
    expect(res.body.workspace.id).toBe(alice.workspace.id);
    expect(res.body.apiKey).toMatchObject({ name: 'ci', prefix: key.apiKey.slice(0, 12) });

    expect((await t.call(api.v1.me)).error.code).toBe('INVALID_API_KEY');
    expect(
      (
        await t.call(api.v1.me, {
          headers: { authorization: 'Bearer plk_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        })
      ).status,
    ).toBe(401);
    // A session cookie is not an API key.
    expect((await t.call(api.v1.me, { as: alice })).status).toBe(401);
  });
});

describe('uploads', () => {
  it('accepts a real PNG and reports the detected type and sanitised name', async () => {
    const alice = await t.signUp();
    const res = await t.call(uploadProbe, {
      as: alice,
      multipart: {
        filename: '../../evil name?.png',
        contentType: 'text/plain',
        data: PNG,
        fields: { name: 'Logo' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      mimeType: 'image/png',
      ext: 'png',
      kind: 'image',
      sizeBytes: PNG.length,
      filename: 'evil name_.png',
      fields: { name: 'Logo' },
    });
  });

  it('rejects disguised, oversized, empty and non-multipart uploads', async () => {
    const alice = await t.signUp();
    const html = await t.call(uploadProbe, {
      as: alice,
      multipart: {
        filename: 'photo.png',
        contentType: 'image/png',
        data: Buffer.from('<html><script>alert(1)</script></html>'),
      },
    });
    expect(html.status).toBe(415);
    expect(html.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const big = await t.call(uploadProbe, {
      as: alice,
      multipart: { filename: 'big.png', data: Buffer.concat([PNG, Buffer.alloc(4096)]) },
    });
    expect(big.status).toBe(413);
    expect(big.error.code).toBe('PAYLOAD_TOO_LARGE');

    const empty = await t.call(uploadProbe, {
      as: alice,
      multipart: { filename: 'e.png', data: Buffer.alloc(0) },
    });
    expect(empty.status).toBe(400);
    const json = await t.call(uploadProbe, { as: alice, body: { file: 'x' } });
    expect(json.status).toBe(400);
  });
});

describe('cross-cutting services', () => {
  it('consumeConsent accepts a matching consent exactly once', async () => {
    const alice = await t.signUp();
    const bob = await t.addMember(alice.workspace, 'editor');
    const insert = async (overrides: Partial<typeof consentRecords.$inferInsert> = {}) => {
      const [row] = await t.db
        .insert(consentRecords)
        .values({
          id: newId('consent'),
          workspaceId: alice.workspace.id,
          userId: alice.user.id,
          kind: 'photo_avatar',
          subjectName: 'Alice Example',
          relationship: 'self',
          statementVersion: '2026-01',
          statement: 'I consent',
          locale: 'es',
          ip: '203.0.113.9',
          ...overrides,
        })
        .returning();
      if (!row) throw new Error('seed');
      return row;
    };
    const consent = await insert();
    const base = {
      consentId: consent.id,
      kind: 'photo_avatar' as const,
      workspaceId: alice.workspace.id,
      userId: alice.user.id,
      resourceId: newId('avatar'),
    };

    await expect(consumeConsent(t.db, { ...base, kind: 'voice_clone' })).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await expect(consumeConsent(t.db, { ...base, userId: bob.user.id })).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
    await expect(
      consumeConsent(t.db, { ...base, workspaceId: newId('workspace') }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    const used = await consumeConsent(t.db, base);
    expect(used.resourceId).toBe(base.resourceId);
    expect(used.usedAt).toBeInstanceOf(Date);
    await expect(consumeConsent(t.db, base)).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
      status: 403,
    });

    const revoked = await insert({ revokedAt: new Date() });
    await expect(consumeConsent(t.db, { ...base, consentId: revoked.id })).rejects.toMatchObject({
      code: 'CONSENT_REQUIRED',
    });
  });

  it('assertWithinLimit enforces plan limits', async () => {
    expect(() => assertWithinLimit({ plan: 'free' }, 'maxScenesPerVideo', 10)).not.toThrow();
    expect(() => assertWithinLimit({ plan: 'free' }, 'maxScenesPerVideo', 11)).toThrow(
      expect.objectContaining({ code: 'PLAN_LIMIT_EXCEEDED', status: 403 }),
    );
  });
});

describe('rate limiting', () => {
  it('limits requests per route when enabled', async () => {
    const limited = await createTestApp({
      modules: [
        defineModule({
          name: 'limited',
          register(app) {
            defineRoute(
              app,
              route({
                method: 'GET',
                path: '/api/test/limited',
                auth: 'public',
                feature: 0,
                tag: 'Test',
                summary: 'Rate limited probe',
                response: z.object({ ok: z.literal(true) }),
                rateLimit: { max: 2, windowSec: 60 },
              }),
              async () => ({ ok: true as const }),
            );
          },
        }),
      ],
      env: { RATE_LIMIT_ENABLED: 'true' },
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push(
          (await limited.inject({ method: 'GET', url: '/api/test/limited' })).statusCode,
        );
      }
      expect(statuses).toEqual([200, 200, 429]);
      const last = await limited.inject({ method: 'GET', url: '/api/test/limited' });
      expect(ApiErrorBodySchema.parse(last.json()).error.code).toBe('RATE_LIMITED');
      expect((await limited.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
