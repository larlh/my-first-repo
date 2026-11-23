import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandColorsSchema,
  BrandFontsSchema,
  api,
  createComposition,
  creditsForRender,
  estimateCompositionDurationMs,
  newId,
} from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  batchItems,
  batchJobs,
  brandKits,
  creditLedger,
  eq,
  getCreditBalance,
  renderJobs,
  shareLinks,
  templates,
  users,
  videos,
} from '@parlante/db';
import { getBuiltinTemplate } from '@parlante/templates';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import templatesModule from '../templates/index';
import videosModule from './index';
import {
  BLOCKED_WORD,
  TEST_PHOTOREAL_AVATAR,
  completeRender,
  decodeJpeg,
  fetchUrl,
  installFakeProviders,
  startRendering,
  storedKeys,
  talkingComposition,
} from './test-support';
import type { FakeProviders } from './test-support';

let t: TestApp;
let fakes: FakeProviders;

beforeAll(async () => {
  t = await createTestApp({ modules: [videosModule, templatesModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  fakes = installFakeProviders(t);
});

async function createVideo(actor: TestActor, body: Record<string, unknown> = {}) {
  const res = await t.call(api.videos.create, { as: actor, body });
  if (res.status !== 201) throw new Error(`Create failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function render(actor: TestActor, videoId: string) {
  const res = await t.call(api.videos.render, { as: actor, params: { videoId }, body: {} });
  if (res.status !== 202) throw new Error(`Render failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

const storedFiles = (prefix: string) => storedKeys(t, prefix);

const near = (actual: number[], expected: number[], tolerance = 14) =>
  actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= tolerance);

describe('create', () => {
  it('creates a blank draft with defaults, a poster and the creator', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const res = await t.call(api.videos.create, { as: alice, body: {} });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workspaceId: alice.workspace.id,
      title: 'Vídeo sin título',
      status: 'draft',
      progress: 0,
      aspect: '16:9',
      source: 'studio',
      revision: 1,
      renderedRevision: null,
      templateId: null,
      batchJobId: null,
      videoUrl: null,
      downloadUrl: null,
      srtUrl: null,
      vttUrl: null,
      renderStage: null,
      renderEtaSec: null,
      usesPhotorealAvatars: false,
      createdBy: { id: alice.user.id, name: 'Alice' },
    });
    expect(res.body.composition.scenes).toHaveLength(1);
    expect(res.body.composition.scenes[0]?.name).toBe('Escena 1');

    // The poster is a real JPEG in the format of the canvas, stored under the video prefix.
    const poster = await fetchUrl(t, res.body.thumbnailUrl ?? '');
    expect(poster.statusCode).toBe(200);
    expect(poster.headers['content-type']).toBe('image/jpeg');
    const image = await decodeJpeg(poster.rawPayload);
    expect(image.width / image.height).toBeCloseTo(16 / 9, 1);
    expect(await storedFiles(storageKeys.videoPrefix(alice.workspace.id, res.body.id))).toEqual([
      storageKeys.videoDraftThumb(alice.workspace.id, res.body.id),
    ]);
  });

  it('uses the format asked for and the language of the user', async () => {
    const alice = await t.signUp();
    await t.db.update(users).set({ locale: 'en' }).where(eq(users.id, alice.user.id));
    const video = await createVideo(alice, { aspect: '9:16' });
    expect(video.title).toBe('Untitled video');
    expect(video.aspect).toBe('9:16');
    expect(video.composition.canvas).toEqual(createComposition({ aspect: '9:16' }).canvas);
    expect(video.composition.scenes[0]?.name).toBe('Scene 1');
    const image = await decodeJpeg((await fetchUrl(t, video.thumbnailUrl ?? '')).rawPayload);
    expect(image.height).toBeGreaterThan(image.width);
  });

  it('stores a full composition (script writer) and draws it on the poster', async () => {
    const alice = await t.signUp();
    const composition = talkingComposition({ backgroundColor: '#1d4ed8', scenes: 2 });
    const video = await createVideo(alice, {
      title: '  Mi guion  ',
      composition,
      source: 'script',
    });
    expect(video.title).toBe('Mi guion');
    expect(video.source).toBe('script');
    expect(video.composition).toEqual(composition);
    expect(video.estimatedDurationMs).toBe(Math.round(estimateCompositionDurationMs(composition)));
    const image = await decodeJpeg((await fetchUrl(t, video.thumbnailUrl ?? '')).rawPayload);
    expect(near(image.at(6, 6), [0x1d, 0x4e, 0xd8])).toBe(true);
  });

  it('copies a built-in template with fresh ids', async () => {
    const alice = await t.signUp();
    const template = getBuiltinTemplate('builtin_explainer');
    if (!template) throw new Error('missing built-in template');
    const video = await createVideo(alice, { templateId: 'builtin_explainer' });
    expect(video).toMatchObject({
      source: 'template',
      templateId: 'builtin_explainer',
      title: template.name.es,
      aspect: template.composition.canvas.aspect,
    });
    expect(video.composition.scenes).toHaveLength(template.composition.scenes.length);
    const templateIds = new Set(template.composition.scenes.map((scene) => scene.id));
    expect(video.composition.scenes.some((scene) => templateIds.has(scene.id))).toBe(false);
    expect(video.composition.variables).toEqual(template.composition.variables);
  });

  it('validates the body, the role and the workspace of the template', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const editor = await t.addMember(alice.workspace, 'editor');

    expect((await t.call(api.videos.create, { body: {} })).status).toBe(401);
    expect((await t.call(api.videos.create, { as: viewer, body: {} })).status).toBe(403);
    expect((await t.call(api.videos.create, { as: editor, body: {} })).status).toBe(201);

    const both = await t.call(api.videos.create, {
      as: alice,
      body: { composition: createComposition(), templateId: 'builtin_explainer' },
    });
    expect(both.status).toBe(400);
    expect(both.error.code).toBe('VALIDATION_ERROR');
    const invalid = await t.call(api.videos.create, {
      as: alice,
      body: { composition: { version: 1, scenes: [] } },
    });
    expect(invalid.status).toBe(400);
    expect((await t.call(api.videos.create, { as: alice, body: { title: '' } })).status).toBe(400);

    const unknown = await t.call(api.videos.create, {
      as: alice,
      body: { templateId: 'builtin_nope' },
    });
    expect(unknown.status).toBe(404);
    // A custom template of another workspace looks exactly like a missing one.
    const bobVideo = await createVideo(bob);
    const saved = await t.call(api.videos.saveAsTemplate, {
      as: bob,
      params: { videoId: bobVideo.id },
      body: { name: 'De Bob' },
    });
    expect(saved.status).toBe(201);
    const foreign = await t.call(api.videos.create, {
      as: alice,
      body: { templateId: saved.body.id },
    });
    expect(foreign.status).toBe(404);
    expect(await t.db.$count(videos, eq(videos.workspaceId, alice.workspace.id))).toBe(1);
  });
});

