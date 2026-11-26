import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { AppError, decodeCursor } from '@parlante/shared';

/**
 * Keyset pagination helpers matching the shared cursor format (createdAt DESC, id DESC).
 *
 *   const rows = await db.select().from(videos)
 *     .where(and(eq(videos.workspaceId, ws), cursorWhere(videos.createdAt, videos.id, q.cursor)))
 *     .orderBy(...cursorOrder(videos.createdAt, videos.id))
 *     .limit(q.limit + 1);
 *   return buildPage(rows, q.limit);   // from @parlante/shared
 */
export function cursorWhere(
  createdAtColumn: PgColumn,
  idColumn: PgColumn,
  cursor: string | undefined,
): SQL | undefined {
  if (!cursor) return undefined;
  const pos = decodeCursor(cursor);
  if (!pos) throw AppError.validation('Invalid cursor', [{ path: 'cursor', message: 'Invalid' }]);
  const at = new Date(pos.createdAt);
  return or(lt(createdAtColumn, at), and(eq(createdAtColumn, at), lt(idColumn, pos.id)));
}

export function cursorOrder(createdAtColumn: PgColumn, idColumn: PgColumn): [SQL, SQL] {
  return [desc(createdAtColumn), desc(idColumn)];
}
