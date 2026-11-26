import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
/** The Drizzle database handle used everywhere. */
export type Db = NodePgDatabase<Schema>;
/** Transaction handle (same query API as Db). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Accept either: lets service functions run standalone or inside a caller's transaction. */
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Max pool size (default 10). */
  max?: number;
  applicationName?: string;
}

/** Create a pooled connection. Call `close()` on shutdown. */
export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'parlante',
  });
  // An idle client erroring (server restart) must not crash the process.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
