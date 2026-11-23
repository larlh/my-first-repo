import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, compositionFromScript, isAppError, newId } from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { asc, batchItems, batchJobs, chargeCredits, eq, renderJobs, videos } from '@parlante/db';
import { listStockAvatars } from '@parlante/renderer';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import { balanceOf, breakQueue, installFakeTts, ledgerOf } from '../interactive/test-doubles';
import { parseBatchCsv } from './csv';
import batchModule from './index';

const AVATAR_ID = listStockAvatars()[0]?.id ?? 'stock_missing';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    modules: [batchModule],
    env: { MODERATION_EXTRA_BLOCKLIST: 'zzprohibido' },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  installFakeTts(t);
});

/** "Hola {{nombre}} … {{empresa}}" with an on-screen {{cargo}} that has a default value. */
function personalisedComposition(extraText = ''): Composition {
  const composition = compositionFromScript(
    [
      {
        text: `Hola {{nombre}}, te damos la bienvenida a {{empresa}}. ${extraText}`,
        headline: '{{ cargo }}',
      },
      { text: 'Gracias por tu tiempo, {{nombre}}.' },
    ],
    { avatarId: AVATAR_ID, voiceId: 'espeak:es-f1', language: 'es' },
  );
  composition.variables = [
    { name: 'nombre', label: 'Nombre', defaultValue: '' },
    { name: 'empresa', label: 'Empresa', defaultValue: '' },
    { name: 'cargo', label: 'Cargo', defaultValue: 'Cliente' },
  ];
  return composition;
}

async function seedVideo(actor: TestActor, composition: Composition = personalisedComposition()) {
  const id = newId('video');
  await t.db.insert(videos).values({
    id,
    workspaceId: actor.workspace.id,
    title: 'Bienvenida',
    composition,
    aspect: '16:9',
    status: 'draft',
    createdBy: actor.user.id,
  });
  return id;
}

const CSV = 'nombre,empresa\nAna,Acme\nBruno,"Globex, S.L."\nCarla,Initech\n';

async function batchRows(actor: TestActor) {
  return t.db.select().from(batchJobs).where(eq(batchJobs.workspaceId, actor.workspace.id));
}

