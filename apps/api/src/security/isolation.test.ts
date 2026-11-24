import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@parlante/shared';
import type { RouteDef } from '@parlante/shared';
import { buildSignedFilePath } from '@parlante/shared/node';
import { and, eq, videos } from '@parlante/db';
import { installFakeProviders } from '../modules/videos/test-support';
import { createTestApp } from '../testing/index';
import type { TestActor, TestApiKeyActor, TestApp } from '../testing/index';
import {
  ATTACKER_MARKER,
  bodyCases,
  compositionWithVictimMedia,
  contractRoutes,
  listRoutes,
  pathCases,
  routeId,
  seedVictim,
  victimFingerprint,
  victimSecrets,
} from './isolation-matrix';
import type { AttackCase, VictimResources } from './isolation-matrix';

/* -------------------------------------------------------------------------------------------
 * Workspace isolation, driven by the shared route table (see `isolation-matrix.ts`).
 * Alice (victim) and Bob (attacker) each own a workspace with one of everything. Bob is the
 * OWNER of his workspace, so a 403 for lack of role can never hide a missing 404.
 * The whole app is the real one (every module autoloaded) on the test database.
 * ----------------------------------------------------------------------------------------- */

let t: TestApp;
let alice: TestActor;
let bob: TestActor;
let bobKey: TestApiKeyActor;
let victim: VictimResources;
let attacker: VictimResources;
let pingJobId: string;
let before: string;

beforeAll(async () => {
  t = await createTestApp();
  installFakeProviders(t);
  await t.reset();
  alice = await t.signUp({ plan: 'team', credits: 500 });
  bob = await t.signUp({ plan: 'team', credits: 500 });
  bobKey = await t.apiKeyFor(bob.workspace);
  const storage = t.app.providers.storage;
  victim = await seedVictim(
    t.db,
    storage,
    { workspaceId: alice.workspace.id, userId: alice.user.id },
    t.config.APP_SECRET,
  );
  attacker = await seedVictim(
    t.db,
    storage,
    { workspaceId: bob.workspace.id, userId: bob.user.id },
    t.config.APP_SECRET,
    ATTACKER_MARKER,
  );
  const ping = await t.call(api.system.pingWorker, { as: alice, body: {} });
  expect(ping.status).toBe(202);
  pingJobId = ping.body.jobId;
  before = await victimFingerprint(t.db, victim);
});
afterAll(async () => {
  await t.close();
});

async function attack(
  attackCase: AttackCase,
  as: TestActor | TestApiKeyActor | undefined,
  headers?: Record<string, string>,
) {
  return t.call(attackCase.route, {
    as,
    params: attackCase.params as never,
    query: attackCase.query as never,
    body: attackCase.body as Record<string, unknown> | undefined,
    headers,
  });
}

const describeCase = (attackCase: AttackCase, status: number, body: string): string =>
  `${attackCase.id}${attackCase.note ? ` (${attackCase.note})` : ''} → ${status} ${body.slice(0, 160)}`;

async function expectVictimUntouched(): Promise<void> {
  expect(await victimFingerprint(t.db, victim)).toBe(before);
  for (const key of victim.fileKeys) {
    expect(await t.app.providers.storage.exists(key), `file ${key}`).toBe(true);
  }
}

function cases(): AttackCase[] {
  return pathCases(victim, { brandKitId: attacker.brandKitId }, { pingJobId });
}