describe('list and get', () => {
  it('lists the videos of the workspace, newest first, with filters and pages', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const titles = ['Alfa', 'Beta 100%', 'Gamma_x', 'Delta', 'Beta 100 por cien'];
    const created = [];
    for (const title of titles) created.push(await createVideo(alice, { title }));
    await createVideo(bob, { title: 'De Bob' });

    const all = await t.call(api.videos.list, { as: viewer });
    expect(all.status).toBe(200);
    expect(all.body.items.map((v) => v.title)).toEqual([...titles].reverse());
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.items[0]).not.toHaveProperty('composition');
    expect(all.body.items[0]?.thumbnailUrl).toContain('/api/files/');

    // Keyset pagination: three pages of two, no overlaps, no gaps.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const res = await t.call(api.videos.list, {
        as: alice,
        query: { limit: 2, ...(cursor ? { cursor } : {}) },
      });
      seen.push(...res.body.items.map((v) => v.title));
      cursor = res.body.nextCursor ?? undefined;
      expect(Boolean(cursor)).toBe(page < 2);
    }
    expect(seen).toEqual([...titles].reverse());

    // Search is case-insensitive and treats % and _ as plain characters.
    const search = async (q: string) =>
      (await t.call(api.videos.list, { as: alice, query: { q } })).body.items.map((v) => v.title);
    expect(await search('beta')).toEqual(['Beta 100 por cien', 'Beta 100%']);
    expect(await search('100%')).toEqual(['Beta 100%']);
    expect(await search('a_x')).toEqual(['Gamma_x']);
    expect(await search('_')).toEqual(['Gamma_x']);

    // Status and batch filters.
    const first = created[0];
    if (!first) throw new Error('no video');
    await render(alice, first.id);
    const queued = await t.call(api.videos.list, { as: alice, query: { status: 'queued' } });
    expect(queued.body.items.map((v) => v.id)).toEqual([first.id]);
    const batchJobId = newId('batchJob');
    await t.db.insert(batchJobs).values({
      id: batchJobId,
      workspaceId: alice.workspace.id,
      name: 'Lote',
      composition: createComposition(),
      resolution: '720p',
      total: 1,
    });
    const second = created[1];
    if (!second) throw new Error('no video');
    await t.db.update(videos).set({ batchJobId }).where(eq(videos.id, second.id));
    const batch = await t.call(api.videos.list, { as: alice, query: { batchJobId } });
    expect(batch.body.items.map((v) => v.id)).toEqual([second.id]);
    expect(batch.body.items[0]?.batchJobId).toBe(batchJobId);

    // Isolation and validation.
    const bobs = await t.call(api.videos.list, { as: bob });
    expect(bobs.body.items.map((v) => v.title)).toEqual(['De Bob']);
    expect((await t.call(api.videos.list)).status).toBe(401);
    expect((await t.call(api.videos.list, { as: alice, query: { limit: 0 } })).status).toBe(400);
    expect(
      (await t.call(api.videos.list, { as: alice, query: { cursor: 'not-a-cursor' } })).status,
    ).toBe(400);
    expect(
      (await t.call(api.videos.list, { as: alice, query: { status: 'nope' as never } })).status,
    ).toBe(400);
  });

  it('returns one video, and 404 for another workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };

    const res = await t.call(api.videos.get, { as: viewer, params });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(video);

    expect((await t.call(api.videos.get, { params })).status).toBe(401);
    const foreign = await t.call(api.videos.get, { as: bob, params });
    expect(foreign.status).toBe(404);
    expect(foreign.error.code).toBe('NOT_FOUND');
    expect(
      (await t.call(api.videos.get, { as: alice, params: { videoId: newId('video') } })).status,
    ).toBe(404);
    expect((await t.call(api.videos.get, { as: alice, params: { videoId: 'nope' } })).status).toBe(
      400,
    );
  });
});