describe('POST /api/batches/preview', () => {
  it('matches CSV columns to the variables of the video and estimates the cost', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    // Semicolons, a BOM, quotes, a blank line, an unknown column and CRLF line ends.
    const csv = `${String.fromCharCode(0xfeff)}nombre;empresa;telefono\r\nAna;Acme;600\r\n\r\n"Bruno ""el jefe""";"Globex; S.L.";\r\n`;
    const res = await t.call(api.batches.preview, { as: alice, body: { sourceVideoId, csv } });
    expect(res.status, res.raw.body).toBe(200);
    expect(res.body).toEqual({
      variables: ['nombre', 'empresa', 'cargo'],
      columns: ['nombre', 'empresa', 'telefono'],
      rows: [
        { nombre: 'Ana', empresa: 'Acme', telefono: '600' },
        { nombre: 'Bruno "el jefe"', empresa: 'Globex; S.L.', telefono: '' },
      ],
      // `cargo` has a default value, so it needs no column.
      missingColumns: [],
      unknownColumns: ['telefono'],
      estimatedCredits: 2,
      maxRows: 5,
    });

    const missing = await t.call(api.batches.preview, {
      as: alice,
      body: { sourceVideoId, csv: 'nombre\nAna\n', resolution: '1080p' },
    });
    expect(missing.body.missingColumns).toEqual(['empresa']);
    expect(missing.body.estimatedCredits).toBe(2); // one row, ×2 at 1080p
    // A preview changes nothing.
    expect(await batchRows(alice)).toEqual([]);
    expect(t.queues.size).toBe(0);
  });

  it('rejects malformed CSV with the line it found the problem on', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    const cases: [string, RegExp][] = [
      ['   \n  \n', /empty/],
      ['nombre,empresa\n', /no rows/],
      ['nombre,nombre\nAna,Ana\n', /repeats the column "nombre"/],
      ['nombre,,empresa\nAna,x,Acme\n', /Column 2 .* has no name/],
      ['nombre,empresa\nAna,Acme,sobra\n', /Row 2 .* has 3 values .* 2 columns/],
      ['nombre,empresa\n"Ana,Acme\n', /could not be read/],
      [`nombre,empresa\nAna,${'x'.repeat(501)}\n`, /Row 2, column "empresa": .* longer than 500/],
      [`nombre,empresa\n${'Ana,Acme\n'.repeat(501)}`, /501 rows; the maximum is 500/],
    ];
    for (const [csv, message] of cases) {
      const res = await t.call(api.batches.preview, { as: alice, body: { sourceVideoId, csv } });
      expect(res.status, csv.slice(0, 40)).toBe(422);
      expect(res.error.code).toBe('UNPROCESSABLE');
      expect(res.error.message).toMatch(message);
    }
    expect(
      (await t.call(api.batches.preview, { as: alice, body: { sourceVideoId, csv: '' } })).status,
    ).toBe(400);
  });

  it('requires the editor role and a video of the workspace', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const mallory = await t.signUp();
    const sourceVideoId = await seedVideo(owner);
    const body = { sourceVideoId, csv: CSV };
    expect((await t.call(api.batches.preview, { body })).status).toBe(401);
    expect((await t.call(api.batches.preview, { as: viewer, body })).status).toBe(403);
    expect((await t.call(api.batches.preview, { as: mallory, body })).status).toBe(404);
    expect(
      (
        await t.call(api.batches.preview, {
          as: owner,
          body: { ...body, sourceVideoId: newId('video') },
        })
      ).status,
    ).toBe(404);
    expect(
      (await t.call(api.batches.preview, { as: owner, body: { ...body, sourceVideoId: 'nope' } }))
        .status,
    ).toBe(400);
  });
});

