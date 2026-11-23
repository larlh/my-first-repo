import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationOptionsSchema, api, createComposition, newId } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  assets,
  avatars,
  consentRecords,
  creditLedger,
  eq,
  members,
  translationJobs,
  videos,
  voices,
  workspaces,
} from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import workspacesModule, { MAX_OWNED_WORKSPACES } from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [workspacesModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  vi.restoreAllMocks();
});

/** Give `actor` a second workspace (owner) so the first one can be deleted. */
async function secondWorkspace(actor: TestActor) {
  const res = await t.call(api.workspaces.create, { as: actor, body: { name: 'Second' } });
  expect(res.status).toBe(201);
  return res.body;
}

describe('workspaces', () => {
  it('creates workspaces owned by the caller and lists only the memberships', async () => {
    const alice = await t.signUp({ name: 'Alice' });
    const bob = await t.signUp();
    await t.db.insert(members).values({
      id: newId('member'),
      workspaceId: bob.workspace.id,
      userId: alice.user.id,
      role: 'viewer',
    });

    const created = await t.call(api.workspaces.create, { as: alice, body: { name: ' Estudio ' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Estudio',
      plan: 'free',
      role: 'owner',
      credits: 30,
    });
    const ledger = await t.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.workspaceId, created.body.id));
    expect(ledger.map((e) => e.reason)).toEqual(['signup_grant']);

    const list = await t.call(api.workspaces.list, { as: alice });
    expect(list.body.items.map((w) => [w.name, w.role])).toEqual([
      [alice.workspace.name, 'owner'],
      [bob.workspace.name, 'viewer'],
      ['Estudio', 'owner'],
    ]);
    expect((await t.call(api.workspaces.list, { as: bob })).body.items).toHaveLength(1);

    // Creating does not move the session.
    const current = await t.call(api.workspaces.current, { as: alice });
    expect(current.body).toMatchObject({ id: alice.workspace.id, role: 'owner' });
  });

  it('validates names, requires a session and caps the workspaces a user owns', async () => {
    const alice = await t.signUp();
    expect((await t.call(api.workspaces.list)).status).toBe(401);
    expect((await t.call(api.workspaces.create, { body: { name: 'x' } })).status).toBe(401);
    expect((await t.call(api.workspaces.create, { as: alice, body: { name: '  ' } })).status).toBe(
      400,
    );
    const long = await t.call(api.workspaces.create, { as: alice, body: { name: 'x'.repeat(61) } });
    expect(long.status).toBe(400);

    for (let i = 1; i < MAX_OWNED_WORKSPACES; i += 1) {
      const res = await t.call(api.workspaces.create, { as: alice, body: { name: `W${i}` } });
      expect(res.status).toBe(201);
    }
    const over = await t.call(api.workspaces.create, { as: alice, body: { name: 'One too many' } });
    expect(over.status).toBe(403);
    expect(over.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('lets admins rename the active workspace, not editors or viewers', async () => {
    const owner = await t.signUp();
    const other = await t.signUp();
    const admin = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const viewer = await t.addMember(owner.workspace, 'viewer');

    const renamed = await t.call(api.workspaces.update, { as: admin, body: { name: 'Renamed' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: owner.workspace.id, name: 'Renamed' });
    expect((await t.call(api.workspaces.current, { as: viewer })).body).toMatchObject({
      name: 'Renamed',
      role: 'viewer',
    });
    expect((await t.call(api.workspaces.update, { as: editor, body: { name: 'No' } })).status).toBe(
      403,
    );
    expect((await t.call(api.workspaces.update, { as: viewer, body: { name: 'No' } })).status).toBe(
      403,
    );
    expect((await t.call(api.workspaces.update, { as: admin, body: { name: '' } })).status).toBe(
      400,
    );
    // Only the active workspace of the session can be touched: the other one is unchanged.
    expect((await t.call(api.workspaces.current, { as: other })).body.name).toBe(
      other.workspace.name,
    );
  });

  it('deletes the active workspace with its rows and files (owners only)', async () => {
    const owner = await t.signUp();
    const admin = await t.addMember(owner.workspace, 'admin');
    const bystander = await t.signUp();
    const ws = owner.workspace.id;

    // Content held together by RESTRICT foreign keys, plus files on disk.
    const assetId = newId('asset');
    const consentId = newId('consent');
    const avatarId = newId('avatar');
    const voiceId = newId('voice');
    const assetKey = storageKeys.asset(ws, assetId, 'png');
    await t.app.providers.storage.put(assetKey, Buffer.from('photo'), { contentType: 'image/png' });
    await t.app.providers.storage.put(
      storageKeys.avatarFile(ws, avatarId, 'image.png'),
      Buffer.from('portrait'),
      { contentType: 'image/png' },
    );
    const foreignKey = storageKeys.asset(bystander.workspace.id, newId('asset'), 'png');
    await t.app.providers.storage.put(foreignKey, Buffer.from('other'), {
      contentType: 'image/png',
    });
    await t.db.insert(assets).values({
      id: assetId,
      workspaceId: ws,
      kind: 'image',
      purpose: 'avatar_source',
      name: 'me.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      storageKey: assetKey,
    });
    await t.db.insert(consentRecords).values(
      (['photo_avatar', 'voice_clone'] as const).map((kind, i) => ({
        id: i === 0 ? consentId : newId('consent'),
        workspaceId: ws,
        userId: owner.user.id,
        kind,
        subjectName: 'Owner',
        relationship: 'self' as const,
        statementVersion: '2026-01',
        statement: 'text',
        locale: 'es' as const,
        ip: '203.0.113.9',
      })),
    );
    const consents = await t.db.select().from(consentRecords);
    await t.db.insert(avatars).values({
      id: avatarId,
      workspaceId: ws,
      name: 'Me',
      origin: 'photo',
      sourceAssetId: assetId,
      consentId,
    });
    await t.db.insert(voices).values({
      id: voiceId,
      workspaceId: ws,
      name: 'My voice',
      language: 'es',
      consentId: consents.find((c) => c.kind === 'voice_clone')?.id ?? '',
      provider: { id: 'local', name: 'Local', quality: 'basic', local: true },
    });
    await t.db.insert(translationJobs).values({
      id: newId('translationJob'),
      workspaceId: ws,
      name: 'Dub',
      sourceAssetId: assetId,
      sourceLanguage: 'es',
      targetLanguages: ['en'],
      transcriptSource: 'user',
      options: TranslationOptionsSchema.parse({}),
    });
    await t.db.insert(videos).values({
      id: newId('video'),
      workspaceId: ws,
      title: 'Demo',
      composition: createComposition(),
      aspect: '16:9',
    });

    // Not the owner → 403; the owner's only workspace → INVALID_STATE.
    expect((await t.call(api.workspaces.remove, { as: admin })).status).toBe(403);
    const last = await t.call(api.workspaces.remove, { as: owner });
    expect(last.status).toBe(409);
    expect(last.error.code).toBe('INVALID_STATE');
    expect(await t.db.select().from(workspaces)).toHaveLength(2);

    const second = await secondWorkspace(owner);
    const removed = await t.call(api.workspaces.remove, { as: owner });
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ ok: true });

    const left = (await t.db.select({ id: workspaces.id }).from(workspaces)).map((w) => w.id);
    expect(left.sort()).toEqual([second.id, bystander.workspace.id].sort());
    for (const table of [assets, avatars, voices, consentRecords, translationJobs, videos]) {
      expect(await t.db.select().from(table)).toHaveLength(0);
    }
    expect(fs.existsSync(path.join(t.storageDir, 'ws', ws))).toBe(false);
    expect(await t.app.providers.storage.exists(foreignKey)).toBe(true);

    // The owner's session lands on the workspace that is left; the admin, who had no other
    // workspace, gets a personal one.
    expect((await t.call(api.workspaces.current, { as: owner })).body.id).toBe(second.id);
    const adminNow = await t.call(api.workspaces.current, { as: admin });
    expect(adminNow.status).toBe(200);
    expect(adminNow.body.role).toBe('owner');
    expect((await t.call(api.workspaces.current, { as: bystander })).body.id).toBe(
      bystander.workspace.id,
    );
  });

  it('keeps the workspace when a cloned voice cannot be removed from its provider', async () => {
    const owner = await t.signUp();
    await secondWorkspace(owner);
    const consentId = newId('consent');
    await t.db.insert(consentRecords).values({
      id: consentId,
      workspaceId: owner.workspace.id,
      userId: owner.user.id,
      kind: 'voice_clone',
      subjectName: 'Owner',
      relationship: 'self',
      statementVersion: '2026-01',
      statement: 'text',
      locale: 'es',
      ip: '203.0.113.9',
    });
    await t.db.insert(voices).values({
      id: newId('voice'),
      workspaceId: owner.workspace.id,
      name: 'External',
      language: 'es',
      consentId,
      ttsProviderId: 'elevenlabs',
      providerVoiceId: 'ext-voice-1',
      provider: { id: 'elevenlabs', name: 'ElevenLabs', quality: 'premium', local: false },
    });

    // The active provider is the local one: it cannot reach the external voice.
    const blocked = await t.call(api.workspaces.remove, { as: owner });
    expect(blocked.status).toBe(503);
    expect(blocked.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(await t.db.select().from(workspaces)).toHaveLength(2);

    // With the provider available the voice is deleted there and the workspace goes.
    const voiceClone = t.app.providers.voiceClone as { info: { id: string }; deleteVoice: unknown };
    const original = { info: voiceClone.info, deleteVoice: voiceClone.deleteVoice };
    const deleteVoice = vi.fn(async () => undefined);
    Object.assign(voiceClone, { info: { ...voiceClone.info, id: 'elevenlabs' }, deleteVoice });
    try {
      expect((await t.call(api.workspaces.remove, { as: owner })).status).toBe(200);
    } finally {
      Object.assign(voiceClone, original);
    }
    expect(deleteVoice).toHaveBeenCalledWith('ext-voice-1');
    expect(await t.db.select().from(workspaces)).toHaveLength(1);
  });
});