describe('workspace isolation: ids in the path', () => {
  it('covers every authenticated route that has a path parameter', () => {
    const covered = new Set(cases().map((c) => c.id));
    const expected = contractRoutes()
      .filter((route) => route.auth !== 'public' && route.path.includes(':'))
      .map(routeId);
    expect(expected.length).toBeGreaterThanOrEqual(50);
    expect([...covered].sort()).toEqual([...expected].sort());
  });

  it('answers 404 to a session of another workspace on every route, and changes nothing', async () => {
    const leaks: string[] = [];
    for (const attackCase of cases().filter((c) => c.route.auth === 'session')) {
      const res = await attack(attackCase, bob);
      if (res.status !== 404) leaks.push(describeCase(attackCase, res.status, res.raw.body));
    }
    expect(leaks).toEqual([]);
    await expectVictimUntouched();
  });

  it('answers 404 to an API key of another workspace on every /v1 route', async () => {
    const leaks: string[] = [];
    const v1 = cases().filter((c) => c.route.auth === 'apiKey');
    expect(v1.length).toBeGreaterThanOrEqual(2);
    for (const attackCase of v1) {
      const res = await attack(attackCase, bobKey);
      if (res.status !== 404) leaks.push(describeCase(attackCase, res.status, res.raw.body));
    }
    expect(leaks).toEqual([]);
    await expectVictimUntouched();
  });

  it('answers 401 without credentials and with the wrong kind of credential', async () => {
    const failures: string[] = [];
    for (const attackCase of cases()) {
      const wrongKind = attackCase.route.auth === 'session' ? bobKey : bob;
      for (const [label, as] of [
        ['anonymous', undefined],
        ['wrong credential kind', wrongKind],
      ] as const) {
        const res = await attack(attackCase, as);
        if (res.status !== 401) {
          failures.push(`${label}: ${describeCase(attackCase, res.status, res.raw.body)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    await expectVictimUntouched();
  });
});

describe('workspace isolation: ids in the body and in the query', () => {
  it('never accepts a reference to a resource of another workspace', async () => {
    const leaks: string[] = [];
    const list = bodyCases(victim, {
      videoId: attacker.draftVideoId,
      imageAssetId: attacker.imageAssetId,
      audioAssetId: attacker.audioAssetId,
      photoConsentId: attacker.unusedConsentId,
      voiceConsentId: attacker.unusedVoiceConsentId,
    });
    expect(list.length).toBeGreaterThanOrEqual(20);
    for (const attackCase of list) {
      const res = await attack(attackCase, attackCase.route.auth === 'apiKey' ? bobKey : bob);
      const allowed = attackCase.expect ?? [404];
      if (!allowed.includes(res.status)) {
        leaks.push(describeCase(attackCase, res.status, res.raw.body));
      }
    }
    expect(leaks).toEqual([]);
    await expectVictimUntouched();
    // The consents of the victim were not consumed by the attacker's attempts.
    expect(await victimFingerprint(t.db, victim)).toBe(before);
  });

  it('does not render a video whose composition points at media of another workspace', async () => {
    for (const what of ['background', 'narration', 'avatar', 'music'] as const) {
      const created = await t.call(api.videos.create, {
        as: bob,
        body: { title: `robo ${what}`, composition: compositionWithVictimMedia(victim, what) },
      });
      // A draft may hold any syntactically valid id; nothing of the victim is resolved for it.
      expect(created.status, what).toBe(201);
      expect(created.raw.body, what).not.toContain(`ws/${victim.workspaceId}`);
      const params = { videoId: created.body.id };
      const read = await t.call(api.videos.get, { as: bob, params });
      expect(read.raw.body, what).not.toContain(`ws/${victim.workspaceId}`);

      const creditsBefore = (await t.call(api.billing.overview, { as: bob })).body.credits;
      const render = await t.call(api.videos.render, { as: bob, params, body: {} });
      expect(render.status, `${what}: ${render.raw.body}`).toBe(422);
      expect(render.error.code, what).toBe('UNPROCESSABLE');
      expect((await t.call(api.billing.overview, { as: bob })).body.credits, what).toBe(
        creditsBefore,
      );
      const [row] = await t.db
        .select({ status: videos.status })
        .from(videos)
        .where(and(eq(videos.id, created.body.id), eq(videos.workspaceId, bob.workspace.id)));
      expect(row?.status, what).toBe('draft');
    }
    expect(t.queues.jobs('render')).toEqual([]);
    await expectVictimUntouched();
  });

  it('lists only the caller workspace on every list route', async () => {
    const secrets = victimSecrets(victim);
    const leaks: string[] = [];
    const queries: Record<string, Record<string, string>[]> = {
      'GET /api/videos': [{}, { batchJobId: victim.batchId }, { q: 'VICTIMA' }],
      'GET /api/assets': [
        {},
        { purpose: 'avatar_source' },
        { purpose: 'voice_sample' },
        { purpose: 'translation_source' },
        { q: 'VICTIMA' },
      ],
      'GET /api/avatars': [{}, { q: 'VICTIMA' }],
      'GET /api/voices': [{}, { kind: 'cloned' }, { q: 'VICTIMA' }],
      'GET /api/templates': [{}, { kind: 'custom' }, { q: 'VICTIMA' }],
      'GET /api/consents': [{}, { kind: 'photo_avatar' }],
    };
    const routes = listRoutes();
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      for (const query of queries[routeId(route)] ?? [{}]) {
        const res = await t.call(route, {
          as: route.auth === 'apiKey' ? bobKey : bob,
          query: query as never,
        });
        if (res.status !== 200) {
          leaks.push(`${routeId(route)} ${JSON.stringify(query)} → ${res.status}`);
          continue;
        }
        for (const secret of secrets) {
          if (res.raw.body.includes(secret)) {
            leaks.push(`${routeId(route)} ${JSON.stringify(query)} leaks ${secret}`);
          }
        }
        if (res.raw.body.includes(`ws/${victim.workspaceId}/`)) {
          leaks.push(`${routeId(route)} ${JSON.stringify(query)} leaks a file URL of the victim`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe('workspace isolation: file URLs', () => {
  const fetchFile = (url: string, headers: Record<string, string> = {}) =>
    t.inject({ method: 'GET', url, headers });

  it('serves a file only with its own unexpired signature', async () => {
    const key = victim.fileKeys[0] as string;
    const good = buildSignedFilePath(t.config.APP_SECRET, key);
    expect((await fetchFile(good)).statusCode).toBe(200);

    const { searchParams } = new URL(good, 'http://x');
    const sig = searchParams.get('sig') as string;
    const exp = searchParams.get('exp') as string;

    // No signature, with or without a session of ANOTHER workspace or of the owner.
    for (const cookie of [undefined, bob.cookie, alice.cookie]) {
      const res = await fetchFile(`/api/files/${key}`, cookie ? { cookie } : {});
      expect(res.statusCode).toBe(400);
    }
    // A signature of one file does not open another one, nor the same one later.
    const other = victim.fileKeys[1] as string;
    expect((await fetchFile(`/api/files/${other}?exp=${exp}&sig=${sig}`)).statusCode).toBe(403);
    const later = Number(exp) + 3600;
    expect((await fetchFile(`/api/files/${key}?exp=${later}&sig=${sig}`)).statusCode).toBe(403);
    // A signature made by the attacker for his own file does not open the victim's.
    const mine = new URL(
      buildSignedFilePath(t.config.APP_SECRET, attacker.fileKeys[0] as string),
      'http://x',
    );
    expect(
      (
        await fetchFile(
          `/api/files/${key}?exp=${mine.searchParams.get('exp')}&sig=${mine.searchParams.get('sig')}`,
        )
      ).statusCode,
    ).toBe(403);
    // Expired links are refused even with a correct signature for that expiry.
    const expired = buildSignedFilePath(t.config.APP_SECRET, key, {
      nowSec: Math.floor(Date.now() / 1000) - 86_400,
      expiresInSec: 60,
    });
    expect((await fetchFile(expired)).statusCode).toBe(403);
    // Garbage and truncated signatures.
    for (const bad of ['', 'x', sig.slice(0, -1), `${sig}A`, sig.toUpperCase()]) {
      const res = await fetchFile(`/api/files/${key}?exp=${exp}&sig=${encodeURIComponent(bad)}`);
      expect([400, 403]).toContain(res.statusCode);
    }
  });

  it('refuses keys that try to leave the storage root, even correctly signed', async () => {
    const traversals = [
      '../../../../etc/passwd',
      `ws/${bob.workspace.id}/../${victim.workspaceId}/assets/${victim.imageAssetId}/original.png`,
      'ws/..%2f..%2f..%2fetc%2fpasswd',
      '%2e%2e/%2e%2e/etc/passwd',
      '/etc/passwd',
      'ws/a\\..\\..\\etc\\passwd',
      'ws/a/%00/passwd',
    ];
    for (const key of traversals) {
      // Signed by the server itself for the literal key: the shape check must still refuse it.
      const decoded = decodeURIComponent(key);
      const signed = buildSignedFilePath(t.config.APP_SECRET, decoded);
      const { search } = new URL(signed, 'http://x');
      for (const url of [signed, `/api/files/${key}${search}`]) {
        const res = await fetchFile(url);
        expect([400, 403, 404], `${url} → ${res.statusCode}`).toContain(res.statusCode);
        expect(res.body).not.toContain('root:');
      }
    }
  });

  it('never hands the attacker a URL for a file of the victim', async () => {
    // Every URL in everything Bob can list points into Bob's workspace or a shared cache.
    for (const route of listRoutes()) {
      const res = await t.call(route, { as: route.auth === 'apiKey' ? bobKey : bob });
      const urls = res.raw.body.match(/\/api\/files\/[^"?]+/g) ?? [];
      for (const url of urls) {
        expect(
          url.startsWith(`/api/files/ws/${bob.workspace.id}/`) ||
            url.startsWith('/api/files/cache/'),
          url,
        ).toBe(true);
      }
    }
  });
});

describe('roles: every mutation states who may run it', () => {
  /** Self-service routes: they only act on the caller's own account or membership. */
  const SELF_SERVICE = new Set([
    'POST /api/auth/logout',
    'PATCH /api/auth/me',
    'POST /api/auth/change-password',
    'POST /api/auth/switch-workspace',
    'POST /api/workspaces',
    'POST /api/invites/accept',
    // Leaving a workspace (self) or removing someone (admin+): decided in the handler.
    'DELETE /api/members/:memberId',
    // Voice preview: reads nothing and stores only a shared cache entry.
    'POST /api/tts/synthesize',
  ]);
  const mutations = (): RouteDef[] =>
    contractRoutes().filter((route) => route.method !== 'GET' && route.auth === 'session');

  it('requires at least the editor role for every mutation that is not self-service', () => {
    const unguarded = mutations()
      .filter((route) => !SELF_SERVICE.has(routeId(route)))
      .filter((route) => !route.minRole || route.minRole === 'viewer')
      .map(routeId);
    expect(unguarded).toEqual([]);
    // Settings that expose or change secrets, people or money need admin or owner.
    for (const route of contractRoutes()) {
      const id = routeId(route);
      if (/^(\w+) \/api\/(api-keys|webhooks|invites(?!\/(accept|lookup)))/.test(id)) {
        expect(['admin', 'owner'], id).toContain(route.minRole);
      }
      if (/\/api\/billing\/(change-plan|top-up)|DELETE \/api\/workspaces\/current/.test(id)) {
        expect(route.minRole, id).toBe('owner');
      }
    }
  });

  it('answers 403 to a member below the minimum role on every guarded route', async () => {
    const viewer = await t.addMember(bob.workspace, 'viewer');
    const editor = await t.addMember(bob.workspace, 'editor');
    const admin = await t.addMember(bob.workspace, 'admin');
    const below: Record<string, TestActor[]> = {
      editor: [viewer],
      admin: [viewer, editor],
      owner: [viewer, editor, admin],
    };
    // Bob's OWN resources: the role is the only reason to refuse.
    const own = pathCases(attacker, { brandKitId: attacker.brandKitId }, { pingJobId });
    const fingerprint = await victimFingerprint(t.db, attacker);
    const failures: string[] = [];
    let checked = 0;
    for (const route of contractRoutes()) {
      if (route.auth !== 'session' || !route.minRole || route.minRole === 'viewer') continue;
      const ownCase = own.find((c) => c.id === routeId(route));
      for (const actor of below[route.minRole] ?? []) {
        // Bodies are irrelevant: the role check runs before the handler. Routes whose body is
        // validated first get a valid one from the matrix when they have a path parameter.
        const res = await t.call(route, {
          as: actor,
          params: ownCase?.params as never,
          body: (ownCase?.body ?? VALID_BODIES[routeId(route)]) as Record<string, unknown>,
        });
        checked += 1;
        if (res.status !== 403) {
          failures.push(
            `${actor.role} on ${routeId(route)} → ${res.status} ${res.raw.body.slice(0, 120)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(80);
    expect(await victimFingerprint(t.db, attacker)).toBe(fingerprint);
  });
});

/** Valid bodies for guarded routes WITHOUT a path parameter (validation runs before auth). */
const VALID_BODIES: Record<string, unknown> = {
  'POST /api/system/worker-ping': {},
  'PATCH /api/workspaces/current': { name: 'x' },
  'POST /api/invites': { email: 'nuevo@example.test' },
  'POST /api/api-keys': { name: 'x' },
  'POST /api/webhooks': { url: 'https://93.184.216.34/hook' },
  'POST /api/billing/change-plan': { planId: 'creator' },
  'POST /api/billing/top-up': { credits: 50 },
  'POST /api/consents': {
    kind: 'photo_avatar',
    subjectName: 'Ana',
    relationship: 'self',
    statementVersion: '2026-01',
    accepted: true,
  },
  'POST /api/videos': {},
  'POST /api/brand-kits': { name: 'x' },
  'POST /api/script-writer/generate': { source: { kind: 'topic', topic: 'energía solar' } },
  'POST /api/translations': {
    sourceAssetId: 'ast_0000000000000000',
    sourceLanguage: 'es',
    targetLanguages: ['en'],
  },
  'POST /api/batches/preview': { sourceVideoId: 'vid_0000000000000000', csv: 'a\n1' },
  'POST /api/batches': { name: 'x', sourceVideoId: 'vid_0000000000000000', csv: 'a\n1' },
  'POST /api/interactive/sessions': {
    avatarId: 'stock_lucia',
    voiceId: 'espeak:es-f1',
    persona: { name: 'x' },
  },
  'POST /api/photo-avatars': {
    name: 'x',
    imageAssetId: 'ast_0000000000000000',
    consentId: 'cns_0000000000000000',
  },
  'POST /api/photo-avatars/generate': { name: 'x', prompt: 'una mujer de 40 años sonriendo' },
  'POST /api/voice-clones': {
    name: 'x',
    sampleAssetId: 'ast_0000000000000000',
    consentId: 'cns_0000000000000000',
    language: 'es',
  },
};
