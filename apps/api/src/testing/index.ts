import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildPath } from '@parlante/shared';
import type {
  ApiErrorBody,
  PlanId,
  Role,
  RouteBodyInput,
  RouteDef,
  RouteParamsInput,
  RouteQueryInput,
  RouteResponse,
} from '@parlante/shared';
import type { Db, DbHandle, MemberRow, UserRow, WorkspaceRow } from '@parlante/db';
import { connectTestDb, resetDatabase, seedAccount, seedMember } from '@parlante/db/testing';
import { InMemoryQueueClient } from '@parlante/jobs';
import { buildApp } from '../app';
import type { BuildAppOptions } from '../app';
import { loadConfig } from '../config';
import type { ApiConfig } from '../config';
import { createApiKey, createSession } from '../lib/auth';

/* -------------------------------------------------------------------------------------------
 * Integration-test harness: the real Fastify app (`app.inject`, no network) on the per-run
 * test database, with an in-memory queue and a temp storage directory.
 *
 *   const t = await createTestApp();                       // in beforeAll
 *   beforeEach(() => t.reset());                           // empty DB, queue and storage
 *   afterAll(() => t.close());
 *
 *   const alice = await t.signUp();                        // user + workspace + session cookie
 *   const res = await t.call(api.videos.create, { as: alice, body: { title: 'Demo' } });
 *   expect(res.status).toBe(201);  res.body  // typed as the route's response
 * ----------------------------------------------------------------------------------------- */

export interface TestActor {
  user: UserRow;
  workspace: WorkspaceRow;
  member: MemberRow;
  role: Role;
  /** `Cookie` header value of a live session. */
  cookie: string;
  password: string;
}

export interface TestApiKeyActor {
  workspace: WorkspaceRow;
  /** Plain API key (`plk_…`). */
  apiKey: string;
  apiKeyId: string;
}

export interface CallOptions<R extends RouteDef> {
  /** Authenticate as this actor (session cookie or API key). */
  as?: TestActor | TestApiKeyActor;
  params?: RouteParamsInput<R>;
  query?: RouteQueryInput<R>;
  /** JSON body. Use `multipart` for uploads. */
  body?: RouteBodyInput<R> | Record<string, unknown>;
  /** Multipart upload: file bytes + optional text fields. */
  multipart?: {
    field?: string;
    filename: string;
    contentType?: string;
    data: Buffer;
    fields?: Record<string, string>;
  };
  headers?: Record<string, string>;
}

export interface CallResult<R extends RouteDef> {
  status: number;
  /** Parsed JSON body: the route response on success, the error body otherwise. */
  body: RouteResponse<R>;
  /** Same body typed as an error (`error.code`, `error.message`). */
  error: ApiErrorBody['error'];
  headers: LightMyRequestResponse['headers'];
  raw: LightMyRequestResponse;
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: ApiConfig;
  queues: InMemoryQueueClient;
  storageDir: string;
  /** Empty the database, the queue and the storage directory. Call in `beforeEach`. */
  reset(): Promise<void>;
  close(): Promise<void>;
  /** Create a user with a personal workspace (owner) and a session. */
  signUp(options?: {
    email?: string;
    name?: string;
    plan?: PlanId;
    credits?: number;
  }): Promise<TestActor>;
  /** Add a new user with `role` to an existing workspace, with a session on it. */
  addMember(workspace: WorkspaceRow, role: Role): Promise<TestActor>;
  /** Create an API key for a workspace. */
  apiKeyFor(workspace: WorkspaceRow, name?: string): Promise<TestApiKeyActor>;
  /** Call a contract route with typed params / query / body and a typed response. */
  call<R extends RouteDef>(route: R, options?: CallOptions<R>): Promise<CallResult<R>>;
  /** Raw `app.inject` for anything not covered by `call`. */
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
}

function multipartBody(input: NonNullable<CallOptions<RouteDef>['multipart']>): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = `----parlante-test-${Date.now().toString(16)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${input.field ?? 'file'}"; filename="${input.filename}"\r\nContent-Type: ${input.contentType ?? 'application/octet-stream'}\r\n\r\n`,
    ),
    input.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