describe('POST /api/batches', () => {
  it('checks the balance WITHOUT charging, stores job and items and queues the fan-out', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    const before = await balanceOf(t, alice);
    const res = await t.call(api.batches.create, {
      as: alice,
      body: {
        name: 'Bienvenidas de marzo',
        sourceVideoId,
        csv: `${CSV}Dani,Umbrella,Directora\n`.replace('nombre,empresa', 'nombre,empresa,cargo'),
      },
    });
    expect(res.status, res.raw.body).toBe(202);
    expect(res.body).toMatchObject({
      workspaceId: alice.workspace.id,
      name: 'Bienvenidas de marzo',
      sourceVideoId,
      resolution: '720p',
      status: 'queued',
      total: 4,
      completed: 0,
      failed: 0,
      progress: 0,
      creditsCharged: 0,
      error: null,
      createdBy: { id: alice.user.id, name: alice.user.name },
    });
    expect(res.body.id).toMatch(/^bat_/);

    // Nothing is charged here: every render is charged on its own by startRender.
    expect(await balanceOf(t, alice)).toBe(before);
    expect((await ledgerOf(t, alice)).filter((entry) => entry.delta < 0)).toEqual([]);
    expect(t.queues.jobs('batch')).toEqual([
      { batchJobId: res.body.id, workspaceId: alice.workspace.id },
    ]);
    expect(t.queues.jobIds('batch')).toEqual([res.body.id]);
    expect(t.queues.jobs('render')).toEqual([]);

    const [batch] = await batchRows(alice);
    expect(batch?.variables).toEqual(['nombre', 'empresa', 'cargo']);
    // The snapshot keeps its {{variables}} for the job to apply per row.
    expect(JSON.stringify(batch?.composition)).toContain('Hola {{nombre}}');
    const items = await t.db
      .select()
      .from(batchItems)
      .where(eq(batchItems.batchJobId, res.body.id))
      .orderBy(asc(batchItems.index));
    expect(items.map((item) => [item.index, item.status, item.videoId, item.values])).toEqual([
      // Empty `cargo` cells fall back to the default value: they are not stored.
      [0, 'pending', null, { nombre: 'Ana', empresa: 'Acme' }],
      [1, 'pending', null, { nombre: 'Bruno', empresa: 'Globex, S.L.' }],
      [2, 'pending', null, { nombre: 'Carla', empresa: 'Initech' }],
      [3, 'pending', null, { nombre: 'Dani', empresa: 'Umbrella', cargo: 'Directora' }],
    ]);
  });

  it('accepts rows already parsed and ignores keys that are not variables', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    const res = await t.call(api.batches.create, {
      as: alice,
      body: {
        name: 'Desde filas',
        sourceVideoId,
        rows: [
          { nombre: ' Ana ', empresa: 'Acme', nota: 'se ignora' },
          { nombre: 'Bruno', empresa: 'Globex' },
        ],
      },
    });
    expect(res.status).toBe(202);
    const items = await t.db.select().from(batchItems).orderBy(asc(batchItems.index));
    expect(items.map((item) => item.values)).toEqual([
      { nombre: 'Ana', empresa: 'Acme' },
      { nombre: 'Bruno', empresa: 'Globex' },
    ]);
  });

  it('rejects data that does not fit the video', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    const plain = await seedVideo(
      alice,
      compositionFromScript([{ text: 'Un vídeo sin variables.' }], {
        avatarId: AVATAR_ID,
        voiceId: 'espeak:es-f1',
        language: 'es',
      }),
    );
    const call = (body: Record<string, unknown>) =>
      t.call(api.batches.create, { as: alice, body: { name: 'Lote', sourceVideoId, ...body } });

    const noVariables = await call({ sourceVideoId: plain, csv: CSV });
    expect(noVariables.status).toBe(422);
    expect(noVariables.error.message).toContain('no {{variables}}');
    const missingColumn = await call({ csv: 'nombre\nAna\n' });
    expect(missingColumn.status).toBe(422);
    expect(missingColumn.error.details).toMatchObject({ missingColumns: ['empresa'] });
    const blankCell = await call({ csv: 'nombre,empresa\nAna,Acme\nBruno,\n' });
    expect(blankCell.status).toBe(422);
    expect(blankCell.error).toMatchObject({
      message: 'Row 2 has no value for: empresa',
      details: { row: 2, missing: ['empresa'] },
    });
    const blankRow = await call({
      rows: [{ nombre: 'Ana', empresa: 'Acme' }, { nombre: 'Bruno' }],
    });
    expect(blankRow.status).toBe(422);
    expect((await call({ csv: 'nombre,empresa\n"Ana,Acme\n' })).status).toBe(422);

    expect((await call({ csv: CSV, rows: [{ nombre: 'Ana', empresa: 'Acme' }] })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call({ csv: CSV, name: ' ' })).status).toBe(400);
    expect((await call({ csv: CSV, resolution: '4k' })).status).toBe(400);
    expect((await call({ csv: CSV, sourceVideoId: newId('video') })).status).toBe(404);

    expect(await batchRows(alice)).toEqual([]);
    expect(t.queues.size).toBe(0);
  });

  it('moderates the name, the fixed texts of the video and the values of every row', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    const badVideo = await seedVideo(alice, personalisedComposition('Y hablamos de zzprohibido.'));

    const badRow = await t.call(api.batches.create, {
      as: alice,
      body: { name: 'Lote', sourceVideoId, csv: 'nombre,empresa\nAna,Acme\nBruno,zzprohibido\n' },
    });
    expect(badRow.status).toBe(422);
    expect(badRow.error).toMatchObject({ code: 'CONTENT_BLOCKED', details: { row: 2 } });
    const badName = await t.call(api.batches.create, {
      as: alice,
      body: { name: 'zzprohibido', sourceVideoId, csv: CSV },
    });
    expect(badName.error).toMatchObject({ code: 'CONTENT_BLOCKED', details: { field: 'name' } });
    const badText = await t.call(api.batches.create, {
      as: alice,
      body: { name: 'Lote', sourceVideoId: badVideo, csv: CSV },
    });
    expect(badText.status).toBe(422);
    expect(badText.error.details).toMatchObject({ kind: 'script' });
    expect(await batchRows(alice)).toEqual([]);
  });

  it('applies the plan limits and needs the balance to cover the estimate', async () => {
    const free = await t.signUp(); // free: 5 rows, 720p, 180 s per video, 30 credits
    const sourceVideoId = await seedVideo(free);
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        nombre: `Persona ${index}`,
        empresa: 'Acme',
      }));
    const call = (body: Record<string, unknown>, as = free) =>
      t.call(api.batches.create, { as, body: { name: 'Lote', sourceVideoId, ...body } });

    const tooManyRows = await call({ rows: rows(6) });
    expect(tooManyRows.status).toBe(403);
    expect(tooManyRows.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxBatchRows', max: 5, value: 6 },
    });
    const hd = await call({ rows: rows(2), resolution: '1080p' });
    expect(hd.status).toBe(403);
    expect(hd.error.details).toMatchObject({ limit: 'maxResolution', max: '720p', value: '1080p' });
    // A value long enough to push one video over the 180 s of the plan.
    const longVideo = await seedVideo(
      free,
      compositionFromScript(
        Array.from({ length: 8 }, () => ({ text: '{{parrafo}} {{parrafo}}' })),
        { avatarId: AVATAR_ID, voiceId: 'espeak:es-f1', language: 'es' },
      ),
    );
    const tooLong = await call({
      sourceVideoId: longVideo,
      rows: [{ parrafo: 'corto' }, { parrafo: 'palabra '.repeat(60) }],
    });
    expect(tooLong.status).toBe(403);
    expect(tooLong.error.details).toMatchObject({ limit: 'maxVideoDurationSec', max: 180, row: 2 });

    const poor = await t.signUp({ credits: 4 });
    const theirs = await seedVideo(poor);
    const noCredits = await t.call(api.batches.create, {
      as: poor,
      body: { name: 'Lote', sourceVideoId: theirs, rows: rows(5) },
    });
    expect(noCredits.status).toBe(402);
    expect(noCredits.error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      details: { required: 5, available: 4 },
    });
    expect(await batchRows(free)).toEqual([]);
    expect(await batchRows(poor)).toEqual([]);

    // Exactly enough: accepted, and still nothing is charged.
    expect((await call({ rows: rows(5) })).status).toBe(202);
    expect(await balanceOf(t, free)).toBe(30);
  });

  it('fails the batch when the queue is down; requires the editor role', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const sourceVideoId = await seedVideo(owner);
    const body = { name: 'Lote', sourceVideoId, csv: CSV };
    expect((await t.call(api.batches.create, { body })).status).toBe(401);
    expect((await t.call(api.batches.create, { as: viewer, body })).status).toBe(403);

    const restore = breakQueue(t);
    const res = await t.call(api.batches.create, { as: owner, body });
    restore();
    expect(res.status).toBe(503);
    const [batch] = await batchRows(owner);
    expect(batch).toMatchObject({
      status: 'failed',
      failed: 3,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    const items = await t.db.select().from(batchItems);
    expect(items.map((item) => item.status)).toEqual(['failed', 'failed', 'failed']);
  });
});

