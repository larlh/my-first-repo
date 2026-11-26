import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** Absolute path of the generated SQL migrations (packages/db/drizzle). */
export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../drizzle',
);

/** Apply all pending migrations to the database at `connectionString`. Idempotent. */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, { max: 1, applicationName: 'parlante-migrate' });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}