describe('autosave', () => {
  it('saves title and composition as new revisions and refreshes the poster', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, {
      composition: talkingComposition({ backgroundColor: '#1d4ed8' }),
    });
    const params = { videoId: video.id };

    const renamed = await t.call(api.videos.update, {
      as: alice,
      params,
      body: { title: 'Nuevo título', baseRevision: 1 },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'Nuevo título', revision: 2 });
    expect(renamed.body.composition).toEqual(video.composition);

    // Same document again: nothing changed, so the revision stays (a render is not outdated).
    const same = await t.call(api.videos.update, {
      as: alice,
      params,
      body: { title: 'Nuevo título', composition: video.composition, baseRevision: 2 },
    });
    expect(same.status).toBe(200);
    expect(same.body.revision).toBe(2);
    expect(same.body.updatedAt).toBe(renamed.body.updatedAt);

    const next: Composition = {
      ...talkingComposition({ backgroundColor: '#16a34a', scenes: 2 }),
      canvas: createComposition({ aspect: '1:1' }).canvas,
    };
    const saved = await t.call(api.videos.update, {
      as: alice,
      params,
      body: { composition: next, baseRevision: 2 },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ revision: 3, aspect: '1:1', title: 'Nuevo título' });
    expect(saved.body.composition).toEqual(next);
    expect(saved.body.estimatedDurationMs).toBe(Math.round(estimateCompositionDurationMs(next)));

    // The poster shows the new first scene in the new format, under a URL the browser has
    // not cached (same storage key, new revision).
    expect(saved.body.thumbnailUrl).not.toBe(video.thumbnailUrl);
    expect(saved.body.thumbnailUrl).toMatch(/&v=3$/);
    const image = await decodeJpeg((await fetchUrl(t, saved.body.thumbnailUrl ?? '')).rawPayload);
    expect(image.width).toBe(image.height);
    expect(near(image.at(6, 6), [0x16, 0xa3, 0x4a])).toBe(true);

    const stored = await t.call(api.videos.get, { as: alice, params });
    expect(stored.body).toEqual(saved.body);
  });

  it('draws the poster with the example values of the variables, only when it changes', async () => {
    const alice = await t.signUp();
    const composition = talkingComposition({ title: 'Oferta para {{nombre}}', scenes: 2 });
    composition.variables = [{ name: 'nombre', label: 'Nombre', defaultValue: 'Marta' }];
    const video = await createVideo(alice, { composition });
    const params = { videoId: video.id };
    const key = storageKeys.videoDraftThumb(alice.workspace.id, video.id);
    const stored = async () => Buffer.from(await t.app.providers.storage.get(key));
    const first = await stored();
    // Same pixels as the same document with the value written in (same ids: the renderer is
    // deterministic per scene and layer): the placeholder itself is not drawn.
    const written = structuredClone(composition);
    written.variables = [];
    for (const layer of written.scenes[0]?.layers ?? []) {
      if (layer.type === 'text') layer.text = 'Oferta para Marta';
    }
    const literal = await createVideo(alice, { composition: written });
    const literalPoster = Buffer.from(
      await t.app.providers.storage.get(
        storageKeys.videoDraftThumb(alice.workspace.id, literal.id),
      ),
    );
    expect(first.equals(literalPoster)).toBe(true);

    // Another example value: the first scene looks different, so the poster is redrawn.
    const renamed: Composition = {
      ...composition,
      variables: [{ name: 'nombre', label: 'Nombre', defaultValue: 'Maximiliano' }],
    };
    await t.call(api.videos.update, { as: alice, params, body: { composition: renamed } });
    const second = await stored();
    expect(second.equals(first)).toBe(false);

    // A change that the first scene does not show leaves the poster file alone.
    const before = await t.app.providers.storage.stat(key);
    const laterScene = structuredClone(renamed);
    const last = laterScene.scenes[1];
    if (last?.script.kind === 'tts') last.script.text = 'Otra narración en la segunda escena.';
    const saved = await t.call(api.videos.update, {
      as: alice,
      params,
      body: { composition: laterScene },
    });
    expect(saved.body.revision).toBe(3);
    expect((await stored()).equals(second)).toBe(true);
    const after = await t.app.providers.storage.stat(key);
    expect(after?.lastModified?.getTime()).toBe(before?.lastModified?.getTime());
  });

  it('rejects a save based on an old revision without changing anything', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };
    const first = await t.call(api.videos.update, {
      as: alice,
      params,
      body: { title: 'Pestaña A', baseRevision: 1 },
    });
    expect(first.body.revision).toBe(2);

    const stale = await t.call(api.videos.update, {
      as: alice,
      params,
      body: { title: 'Pestaña B', composition: talkingComposition({ scenes: 3 }), baseRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.error).toMatchObject({
      code: 'REVISION_CONFLICT',
      details: { currentRevision: 2 },
    });
    const after = await t.call(api.videos.get, { as: alice, params });
    expect(after.body).toMatchObject({ title: 'Pestaña A', revision: 2 });
    expect(after.body.composition.scenes).toHaveLength(1);

    // Without baseRevision the last write wins.
    const forced = await t.call(api.videos.update, { as: alice, params, body: { title: 'C' } });
    expect(forced.body).toMatchObject({ title: 'C', revision: 3 });
  });

  it('never applies two concurrent saves on the same revision', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };
    const results = await Promise.all(
      ['A', 'B', 'C', 'D'].map((title) =>
        t.call(api.videos.update, { as: alice, params, body: { title, baseRevision: 1 } }),
      ),
    );
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    const winner = results.find((res) => res.status === 200);
    const after = await t.call(api.videos.get, { as: alice, params });
    expect(after.body).toMatchObject({ revision: 2, title: winner?.body.title });
  });

  it('validates the body, the role and the workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const video = await createVideo(alice);
    const params = { videoId: video.id };

    expect((await t.call(api.videos.update, { params, body: { title: 'x' } })).status).toBe(401);
    expect(
      (await t.call(api.videos.update, { as: viewer, params, body: { title: 'x' } })).status,
    ).toBe(403);
    expect(
      (await t.call(api.videos.update, { as: bob, params, body: { title: 'x' } })).status,
    ).toBe(404);
    expect(
      (await t.call(api.videos.update, { as: alice, params, body: { title: ' ' } })).status,
    ).toBe(400);
    const badLayer = talkingComposition() as unknown as { scenes: { layers: unknown[] }[] };
    badLayer.scenes[0]?.layers.push({ type: 'hologram' });
    expect(
      (await t.call(api.videos.update, { as: alice, params, body: { composition: badLayer } }))
        .status,
    ).toBe(400);
    const after = await t.call(api.videos.get, { as: alice, params });
    expect(after.body).toMatchObject({ title: video.title, revision: 1 });
  });
});

