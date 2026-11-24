import { randomBytes } from 'node:crypto';
import { api, buildPath } from '@parlante/shared';
import type { RouteDef } from '@parlante/shared';
import { createDb } from '@parlante/db';
import { createProviders } from '@parlante/providers';
import { loadConfig } from '../../config';
import {
  ATTACKER_MARKER,
  bodyCases,
  listRoutes,
  pathCases,
  routeId,
  seedVictim,
  victimFingerprint,
  victimSecrets,
} from '../isolation-matrix';
import type { AttackCase } from '../isolation-matrix';

/* -------------------------------------------------------------------------------------------
 * The isolation matrix of `isolation.test.ts`, run OVER HTTP against a live API:
 *
 *   LIVE_API_URL=http://127.0.0.1:4000 pnpm --filter @parlante/api exec tsx src/security/scripts/live-isolation.ts
 *
 * It needs the same DATABASE_URL / storage settings as that API (it seeds the victim's rows and
 * files directly) and registers two throw-away accounts (`e2e-…@example.test`). Use it on a
 * development or staging stack, never on production data. Exit code 1 = at least one leak.
 * ----------------------------------------------------------------------------------------- */

const base = (process.env.LIVE_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const config = loadConfig();
const origin = config.PUBLIC_WEB_URL.replace(/\/+$/, '');

interface Credentials {
  cookie?: string;
  apiKey?: string;
}

async function call(
  route: RouteDef,
  options: {
    as?: Credentials;
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; text: string; json: unknown; setCookie: string | null }> {
  const headers: Record<string, string> = {};
  if (options.as?.cookie) headers.cookie = options.as.cookie;
  if (options.as?.apiKey) headers.authorization = `Bearer ${options.as.apiKey}`;
  if (route.method !== 'GET' && route.auth !== 'apiKey') headers.origin = origin;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const res = await fetch(`${base}${buildPath(route.path, options.params, options.query)}`, {
    method: route.method,
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, setCookie: res.headers.get('set-cookie') };
}

async function register(label: string) {
  const email = `e2e-${label}-${randomBytes(5).toString('hex')}@example.test`;
  const res = await call(api.auth.register, {
    body: { email, password: `Pw-${randomBytes(12).toString('hex')}`, name: `E2E ${label}` },
  });
  if (res.status !== 201 || !res.setCookie)
    throw new Error(`register failed: ${res.status} ${res.text}`);
  const session = res.json as { user: { id: string }; currentWorkspaceId: string };
  return {
    cookie: res.setCookie.split(';')[0] as string,
    userId: session.user.id,
    workspaceId: session.currentWorkspaceId,
  };
}

async function main(): Promise<void> {
  const handle = createDb(config.DATABASE_URL, { applicationName: 'parlante-live-isolation' });
  const storage = createProviders(config).storage;
  const problems: string[] = [];
  let requests = 0;
  const run = async (
    attackCase: AttackCase,
    as: Credentials | undefined,
    allowed: readonly number[],
    label: string,
  ) => {
    const res = await call(attackCase.route, {
      as,
      params: attackCase.params,
      query: attackCase.query,
      body: attackCase.body,
    });
    requests += 1;
    if (!allowed.includes(res.status)) {
      problems.push(
        `[${label}] ${attackCase.id}${attackCase.note ? ` (${attackCase.note})` : ''} → ${res.status} ${res.text.slice(0, 200)}`,
      );
    }
  };
  try {
    const alice = await register('victim');
    const bob = await register('attacker');
    const key = await call(api.apiKeys.create, { as: bob, body: { name: 'live isolation' } });
    if (key.status !== 201) throw new Error(`api key: ${key.status} ${key.text}`);
    const bobKey: Credentials = { apiKey: (key.json as { key: string }).key };

    const victim = await seedVictim(handle.db, storage, alice, config.APP_SECRET);
    const attacker = await seedVictim(handle.db, storage, bob, config.APP_SECRET, ATTACKER_MARKER);
    const ping = await call(api.system.pingWorker, { as: alice, body: {} });
    if (ping.status !== 202) throw new Error(`ping: ${ping.status} ${ping.text}`);
    const pingJobId = (ping.json as { jobId: string }).jobId;
    const before = await victimFingerprint(handle.db, victim);

    const cases = pathCases(victim, { brandKitId: attacker.brandKitId }, { pingJobId });
    for (const attackCase of cases) {
      const isKey = attackCase.route.auth === 'apiKey';
      await run(attackCase, isKey ? bobKey : bob, [404], isKey ? 'api key' : 'session');
      await run(attackCase, undefined, [401], 'anonymous');
      await run(attackCase, isKey ? bob : bobKey, [401], 'wrong credential');
    }
    const bodies = bodyCases(victim, {
      videoId: attacker.draftVideoId,
      imageAssetId: attacker.imageAssetId,
      audioAssetId: attacker.audioAssetId,
      photoConsentId: attacker.unusedConsentId,
      voiceConsentId: attacker.unusedVoiceConsentId,
    });
    for (const attackCase of bodies) {
      await run(
        attackCase,
        attackCase.route.auth === 'apiKey' ? bobKey : bob,
        attackCase.expect ?? [404],
        'body',
      );
    }
    const secrets = victimSecrets(victim);
    for (const route of listRoutes()) {
      const res = await call(route, { as: route.auth === 'apiKey' ? bobKey : bob });
      requests += 1;
      if (res.status !== 200) problems.push(`[list] ${routeId(route)} → ${res.status}`);
      for (const secret of secrets) {
        if (res.text.includes(secret)) problems.push(`[list] ${routeId(route)} leaks ${secret}`);
      }
      if (res.text.includes(`ws/${victim.workspaceId}/`)) {
        problems.push(`[list] ${routeId(route)} leaks a file URL of the victim`);
      }
    }
    if ((await victimFingerprint(handle.db, victim)) !== before) {
      problems.push('the rows of the victim changed during the attack');
    }
    for (const fileKey of victim.fileKeys) {
      if (!(await storage.exists(fileKey))) problems.push(`victim file deleted: ${fileKey}`);
    }
    console.log(
      `live isolation against ${base}: ${cases.length} path routes × 3 actors, ${bodies.length} body cases, ${listRoutes().length} lists, ${requests} requests, ${problems.length} problems`,
    );
    for (const problem of problems) console.log(`  LEAK ${problem}`);
  } finally {
    await handle.close();
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});
