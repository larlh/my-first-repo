export * from './client';
export * from './schema';
export * as schema from './schema';
export * from './migrate';
export * from './pagination';
export * from './credits';
export * from './accounts';

/**
 * Drizzle query helpers (eq, and, or, sql, desc, inArray, isNull, count…) are re-exported here
 * ON PURPOSE: import them from '@parlante/db', never from 'drizzle-orm' directly. Other
 * packages do not depend on drizzle-orm, which guarantees a single copy of its types (two
 * copies make every query fail to typecheck).
 */
export * from 'drizzle-orm';
