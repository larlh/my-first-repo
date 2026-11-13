import { z } from 'zod';

/**
 * Cursor pagination used by every list endpoint.
 * - Request: `?limit=20&cursor=<opaque>`
 * - Response: `{ items: [...], nextCursor: string | null }`
 * The cursor is opaque to clients. Server side it encodes `(createdAt, id)` of the last item
 * (see `encodeCursor`/`decodeCursor`); lists are ordered by `createdAt DESC, id DESC`.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorPosition {
  /** ISO timestamp of the last item of the page. */
  createdAt: string;
  id: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(pos: CursorPosition): string {
  return toBase64Url(JSON.stringify([pos.createdAt, pos.id]));
}

/** Returns null when the cursor is malformed (treat as VALIDATION_ERROR). */
export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(cursor));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      !Number.isNaN(Date.parse(parsed[0]))
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a page from `limit + 1` fetched rows.
 * Usage: fetch `limit + 1` rows ordered by (createdAt DESC, id DESC), then call this.
 */
export function buildPage<T extends { id: string; createdAt: Date | string }>(
  rows: T[],
  limit: number,
): Paginated<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = rows.length > limit;
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({
            createdAt:
              last.createdAt instanceof Date ? last.createdAt.toISOString() : last.createdAt,
            id: last.id,
          })
        : null,
  };
}
