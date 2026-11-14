import { randomBytes } from 'node:crypto';
import {
  batchItems,
  batchJobs,
  eq,
  videos,
  webhookDeliveries,
  webhookEndpoints,
} from '@parlante/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublicVideoSchema, WebhookEventSchema, createComposition, newId } from '@parlante/shared';
import type { StorageProvider } from '@parlante/shared';
import { encryptSecret, verifyFileAccess } from '@parlante/shared/node';
import type { DbHandle } from '@parlante/db';
import { connectTestDb, resetDatabase, seedAccount } from '@parlante/db/testing';
import {
  BullQueueClient,
  InMemoryQueueClient,
  createFileUrlBuilder,
  dispatchWebhookEvent,
  notifyVideoFinished,
} from './index';

const SECRET = 'jobs-test-secret-jobs-test-secret-1234';
const localStorageStub = { signedUrl: async () => null } as unknown as StorageProvider;
const fileUrl = createFileUrlBuilder({
  storage: localStorageStub,
  appSecret: SECRET,
  publicApiUrl: 'http://api.test/',
});

let handle: DbHandle;
let queues: InMemoryQueueClient;

beforeAll(() => {
  handle = connectTestDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDatabase(handle.db);
  queues = new InMemoryQueueClient();
});

async function seedEndpoint(
  workspaceId: string,
  events: ('video.completed' | 'video.failed' | 'ping')[],
  enabled = true,
) {
  const [row] = await handle.db
    .insert(webhookEndpoints)
    .values({
      id: newId('webhookEndpoint'),
      workspaceId,
      url: 'https://hooks.example.test/in',
      events,
      enabled,
      secretEncrypted: encryptSecret(SECRET, 'whsec_test'),
      secretPreview: 'test',
    })
    .returning();
  if (!row) throw new Error('seed');
  return row;
}

