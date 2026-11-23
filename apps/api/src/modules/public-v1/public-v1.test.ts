import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PublicVideoSchema,
  api,
  creditsForRender,
  estimateCompositionDurationMs,
  listUsedVariables,
  newId,
} from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { hashApiKey, storageKeys } from '@parlante/shared/node';
import {
  apiKeys,
  assets,
  avatars,
  eq,
  getCreditBalance,
  renderJobs,
  videos,
  workspaces,
} from '@parlante/db';
import { getBuiltinTemplate, listBuiltinTemplates } from '@parlante/templates';
import { createTestApp } from '../../testing/index';
import type { TestApiKeyActor, TestApp } from '../../testing/index';
import { pngBytes } from '../assets/test-fixtures';
import templatesModule from '../templates/index';
import videosModule from '../videos/index';
import {
  BLOCKED_WORD,
  TEST_AVATAR,
  TEST_VOICE,
  completeRender,
  fetchUrl,
  installFakeProviders,
  storedKeys,
  talkingComposition,
} from '../videos/test-support';
import publicV1Module from './index';
import { KeyRateLimiter, V1_RATE_LIMITS } from './rate-limit';

let t: TestApp;
const modules = [videosModule, templatesModule, publicV1Module];

beforeAll(async () => {
  t = await createTestApp({ modules });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  installFakeProviders(t);
});

const scriptInput = (text = 'Hola, esto es una prueba de la API.') => ({
  type: 'script' as const,
  text,
  avatarId: TEST_AVATAR,
  voiceId: TEST_VOICE,
});

async function workspaceWithKey(options: Parameters<TestApp['signUp']>[0] = {}) {
  const owner = await t.signUp(options);
  const key = await t.apiKeyFor(owner.workspace, 'Integración');
  return { owner, key };
}