/* ---- a batch as the worker leaves it half-way: one row done, one rendering, one queued ---- */

async function fannedOutBatch(actor: TestActor) {
  const sourceVideoId = await seedVideo(actor);
  const created = await t.call(api.batches.create, {
    as: actor,
    body: {
      name: 'En marcha',
      sourceVideoId,
      csv: 'nombre,empresa\nAna,Acme\nBruno,Globex\nCarla,Initech\nDani,Umbrella\n',
    },
  });
  expect(created.status).toBe(202);
  const batchId = created.body.id;
  const items = await t.db
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchJobId, batchId))
    .orderBy(asc(batchItems.index));
  const workspaceId = actor.workspace.id;
  const composition = personalisedComposition();

  const addVideo = async (
    index: number,
    status: 'completed' | 'rendering' | 'queued' | 'failed',
  ) => {
    const videoId = newId('video');
    const renderJobId = newId('renderJob');
    const done = status === 'completed';
    const videoKey = storageKeys.videoOutput(workspaceId, videoId, renderJobId, 'video.mp4');
    const thumbnailKey = storageKeys.videoOutput(workspaceId, videoId, renderJobId, 'thumb.jpg');
    if (done) {
      await t.app.providers.storage.put(videoKey, Buffer.from(`mp4 ${index}`), {
        contentType: 'video/mp4',
      });
      await t.app.providers.storage.put(thumbnailKey, Buffer.from('jpg'), {
        contentType: 'image/jpeg',
      });
    }
    await t.db.insert(videos).values({
      id: videoId,
      workspaceId,
      title: `Bienvenida ${index + 1}`,
      composition,
      aspect: '16:9',
      source: 'batch',
      batchJobId: batchId,
      status,
      progress: done ? 100 : status === 'rendering' ? 40 : 0,
      currentRenderJobId: renderJobId,
      ...(done ? { videoKey, thumbnailKey, durationMs: 9000, resolution: '720p' as const } : {}),
      ...(status === 'failed'
        ? { error: { code: 'PROVIDER_ERROR' as const, message: 'TTS failed' } }
        : {}),
    });
    await chargeCredits(t.db, {
      workspaceId,
      amount: 1,
      reason: 'render',
      refType: 'renderJob',
      refId: renderJobId,
    });
    await t.db.insert(renderJobs).values({
      id: renderJobId,
      workspaceId,
      videoId,
      status: done
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'rendering'
            ? 'running'
            : 'queued',
      resolution: '720p',
      composition,
      revision: 1,
      creditsCharged: 1,
    });
    if (status === 'queued' || status === 'rendering') {
      await t.queues.enqueue(
        'render',
        { renderJobId, videoId, workspaceId },
        { jobId: renderJobId },
      );
    }
    await t.db
      .update(batchItems)
      .set({ videoId, status: done ? 'completed' : 'queued' })
      .where(eq(batchItems.id, items[index]?.id ?? ''));
    return { videoId, renderJobId };
  };
  const completed = await addVideo(0, 'completed');
  const rendering = await addVideo(1, 'rendering');
  const queued = await addVideo(2, 'queued');
  // Row 3 (Dani) is still pending: the fan-out has not reached it.
  await t.db
    .update(batchJobs)
    .set({ status: 'processing', completed: 1, creditsCharged: 3 })
    .where(eq(batchJobs.id, batchId));
  return { batchId, completed, rendering, queued };
}