describe('duplicate', () => {
  it('copies a video as a new draft with its own ids', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const source = await createVideo(alice, { templateId: 'builtin_greeting', title: 'Saludo' });
    await render(alice, source.id);
    await completeRender(t, source);
    const params = { videoId: source.id };

    const copy = await t.call(api.videos.duplicate, { as: alice, params });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      title: 'Saludo (copia)',
      status: 'draft',
      revision: 1,
      renderedRevision: null,
      videoUrl: null,
      durationMs: null,
      resolution: null,
      templateId: 'builtin_greeting',
      aspect: source.aspect,
      source: 'studio',
    });
    expect(copy.body.id).not.toBe(source.id);
    const sourceIds = source.composition.scenes.flatMap((scene) => [
      scene.id,
      ...scene.layers.map((layer) => layer.id),
    ]);
    const copyIds = copy.body.composition.scenes.flatMap((scene) => [
      scene.id,
      ...scene.layers.map((layer) => layer.id),
    ]);
    expect(copyIds).toHaveLength(sourceIds.length);
    expect(copyIds.some((id) => sourceIds.includes(id))).toBe(false);
    expect(copy.body.composition.scenes.map((scene) => scene.script)).toEqual(
      source.composition.scenes.map((scene) => scene.script),
    );
    // The copy has its own poster, not the files of the original.
    expect(copy.body.thumbnailUrl).toContain(copy.body.id);
    expect((await fetchUrl(t, copy.body.thumbnailUrl ?? '')).statusCode).toBe(200);

    const long = await createVideo(alice, { title: 'x'.repeat(120) });
    const longCopy = await t.call(api.videos.duplicate, {
      as: alice,
      params: { videoId: long.id },
    });
    expect(longCopy.body.title).toHaveLength(120);
    expect(longCopy.body.title.endsWith(' (copia)')).toBe(true);

    expect((await t.call(api.videos.duplicate, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.videos.duplicate, { as: bob, params })).status).toBe(404);
    expect((await t.call(api.videos.duplicate, { params })).status).toBe(401);
  });
});

