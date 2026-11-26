import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComposition, newId } from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import {
  asc,
  batchItems,
  batchJobs,
  creditLedger,
  eq,
  getCreditBalance,
  renderJobs,
  videos,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import { notifyVideoFinished } from '@parlante/jobs';
import { createTestWorker } from '../../testing/index';
import type { TestWorker } from '../../testing/index';
import job, { batchVideoTitle } from './index';

let t: TestWorker;
let voiceId: string;

beforeAll(async () => {
  // Real local moderation, with one extra blocked term for the "bad row" cases.
  t = await createTestWorker({ MODERATION_EXTRA_BLOCKLIST: 'zarandajas' });
  const voice = (await t.ctx.providers.tts.default.listVoices()).find((v) =>
    v.language.startsWith('es'),
  );
  if (!voice) throw new Error('The local TTS has no Spanish voice');
  voiceId = `${t.ctx.providers.tts.default.info.id}:${voice.providerVoiceId}`;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  vi.restoreAllMocks();
});

function template(): Composition {
  return createComposition({
    scenes: [
      {
        id: 'scene1',
        script: {
          kind: 'tts',
          text: 'Hola {{nombre}}, tu pedido de {{producto}} está listo.',
          voiceId,
          language: 'es',
        },
        layers: [
          {
            id: 'avatar1',
            type: 'avatar',
            avatarId: 'stock_lucia',
            box: { x: 0.3, y: 0.1, w: 0.4, h: 0.9 },
          },
          {
            id: 'title1',
            type: 'text',
            text: 'Para {{nombre}}',
            box: { x: 0.1, y: 0.05, w: 0.8, h: 0.15 },
          },
        ],
      },
    ],
  });
}

const ROWS = [
  { nombre: 'Ana', producto: 'café' },
  { nombre: 'Luis', producto: 'té' },
  { nombre: 'Marta', producto: 'cacao' },
];

/** A batch exactly as `POST /api/batches` leaves it: job `queued`, rows `pending`, no charge. */
async function seedBatch(rows = ROWS, credits = 30) {
  const account = await seedAccount(t.ctx.db, { credits });
  const workspaceId = account.workspace.id;
  const batchJobId = newId('batchJob');
  await t.ctx.db.insert(batchJobs).values({
    id: batchJobId,
    workspaceId,
    name: 'Campaña de otoño',
    composition: template(),
    variables: ['nombre', 'producto'],
    resolution: '720p',
    status: 'queued',
    total: rows.length,
    createdBy: account.user.id,
  });
  await t.ctx.db.insert(batchItems).values(
    rows.map((values, index) => ({
      id: newId('batchItem'),
      workspaceId,
      batchJobId,
      index,
      values,
      status: 'pending' as const,
    })),
  );
  return { workspaceId, batchJobId, userId: account.user.id, payload: { batchJobId, workspaceId } };
}

async function state(seeded: { workspaceId: string; batchJobId: string }) {
  const [batch] = await t.ctx.db
    .select()
    .from(batchJobs)
    .where(eq(batchJobs.id, seeded.batchJobId));
  const items = await t.ctx.db
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchJobId, seeded.batchJobId))
    .orderBy(asc(batchItems.index));
  const batchVideos = await t.ctx.db
    .select()
    .from(videos)
    .where(eq(videos.workspaceId, seeded.workspaceId))
    .orderBy(asc(videos.title));
  const renders = await t.ctx.db
    .select()
    .from(renderJobs)
    .where(eq(renderJobs.workspaceId, seeded.workspaceId));
  if (!batch) throw new Error('batch row is gone');
  return { batch, items, videos: batchVideos, renders };
}

/** What the render job does when a video ends (status first, then the shared side effects). */
async function finishVideo(workspaceId: string, videoId: string, status: 'completed' | 'failed') {
  await t.ctx.db
    .update(videos)
    .set({
      status,
      error: status === 'failed' ? { code: 'INTERNAL', message: 'Render crashed' } : null,
    })
    .where(eq(videos.id, videoId));
  await t.ctx.db
    .update(renderJobs)
    .set({ status: status === 'completed' ? 'completed' : 'failed' })
    .where(eq(renderJobs.videoId, videoId));
  await notifyVideoFinished({
    db: t.ctx.db,
    queues: t.queues,
    fileUrl: t.ctx.fileUrl,
    workspaceId,
    videoId,
  });
}