export async function createTestApp(
  options: Omit<BuildAppOptions, 'db' | 'queues' | 'config'> & {
    /** Extra environment for this app (e.g. `{ ANTHROPIC_API_KEY: 'x' }`). */
    env?: Record<string, string>;
  } = {},
): Promise<TestApp> {
  const handle: DbHandle = connectTestDb();
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-api-test-'));
  const queues = new InMemoryQueueClient();
  const { env, ...buildOptions } = options;
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.DATABASE_URL,
    APP_SECRET: 'test-app-secret-test-app-secret-0123456789',
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: storageDir,
    UPLOAD_TMP_DIR: path.join(storageDir, '_uploads'),
    PUBLIC_API_URL: 'http://api.test',
    PUBLIC_WEB_URL: 'http://web.test',
    WEB_ORIGIN: 'http://web.test',
    RATE_LIMIT_ENABLED: 'false',
    ...env,
  });
  const app = await buildApp({ ...buildOptions, config, db: handle.db, queues });
  await app.ready();

  const sessionActor = async (
    user: UserRow,
    workspace: WorkspaceRow,
    member: MemberRow,
    password: string,
  ): Promise<TestActor> => {
    const { token } = await createSession(handle.db, config, {
      userId: user.id,
      workspaceId: workspace.id,
    });
    return {
      user,
      workspace,
      member,
      role: member.role,
      cookie: `${config.SESSION_COOKIE_NAME}=${token}`,
      password,
    };
  };

  const t: TestApp = {
    app,
    db: handle.db,
    config,
    queues,
    storageDir,
    async reset() {
      await resetDatabase(handle.db);
      queues.clear();
      await fs.rm(storageDir, { recursive: true, force: true });
      await fs.mkdir(storageDir, { recursive: true });
    },
    async close() {
      await app.close();
      await handle.close();
      await fs.rm(storageDir, { recursive: true, force: true });
    },
    async signUp(signUpOptions = {}) {
      const account = await seedAccount(handle.db, signUpOptions);
      return sessionActor(account.user, account.workspace, account.member, account.password);
    },
    async addMember(workspace, role) {
      const seeded = await seedMember(handle.db, workspace.id, role);
      return sessionActor(seeded.user, workspace, seeded.member, seeded.password);
    },
    async apiKeyFor(workspace, name = 'test key') {
      const { row, key } = await createApiKey(handle.db, {
        workspaceId: workspace.id,
        name,
        createdBy: null,
      });
      return { workspace, apiKey: key, apiKeyId: row.id };
    },
    async call(route, callOptions = {}) {
      const headers: Record<string, string> = { ...(callOptions.headers ?? {}) };
      if (callOptions.as) {
        if ('cookie' in callOptions.as) headers.cookie = callOptions.as.cookie;
        else headers.authorization = `Bearer ${callOptions.as.apiKey}`;
      }
      const url = buildPath(
        route.path,
        callOptions.params as Record<string, string | number> | undefined,
        callOptions.query as Record<string, unknown> | undefined,
      );
      const injectOptions: InjectOptions = { method: route.method, url, headers };
      if (callOptions.multipart) {
        const { payload, contentType } = multipartBody(callOptions.multipart);
        injectOptions.payload = payload;
        headers['content-type'] = contentType;
      } else if (callOptions.body !== undefined) {
        injectOptions.payload = callOptions.body as Record<string, unknown>;
      }
      const raw = await app.inject(injectOptions);
      let parsed: unknown = null;
      const type = String(raw.headers['content-type'] ?? '');
      if (type.includes('application/json') && raw.body !== '') parsed = raw.json();
      return {
        status: raw.statusCode,
        body: parsed as RouteResponse<typeof route>,
        error: ((parsed as ApiErrorBody | null)?.error ?? {
          code: 'INTERNAL',
          message: '',
        }) as ApiErrorBody['error'],
        headers: raw.headers,
        raw,
      };
    },
    inject: (injectOptions) => app.inject(injectOptions),
  };
  return t;
}