describe('GET /api/batches and /api/batches/:batchId', () => {
  it('aggregates the state of the batch and shows every item with its video', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mallory = await t.signUp();
    const { batchId, completed, rendering, queued } = await fannedOutBatch(alice);
    const params = { batchId };

    const res = await t.call(api.batches.get, { as: viewer, params });
    expect(res.status, res.raw.body).toBe(200);
    expect(res.body).toMatchObject({
      id: batchId,
      status: 'processing',
      total: 4,
      completed: 1,
      failed: 0,
      creditsCharged: 3,
      variables: ['nombre', 'empresa', 'cargo'],
      // (100 done + 40 rendering + 0 queued + 0 pending) / 4
      progress: 35,
    });
    expect(res.body.items.map((item) => [item.index, item.status, item.videoId])).toEqual([
      [0, 'completed', completed.videoId],
      [1, 'rendering', rendering.videoId], // follows its video
      [2, 'queued', queued.videoId],
      [3, 'pending', null],
    ]);
    expect(res.body.items[1]).toMatchObject({
      values: { nombre: 'Bruno', empresa: 'Globex' },
      videoUrl: null,
      downloadUrl: null,
      error: null,
    });
    const done = res.body.items[0];
    const fetchFile = async (url: string | null | undefined) => {
      const parsed = new URL(url ?? '');
      return t.inject({ method: 'GET', url: parsed.pathname + parsed.search });
    };
    expect((await fetchFile(done?.videoUrl)).body).toBe('mp4 0');
    const download = await fetchFile(done?.downloadUrl);
    expect(String(download.headers['content-disposition'])).toMatch(
      /^attachment; .*Bienvenida 1\.mp4/,
    );
    expect((await fetchFile(done?.thumbnailUrl)).statusCode).toBe(200);

    const list = await t.call(api.batches.list, { as: alice });
    expect(list.body.items).toMatchObject([{ id: batchId, status: 'processing', progress: 35 }]);
    expect(list.body.nextCursor).toBeNull();

    expect((await t.call(api.batches.get, { params })).status).toBe(401);
    expect((await t.call(api.batches.list)).status).toBe(401);
    expect((await t.call(api.batches.get, { as: mallory, params })).status).toBe(404);
    expect((await t.call(api.batches.list, { as: mallory })).body.items).toEqual([]);
    expect((await t.call(api.batches.get, { as: alice, params: { batchId: 'nope' } })).status).toBe(
      400,
    );
  });

  it('paginates newest first', async () => {
    const alice = await t.signUp({ credits: 100 });
    const sourceVideoId = await seedVideo(alice);
    const ids: string[] = [];
    for (const [index, name] of ['Uno', 'Dos', 'Tres'].entries()) {
      const res = await t.call(api.batches.create, {
        as: alice,
        body: { name, sourceVideoId, csv: CSV },
      });
      ids.push(res.body.id);
      await t.db
        .update(batchJobs)
        .set({ createdAt: new Date(Date.now() - (3 - index) * 60_000) })
        .where(eq(batchJobs.id, res.body.id));
    }
    const page1 = await t.call(api.batches.list, { as: alice, query: { limit: 2 } });
    expect(page1.body.items.map((batch) => batch.name)).toEqual(['Tres', 'Dos']);
    const page2 = await t.call(api.batches.list, {
      as: alice,
      query: { limit: 2, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((batch) => batch.name)).toEqual(['Uno']);
    expect(page2.body.nextCursor).toBeNull();
  });
});

describe('POST /api/batches/:batchId/cancel and DELETE /api/batches/:batchId', () => {
  it('cancels what has not finished, refunds renders in flight and keeps finished videos', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mallory = await t.signUp();
    const { batchId, completed, rendering, queued } = await fannedOutBatch(alice);
    const params = { batchId };
    expect(await balanceOf(t, alice)).toBe(30 - 3);

    expect((await t.call(api.batches.cancel, { params })).status).toBe(401);
    expect((await t.call(api.batches.cancel, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.batches.cancel, { as: mallory, params })).status).toBe(404);

    const res = await t.call(api.batches.cancel, { as: alice, params });
    expect(res.status, res.raw.body).toBe(200);
    // One row had finished, the rest were cancelled.
    expect(res.body).toMatchObject({
      id: batchId,
      status: 'partial',
      total: 4,
      completed: 1,
      failed: 0,
      progress: 100,
      creditsCharged: 1,
    });
    const detail = await t.call(api.batches.get, { as: alice, params });
    expect(detail.body.items.map((item) => item.status)).toEqual([
      'completed',
      'canceled',
      'canceled',
      'canceled',
    ]);
    expect(detail.body.items[0]?.videoUrl).not.toBeNull();

    // The two renders in flight were cancelled and refunded; the finished one keeps its charge.
    const jobs = await t.db
      .select()
      .from(renderJobs)
      .where(eq(renderJobs.workspaceId, alice.workspace.id));
    const statusOf = (id: string) => jobs.find((job) => job.id === id)?.status;
    expect(statusOf(completed.renderJobId)).toBe('completed');
    expect(statusOf(rendering.renderJobId)).toBe('canceled');
    expect(statusOf(queued.renderJobId)).toBe('canceled');
    expect(await balanceOf(t, alice)).toBe(30 - 1);
    expect(t.queues.jobs('render')).toEqual([]);
    expect(t.queues.jobs('batch')).toEqual([]);
    const [finished] = await t.db.select().from(videos).where(eq(videos.id, completed.videoId));
    expect(finished?.status).toBe('completed');
    const [stopped] = await t.db.select().from(videos).where(eq(videos.id, queued.videoId));
    expect(stopped?.status).toBe('draft');

    const again = await t.call(api.batches.cancel, { as: alice, params });
    expect(again.status).toBe(409);
    expect(again.error).toMatchObject({ code: 'INVALID_STATE', details: { status: 'partial' } });
  });

  it('cancels a batch that has not started as `canceled`', async () => {
    const alice = await t.signUp();
    const sourceVideoId = await seedVideo(alice);
    const created = await t.call(api.batches.create, {
      as: alice,
      body: { name: 'Sin empezar', sourceVideoId, csv: CSV },
    });
    const res = await t.call(api.batches.cancel, {
      as: alice,
      params: { batchId: created.body.id },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'canceled', completed: 0, failed: 0, progress: 100 });
    expect(t.queues.jobs('batch')).toEqual([]);
    const items = await t.db.select().from(batchItems);
    expect(items.map((item) => item.status)).toEqual(['canceled', 'canceled', 'canceled']);
  });

  it('deletes the batch record (stopping it first) and keeps its videos', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mallory = await t.signUp();
    const { batchId, completed, queued } = await fannedOutBatch(alice);
    const params = { batchId };

    expect((await t.call(api.batches.remove, { params })).status).toBe(401);
    expect((await t.call(api.batches.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.batches.remove, { as: mallory, params })).status).toBe(404);
    expect(await batchRows(alice)).toHaveLength(1);

    const res = await t.call(api.batches.remove, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await batchRows(alice)).toEqual([]);
    expect(await t.db.select().from(batchItems)).toEqual([]);
    // Renders in flight were stopped and refunded; no job is left for a batch that is gone.
    expect(await balanceOf(t, alice)).toBe(30 - 1);
    expect(t.queues.size).toBe(0);
    // The videos stay in the library, detached from the batch.
    const kept = await t.db.select().from(videos).where(eq(videos.id, completed.videoId));
    expect(kept[0]).toMatchObject({ status: 'completed', batchJobId: null });
    const draft = await t.db.select().from(videos).where(eq(videos.id, queued.videoId));
    expect(draft[0]).toMatchObject({ status: 'draft', batchJobId: null });
    expect((await t.call(api.batches.remove, { as: alice, params })).status).toBe(404);
    expect((await t.call(api.batches.get, { as: alice, params })).status).toBe(404);
  });
});

