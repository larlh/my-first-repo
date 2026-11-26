import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, listUsedVariables, newId } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { eq, templates, users, videos } from '@parlante/db';
import { BUILTIN_TEMPLATE_IDS, getBuiltinTemplate } from '@parlante/templates';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import videosModule from '../videos/index';
import {
  decodeJpeg,
  fetchUrl,
  installFakeProviders,
  storedKeys,
  talkingComposition,
} from '../videos/test-support';
import templatesModule from './index';
import { MAX_CUSTOM_TEMPLATES } from './service';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [videosModule, templatesModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  installFakeProviders(t);
});

/** A custom template made the way a user makes one: from a video, through the API. */
async function saveTemplate(
  actor: TestActor,
  body: { name: string; description?: string; category?: string },
  composition = talkingComposition({ text: 'Hola {{nombre}}.', backgroundColor: '#16a34a' }),
) {
  const video = await t.call(api.videos.create, { as: actor, body: { composition } });
  const saved = await t.call(api.videos.saveAsTemplate, {
    as: actor,
    params: { videoId: video.body.id },
    body,
  });
  if (saved.status !== 201) throw new Error(`Save failed: ${JSON.stringify(saved.body)}`);
  return saved.body;
}

describe('catalogue', () => {
  it('lists the built-in templates and the custom ones of the workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const older = await saveTemplate(alice, { name: 'Aviso de envío', category: 'product' });
    const newer = await saveTemplate(alice, { name: 'Bienvenida', description: 'Para el equipo' });
    await saveTemplate(bob, { name: 'De Bob' });

    const res = await t.call(api.templates.list, { as: viewer });
    expect(res.status).toBe(200);
    const builtin = res.body.items.filter((item) => item.kind === 'builtin');
    const custom = res.body.items.filter((item) => item.kind === 'custom');
    expect(builtin.map((item) => item.id)).toEqual(BUILTIN_TEMPLATE_IDS);
    expect(builtin.length).toBeGreaterThanOrEqual(6);
    expect(custom.map((item) => item.id)).toEqual([newer.id, older.id]);
    // Built-in first, in catalogue order; then the workspace's own, newest first.
    expect(res.body.items.map((item) => item.kind).lastIndexOf('builtin')).toBe(builtin.length - 1);

    const explainer = builtin.find((item) => item.id === 'builtin_explainer');
    const source = getBuiltinTemplate('builtin_explainer');
    expect(explainer).toMatchObject({
      kind: 'builtin',
      workspaceId: null,
      name: source?.name.es,
      description: source?.description.es,
      category: 'explainer',
      aspect: source?.composition.canvas.aspect,
      sceneCount: source?.composition.scenes.length,
      createdAt: null,
      thumbnailUrl: `${t.config.PUBLIC_API_URL}/api/templates/builtin_explainer/thumbnail`,
    });
    expect(explainer).not.toHaveProperty('composition');
    expect(custom[0]).toMatchObject({
      kind: 'custom',
      workspaceId: alice.workspace.id,
      name: 'Bienvenida',
      description: 'Para el equipo',
      category: 'other',
      sceneCount: 1,
    });

    // Filters.
    const list = async (query: Record<string, string>) =>
      (await t.call(api.templates.list, { as: alice, query })).body.items;
    expect((await list({ kind: 'custom' })).map((item) => item.id)).toEqual([newer.id, older.id]);
    expect((await list({ kind: 'builtin' })).every((item) => item.kind === 'builtin')).toBe(true);
    expect((await list({ category: 'product' })).map((item) => item.id).sort()).toEqual(
      ['builtin_product', older.id].sort(),
    );
    const vertical = await list({ aspect: '9:16' });
    expect(vertical.length).toBeGreaterThan(0);
    expect(vertical.every((item) => item.aspect === '9:16')).toBe(true);
    expect((await list({ q: 'ENVIO' })).map((item) => item.id)).toEqual([older.id]);
    expect((await list({ q: 'zzzz-nada' })).length).toBe(0);
    expect((await list({ kind: 'custom', aspect: '1:1' })).length).toBe(0);

    // Another workspace sees the same built-ins and only its own custom templates.
    const bobs = await t.call(api.templates.list, { as: bob, query: { kind: 'custom' } });
    expect(bobs.body.items.map((item) => item.name)).toEqual(['De Bob']);
    expect((await t.call(api.templates.list)).status).toBe(401);
    expect(
      (await t.call(api.templates.list, { as: alice, query: { category: 'nope' as never } }))
        .status,
    ).toBe(400);
  });

  it('serves built-in templates in the language of the user', async () => {
    const alice = await t.signUp();
    const es = await t.call(api.templates.get, {
      as: alice,
      params: { templateId: 'builtin_greeting' },
    });
    await t.db.update(users).set({ locale: 'en' }).where(eq(users.id, alice.user.id));
    const en = await t.call(api.templates.get, {
      as: alice,
      params: { templateId: 'builtin_greeting' },
    });
    const source = getBuiltinTemplate('builtin_greeting', 'en');
    expect(es.status).toBe(200);
    expect(en.body.name).toBe(source?.name.en);
    expect(en.body.name).not.toBe(es.body.name);
    expect(en.body.composition).toEqual(source?.composition);
    expect(en.body.composition.scenes[0]?.script).not.toEqual(
      es.body.composition.scenes[0]?.script,
    );
    const list = await t.call(api.templates.list, { as: alice, query: { kind: 'builtin' } });
    expect(list.body.items.find((item) => item.id === 'builtin_greeting')?.name).toBe(
      source?.name.en,
    );
  });

  it('returns one template with its composition, 404 across workspaces', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const saved = await saveTemplate(alice, { name: 'Mía' });

    const custom = await t.call(api.templates.get, {
      as: viewer,
      params: { templateId: saved.id },
    });
    expect(custom.status).toBe(200);
    expect(custom.body).toEqual(saved);
    expect(listUsedVariables(custom.body.composition)).toEqual(['nombre']);

    const builtin = await t.call(api.templates.get, {
      as: bob,
      params: { templateId: 'builtin_news' },
    });
    expect(builtin.status).toBe(200);
    expect(builtin.body.composition).toEqual(getBuiltinTemplate('builtin_news')?.composition);

    expect(
      (await t.call(api.templates.get, { as: bob, params: { templateId: saved.id } })).status,
    ).toBe(404);
    expect(
      (await t.call(api.templates.get, { as: alice, params: { templateId: 'builtin_nope' } }))
        .status,
    ).toBe(404);
    expect(
      (await t.call(api.templates.get, { as: alice, params: { templateId: newId('template') } }))
        .status,
    ).toBe(404);
    expect(
      (await t.call(api.templates.get, { as: alice, params: { templateId: 'vid_abc' } })).status,
    ).toBe(400);
    expect((await t.call(api.templates.get, { params: { templateId: saved.id } })).status).toBe(
      401,
    );
  });
});

