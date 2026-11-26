import { AssetSchema } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { isFinished, nextToStart, summarize, uploadReducer } from './uploadQueue';
import type { NewUpload, UploadItem } from './uploadQueue';

const asset = AssetSchema.parse({
  id: 'ast_0001abcdefgh1234',
  workspaceId: 'ws_a1b2c3d4e5f6g7h8',
  kind: 'image',
  name: 'uno',
  mimeType: 'image/png',
  sizeBytes: 100,
  width: 10,
  height: 10,
  durationMs: null,
  url: 'http://localhost:4000/api/files/x.png?exp=1&sig=abcdefghijklmnopq',
  thumbnailUrl: null,
  createdBy: null,
  createdAt: '2026-11-20T10:00:00.000Z',
});

const upload = (id: string, extra: Partial<NewUpload> = {}): NewUpload => ({
  id,
  name: id,
  fileName: `${id}.png`,
  sizeBytes: 100,
  kind: 'image',
  rejection: null,
  ...extra,
});

function queue(...ids: string[]): UploadItem[] {
  return uploadReducer([], { type: 'add', items: ids.map((id) => upload(id)) });
}

describe('uploadReducer', () => {
  it('queues accepted files and lists rejected ones with their reason', () => {
    const items = uploadReducer([], {
      type: 'add',
      items: [upload('a'), upload('b', { kind: null, rejection: 'type' })],
    });
    expect(items.map((item) => [item.id, item.status, item.rejection])).toEqual([
      ['a', 'queued', null],
      ['b', 'rejected', 'type'],
    ]);
  });

  it('walks queued → uploading → done and keeps progress monotonic', () => {
    let items = queue('a');
    items = uploadReducer(items, { type: 'start', id: 'a' });
    items = uploadReducer(items, { type: 'progress', id: 'a', fraction: 0.6 });
    items = uploadReducer(items, { type: 'progress', id: 'a', fraction: 0.4 });
    expect(items[0]).toMatchObject({ status: 'uploading', progress: 0.6 });
    items = uploadReducer(items, { type: 'done', id: 'a', asset });
    expect(items[0]).toMatchObject({ status: 'done', progress: 1, asset });
  });

  it('records failures and lets them be retried from scratch', () => {
    let items = queue('a');
    items = uploadReducer(items, { type: 'start', id: 'a' });
    items = uploadReducer(items, { type: 'progress', id: 'a', fraction: 0.9 });
    items = uploadReducer(items, {
      type: 'fail',
      id: 'a',
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Not an image',
    });
    expect(items[0]).toMatchObject({
      status: 'error',
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Not an image' },
    });
    items = uploadReducer(items, { type: 'retry', id: 'a' });
    expect(items[0]).toMatchObject({ status: 'queued', progress: 0, error: null });
  });

  it('ignores late events of a cancelled upload', () => {
    let items = queue('a');
    items = uploadReducer(items, { type: 'start', id: 'a' });
    items = uploadReducer(items, { type: 'cancel', id: 'a' });
    items = uploadReducer(items, { type: 'progress', id: 'a', fraction: 1 });
    items = uploadReducer(items, { type: 'done', id: 'a', asset });
    items = uploadReducer(items, { type: 'fail', id: 'a', code: 'INTERNAL', message: 'late' });
    expect(items[0]).toMatchObject({ status: 'canceled', asset: null, error: null });
  });

  it('dismisses and clears only finished rows', () => {
    let items = queue('a', 'b', 'c');
    items = uploadReducer(items, { type: 'start', id: 'a' });
    items = uploadReducer(items, { type: 'done', id: 'a', asset });
    items = uploadReducer(items, { type: 'start', id: 'b' });
    // An upload in flight cannot be dismissed, only cancelled.
    expect(uploadReducer(items, { type: 'dismiss', id: 'b' })).toHaveLength(3);
    expect(uploadReducer(items, { type: 'dismiss', id: 'a' }).map((i) => i.id)).toEqual(['b', 'c']);
    expect(uploadReducer(items, { type: 'clearFinished' }).map((i) => i.id)).toEqual(['b', 'c']);
    expect(isFinished('done')).toBe(true);
    expect(isFinished('uploading')).toBe(false);
  });
});

describe('scheduling and summary', () => {
  it('starts uploads in order up to the concurrency limit', () => {
    let items = queue('a', 'b', 'c');
    expect(nextToStart(items, 2)).toEqual(['a', 'b']);
    items = uploadReducer(items, { type: 'start', id: 'a' });
    expect(nextToStart(items, 2)).toEqual(['b']);
    items = uploadReducer(items, { type: 'start', id: 'b' });
    expect(nextToStart(items, 2)).toEqual([]);
    items = uploadReducer(items, { type: 'done', id: 'a', asset });
    expect(nextToStart(items, 2)).toEqual(['c']);
  });

  it('weights overall progress by bytes and leaves rejected files out', () => {
    let items = uploadReducer([], {
      type: 'add',
      items: [
        upload('big', { sizeBytes: 900 }),
        upload('small', { sizeBytes: 100 }),
        upload('bad', { sizeBytes: 5000, rejection: 'size' }),
      ],
    });
    items = uploadReducer(items, { type: 'start', id: 'big' });
    items = uploadReducer(items, { type: 'progress', id: 'big', fraction: 0.5 });
    items = uploadReducer(items, { type: 'start', id: 'small' });
    items = uploadReducer(items, { type: 'done', id: 'small', asset });
    expect(summarize(items)).toEqual({
      total: 3,
      active: 1,
      done: 1,
      failed: 0,
      rejected: 1,
      percent: 55,
    });
    expect(summarize([]).percent).toBe(0);
  });
});