async function seedVideo(workspaceId: string, overrides: Partial<typeof videos.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(videos)
    .values({
      id: newId('video'),
      workspaceId,
      title: 'Demo',
      composition: createComposition(),
      aspect: '16:9',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seed');
  return row;
}

describe('file URLs', () => {
  it('builds absolute signed API URLs for local storage and passes nulls through', async () => {
    const key = 'ws/ws_a/videos/vid_b/rnd_c/video.mp4';
    const url = new URL(await fileUrl(key, { downloadName: 'demo.mp4' }));
    expect(url.origin).toBe('http://api.test');
    expect(url.pathname).toBe(`/api/files/${key}`);
    expect(url.searchParams.get('download')).toBe('demo.mp4');
    expect(
      verifyFileAccess(
        SECRET,
        key,
        Number(url.searchParams.get('exp')),
        url.searchParams.get('sig') ?? '',
      ),
    ).toBe(true);
    expect(await fileUrl(null)).toBeNull();
  });

  it('prefers provider-signed URLs for remote storage', async () => {
    const remote = createFileUrlBuilder({
      storage: {
        signedUrl: async (key: string) => `https://cdn.test/${key}?sig=1`,
      } as unknown as StorageProvider,
      appSecret: SECRET,
      publicApiUrl: 'http://api.test',
    });
    expect(await remote('cache/tts/a.wav')).toBe('https://cdn.test/cache/tts/a.wav?sig=1');
  });
});

describe('InMemoryQueueClient', () => {
  it('validates payloads, records jobs and replaces duplicates by job id', async () => {
    const payload = {
      renderJobId: newId('renderJob'),
      videoId: newId('video'),
      workspaceId: newId('workspace'),
    };
    await queues.enqueue('render', payload, { jobId: payload.renderJobId });
    await queues.enqueue('render', payload, { jobId: payload.renderJobId });
    expect(queues.jobs('render')).toEqual([payload]);
    expect(queues.jobIds('render')).toEqual([payload.renderJobId]);
    await expect(queues.enqueue('render', { ...payload, videoId: 'nope' })).rejects.toThrow();
    expect((await queues.getJob('render', payload.renderJobId))?.state).toBe('waiting');
    expect(await queues.remove('render', payload.renderJobId)).toBe(true);
    expect(queues.size).toBe(0);
  });
});

describe('BullQueueClient (real Redis)', () => {
  it('enqueues, reads back, removes and isolates by prefix', async () => {
    const client = new BullQueueClient({
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
      prefix: `parlante-test-${randomBytes(4).toString('hex')}`,
    });
    try {
      expect(await client.ping()).toBe(true);
      const { jobId } = await client.enqueue(
        'system',
        { kind: 'ping', echo: 'hi' },
        { jobId: 'job-1' },
      );
      expect(jobId).toBe('job-1');
      const snapshot = await client.getJob('system', 'job-1');
      expect(snapshot).toMatchObject({
        id: 'job-1',
        state: 'waiting',
        payload: { kind: 'ping', echo: 'hi' },
      });
      await expect(client.enqueue('system', { kind: 'pong' } as never)).rejects.toThrow();
      expect(await client.remove('system', 'job-1')).toBe(true);
      expect(await client.getJob('system', 'job-1')).toBeNull();
      expect(await client.remove('system', 'job-1')).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('dispatchWebhookEvent', () => {
  it('creates and queues one delivery per enabled, subscribed endpoint of the workspace', async () => {
    const a = await seedAccount(handle.db);
    const b = await seedAccount(handle.db);
    const subscribed = await seedEndpoint(a.workspace.id, ['video.completed']);
    await seedEndpoint(a.workspace.id, ['video.failed']);
    await seedEndpoint(a.workspace.id, ['video.completed'], false);
    await seedEndpoint(b.workspace.id, ['video.completed']);

    const rows = await dispatchWebhookEvent({
      db: handle.db,
      queues,
      workspaceId: a.workspace.id,
      type: 'video.completed',
      data: {},
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpointId: subscribed.id, status: 'pending', attempts: 0 });
    expect(WebhookEventSchema.safeParse(rows[0]?.payload).success).toBe(true);
    expect(queues.jobs('webhookDelivery')).toEqual([
      { deliveryId: rows[0]?.id, workspaceId: a.workspace.id },
    ]);
  });

  it('targets a single endpoint for test pings, regardless of subscription', async () => {
    const a = await seedAccount(handle.db);
    const other = await seedAccount(handle.db);
    const endpoint = await seedEndpoint(a.workspace.id, ['video.failed'], false);
    const rows = await dispatchWebhookEvent({
      db: handle.db,
      queues,
      workspaceId: a.workspace.id,
      type: 'ping',
      data: {},
      endpointId: endpoint.id,
    });
    expect(rows).toHaveLength(1);
    // Another workspace cannot target it.
    expect(
      await dispatchWebhookEvent({
        db: handle.db,
        queues,
        workspaceId: other.workspace.id,
        type: 'ping',
        data: {},
        endpointId: endpoint.id,
      }),
    ).toEqual([]);
  });
});

describe('notifyVideoFinished', () => {
  it('sends video.completed with a valid PublicVideo and signed URLs', async () => {
    const { workspace } = await seedAccount(handle.db);
    await seedEndpoint(workspace.id, ['video.completed', 'video.failed']);
    const video = await seedVideo(workspace.id, {
      status: 'completed',
      progress: 100,
      resolution: '720p',
      durationMs: 4200,
      videoKey: `ws/${workspace.id}/videos/v/r/video.mp4`,
      thumbnailKey: `ws/${workspace.id}/videos/v/r/thumb.jpg`,
      renderedAt: new Date(),
    });
    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: workspace.id,
      videoId: video.id,
    });
    const [delivery] = await handle.db.select().from(webhookDeliveries);
    expect(delivery?.eventType).toBe('video.completed');
    const publicVideo = PublicVideoSchema.parse(delivery?.payload.data.video);
    expect(publicVideo.id).toBe(video.id);
    expect(publicVideo.videoUrl).toContain('/api/files/ws/');
    expect(publicVideo.srtUrl).toBeNull();
    expect(queues.jobs('webhookDelivery')).toHaveLength(1);
  });

  it('ignores videos that are not finished or belong to another workspace', async () => {
    const a = await seedAccount(handle.db);
    const b = await seedAccount(handle.db);
    await seedEndpoint(a.workspace.id, ['video.completed', 'video.failed']);
    const rendering = await seedVideo(a.workspace.id, { status: 'rendering' });
    const done = await seedVideo(a.workspace.id, {
      status: 'failed',
      error: { code: 'INTERNAL', message: 'x' },
    });
    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: a.workspace.id,
      videoId: rendering.id,
    });
    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: b.workspace.id,
      videoId: done.id,
    });
    expect(queues.size).toBe(0);
    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: a.workspace.id,
      videoId: done.id,
    });
    expect((await handle.db.select().from(webhookDeliveries))[0]?.eventType).toBe('video.failed');
  });

  it('keeps batch items and counters in step with their videos', async () => {
    const { workspace } = await seedAccount(handle.db);
    const [batch] = await handle.db
      .insert(batchJobs)
      .values({
        id: newId('batchJob'),
        workspaceId: workspace.id,
        name: 'Lote',
        composition: createComposition(),
        resolution: '720p',
        status: 'processing',
        total: 2,
      })
      .returning();
    if (!batch) throw new Error('seed');
    const ok = await seedVideo(workspace.id, {
      status: 'completed',
      batchJobId: batch.id,
      source: 'batch',
    });
    const bad = await seedVideo(workspace.id, {
      status: 'failed',
      batchJobId: batch.id,
      source: 'batch',
      error: { code: 'PROVIDER_ERROR', message: 'tts down' },
    });
    await handle.db.insert(batchItems).values([
      {
        id: newId('batchItem'),
        workspaceId: workspace.id,
        batchJobId: batch.id,
        index: 0,
        values: { n: 'a' },
        status: 'rendering',
        videoId: ok.id,
      },
      {
        id: newId('batchItem'),
        workspaceId: workspace.id,
        batchJobId: batch.id,
        index: 1,
        values: { n: 'b' },
        status: 'rendering',
        videoId: bad.id,
      },
    ]);
    const read = async () =>
      (await handle.db.select().from(batchJobs).where(eq(batchJobs.id, batch.id)))[0];

    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: workspace.id,
      videoId: ok.id,
    });
    expect(await read()).toMatchObject({ completed: 1, failed: 0, status: 'processing' });
    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: workspace.id,
      videoId: bad.id,
    });
    expect(await read()).toMatchObject({ completed: 1, failed: 1, status: 'partial' });
    await notifyVideoFinished({
      db: handle.db,
      queues,
      fileUrl,
      workspaceId: workspace.id,
      videoId: bad.id,
    });
    expect(await read()).toMatchObject({ completed: 1, failed: 1, status: 'partial' });
    const items = await handle.db.select().from(batchItems).orderBy(batchItems.index);
    expect(items.map((i) => i.status)).toEqual(['completed', 'failed']);
    expect(items[1]?.error).toEqual({ code: 'PROVIDER_ERROR', message: 'tts down' });
  });
});