describe('thumbnail of built-in templates', () => {
  it('renders a cacheable JPEG poster in the format of each template, without a session', async () => {
    for (const id of ['builtin_explainer', 'builtin_vertical-ad', 'builtin_greeting']) {
      const template = getBuiltinTemplate(id);
      if (!template) throw new Error(`missing ${id}`);
      const res = await t.inject({ method: 'GET', url: `/api/templates/${id}/thumbnail` });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toContain('public');
      const image = await decodeJpeg(res.rawPayload);
      const { width, height } = template.composition.canvas;
      expect(image.width).toBe(640);
      expect(image.width / image.height).toBeCloseTo(width / height, 1);
      // Not a flat placeholder: the poster has detail.
      const colours = new Set<string>();
      for (let x = 20; x < image.width; x += 40) {
        for (let y = 20; y < image.height; y += 40) colours.add(image.at(x, y).join(','));
      }
      expect(colours.size).toBeGreaterThan(8);
      // Rendered once: a second request returns the very same bytes.
      const again = await t.inject({ method: 'GET', url: `/api/templates/${id}/thumbnail` });
      expect(again.rawPayload.equals(res.rawPayload)).toBe(true);
    }
  });

  it('answers 404 for unknown ids and does not serve custom templates', async () => {
    const alice = await t.signUp();
    const saved = await saveTemplate(alice, { name: 'Mía' });
    const call = (id: string) => t.inject({ method: 'GET', url: `/api/templates/${id}/thumbnail` });
    expect((await call('builtin_nope')).statusCode).toBe(404);
    expect((await call(saved.id)).statusCode).toBe(400);
    expect((await call('..%2F..%2Fetc')).statusCode).toBe(400);
  });
});

