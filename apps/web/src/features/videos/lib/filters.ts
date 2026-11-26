import { VIDEO_STATUSES, idOf } from '@parlante/shared';
import type { VideoStatus } from '@parlante/shared';

/* The list filters live in the URL (`/videos?q=…&status=…`) so a filtered view can be linked,
 * reloaded and reached with the back button. Everything here is pure. */

export type StatusFilter = VideoStatus | 'all';
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...VIDEO_STATUSES];

export interface VideoFilters {
  /** Free-text search on the title. */
  q: string;
  status: StatusFilter;
  /** Only videos produced by one batch job (linked from the batch screen). */
  batchJobId: string | null;
}

export const EMPTY_FILTERS: VideoFilters = { q: '', status: 'all', batchJobId: null };
export const PAGE_SIZE = 12;
/** Same limit as the API (`q` is at most 100 characters). */
export const MAX_QUERY_LENGTH = 100;

const BatchJobId = idOf('batchJob');

function isStatus(value: string | null): value is VideoStatus {
  return value !== null && (VIDEO_STATUSES as readonly string[]).includes(value);
}

/** Read filters from the query string; anything unknown falls back to the default. */
export function parseFilters(params: URLSearchParams): VideoFilters {
  const status = params.get('status');
  const batch = params.get('batchJobId');
  return {
    q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH),
    status: isStatus(status) ? status : 'all',
    batchJobId: batch !== null && BatchJobId.safeParse(batch).success ? batch : null,
  };
}

/** Query string for a set of filters; defaults are left out so the plain list stays `/videos`. */
export function filtersToParams(filters: VideoFilters): URLSearchParams {
  const params = new URLSearchParams();
  const q = filters.q.trim().slice(0, MAX_QUERY_LENGTH);
  if (q !== '') params.set('q', q);
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.batchJobId) params.set('batchJobId', filters.batchJobId);
  return params;
}

/** Query of `GET /api/videos` for a set of filters (without the cursor). */
export function filtersToQuery(
  filters: VideoFilters,
  limit: number = PAGE_SIZE,
): { limit: number; q?: string; status?: VideoStatus; batchJobId?: string } {
  const q = filters.q.trim().slice(0, MAX_QUERY_LENGTH);
  return {
    limit,
    ...(q !== '' ? { q } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.batchJobId ? { batchJobId: filters.batchJobId } : {}),
  };
}

export function hasActiveFilters(filters: VideoFilters): boolean {
  return filters.q.trim() !== '' || filters.status !== 'all' || filters.batchJobId !== null;
}