describe('batch job', () => {
  it('creates one video per row and starts its render with the values of the row', async () => {
    const seeded = await seedBatch();
    const { result, progress } = await t.run(job, seeded.payload);

    expect(result).toEqual({ batchJobId: seeded.batchJobId, enqueued: 3, skipped: 0 });
    expect(progress[0]).toEqual({ enqueued: 0, total: 3 });
    const after = await state(seeded);

    // One video per row: source `batch`, linked to the batch, still WITH its variables…
    expect(after.videos).toHaveLength(3);
    expect(after.videos.map((v) => v.title)).toEqual([
      'Campaña de otoño — 01',
      'Campaña de otoño — 02',
      'Campaña de otoño — 03',
    ]);
    for (const video of after.videos) {
      expect(video).toMatchObject({
        source: 'batch',
        batchJobId: seeded.batchJobId,
        status: 'queued',
        aspect: '16:9',
        createdBy: seeded.userId,
      });
      expect(video.composition.scenes[0]?.script).toMatchObject({
        text: 'Hola {{nombre}}, tu pedido de {{producto}} está listo.',
      });
    }
    // …with its own scene / layer ids (documents never share ids).
    expect(new Set(after.videos.map((v) => v.composition.scenes[0]?.id)).size).toBe(3);

    // …and a render whose SNAPSHOT has the values of its row applied.
    expect(after.renders).toHaveLength(3);
    const spoken = after.renders
      .map((r) => {
        const script = r.composition.scenes[0]?.script;
        return script?.kind === 'tts' ? script.text : '';
      })
      .sort();
    expect(spoken).toEqual([
      'Hola Ana, tu pedido de café está listo.',
      'Hola Luis, tu pedido de té está listo.',
      'Hola Marta, tu pedido de cacao está listo.',
    ]);
    expect(after.renders.every((r) => r.status === 'queued' && r.resolution === '720p')).toBe(true);
    // Render jobs are queued with jobId = renderJobId (the free plan allows ONE concurrent
    // render: the fan-out is exempt).
    expect(t.queues.jobIds('render').sort()).toEqual(after.renders.map((r) => r.id).sort());

    // Rows follow: queued, linked to their video, in order.
    expect(after.items.map((i) => i.status)).toEqual(['queued', 'queued', 'queued']);
    expect(after.items.map((i) => i.videoId)).toEqual(after.videos.map((v) => v.id));

    // Charged per render (ledger ref `renderJob`), never as a batch.
    const spent = after.renders.reduce((sum, r) => sum + r.creditsCharged, 0);
    expect(spent).toBeGreaterThanOrEqual(3);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(30 - spent);
    const ledger = await t.ctx.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, seeded.workspaceId));
    expect(ledger.filter((e) => e.reason === 'render').map((e) => e.refType)).toEqual([
      'renderJob',
      'renderJob',
      'renderJob',
    ]);
    expect(after.batch).toMatchObject({
      status: 'processing',
      completed: 0,
      failed: 0,
      creditsCharged: spent,
    });
  });

  it('the batch then follows its videos: completed, or partial when one render fails', async () => {
    const seeded = await seedBatch();
    await t.run(job, seeded.payload);
    const [first, second, third] = (await state(seeded)).videos;
    if (!first || !second || !third) throw new Error('missing videos');

    await finishVideo(seeded.workspaceId, first.id, 'completed');
    expect((await state(seeded)).batch).toMatchObject({ status: 'processing', completed: 1 });
    await finishVideo(seeded.workspaceId, second.id, 'failed');
    await finishVideo(seeded.workspaceId, third.id, 'completed');

    const after = await state(seeded);
    expect(after.items.map((i) => i.status)).toEqual(['completed', 'failed', 'completed']);
    expect(after.items[1]?.error).toEqual({ code: 'INTERNAL', message: 'Render crashed' });
    expect(after.batch).toMatchObject({ status: 'partial', completed: 2, failed: 1 });
  });

  it('a row with blocked content fails alone: the others are rendered', async () => {
    const seeded = await seedBatch([
      { nombre: 'Ana', producto: 'café' },
      { nombre: 'Luis', producto: 'zarandajas' },
      { nombre: 'Marta', producto: 'cacao' },
    ]);
    const { result } = await t.run(job, seeded.payload);

    expect(result).toEqual({ batchJobId: seeded.batchJobId, enqueued: 2, skipped: 1 });
    const after = await state(seeded);
    expect(after.items.map((i) => i.status)).toEqual(['queued', 'failed', 'queued']);
    expect(after.items[1]?.error?.code).toBe('CONTENT_BLOCKED');
    expect(after.items[1]?.videoId).toBeNull();
    // The row that never rendered leaves no draft in the library and was not charged.
    expect(after.videos).toHaveLength(2);
    expect(after.renders).toHaveLength(2);
    const spent = after.renders.reduce((sum, r) => sum + r.creditsCharged, 0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(30 - spent);
    expect(after.batch).toMatchObject({ status: 'processing', failed: 1, creditsCharged: spent });

    // When the two renders end, the batch is partial.
    for (const video of after.videos) await finishVideo(seeded.workspaceId, video.id, 'completed');
    expect((await state(seeded)).batch).toMatchObject({
      status: 'partial',
      completed: 2,
      failed: 1,
    });
  });

  it('rows that cannot be paid fail with INSUFFICIENT_CREDITS; every row failing fails the batch', async () => {
    const one = await seedBatch(ROWS, 1);
    const first = await t.run(job, one.payload);
    expect(first.result).toMatchObject({ enqueued: 1, skipped: 2 });
    const partial = await state(one);
    expect(partial.items.map((i) => i.status)).toEqual(['queued', 'failed', 'failed']);
    expect(partial.items[2]?.error?.code).toBe('INSUFFICIENT_CREDITS');
    expect(partial.batch.status).toBe('processing');
    expect(await getCreditBalance(t.ctx.db, one.workspaceId)).toBe(0);

    const none = await seedBatch(ROWS, 0);
    const second = await t.run(job, none.payload);
    expect(second.result).toEqual({ batchJobId: none.batchJobId, enqueued: 0, skipped: 3 });
    const failed = await state(none);
    expect(failed.items.every((i) => i.status === 'failed')).toBe(true);
    expect(failed.videos).toHaveLength(0);
    expect(failed.batch).toMatchObject({
      status: 'failed',
      failed: 3,
      completed: 0,
      creditsCharged: 0,
    });
  });

  it('is idempotent: running again renders no row twice', async () => {
    const seeded = await seedBatch();
    await t.run(job, seeded.payload);
    const before = await state(seeded);
    const balance = await getCreditBalance(t.ctx.db, seeded.workspaceId);

    const again = await t.run(job, seeded.payload, { attemptsMade: 1 });
    expect(again.result).toEqual({ batchJobId: seeded.batchJobId, enqueued: 0, skipped: 3 });
    const after = await state(seeded);
    expect(after.videos.map((v) => v.id)).toEqual(before.videos.map((v) => v.id));
    expect(after.renders).toHaveLength(3);
    expect(t.queues.jobs('render')).toHaveLength(3);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(balance);
  });

  it('resumes after a crash between starting a render and marking its row', async () => {
    const seeded = await seedBatch();
    await t.run(job, seeded.payload);
    // The first attempt died right after `startRender` of row 0: the row is still pending.
    const crashed = (await state(seeded)).items[0];
    if (!crashed) throw new Error('missing item');
    await t.ctx.db
      .update(batchItems)
      .set({ status: 'pending' })
      .where(eq(batchItems.id, crashed.id));

    const { result } = await t.run(job, seeded.payload, { attemptsMade: 1 });
    expect(result.enqueued).toBe(0);
    const after = await state(seeded);
    expect(after.items.map((i) => i.status)).toEqual(['queued', 'queued', 'queued']);
    expect(after.items[0]?.videoId).toBe(crashed.videoId);
    expect(after.videos).toHaveLength(3);
    expect(after.renders).toHaveLength(3);
  });

  it('retries when the queue is down and fails the rows only on the last attempt', async () => {
    const seeded = await seedBatch();
    const enqueue = vi
      .spyOn(t.queues, 'enqueue')
      .mockRejectedValue(new Error('Redis connection lost'));

    // Attempt 1 of 2: temporary → the job fails so the queue retries; nothing is decided.
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/job queue is not available/);
    const during = await state(seeded);
    expect(during.batch.status).toBe('processing');
    expect(during.items.map((i) => i.status)).toEqual(['pending', 'pending', 'pending']);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(30); // refunded by startRender

    // Attempt 2 of 2 with the queue back: the same video of row 0 is rendered, not a new one.
    enqueue.mockRestore();
    const { result } = await t.run(job, seeded.payload, { attemptsMade: 1 });
    expect(result).toEqual({ batchJobId: seeded.batchJobId, enqueued: 3, skipped: 0 });
    const after = await state(seeded);
    expect(after.videos).toHaveLength(3);
    expect(after.items[0]?.videoId).toBe(during.items[0]?.videoId);
    expect(after.items.map((i) => i.status)).toEqual(['queued', 'queued', 'queued']);
    expect(t.queues.jobs('render')).toHaveLength(3);

    // A batch whose LAST attempt still finds the queue down: every row fails, all refunded.
    const unlucky = await seedBatch();
    vi.spyOn(t.queues, 'enqueue').mockRejectedValue(new Error('Redis connection lost'));
    const last = await t.run(job, unlucky.payload, { attemptsMade: 1 });
    expect(last.result).toEqual({ batchJobId: unlucky.batchJobId, enqueued: 0, skipped: 3 });
    const failed = await state(unlucky);
    expect(failed.items.map((i) => i.error?.code)).toEqual([
      'SERVICE_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
    ]);
    expect(failed.batch.status).toBe('failed');
    expect(await getCreditBalance(t.ctx.db, unlucky.workspaceId)).toBe(30);
  });

  it('does nothing for a cancelled batch and stops when it is cancelled half-way', async () => {
    const cancelled = await seedBatch();
    await t.ctx.db
      .update(batchJobs)
      .set({ status: 'canceled' })
      .where(eq(batchJobs.id, cancelled.batchJobId));
    const nothing = await t.run(job, cancelled.payload);
    expect(nothing.result).toEqual({ batchJobId: cancelled.batchJobId, enqueued: 0, skipped: 3 });
    expect((await state(cancelled)).videos).toHaveLength(0);

    // Cancelled by the API while row 0 is being started: rows 1 and 2 are never fanned out.
    const seeded = await seedBatch();
    const check = t.ctx.providers.moderation.check.bind(t.ctx.providers.moderation);
    let cancelledOnce = false;
    vi.spyOn(t.ctx.providers.moderation, 'check').mockImplementation(async (request) => {
      if (!cancelledOnce) {
        cancelledOnce = true;
        await t.ctx.db
          .update(batchJobs)
          .set({ status: 'canceled' })
          .where(eq(batchJobs.id, seeded.batchJobId));
        await t.ctx.db
          .update(batchItems)
          .set({ status: 'canceled' })
          .where(eq(batchItems.batchJobId, seeded.batchJobId));
      }
      return check(request);
    });
    const { result } = await t.run(job, seeded.payload);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    const after = await state(seeded);
    expect(after.batch.status).toBe('canceled');
    expect(after.items.map((i) => i.status)).toEqual(['canceled', 'canceled', 'canceled']);
    // Only the row in flight got a video (the API cancels that render in its second pass).
    expect(after.videos).toHaveLength(1);
  });

  it('never loads a batch through another workspace', async () => {
    const seeded = await seedBatch();
    const other = await seedAccount(t.ctx.db);
    await expect(
      t.run(job, { batchJobId: seeded.batchJobId, workspaceId: other.workspace.id }),
    ).rejects.toThrow(/NOT_FOUND/);
    const after = await state(seeded);
    expect(after.batch.status).toBe('queued');
    expect(after.videos).toHaveLength(0);
  });

  it('onFinalFailure fails the rows never fanned out and keeps the ones already rendering', async () => {
    const seeded = await seedBatch();
    await t.run(job, seeded.payload);
    // The worker died after row 0: rows 1 and 2 were never started.
    const items = (await state(seeded)).items;
    for (const item of items.slice(1)) {
      await t.ctx.db
        .update(batchItems)
        .set({ status: 'pending', videoId: null })
        .where(eq(batchItems.id, item.id));
    }
    const error = { code: 'SERVICE_UNAVAILABLE' as const, message: 'The worker stopped' };
    await job.onFinalFailure?.(t.ctx, seeded.payload, error);
    await job.onFinalFailure?.(t.ctx, seeded.payload, error);

    const after = await state(seeded);
    expect(after.items.map((i) => i.status)).toEqual(['queued', 'failed', 'failed']);
    expect(after.items[1]?.error).toEqual(error);
    expect(after.batch).toMatchObject({ status: 'processing', failed: 2, error });

    // A batch that never started: everything fails, the batch is `failed`.
    const untouched = await seedBatch();
    await job.onFinalFailure?.(t.ctx, untouched.payload, error);
    expect((await state(untouched)).batch).toMatchObject({ status: 'failed', failed: 3, error });
  });

  it('titles sort in row order', () => {
    expect(batchVideoTitle({ name: 'Lote', total: 5 }, 0)).toBe('Lote — 01');
    expect(batchVideoTitle({ name: 'Lote', total: 250 }, 41)).toBe('Lote — 042');
  });
});
