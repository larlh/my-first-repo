import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { hashPassword } from '@parlante/shared/node';
import type { PlanId, Role } from '@parlante/shared';
import { newId } from '@parlante/shared';
import { createUserWithWorkspace } from '../accounts';
import { createDb } from '../client';
import type { Db, DbHandle } from '../client';
import { runMigrations } from '../migrate';
import { members, users } from '../schema';
import type { MemberRow, UserRow, WorkspaceRow } from '../schema';

/* -------------------------------------------------------------------------------------------
 * Test database utilities.
 *
 * Isolation model: EVERY vitest run gets its own freshly migrated database
 * (`parlante_test_<random>`), created in globalSetup and dropped in teardown. Several agents /
 * terminals can therefore run test suites at the same time without touching each other's data.
 * Inside one run, test files share that database: run files sequentially
 * (`fileParallelism: false`) and call `resetDatabase(db)` in `beforeEach`.
 * ----------------------------------------------------------------------------------------- */

export const TEST_DB_PREFIX = 'parlante_test_';
const DEFAULT_ADMIN_URL = 'postgres://parlante:parlante@localhost:5432/parlante_test';

/** Maintenance connection used to CREATE/DROP per-run databases (role needs CREATEDB). */
export function testAdminUrl(): string {
  return process.env.DATABASE_TEST_URL ?? DEFAULT_ADMIN_URL;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function adminQuery(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: testAdminUrl() });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

/** Create and migrate a throw-away database. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `${TEST_DB_PREFIX}${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  // `name` is generated above from [a-z0-9_] only, so it is safe to inline as an identifier.
  await adminQuery(`CREATE DATABASE "${name}"`);
  const url = withDatabase(testAdminUrl(), name);
  try {
    await runMigrations(url);
  } catch (err) {
    await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    throw err;
  }
  return {
    name,
    url,
    drop: async () => {
      // Give test workers a moment to close their pools: a plain DROP fails while connections
      // are open, and FORCE would kill them mid-flight (noisy "terminating connection" errors).
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await adminQuery(`DROP DATABASE IF EXISTS "${name}"`);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      await adminQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

/**
 * Drop per-run databases left behind by crashed test runs. Only databases older than
 * `olderThanMs` (default 1 h) are removed so concurrent runs are not disturbed.
 */
export async function dropStaleTestDatabases(olderThanMs = 3_600_000): Promise<string[]> {
  const client = new pg.Client({ connectionString: testAdminUrl() });
  await client.connect();
  const dropped: string[] = [];
  try {
    const res = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${TEST_DB_PREFIX}%`],
    );
    for (const row of res.rows) {
      const stamp = parseInt(row.datname.slice(TEST_DB_PREFIX.length).split('_')[0] ?? '', 36);
      if (!Number.isFinite(stamp) || Date.now() - stamp < olderThanMs) continue;
      if (!/^[a-z0-9_]+$/.test(row.datname)) continue;
      await client.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
      dropped.push(row.datname);
    }
  } finally {
    await client.end();
  }
  return dropped;
}

/**
 * vitest `globalSetup` implementation. In a package's `vitest.config.ts`:
 *
 *   test: { globalSetup: ['@parlante/db/testing/global-setup'], fileParallelism: false }
 *
 * It creates the per-run database, exports its URL as `process.env.DATABASE_URL` (inherited by
 * the test workers) and drops it afterwards.
 */
export async function setupTestDatabase(): Promise<() => Promise<void>> {
  const database = await createTestDatabase();
  process.env.DATABASE_URL = database.url;
  process.env.PARLANTE_TEST_DATABASE = database.name;
  return async () => {
    await database.drop();
  };
}

/** Connect to the per-run database from a test file. Remember to `close()` in afterAll. */
export function connectTestDb(): DbHandle {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PARLANTE_TEST_DATABASE || !url.includes(TEST_DB_PREFIX)) {
    throw new Error(
      'connectTestDb(): no per-run test database. Add the db globalSetup to vitest.config.ts.',
    );
  }
  return createDb(url, { max: 4, applicationName: 'parlante-test' });
}

/** Delete all rows from every table (keeps the schema). Call in `beforeEach`. */
export async function resetDatabase(db: Db): Promise<void> {
  const result = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = result.rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length === 0) return;
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`));
}

/* ---------- fixtures ---------- */

let cachedHash: Promise<string> | null = null;
export const TEST_PASSWORD = 'test-password-123';
/** scrypt is slow on purpose: hash the shared test password once per process. */
export function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  return cachedHash;
}

export interface SeededAccount {
  user: UserRow;
  workspace: WorkspaceRow;
  member: MemberRow;
  password: string;
}

/** Insert a user with a personal workspace (owner). Password is TEST_PASSWORD. */
export async function seedAccount(
  db: Db,
  overrides: { email?: string; name?: string; plan?: PlanId; credits?: number } = {},
): Promise<SeededAccount> {
  const unique = randomBytes(4).toString('hex');
  const account = await createUserWithWorkspace(db, {
    email: overrides.email ?? `user-${unique}@example.test`,
    name: overrides.name ?? `User ${unique}`,
    passwordHash: await testPasswordHash(),
    plan: overrides.plan,
    credits: overrides.credits,
  });
  return { ...account, password: TEST_PASSWORD };
}

/** Add another user to an existing workspace with the given role. */
export async function seedMember(
  db: Db,
  workspaceId: string,
  role: Role,
  overrides: { email?: string; name?: string } = {},
): Promise<{ user: UserRow; member: MemberRow; password: string }> {
  const unique = randomBytes(4).toString('hex');
  const [user] = await db
    .insert(users)
    .values({
      id: newId('user'),
      email: overrides.email ?? `member-${unique}@example.test`,
      name: overrides.name ?? `Member ${unique}`,
      passwordHash: await testPasswordHash(),
    })
    .returning();
  if (!user) throw new Error('Failed to seed user');
  const [member] = await db
    .insert(members)
    .values({ id: newId('member'), workspaceId, userId: user.id, role })
    .returning();
  if (!member) throw new Error('Failed to seed member');
  return { user, member, password: TEST_PASSWORD };
}