describe('render', () => {
  it('queues a render through startRender: moderation, charge, snapshot and job', async () => {
    const alice = await t.signUp({ credits: 10 });
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };

    const res = await t.call(api.videos.render, { as: alice, params, body: {} });
    expect(res.status).toBe(202);
    const cost = creditsForRender(estimateCompositionDurationMs(video.composition), '720p');
    expect(res.body.renderJob).toMatchObject({
      videoId: video.id,
      status: 'queued',
      resolution: '720p',
      creditsCharged: cost,
      progress: 0,
      stage: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(res.body.video).toMatchObject({ id: video.id, status: 'queued', progress: 0 });
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(10 - cost);
    expect(t.queues.jobs('render')).toEqual([
      { renderJobId: res.body.renderJob.id, videoId: video.id, workspaceId: alice.workspace.id },
    ]);
    expect(t.queues.jobIds('render')).toEqual([res.body.renderJob.id]);
    expect(fakes.moderated.map((m) => m.context)).toEqual(['script']);

    // Already rendering: nothing else is charged or queued.
    const again = await t.call(api.videos.render, { as: alice, params, body: {} });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe('INVALID_STATE');
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(10 - cost);
    expect(t.queues.jobs('render')).toHaveLength(1);
  });

  it('reports the progress the worker persists while rendering', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const video = await createVideo(alice, { composition: talkingComposition() });
    await render(alice, video.id);
    await startRendering(t, video, { stage: 'frames', percent: 42, etaSec: 17 });

    const detail = await t.call(api.videos.get, { as: viewer, params: { videoId: video.id } });
    expect(detail.body).toMatchObject({
      status: 'rendering',
      progress: 42,
      renderStage: 'frames',
      renderEtaSec: 17,
    });
    const list = await t.call(api.videos.list, { as: viewer, query: { status: 'rendering' } });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      id: video.id,
      progress: 42,
      renderStage: 'frames',
      renderEtaSec: 17,
    });
    const jobs = await t.call(api.videos.renderJobs, {
      as: viewer,
      params: { videoId: video.id },
    });
    expect(jobs.body.items).toHaveLength(1);
    expect(jobs.body.items[0]).toMatchObject({
      status: 'running',
      stage: 'frames',
      progress: 42,
      etaSec: 17,
    });
  });

  it('exposes the output of a completed render with named downloads', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, {
      title: 'Lanzamiento: otoño/2026',
      composition: talkingComposition(),
    });
    await render(alice, video.id);
    await completeRender(t, video, { durationMs: 4200 });

    const res = await t.call(api.videos.get, { as: alice, params: { videoId: video.id } });
    expect(res.body).toMatchObject({
      status: 'completed',
      progress: 100,
      durationMs: 4200,
      resolution: '720p',
      renderedRevision: 1,
      revision: 1,
      renderStage: null,
      renderEtaSec: null,
      providers: { tts: { id: 'espeak', quality: 'basic' } },
    });
    expect(res.body.renderedAt).not.toBeNull();

    const play = await fetchUrl(t, res.body.videoUrl ?? '');
    expect(play.statusCode).toBe(200);
    expect(play.headers['content-type']).toBe('video/mp4');
    expect(play.headers['content-disposition']).toBeUndefined();
    expect(play.body).toBe('fake mp4 bytes');

    const disposition = async (url: string | null) =>
      (await fetchUrl(t, url ?? '')).headers['content-disposition'];
    expect(await disposition(res.body.downloadUrl)).toBe(
      'attachment; filename="Lanzamiento_ otono_2026.mp4"',
    );
    expect(await disposition(res.body.srtUrl)).toBe(
      'attachment; filename="Lanzamiento_ otono_2026.srt"',
    );
    expect(await disposition(res.body.vttUrl)).toBe(
      'attachment; filename="Lanzamiento_ otono_2026.vtt"',
    );
    expect((await fetchUrl(t, res.body.vttUrl ?? '')).body).toContain('WEBVTT');
    // The thumbnail is now the one of the render, not the draft poster.
    expect(res.body.thumbnailUrl).toContain('thumb.jpg');
    expect(res.body.thumbnailUrl).not.toContain('draft-thumb');

    // Editing afterwards marks the output as outdated but keeps it (and its thumbnail).
    const edited = await t.call(api.videos.update, {
      as: alice,
      params: { videoId: video.id },
      body: { composition: talkingComposition({ backgroundColor: '#000000' }) },
    });
    expect(edited.body).toMatchObject({ status: 'completed', revision: 2, renderedRevision: 1 });
    expect(edited.body.videoUrl).toBe(res.body.videoUrl);
    expect(edited.body.thumbnailUrl).toBe(res.body.thumbnailUrl);

    // A tampered or unsigned file URL gives nothing away.
    const url = new URL(res.body.videoUrl ?? '');
    url.searchParams.set('sig', 'a'.repeat(64));
    expect((await fetchUrl(t, url.toString())).statusCode).toBe(403);
  });

  it('refuses blocked content, plan limits, missing credits and bad references', async () => {
    const alice = await t.signUp({ credits: 5 });
    const attempt = async (composition: Composition, body: Record<string, unknown> = {}) => {
      const video = await createVideo(alice, { composition });
      return t.call(api.videos.render, { as: alice, params: { videoId: video.id }, body });
    };

    const blocked = await attempt(talkingComposition({ text: `Esto es ${BLOCKED_WORD}.` }));
    expect(blocked.status).toBe(422);
    expect(blocked.error.code).toBe('CONTENT_BLOCKED');

    // Free plan: at most 10 scenes and 720p. Saving more scenes is allowed; rendering is not.
    const scenes = await attempt(talkingComposition({ scenes: 11 }));
    expect(scenes.status).toBe(403);
    expect(scenes.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxScenesPerVideo', max: 10, value: 11 },
    });
    const resolution = await attempt(talkingComposition(), { resolution: '1080p' });
    expect(resolution.status).toBe(403);
    expect(resolution.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxResolution' },
    });

    const unknownAvatar = await attempt(talkingComposition({ avatarId: 'stock_nadie' }));
    expect(unknownAvatar.status).toBe(422);
    expect(unknownAvatar.error.code).toBe('UNPROCESSABLE');

    // Photorealistic avatars need the neural engine to be up.
    const photoreal = await attempt(talkingComposition({ avatarId: TEST_PHOTOREAL_AVATAR }));
    expect(photoreal.status).toBe(503);
    expect(photoreal.error.code).toBe('SERVICE_UNAVAILABLE');

    expect((await attempt(talkingComposition(), { resolution: '4k' })).status).toBe(400);

    // Not enough credits for a render that is otherwise fine.
    const poor = await t.signUp({ credits: 0 });
    const unpaid = await createVideo(poor, { composition: talkingComposition() });
    const broke = await t.call(api.videos.render, {
      as: poor,
      params: { videoId: unpaid.id },
      body: {},
    });
    expect(broke.status).toBe(402);
    expect(broke.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(await getCreditBalance(t.db, poor.workspace.id)).toBe(0);

    // None of the refused renders charged, queued or left a job behind.
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(5);
    expect(t.queues.size).toBe(0);
    expect(await t.db.$count(renderJobs)).toBe(0);
    const drafts = await t.call(api.videos.list, { as: alice, query: { status: 'draft' } });
    expect(drafts.body.items).toHaveLength(6);
  });

  it('charges double for photorealistic avatars once the engine is available', async () => {
    const alice = await t.signUp({ credits: 10 });
    fakes.engine = {
      available: true,
      reason: null,
      device: 'cpu',
      secondsPerVideoSecond: 20,
      operations: { generate: true, prepare: true, animate: true },
    };
    const video = await createVideo(alice, {
      composition: talkingComposition({ avatarId: TEST_PHOTOREAL_AVATAR }),
    });
    expect(video.usesPhotorealAvatars).toBe(true);
    const started = await render(alice, video.id);
    const base = creditsForRender(estimateCompositionDurationMs(video.composition), '720p');
    expect(started.renderJob.creditsCharged).toBe(base * 2);
    expect(started.video.usesPhotorealAvatars).toBe(true);
  });

  it('requires the editor role and the same workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };

    expect((await t.call(api.videos.render, { params, body: {} })).status).toBe(401);
    expect((await t.call(api.videos.render, { as: viewer, params, body: {} })).status).toBe(403);
    expect((await t.call(api.videos.render, { as: bob, params, body: {} })).status).toBe(404);
    expect((await t.call(api.videos.renderJobs, { as: bob, params })).status).toBe(404);
    expect((await t.call(api.videos.renderJobs, { params })).status).toBe(401);
    expect(t.queues.size).toBe(0);
    expect(await getCreditBalance(t.db, bob.workspace.id)).toBe(bob.workspace.credits);
  });
});