describe('use', () => {
  it('creates a draft video from a built-in or a custom template', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const saved = await saveTemplate(alice, { name: 'Aviso' });

    const fromBuiltin = await t.call(api.templates.use, {
      as: alice,
      params: { templateId: 'builtin_product' },
      body: {},
    });
    const source = getBuiltinTemplate('builtin_product');
    expect(fromBuiltin.status).toBe(201);
    expect(fromBuiltin.body).toMatchObject({
      status: 'draft',
      source: 'template',
      templateId: 'builtin_product',
      title: source?.name.es,
      aspect: source?.composition.canvas.aspect,
      revision: 1,
      createdBy: { id: alice.user.id, name: 'Alice' },
    });
    expect(fromBuiltin.body.composition.variables).toEqual(source?.composition.variables);
    expect(fromBuiltin.body.composition.scenes.map((scene) => scene.script)).toEqual(
      source?.composition.scenes.map((scene) => scene.script),
    );
    expect((await fetchUrl(t, fromBuiltin.body.thumbnailUrl ?? '')).statusCode).toBe(200);

    const fromCustom = await t.call(api.templates.use, {
      as: alice,
      params: { templateId: saved.id },
      body: { title: 'Aviso para Marta' },
    });
    expect(fromCustom.status).toBe(201);
    expect(fromCustom.body).toMatchObject({
      title: 'Aviso para Marta',
      source: 'template',
      templateId: saved.id,
    });
    expect(fromCustom.body.composition.variables).toEqual(saved.composition.variables);

    // Two videos from the same template never share ids with it or with each other.
    const second = await t.call(api.templates.use, {
      as: alice,
      params: { templateId: saved.id },
      body: {},
    });
    const ids = [saved, fromCustom.body, second.body].map(
      (doc) => doc.composition.scenes[0]?.id ?? '',
    );
    expect(new Set(ids).size).toBe(3);
    expect(second.body.title).toBe('Aviso');
  });

  it('validates the role, the workspace and the template id', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const saved = await saveTemplate(alice, { name: 'Mía' });
    const params = { templateId: saved.id };
    const before = await t.db.$count(videos);

    expect((await t.call(api.templates.use, { params, body: {} })).status).toBe(401);
    expect((await t.call(api.templates.use, { as: viewer, params, body: {} })).status).toBe(403);
    expect((await t.call(api.templates.use, { as: bob, params, body: {} })).status).toBe(404);
    expect(
      (
        await t.call(api.templates.use, {
          as: alice,
          params: { templateId: 'builtin_nope' },
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (await t.call(api.templates.use, { as: alice, params, body: { title: '' } })).status,
    ).toBe(400);
    expect(await t.db.$count(videos)).toBe(before);
  });
});

describe('update and remove', () => {
  it('edits and deletes custom templates of the workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const saved = await saveTemplate(alice, { name: 'Borrador', description: 'v1' });
    const params = { templateId: saved.id };
    const prefix = storageKeys.templatePrefix(alice.workspace.id, saved.id);
    expect(await storedKeys(t, prefix)).toEqual([
      storageKeys.templateThumb(alice.workspace.id, saved.id),
    ]);

    const updated = await t.call(api.templates.update, {
      as: alice,
      params,
      body: { name: 'Definitiva', category: 'training' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: saved.id,
      name: 'Definitiva',
      description: 'v1',
      category: 'training',
    });
    expect(updated.body).not.toHaveProperty('composition');

    expect((await t.call(api.templates.update, { params, body: { name: 'x' } })).status).toBe(401);
    expect(
      (await t.call(api.templates.update, { as: viewer, params, body: { name: 'x' } })).status,
    ).toBe(403);
    expect(
      (await t.call(api.templates.update, { as: bob, params, body: { name: 'x' } })).status,
    ).toBe(404);
    expect(
      (await t.call(api.templates.update, { as: alice, params, body: { name: '' } })).status,
    ).toBe(400);
    expect((await t.call(api.templates.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.templates.remove, { as: bob, params })).status).toBe(404);
    const still = await t.call(api.templates.get, { as: alice, params });
    expect(still.body.name).toBe('Definitiva');

    // A video made from the template survives the template.
    const video = await t.call(api.templates.use, { as: alice, params, body: {} });
    const removed = await t.call(api.templates.remove, { as: alice, params });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true });
    expect((await t.call(api.templates.get, { as: alice, params })).status).toBe(404);
    expect(await storedKeys(t, prefix)).toEqual([]);
    expect((await fetchUrl(t, saved.thumbnailUrl ?? '')).statusCode).toBe(404);
    expect((await t.call(api.templates.remove, { as: alice, params })).status).toBe(404);
    const kept = await t.call(api.videos.get, { as: alice, params: { videoId: video.body.id } });
    expect(kept.body.templateId).toBe(saved.id);
  });

  it('keeps built-in templates read-only', async () => {
    const alice = await t.signUp();
    const params = { templateId: 'builtin_explainer' };
    const update = await t.call(api.templates.update, { as: alice, params, body: { name: 'Mía' } });
    expect(update.status).toBe(403);
    expect(update.error.code).toBe('FORBIDDEN');
    const remove = await t.call(api.templates.remove, { as: alice, params });
    expect(remove.status).toBe(403);
    expect(remove.error.code).toBe('FORBIDDEN');
    expect(
      (await t.call(api.templates.remove, { as: alice, params: { templateId: 'builtin_nope' } }))
        .status,
    ).toBe(404);
    const still = await t.call(api.templates.get, { as: alice, params });
    expect(still.body.name).toBe(getBuiltinTemplate('builtin_explainer')?.name.es);
  });

  it('bounds the number of custom templates of a workspace', async () => {
    const alice = await t.signUp();
    const first = await saveTemplate(alice, { name: 'Primera' });
    const [row] = await t.db.select().from(templates).where(eq(templates.id, first.id));
    if (!row) throw new Error('missing row');
    await t.db.insert(templates).values(
      Array.from({ length: MAX_CUSTOM_TEMPLATES - 1 }, (_, index) => ({
        ...row,
        id: newId('template'),
        name: `Copia ${index}`,
        thumbnailKey: null,
      })),
    );
    const video = await t.call(api.videos.create, { as: alice, body: {} });
    const res = await t.call(api.videos.saveAsTemplate, {
      as: alice,
      params: { videoId: video.body.id },
      body: { name: 'Una más' },
    });
    expect(res.status).toBe(403);
    expect(res.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxCustomTemplates', max: MAX_CUSTOM_TEMPLATES },
    });
    expect(await t.db.$count(templates)).toBe(MAX_CUSTOM_TEMPLATES);
    // The poster rendered for the refused template was removed again.
    const keys = await storedKeys(t, `ws/${alice.workspace.id}/templates/`);
    expect(keys).toEqual([storageKeys.templateThumb(alice.workspace.id, first.id)]);
  });
});