describe('parseBatchCsv', () => {
  it('reads commas, semicolons and tabs, quotes and line breaks inside cells', () => {
    expect(parseBatchCsv('a,b\n1,2\n')).toEqual({
      columns: ['a', 'b'],
      rows: [{ a: '1', b: '2' }],
    });
    expect(parseBatchCsv('a;b\n"1;5";2\n').rows).toEqual([{ a: '1;5', b: '2' }]);
    expect(parseBatchCsv('a\tb\n1\t2\n').rows).toEqual([{ a: '1', b: '2' }]);
    expect(parseBatchCsv(' nombre , saludo \n Ana ,"Hola,\nAna"\n')).toEqual({
      columns: ['nombre', 'saludo'],
      rows: [{ nombre: 'Ana', saludo: 'Hola,\nAna' }],
    });
    // Short rows are padded; rows of empty cells are skipped.
    expect(parseBatchCsv('a,b,c\n1\n,,\n2,3,4\n').rows).toEqual([
      { a: '1', b: '', c: '' },
      { a: '2', b: '3', c: '4' },
    ]);
  });

  it('throws UNPROCESSABLE for anything it cannot map to rows', () => {
    for (const csv of ['', 'a,b', 'a,a\n1,2', 'a,b\n1,2,3']) {
      let error: unknown;
      try {
        parseBatchCsv(csv);
      } catch (err) {
        error = err;
      }
      expect(isAppError(error) && error.code, JSON.stringify(csv)).toBe('UNPROCESSABLE');
    }
  });
});