describe('cancel render', () => {
  it('cancels a queued render, refunds it and returns the video to draft', async () => {
    const alice = await t.signUp({ credits: 10 });
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };
    const started = await render(alice, video.id);
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBeLessThan(10);

    const res = await t.call(api.videos.cancelRender, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'draft',
      progress: 0,
      error: null,
      renderStage: null,
      videoUrl: null,
    });
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(10);
    expect(t.queues.jobs('render')).toEqual([]);
    const jobs = await t.call(api.videos.renderJobs, { as: alice, params });
    expect(jobs.body.items).toHaveLength(1);
    expect(jobs.body.items[0]).toMatchObject({
      id: started.renderJob.id,
      status: 'canceled',
      creditsCharged: 0,
    });
    expect(jobs.body.items[0]?.finishedAt).not.toBeNull();
    const ledger = await t.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.refId, started.renderJob.id));
    expect(ledger.map((entry) => entry.reason).sort()).toEqual(['refund', 'render']);

    // Nothing left to cancel; and the video can be rendered again.
    const again = await t.call(api.videos.cancelRender, { as: alice, params });
    expect(again.status).toBe(409);
    expect(again.error.code).toBe('INVALID_STATE');
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(10);
    expect((await t.call(api.videos.render, { as: alice, params, body: {} })).status).toBe(202);
  });

  it('returns to the previous output when a re-render is cancelled', async () => {
    const alice = await t.signUp({ credits: 10 });
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };
    await render(alice, video.id);
    await completeRender(t, video);
    const completed = await t.call(api.videos.get, { as: alice, params });
    const balance = await getCreditBalance(t.db, alice.workspace.id);

    await t.call(api.videos.update, { as: alice, params, body: { title: 'Segunda versión' } });
    await render(alice, video.id);
    await startRendering(t, video, { stage: 'audio', percent: 12, etaSec: null });
    // The current output stays available while the new render runs.
    const during = await t.call(api.videos.get, { as: alice, params });
    expect(during.body).toMatchObject({ status: 'rendering', progress: 12, renderedRevision: 1 });
    expect(during.body.videoUrl).toBe(completed.body.videoUrl);

    const res = await t.call(api.videos.cancelRender, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'completed',
      progress: 100,
      revision: 2,
      renderedRevision: 1,
      durationMs: completed.body.durationMs,
    });
    expect(res.body.videoUrl).toBe(completed.body.videoUrl);
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(balance);
    const jobs = await t.call(api.videos.renderJobs, { as: alice, params });
    expect(jobs.body.items.map((job) => job.status)).toEqual(['canceled', 'completed']);
  });

  it('returns to failed when the previous render had failed', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };
    const first = await render(alice, video.id);
    const error = { code: 'PROVIDER_ERROR' as const, message: 'The voice provider failed' };
    await t.db
      .update(renderJobs)
      .set({ status: 'failed', error, finishedAt: new Date(), creditsCharged: 0 })
      .where(eq(renderJobs.id, first.renderJob.id));
    await t.db.update(videos).set({ status: 'failed', error }).where(eq(videos.id, video.id));

    await render(alice, video.id);
    const res = await t.call(api.videos.cancelRender, { as: alice, params });
    expect(res.body).toMatchObject({ status: 'failed', error, progress: 0 });
  });

  it('releases the row of a batch whose video is cancelled by hand', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, { composition: talkingComposition() });
    const batchJobId = newId('batchJob');
    await t.db.insert(batchJobs).values({
      id: batchJobId,
      workspaceId: alice.workspace.id,
      name: 'Lote',
      composition: video.composition,
      resolution: '720p',
      total: 1,
      status: 'processing',
    });
    await t.db.insert(batchItems).values({
      id: newId('batchItem'),
      workspaceId: alice.workspace.id,
      batchJobId,
      index: 0,
      values: {},
      status: 'queued',
      videoId: video.id,
    });
    await t.db.update(videos).set({ batchJobId }).where(eq(videos.id, video.id));
    await render(alice, video.id);

    const res = await t.call(api.videos.cancelRender, { as: alice, params: { videoId: video.id } });
    expect(res.status).toBe(200);
    const [item] = await t.db
      .select()
      .from(batchItems)
      .where(eq(batchItems.batchJobId, batchJobId));
    expect(item?.status).toBe('canceled');
    const [batch] = await t.db.select().from(batchJobs).where(eq(batchJobs.id, batchJobId));
    expect(batch).toMatchObject({ status: 'canceled', creditsCharged: 0 });
  });

  it('requires the editor role and the same workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const video = await createVideo(alice, { composition: talkingComposition() });
    const params = { videoId: video.id };
    await render(alice, video.id);

    expect((await t.call(api.videos.cancelRender, { params })).status).toBe(401);
    expect((await t.call(api.videos.cancelRender, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.videos.cancelRender, { as: bob, params })).status).toBe(404);
    const after = await t.call(api.videos.get, { as: alice, params });
    expect(after.body.status).toBe('queued');
    expect(t.queues.jobs('render')).toHaveLength(1);
  });
});

