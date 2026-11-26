import type { Asset, AssetKind } from '@parlante/shared';
import type { RejectReason } from './files';

/* State machine of the upload queue (pure; the hook in useUploadQueue.ts runs the requests).
 *
 *   queued ──► uploading ──► done
 *     │            ├──────► error ──(retry)──► queued
 *     └────────────┴──────► canceled
 *   rejected: failed the browser-side check and was never sent.
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'canceled' | 'rejected';

export interface UploadItem {
  id: string;
  /** Display name sent to the API. */
  name: string;
  fileName: string;
  sizeBytes: number;
  kind: AssetKind | null;
  status: UploadStatus;
  /** 0..1 of the bytes sent. 1 while the server is still processing the file. */
  progress: number;
  /** Why the browser check refused it (status `rejected`). */
  rejection: RejectReason | null;
  /** Error code + message of a failed upload (status `error`). */
  error: { code: string; message: string } | null;
  asset: Asset | null;
}

export interface NewUpload {
  id: string;
  name: string;
  fileName: string;
  sizeBytes: number;
  kind: AssetKind | null;
  rejection: RejectReason | null;
}

export type UploadAction =
  | { type: 'add'; items: NewUpload[] }
  | { type: 'start'; id: string }
  | { type: 'progress'; id: string; fraction: number }
  | { type: 'done'; id: string; asset: Asset }
  | { type: 'fail'; id: string; code: string; message: string }
  | { type: 'cancel'; id: string }
  | { type: 'retry'; id: string }
  | { type: 'dismiss'; id: string }
  | { type: 'clearFinished' };

const FINISHED: readonly UploadStatus[] = ['done', 'error', 'canceled', 'rejected'];

export function isFinished(status: UploadStatus): boolean {
  return FINISHED.includes(status);
}

function patch(items: UploadItem[], id: string, change: (item: UploadItem) => UploadItem) {
  return items.map((item) => (item.id === id ? change(item) : item));
}

export function uploadReducer(items: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case 'add':
      return [
        ...items,
        ...action.items.map((item): UploadItem => ({
          ...item,
          status: item.rejection ? 'rejected' : 'queued',
          progress: 0,
          error: null,
          asset: null,
        })),
      ];
    case 'start':
      return patch(items, action.id, (item) =>
        item.status === 'queued' ? { ...item, status: 'uploading', progress: 0 } : item,
      );
    case 'progress':
      return patch(items, action.id, (item) =>
        item.status === 'uploading'
          ? { ...item, progress: Math.min(1, Math.max(item.progress, action.fraction)) }
          : item,
      );
    case 'done':
      return patch(items, action.id, (item) =>
        item.status === 'uploading'
          ? { ...item, status: 'done', progress: 1, asset: action.asset }
          : item,
      );
    case 'fail':
      return patch(items, action.id, (item) =>
        item.status === 'uploading'
          ? {
              ...item,
              status: 'error',
              error: { code: action.code, message: action.message },
            }
          : item,
      );
    case 'cancel':
      return patch(items, action.id, (item) =>
        item.status === 'queued' || item.status === 'uploading'
          ? { ...item, status: 'canceled' }
          : item,
      );
    case 'retry':
      return patch(items, action.id, (item) =>
        item.status === 'error' || item.status === 'canceled'
          ? { ...item, status: 'queued', progress: 0, error: null }
          : item,
      );
    case 'dismiss':
      return items.filter((item) => item.id !== action.id || !isFinished(item.status));
    case 'clearFinished':
      return items.filter((item) => !isFinished(item.status));
    default:
      return items;
  }
}

/** Ids to start now so that at most `concurrency` uploads run at once (queue order). */
export function nextToStart(items: readonly UploadItem[], concurrency: number): string[] {
  const running = items.filter((item) => item.status === 'uploading').length;
  const free = Math.max(0, concurrency - running);
  return items
    .filter((item) => item.status === 'queued')
    .slice(0, free)
    .map((item) => item.id);
}

export interface QueueSummary {
  total: number;
  active: number;
  done: number;
  failed: number;
  rejected: number;
  /** 0..100 over the bytes of everything that was actually queued. */
  percent: number;
}

export function summarize(items: readonly UploadItem[]): QueueSummary {
  const sent = items.filter((item) => item.status !== 'rejected' && item.status !== 'canceled');
  const bytes = sent.reduce((sum, item) => sum + item.sizeBytes, 0);
  const loaded = sent.reduce(
    (sum, item) => sum + item.sizeBytes * (item.status === 'done' ? 1 : item.progress),
    0,
  );
  return {
    total: items.length,
    active: items.filter((item) => item.status === 'queued' || item.status === 'uploading').length,
    done: items.filter((item) => item.status === 'done').length,
    failed: items.filter((item) => item.status === 'error').length,
    rejected: items.filter((item) => item.status === 'rejected').length,
    percent: bytes > 0 ? Math.round((loaded / bytes) * 100) : 0,
  };
}