async function createVideo(key: TestApiKeyActor, body: Record<string, unknown>) {
  const res = await t.call(api.v1.createVideo, { as: key, body });
  if (res.status !== 202) throw new Error(`Create failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('authentication', () => {
  it('accepts only a live API key, stored as a hash, and records its last use', async () => {
    const { owner, key } = await workspaceWithKey({ name: 'Acme' });
    const [stored] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, key.apiKeyId));
    expect(stored?.keyHash).toBe(hashApiKey(key.apiKey));
    expect(JSON.stringify(stored)).not.toContain(key.apiKey);
    expect(stored?.lastUsedAt).toBeNull();

    const me = await t.call(api.v1.me, { as: key });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      workspace: {
        id: owner.workspace.id,
        name: owner.workspace.name,
        plan: 'free',
        credits: owner.workspace.credits,
      },
      apiKey: { id: key.apiKeyId, name: 'Integración', prefix: stored?.prefix },
    });
    expect(JSON.stringify(me.body)).not.toContain(key.apiKey);
    const [used] = await t.db.select().from(apiKeys).where(eq(apiKeys.id, key.apiKeyId));
    expect(used?.lastUsedAt).toBeInstanceOf(Date);
    expect(Date.now() - (used?.lastUsedAt?.getTime() ?? 0)).toBeLessThan(10_000);

    const call = (authorization?: string) =>
      t.inject({
        method: 'GET',
        url: '/v1/me',
        headers: authorization ? { authorization } : {},
      });
    for (const header of [
      undefined,
      'Bearer',
      'Bearer plk_aaaaaaaa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `Basic ${key.apiKey}`,
      `Bearer ${key.apiKey.slice(0, -1)}${key.apiKey.endsWith('x') ? 'y' : 'x'}`,
      `Bearer ${stored?.keyHash ?? ''}`,
    ]) {
      const res = await call(header);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'INVALID_API_KEY' } });
    }
    // A session cookie is not a credential for the public API…
    const withCookie = await t.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { cookie: owner.cookie },
    });
    expect(withCookie.statusCode).toBe(401);
    // …and an API key is not one for the first-party API.
    expect((await t.call(api.videos.list, { as: key as never })).status).toBe(401);

    await t.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key.apiKeyId));
    const revoked = await t.call(api.v1.me, { as: key });
    expect(revoked.status).toBe(401);
    expect(revoked.error.code).toBe('INVALID_API_KEY');
  });

  it('requires a key on every route of the public API', async () => {
    const routes = Object.values(api.v1);
    expect(routes.map((route) => route.path).every((path) => path.startsWith('/v1/'))).toBe(true);
    for (const route of routes) {
      const url = route.path.replace(':videoId', newId('video'));
      // A well-formed request, so the only thing missing is the credential.
      const res = await t.inject({
        method: route.method,
        url,
        ...('body' in route ? { payload: { input: scriptInput() } } : {}),
      });
      expect([route.method, route.path, res.statusCode]).toEqual([route.method, route.path, 401]);
      expect(res.json()).toMatchObject({ error: { code: 'INVALID_API_KEY' } });
    }
  });
});

describe('catalogues', () => {
  it('lists the avatars a video can use right now', async () => {
    const { owner, key } = await workspaceWithKey();
    const other = await workspaceWithKey();
    const avatar = (workspaceId: string, name: string, status: 'ready' | 'processing') => ({
      id: newId('avatar'),
      workspaceId,
      name,
      status,
      origin: 'generated' as const,
      prompt: 'Persona sintética',
    });
    const mine = avatar(owner.workspace.id, 'Mía', 'ready');
    await t.db
      .insert(avatars)
      .values([
        mine,
        avatar(owner.workspace.id, 'En preparación', 'processing'),
        avatar(other.owner.workspace.id, 'Ajena', 'ready'),
      ]);

    const res = await t.call(api.v1.listAvatars, { as: key });
    expect(res.status).toBe(200);
    const ids = res.body.items.map((item) => item.id);
    expect(ids).toContain(TEST_AVATAR);
    expect(ids).toContain('real_lucia');
    expect(ids).toContain(mine.id);
    expect(res.body.items.every((item) => item.status === 'ready')).toBe(true);
    expect(res.body.items.map((item) => item.name)).not.toContain('Ajena');
    expect(res.body.items.map((item) => item.name)).not.toContain('En preparación');
    const instant = res.body.items.find((item) => item.id === TEST_AVATAR);
    expect(instant).toMatchObject({ kind: 'stock', rendering: 'instant' });
    expect(res.body.items.find((item) => item.id === 'real_lucia')?.rendering).toBe('photoreal');
  });

  it('lists voices, optionally by language', async () => {
    const { key } = await workspaceWithKey();
    const all = await t.call(api.v1.listVoices, { as: key });
    expect(all.status).toBe(200);
    expect(all.body.items.map((voice) => voice.id).sort()).toEqual(['espeak:en-f1', TEST_VOICE]);
    expect(all.body.items[0]?.provider).toMatchObject({ id: 'espeak', quality: 'basic' });
    const english = await t.call(api.v1.listVoices, { as: key, query: { language: 'en' } });
    expect(english.body.items.map((voice) => voice.id)).toEqual(['espeak:en-f1']);
    expect(
      (await t.call(api.v1.listVoices, { as: key, query: { language: 'xx' as never } })).status,
    ).toBe(400);
  });

  it('lists built-in and own templates, in the language asked for', async () => {
    const { owner, key } = await workspaceWithKey();
    const other = await workspaceWithKey();
    for (const account of [owner, other.owner]) {
      const video = await t.call(api.videos.create, { as: account, body: {} });
      await t.call(api.videos.saveAsTemplate, {
        as: account,
        params: { videoId: video.body.id },
        body: { name: `Plantilla de ${account.workspace.id}` },
      });
    }
    const res = await t.call(api.v1.listTemplates, { as: key });
    expect(res.status).toBe(200);
    const builtin = res.body.items.filter((item) => item.kind === 'builtin');
    const custom = res.body.items.filter((item) => item.kind === 'custom');
    expect(builtin.map((item) => item.name)).toEqual(
      listBuiltinTemplates('es').map((template) => template.name.es),
    );
    expect(custom.map((item) => item.name)).toEqual([`Plantilla de ${owner.workspace.id}`]);
    expect(builtin[0]?.thumbnailUrl).toMatch(/^http:\/\/api\.test\/api\/templates\/builtin_/);

    const english = await t.call(api.v1.listTemplates, {
      as: key,
      headers: { 'accept-language': 'en-GB,en;q=0.9' },
    });
    expect(english.body.items.filter((item) => item.kind === 'builtin')[0]?.name).toBe(
      listBuiltinTemplates('en')[0]?.name.en,
    );
  });
});

describe('create video', () => {
  it('creates a video from a script and queues its render', async () => {
    const { owner, key } = await workspaceWithKey({ credits: 10 });
    const res = await t.call(api.v1.createVideo, {
      as: key,
      body: { input: scriptInput(), title: 'Desde la API' },
    });
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(PublicVideoSchema.shape).sort());
    expect(res.body).toMatchObject({
      title: 'Desde la API',
      status: 'queued',
      progress: 0,
      aspect: '16:9',
      videoUrl: null,
      downloadUrl: null,
      srtUrl: null,
      vttUrl: null,
      aiGenerated: false,
      error: null,
      renderedAt: null,
    });
    expect(res.body.thumbnailUrl).toContain('draft-thumb.jpg');

    const [row] = await t.db.select().from(videos).where(eq(videos.id, res.body.id));
    expect(row).toMatchObject({
      workspaceId: owner.workspace.id,
      source: 'api',
      createdBy: null,
      templateId: null,
    });
    const [job] = await t.db.select().from(renderJobs).where(eq(renderJobs.videoId, res.body.id));
    expect(job).toMatchObject({ status: 'queued', resolution: '720p', createdBy: null });
    expect(t.queues.jobs('render')).toEqual([
      { renderJobId: job?.id, videoId: res.body.id, workspaceId: owner.workspace.id },
    ]);
    const cost = creditsForRender(
      estimateCompositionDurationMs(row?.composition as Composition),
      '720p',
    );
    expect(await getCreditBalance(t.db, owner.workspace.id)).toBe(10 - cost);
    // The script became the standard one-scene layout, with the options defaulted.
    const scene = row?.composition.scenes[0];
    expect(scene?.script).toMatchObject({
      kind: 'tts',
      text: 'Hola, esto es una prueba de la API.',
      voiceId: TEST_VOICE,
      language: 'es',
    });
    expect(row?.composition.subtitles.enabled).toBe(true);

    // The owner sees it in the app, labelled as created by the API.
    const inApp = await t.call(api.videos.get, { as: owner, params: { videoId: res.body.id } });
    expect(inApp.body).toMatchObject({ source: 'api', createdBy: null, status: 'queued' });

    // Without a title, the beginning of the script names the video.
    const untitled = await workspaceWithKey();
    const long = await createVideo(untitled.key, {
      input: scriptInput(`${'Una frase bastante larga para el título. '.repeat(4)}`),
      render: false,
    });
    expect(long.title.length).toBeLessThanOrEqual(60);
    expect(long.title.endsWith('…')).toBe(true);
  });

  it('fills the variables of a template for the render and keeps them on the video', async () => {
    const { key } = await workspaceWithKey({ credits: 20, plan: 'creator' });
    const template = getBuiltinTemplate('builtin_greeting');
    if (!template) throw new Error('missing template');
    const res = await t.call(api.v1.createVideo, {
      as: key,
      body: {
        input: {
          type: 'template',
          templateId: 'builtin_greeting',
          variables: { nombre: 'Lucía', remitente: 'el equipo de soporte' },
        },
        resolution: '1080p',
      },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ title: template.name.es, status: 'queued', aspect: '1:1' });

    const [row] = await t.db.select().from(videos).where(eq(videos.id, res.body.id));
    const [job] = await t.db.select().from(renderJobs).where(eq(renderJobs.videoId, res.body.id));
    expect(row?.templateId).toBe('builtin_greeting');
    expect(job?.resolution).toBe('1080p');
    // The snapshot being rendered has every placeholder replaced…
    const rendered = JSON.stringify(job?.composition);
    expect(listUsedVariables(job?.composition as Composition)).toEqual([]);
    expect(rendered).toContain('Lucía');
    expect(rendered).toContain('el equipo de soporte');
    expect(rendered).not.toContain('Marta');
    // …while the video keeps its placeholders, with the values sent as defaults, so a later
    // render from the app says the same.
    expect(listUsedVariables(row?.composition as Composition)).toEqual(
      listUsedVariables(template.composition),
    );
    const defaults = Object.fromEntries(
      (row?.composition.variables ?? []).map((v) => [v.name, v.defaultValue]),
    );
    const original = Object.fromEntries(
      template.composition.variables.map((v) => [v.name, v.defaultValue]),
    );
    expect(defaults).toEqual({ ...original, nombre: 'Lucía', remitente: 'el equipo de soporte' });
    // Fresh ids: the video does not share scene ids with the template.
    expect(row?.composition.scenes[0]?.id).not.toBe(template.composition.scenes[0]?.id);
  });

  it('rejects variables that do not match the placeholders, creating nothing', async () => {
    const { owner, key } = await workspaceWithKey();
    const unknown = await t.call(api.v1.createVideo, {
      as: key,
      body: {
        input: { type: 'template', templateId: 'builtin_greeting', variables: { nombr: 'Lucía' } },
      },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.error).toMatchObject({
      code: 'UNPROCESSABLE',
      details: { unknown: ['nombr'], missing: [] },
    });

    const composition = talkingComposition({ text: 'Hola {{nombre}}, tu código es {{codigo}}.' });
    composition.variables = [{ name: 'nombre', label: '', defaultValue: 'cliente' }];
    const missing = await t.call(api.v1.createVideo, {
      as: key,
      body: { input: { type: 'composition', composition, variables: {} } },
    });
    expect(missing.status).toBe(422);
    expect(missing.error).toMatchObject({
      code: 'UNPROCESSABLE',
      details: { missing: ['codigo'], unknown: [], expected: ['nombre', 'codigo'] },
    });
    expect(await t.db.$count(videos)).toBe(0);
    expect(t.queues.size).toBe(0);

    // With the value, the same document renders; `nombre` falls back to its default.
    const ok = await createVideo(key, {
      input: { type: 'composition', composition, variables: { codigo: 'A-42' } },
    });
    const [job] = await t.db.select().from(renderJobs).where(eq(renderJobs.videoId, ok.id));
    const text = job?.composition.scenes[0]?.script;
    expect(text).toMatchObject({ text: 'Hola cliente, tu código es A-42.' });
    expect(ok.title).toBe('Vídeo sin título');
    expect(await t.db.$count(videos, eq(videos.workspaceId, owner.workspace.id))).toBe(1);
  });

  it('only creates the draft when render is false', async () => {
    const { owner, key } = await workspaceWithKey({ credits: 10 });
    const composition = talkingComposition({ scenes: 2 });
    const res = await t.call(api.v1.createVideo, {
      as: key,
      body: { input: { type: 'composition', composition }, render: false, title: 'Borrador' },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'draft', title: 'Borrador', resolution: null });
    expect(t.queues.size).toBe(0);
    expect(await t.db.$count(renderJobs)).toBe(0);
    expect(await getCreditBalance(t.db, owner.workspace.id)).toBe(10);
    const [row] = await t.db.select().from(videos).where(eq(videos.id, res.body.id));
    expect(row?.composition).toEqual(composition);
    // It can be rendered later from the app.
    const later = await t.call(api.videos.render, {
      as: owner,
      params: { videoId: res.body.id },
      body: {},
    });
    expect(later.status).toBe(202);
  });

  it('leaves nothing behind when the render cannot start', async () => {
    const { owner, key } = await workspaceWithKey({ credits: 3 });
    const failed = async (body: Record<string, unknown>) =>
      t.call(api.v1.createVideo, { as: key, body });

    const blocked = await failed({ input: scriptInput(`Texto ${BLOCKED_WORD} aquí.`) });
    expect(blocked.status).toBe(422);
    expect(blocked.error.code).toBe('CONTENT_BLOCKED');

    const resolution = await failed({ input: scriptInput(), resolution: '1080p' });
    expect(resolution.status).toBe(403);
    expect(resolution.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxResolution' },
    });
    const scenes = await failed({
      input: { type: 'composition', composition: talkingComposition({ scenes: 11 }) },
    });
    expect(scenes.status).toBe(403);
    expect(scenes.error.details).toMatchObject({ limit: 'maxScenesPerVideo', max: 10 });

    const avatar = await failed({ input: { ...scriptInput(), avatarId: 'stock_nadie' } });
    expect(avatar.status).toBe(422);
    expect(avatar.error.code).toBe('UNPROCESSABLE');
    const voice = await failed({ input: { ...scriptInput(), voiceId: 'acme:nobody' } });
    expect(voice.status).toBe(503);
    expect(voice.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    const photoreal = await failed({ input: { ...scriptInput(), avatarId: 'real_lucia' } });
    expect(photoreal.status).toBe(503);
    expect(photoreal.error.code).toBe('SERVICE_UNAVAILABLE');

    await t.db.update(workspaces).set({ credits: 0 }).where(eq(workspaces.id, owner.workspace.id));
    const broke = await failed({ input: scriptInput() });
    expect(broke.status).toBe(402);
    expect(broke.error.code).toBe('INSUFFICIENT_CREDITS');

    expect(await t.db.$count(videos)).toBe(0);
    expect(await t.db.$count(renderJobs)).toBe(0);
    expect(t.queues.size).toBe(0);
    expect(await storedKeys(t, storageKeys.workspacePrefix(owner.workspace.id))).toEqual([]);
    expect((await t.call(api.v1.listVideos, { as: key })).body.items).toEqual([]);
  });

  it('applies the concurrency limit of the plan', async () => {
    const { key } = await workspaceWithKey({ credits: 10 });
    await createVideo(key, { input: scriptInput() });
    const second = await t.call(api.v1.createVideo, { as: key, body: { input: scriptInput() } });
    expect(second.status).toBe(403);
    expect(second.error.details).toMatchObject({ limit: 'maxConcurrentRenders', max: 1 });
    expect(await t.db.$count(videos)).toBe(1);
  });

  it('validates the body and the workspace of what it references', async () => {
    const { key } = await workspaceWithKey();
    const other = await workspaceWithKey();
    const video = await t.call(api.videos.create, { as: other.owner, body: {} });
    const foreign = await t.call(api.videos.saveAsTemplate, {
      as: other.owner,
      params: { videoId: video.body.id },
      body: { name: 'Ajena' },
    });
    const bad = async (body: Record<string, unknown>) =>
      (await t.call(api.v1.createVideo, { as: key, body })).status;

    expect(await bad({})).toBe(400);
    expect(await bad({ input: { type: 'script', text: '', avatarId: TEST_AVATAR } })).toBe(400);
    expect(await bad({ input: { type: 'hologram' } })).toBe(400);
    expect(await bad({ input: { ...scriptInput(), aspect: '4:3' } })).toBe(400);
    expect(await bad({ input: scriptInput(), resolution: '8k' })).toBe(400);
    expect(await bad({ input: { type: 'composition', composition: { version: 1 } } })).toBe(400);
    expect(await bad({ input: { type: 'template', templateId: 'builtin_nope' } })).toBe(404);
    expect(await bad({ input: { type: 'template', templateId: foreign.body.id } })).toBe(404);
    expect(await t.db.$count(videos, eq(videos.source, 'api'))).toBe(0);
  });
});

describe('videos', () => {
  it('lists, reads and deletes the videos of the workspace of the key', async () => {
    const { owner, key } = await workspaceWithKey({ credits: 20, plan: 'team' });
    const other = await workspaceWithKey();
    const first = await createVideo(key, { input: scriptInput(), title: 'Primero' });
    const second = await createVideo(key, { input: scriptInput(), title: 'Segundo: final' });
    const draft = await createVideo(key, { input: scriptInput(), title: 'Tercero', render: false });
    const foreign = await createVideo(other.key, { input: scriptInput(), render: false });
    await completeRender(
      t,
      { id: second.id, workspaceId: owner.workspace.id },
      { durationMs: 6100 },
    );

    const list = await t.call(api.v1.listVideos, { as: key });
    expect(list.status).toBe(200);
    expect(list.body.items.map((video) => video.title)).toEqual([
      'Tercero',
      'Segundo: final',
      'Primero',
    ]);
    expect(list.body.nextCursor).toBeNull();
    const page1 = await t.call(api.v1.listVideos, { as: key, query: { limit: 2 } });
    expect(page1.body.items).toHaveLength(2);
    const page2 = await t.call(api.v1.listVideos, {
      as: key,
      query: { limit: 2, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((video) => video.id)).toEqual([first.id]);
    expect(page2.body.nextCursor).toBeNull();
    const completed = await t.call(api.v1.listVideos, { as: key, query: { status: 'completed' } });
    expect(completed.body.items.map((video) => video.id)).toEqual([second.id]);
    expect((await t.call(api.v1.listVideos, { as: key, query: { cursor: '???' } })).status).toBe(
      400,
    );

    // A finished video: playable URL, named download, subtitles and provenance.
    const done = await t.call(api.v1.getVideo, { as: key, params: { videoId: second.id } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      id: second.id,
      status: 'completed',
      progress: 100,
      durationMs: 6100,
      resolution: '720p',
      aiGenerated: false,
      providers: { tts: { id: 'espeak' } },
    });
    expect(done.body).toEqual(completed.body.items[0]);
    expect((await fetchUrl(t, done.body.videoUrl ?? '')).body).toBe('fake mp4 bytes');
    expect((await fetchUrl(t, done.body.downloadUrl ?? '')).headers['content-disposition']).toBe(
      'attachment; filename="Segundo_ final.mp4"',
    );
    expect((await fetchUrl(t, done.body.srtUrl ?? '')).statusCode).toBe(200);
    expect((await fetchUrl(t, done.body.vttUrl ?? '')).statusCode).toBe(200);
    const queued = await t.call(api.v1.getVideo, { as: key, params: { videoId: first.id } });
    expect(queued.body).toMatchObject({ status: 'queued', videoUrl: null, downloadUrl: null });

    // Other workspaces: invisible, and untouchable.
    const params = { videoId: foreign.id };
    expect((await t.call(api.v1.getVideo, { as: key, params })).status).toBe(404);
    expect((await t.call(api.v1.deleteVideo, { as: key, params })).status).toBe(404);
    expect((await t.call(api.v1.getVideo, { as: other.key, params })).status).toBe(200);
    expect((await t.call(api.v1.getVideo, { as: key, params: { videoId: 'nope' } })).status).toBe(
      400,
    );

    // Deleting a queued video cancels and refunds its render; files and row are gone.
    const before = await getCreditBalance(t.db, owner.workspace.id);
    const removed = await t.call(api.v1.deleteVideo, { as: key, params: { videoId: first.id } });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true });
    expect(await getCreditBalance(t.db, owner.workspace.id)).toBeGreaterThan(before);
    expect(t.queues.jobs('render').map((job) => job.videoId)).toEqual([second.id]);
    expect(
      (await t.call(api.v1.deleteVideo, { as: key, params: { videoId: second.id } })).status,
    ).toBe(200);
    expect((await fetchUrl(t, done.body.videoUrl ?? '')).statusCode).toBe(404);
    expect(
      (await t.call(api.v1.getVideo, { as: key, params: { videoId: second.id } })).status,
    ).toBe(404);
    const left = await t.call(api.v1.listVideos, { as: key });
    expect(left.body.items.map((video) => video.id)).toEqual([draft.id]);
  });
});

describe('upload asset', () => {
  it('stores an image of the workspace that compositions can use', async () => {
    const { owner, key } = await workspaceWithKey();
    const res = await t.call(api.v1.uploadAsset, {
      as: key,
      multipart: {
        filename: 'fondo.png',
        data: pngBytes(320, 180),
        fields: { name: 'Fondo de oficina' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workspaceId: owner.workspace.id,
      kind: 'image',
      purpose: 'library',
      name: 'Fondo de oficina',
      mimeType: 'image/png',
      width: 320,
      height: 180,
      createdBy: null,
    });
    expect((await fetchUrl(t, res.body.url)).statusCode).toBe(200);
    expect(await t.db.$count(assets, eq(assets.workspaceId, owner.workspace.id))).toBe(1);

    // The type comes from the bytes, not from the name the client sends.
    const fake = await t.call(api.v1.uploadAsset, {
      as: key,
      multipart: { filename: 'foto.png', contentType: 'image/png', data: Buffer.from('#!/bin/sh') },
    });
    expect(fake.status).toBe(415);
    expect(fake.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const notMultipart = await t.call(api.v1.uploadAsset, { as: key, body: { name: 'x' } });
    expect(notMultipart.status).toBe(400);
    expect(await t.db.$count(assets)).toBe(1);
  });
});

describe('rate limit per API key', () => {
  it('counts each key on its own window and resets it', () => {
    let now = 1_000_000;
    const limiter = new KeyRateLimiter(60_000, () => now);
    expect(limiter.take('a', 2)).toEqual({ allowed: true, limit: 2, remaining: 1, resetSec: 60 });
    now += 20_000;
    expect(limiter.take('a', 2)).toEqual({ allowed: true, limit: 2, remaining: 0, resetSec: 40 });
    expect(limiter.take('a', 2)).toEqual({ allowed: false, limit: 2, remaining: 0, resetSec: 40 });
    expect(limiter.take('b', 2).allowed).toBe(true);
    now += 40_000;
    // A new window for `a`; denied requests did not extend the old one.
    expect(limiter.take('a', 2)).toEqual({ allowed: true, limit: 2, remaining: 1, resetSec: 60 });
    now += 120_000;
    limiter.take('c', 2);
    expect(limiter.size).toBe(1);
  });

  it('answers 429 with headers once a key exceeds its plan, without affecting other keys', async () => {
    const limited = await createTestApp({ modules, env: { RATE_LIMIT_ENABLED: 'true' } });
    try {
      installFakeProviders(limited);
      const owner = await limited.signUp();
      const key = await limited.apiKeyFor(owner.workspace, 'A');
      const sameWorkspace = await limited.apiKeyFor(owner.workspace, 'B');
      const limit = V1_RATE_LIMITS.free;

      const first = await limited.call(api.v1.me, { as: key });
      expect(first.status).toBe(200);
      expect(first.headers['ratelimit-limit']).toBe(String(limit));
      expect(first.headers['ratelimit-remaining']).toBe(String(limit - 1));
      expect(Number(first.headers['ratelimit-reset'])).toBeGreaterThan(0);
      for (let i = 1; i < limit; i += 1) {
        const res = await limited.call(api.v1.listVideos, { as: key });
        expect(res.status).toBe(200);
      }
      const over = await limited.call(api.v1.me, { as: key });
      expect(over.status).toBe(429);
      expect(over.error).toMatchObject({
        code: 'RATE_LIMITED',
        details: { limit, windowSec: 60 },
      });
      expect(over.headers['ratelimit-remaining']).toBe('0');
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      // Writes are refused too, before doing any work.
      const create = await limited.call(api.v1.createVideo, {
        as: key,
        body: { input: scriptInput() },
      });
      expect(create.status).toBe(429);
      expect(await limited.db.$count(videos)).toBe(0);

      // Another key — even of the same workspace — has its own budget; a bad key gets 401.
      const other = await limited.call(api.v1.me, { as: sameWorkspace });
      expect(other.status).toBe(200);
      expect(other.headers['ratelimit-remaining']).toBe(String(limit - 1));
      const invalid = await limited.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: 'Bearer nope' },
      });
      expect(invalid.statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });
});

describe('documentation', () => {
  it('serves an OpenAPI document with exactly the public routes', async () => {
    const res = await t.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const doc = res.json<{
      openapi: string;
      info: { title: string; description: string };
      servers: { url: string }[];
      security: unknown;
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { securitySchemes: Record<string, unknown>; schemas?: Record<string, unknown> };
    }>();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Parlante API v1');
    expect(doc.servers).toEqual([{ url: t.config.PUBLIC_API_URL }]);

    // One operation per contract route, nothing from the first-party API.
    const documented = Object.entries(doc.paths)
      .flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    const contract = Object.values(api.v1)
      .map((route) => `${route.method} ${route.path.replace(/:(\w+)/g, '{$1}')}`)
      .sort();
    expect(documented).toEqual(contract);
    expect(Object.keys(doc.paths).every((path) => path.startsWith('/v1/'))).toBe(true);

    // Only the API-key scheme, required by every operation.
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['apiKey']);
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) {
        expect(operation.security).toEqual([{ apiKey: [] }]);
        expect(operation.summary).toBeTruthy();
      }
    }

    // Bodies and responses are really described.
    const create = doc.paths['/v1/videos']?.post as {
      requestBody: { content: Record<string, { schema: unknown }> };
      responses: Record<string, { headers: Record<string, unknown>; content: unknown }>;
    };
    const body = JSON.stringify(create.requestBody.content['application/json']?.schema);
    for (const word of ['script', 'template', 'composition', 'variables', 'resolution', 'render']) {
      expect(body).toContain(word);
    }
    expect(Object.keys(create.responses)).toEqual(expect.arrayContaining(['202', '401', '429']));
    expect(JSON.stringify(create.responses['202']?.content)).toContain('downloadUrl');
    expect(Object.keys(create.responses['429']?.headers ?? {})).toEqual(
      expect.arrayContaining(['RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After']),
    );
    const upload = doc.paths['/v1/assets']?.post as { description: string };
    expect(upload.description).toContain('multipart/form-data');

    // Every $ref of the document resolves inside the document.
    const refs = [...res.body.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(
      (match) => match[1] ?? '',
    );
    for (const ref of refs) expect(Object.keys(doc.components.schemas ?? {})).toContain(ref);

    // The guide covers what an integrator needs to know.
    for (const topic of ['Authorization: Bearer', 'RateLimit-Remaining', 'Parlante-Signature']) {
      expect(doc.info.description).toContain(topic);
    }
    for (const limit of Object.values(V1_RATE_LIMITS)) {
      expect(doc.info.description).toContain(`| ${limit} |`);
    }
  });

  it('serves a human-readable reference and can be switched off', async () => {
    const page = await t.inject({ method: 'GET', url: '/v1/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('/v1/openapi.json');
    for (const asset of ['swagger-ui-bundle.js', 'swagger-ui.css']) {
      expect(page.body).toContain(`/docs/static/${asset}`);
      const res = await t.inject({ method: 'GET', url: `/docs/static/${asset}` });
      expect(res.statusCode).toBe(200);
    }
    // The full document of the app still lists the public routes next to the others.
    const full = (await t.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, unknown>;
    }>();
    expect(Object.keys(full.paths)).toEqual(expect.arrayContaining(['/v1/videos', '/api/videos']));
    expect(Object.keys(full.paths)).not.toContain('/v1/openapi.json');

    const off = await createTestApp({ modules, env: { OPENAPI_ENABLED: 'false' } });
    try {
      expect((await off.inject({ method: 'GET', url: '/v1/openapi.json' })).statusCode).toBe(404);
      expect((await off.inject({ method: 'GET', url: '/v1/docs' })).statusCode).toBe(404);
      const key = await off.apiKeyFor((await off.signUp()).workspace);
      expect((await off.call(api.v1.me, { as: key })).status).toBe(200);
    } finally {
      await off.close();
    }
  });
});