describe('delete', () => {
  it('deletes the video with its files, render history and share link', async () => {
    const alice = await t.signUp();
    const video = await createVideo(alice, { composition: talkingComposition() });
    const other = await createVideo(alice, { title: 'Se queda' });
    const params = { videoId: video.id };
    await render(alice, video.id);
    await completeRender(t, video);
    await t.db.insert(shareLinks).values({
      id: newId('shareLink'),
      workspaceId: alice.workspace.id,
      videoId: video.id,
      token: 'tokentokentokentokentoken',
    });
    const before = await t.call(api.videos.get, { as: alice, params });
    const prefix = storageKeys.videoPrefix(alice.workspace.id, video.id);
    expect(await storedFiles(prefix)).toHaveLength(5);

    const res = await t.call(api.videos.remove, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await t.call(api.videos.get, { as: alice, params })).status).toBe(404);
    expect(await storedFiles(prefix)).toEqual([]);
    expect((await fetchUrl(t, before.body.videoUrl ?? '')).statusCode).toBe(404);
    expect(await t.db.$count(renderJobs, eq(renderJobs.videoId, video.id))).toBe(0);
    expect(await t.db.$count(shareLinks, eq(shareLinks.videoId, video.id))).toBe(0);
    // The other video and its poster are untouched.
    const kept = await t.call(api.videos.get, { as: alice, params: { videoId: other.id } });
    expect(kept.status).toBe(200);
    expect((await fetchUrl(t, kept.body.thumbnailUrl ?? '')).statusCode).toBe(200);
    expect((await t.call(api.videos.remove, { as: alice, params })).status).toBe(404);
  });

  it('cancels and refunds the render in progress of a deleted video', async () => {
    const alice = await t.signUp({ credits: 10 });
    const video = await createVideo(alice, { composition: talkingComposition() });
    await render(alice, video.id);
    await startRendering(t, video, { stage: 'frames', percent: 60, etaSec: 3 });
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBeLessThan(10);

    const res = await t.call(api.videos.remove, { as: alice, params: { videoId: video.id } });
    expect(res.status).toBe(200);
    expect(await getCreditBalance(t.db, alice.workspace.id)).toBe(10);
    expect(t.queues.jobs('render')).toEqual([]);
    expect(await t.db.$count(videos, eq(videos.id, video.id))).toBe(0);
  });

  it('requires the editor role and never deletes across workspaces', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const video = await createVideo(alice);
    const params = { videoId: video.id };

    expect((await t.call(api.videos.remove, { params })).status).toBe(401);
    expect((await t.call(api.videos.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.videos.remove, { as: bob, params })).status).toBe(404);
    expect((await t.call(api.videos.get, { as: alice, params })).status).toBe(200);
    expect(await storedFiles(storageKeys.videoPrefix(alice.workspace.id, video.id))).toHaveLength(
      1,
    );
  });
});

describe('save as template', () => {
  it('saves the composition as a custom template with poster and variables', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const composition = talkingComposition({
      text: 'Hola {{nombre}}, tu pedido {{pedido}} está listo.',
      title: 'Para {{nombre}}',
      backgroundColor: '#16a34a',
    });
    composition.variables = [
      { name: 'nombre', label: 'Nombre', defaultValue: 'Marta' },
      { name: 'sobra', label: 'No se usa', defaultValue: 'x' },
    ];
    const video = await createVideo(alice, { composition });
    const params = { videoId: video.id };

    const res = await t.call(api.videos.saveAsTemplate, {
      as: alice,
      params,
      body: { name: 'Aviso de pedido', description: 'Para clientes', category: 'product' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'custom',
      workspaceId: alice.workspace.id,
      name: 'Aviso de pedido',
      description: 'Para clientes',
      category: 'product',
      aspect: '16:9',
      sceneCount: 1,
      tags: [],
    });
    expect(res.body.id).toMatch(/^tpl_/);
    // Declared variables follow the placeholders actually used.
    expect(res.body.composition.variables).toEqual([
      { name: 'nombre', label: 'Nombre', defaultValue: 'Marta' },
      { name: 'pedido', label: '', defaultValue: '' },
    ]);
    // The template is its own document: same content, different ids.
    expect(res.body.composition.scenes[0]?.id).not.toBe(video.composition.scenes[0]?.id);
    expect(res.body.composition.scenes[0]?.script).toEqual(video.composition.scenes[0]?.script);
    const poster = await fetchUrl(t, res.body.thumbnailUrl ?? '');
    expect(poster.statusCode).toBe(200);
    const image = await decodeJpeg(poster.rawPayload);
    expect(near(image.at(6, 6), [0x16, 0xa3, 0x4a])).toBe(true);
    expect(res.body.thumbnailUrl).toContain(
      encodeURI(storageKeys.templateThumb(alice.workspace.id, res.body.id)),
    );

    const defaults = await t.call(api.videos.saveAsTemplate, {
      as: alice,
      params,
      body: { name: 'Otra' },
    });
    expect(defaults.body).toMatchObject({ description: '', category: 'other' });

    expect((await t.call(api.videos.saveAsTemplate, { as: alice, params, body: {} })).status).toBe(
      400,
    );
    expect(
      (await t.call(api.videos.saveAsTemplate, { as: viewer, params, body: { name: 'x' } })).status,
    ).toBe(403);
    expect(
      (await t.call(api.videos.saveAsTemplate, { as: bob, params, body: { name: 'x' } })).status,
    ).toBe(404);
    expect(await t.db.$count(templates)).toBe(2);
    expect(await t.db.$count(templates, eq(templates.workspaceId, bob.workspace.id))).toBe(0);
  });
});

describe('apply brand kit', () => {
  it('applies the colours and fonts of a kit of the workspace as a new revision', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const kit = async (workspaceId: string) => {
      const id = newId('brandKit');
      await t.db.insert(brandKits).values({
        id,
        workspaceId,
        name: 'Marca',
        colors: BrandColorsSchema.parse({ background: '#aa0000', accent: '#00ff88' }),
        fonts: BrandFontsSchema.parse({ heading: 'Poppins', body: 'Inter' }),
      });
      return id;
    };
    const brandKitId = await kit(alice.workspace.id);
    const foreignKitId = await kit(bob.workspace.id);
    const composition = talkingComposition();
    const background = composition.scenes[0]?.background;
    if (background?.type === 'color') background.brandRole = 'background';
    const video = await createVideo(alice, { composition });
    const params = { videoId: video.id };

    const res = await t.call(api.videos.applyBrandKit, { as: alice, params, body: { brandKitId } });
    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(2);
    expect(res.body.composition.brandKitId).toBe(brandKitId);
    expect(res.body.composition.scenes[0]?.background).toMatchObject({
      type: 'color',
      color: '#aa0000',
    });
    expect(res.body.composition.subtitles.highlightColor).toBe('#00ff88');
    // The poster follows the new look.
    const image = await decodeJpeg((await fetchUrl(t, res.body.thumbnailUrl ?? '')).rawPayload);
    expect(near(image.at(6, 6), [0xaa, 0x00, 0x00])).toBe(true);

    const foreign = await t.call(api.videos.applyBrandKit, {
      as: alice,
      params,
      body: { brandKitId: foreignKitId },
    });
    expect(foreign.status).toBe(404);
    expect(
      (await t.call(api.videos.applyBrandKit, { as: viewer, params, body: { brandKitId } })).status,
    ).toBe(403);
    expect(
      (await t.call(api.videos.applyBrandKit, { as: bob, params, body: { brandKitId } })).status,
    ).toBe(404);
    expect((await t.call(api.videos.applyBrandKit, { as: alice, params, body: {} })).status).toBe(
      400,
    );
    const after = await t.call(api.videos.get, { as: alice, params });
    expect(after.body.revision).toBe(2);
  });
});
