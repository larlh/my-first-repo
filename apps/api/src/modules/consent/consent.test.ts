import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_STATEMENTS, CONSENT_STATEMENT_VERSION, api, newId } from '@parlante/shared';
import type { ProviderRef } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { assets, avatars, consentRecords, eq, voices } from '@parlante/db';
import { consumeConsent } from '../../lib/consent';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import consentModule from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [consentModule] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

const LOCAL: ProviderRef = {
  id: 'local',
  name: 'Voice profile (local)',
  quality: 'basic',
  local: true,
};
const EXTERNAL: ProviderRef = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  quality: 'premium',
  local: false,
};

const photoBody = {
  kind: 'photo_avatar',
  subjectName: 'Ana García López',
  relationship: 'self',
  statementVersion: CONSENT_STATEMENT_VERSION,
  accepted: true,
} as const;
const voiceBody = { ...photoBody, kind: 'voice_clone' } as const;

const put = (key: string) =>
  t.app.providers.storage.put(key, Buffer.from('bytes'), {
    contentType: 'application/octet-stream',
  });
const exists = (key: string) => t.app.providers.storage.exists(key);

async function createConsent(actor: TestActor, body: Record<string, unknown> = photoBody) {
  const res = await t.call(api.consents.create, { as: actor, body });
  expect(res.status).toBe(201);
  return res.body;
}

/** A source asset (photo / sample) with its file, as the upload endpoint leaves it. */
async function seedSourceAsset(actor: TestActor, purpose: 'avatar_source' | 'voice_sample') {
  const id = newId('asset');
  const ws = actor.workspace.id;
  const storageKey = storageKeys.asset(ws, id, purpose === 'avatar_source' ? 'png' : 'wav');
  const thumbnailKey = storageKeys.assetThumb(ws, id);
  await put(storageKey);
  await put(thumbnailKey);
  await t.db.insert(assets).values({
    id,
    workspaceId: ws,
    kind: purpose === 'avatar_source' ? 'image' : 'audio',
    purpose,
    name: 'source',
    mimeType: purpose === 'avatar_source' ? 'image/png' : 'audio/wav',
    sizeBytes: 5,
    storageKey,
    thumbnailKey,
  });
  return { id, storageKey, thumbnailKey };
}

/** A photo avatar made with `consentId`, exactly as `POST /api/photo-avatars` + its job do. */
async function seedPhotoAvatar(actor: TestActor, consentId: string) {
  const ws = actor.workspace.id;
  const id = newId('avatar');
  const source = await seedSourceAsset(actor, 'avatar_source');
  await t.db.transaction(async (tx) => {
    await consumeConsent(tx, {
      consentId,
      kind: 'photo_avatar',
      workspaceId: ws,
      userId: actor.user.id,
      resourceId: id,
    });
    await tx.insert(avatars).values({
      id,
      workspaceId: ws,
      name: 'Ana',
      origin: 'photo',
      status: 'ready',
      sourceAssetId: source.id,
      consentId,
    });
  });
  const files = [
    storageKeys.avatarFile(ws, id, 'image.png'),
    storageKeys.avatarFile(ws, id, 'mask.png'),
    storageKeys.avatarFile(ws, id, 'cutout.png'),
    storageKeys.avatarFile(ws, id, 'thumb.jpg'),
    storageKeys.avatarClipCache({ workspaceId: ws, avatarId: id }, 'a'.repeat(64), 'clip.mp4'),
  ];
  for (const key of files) await put(key);
  await t.queues.enqueue('photoAvatar', { avatarId: id, workspaceId: ws }, { jobId: id });
  return { id, source, files };
}

async function seedVoice(actor: TestActor, consentId: string, provider: ProviderRef = LOCAL) {
  const ws = actor.workspace.id;
  const id = newId('voice');
  const source = await seedSourceAsset(actor, 'voice_sample');
  await t.db.transaction(async (tx) => {
    await consumeConsent(tx, {
      consentId,
      kind: 'voice_clone',
      workspaceId: ws,
      userId: actor.user.id,
      resourceId: id,
    });
    await tx.insert(voices).values({
      id,
      workspaceId: ws,
      name: 'Ana',
      language: 'es',
      status: 'ready',
      sampleAssetId: source.id,
      consentId,
      provider,
      ttsProviderId: provider.local ? 'espeak' : provider.id,
      providerVoiceId: provider.local ? 'es' : 'ext-voice-42',
    });
  });
  const sample = storageKeys.voiceSample(ws, id);
  await put(sample);
  return { id, source, sample };
}

/** Swap the active voice-clone provider for the duration of a test. */
function useVoiceCloneProvider(info: ProviderRef, deleteVoice: (id: string) => Promise<void>) {
  const provider = t.app.providers.voiceClone as { info: ProviderRef; deleteVoice: unknown };
  const original = { info: provider.info, deleteVoice: provider.deleteVoice };
  Object.assign(provider, { info, deleteVoice });
  restore.push(() => Object.assign(provider, original));
}
const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

describe('consent records', () => {
  it('records who consented, to what text, when, by which user and from which IP', async () => {
    const editor = await t.addMember((await t.signUp()).workspace, 'editor');
    const raw = await t.inject({
      method: 'POST',
      url: api.consents.create.path,
      headers: { cookie: editor.cookie, 'user-agent': 'ParlanteTest/1.0' },
      remoteAddress: '203.0.113.77',
      payload: { ...photoBody, subjectName: '  Ana García López ', locale: 'en' },
    });
    expect(raw.statusCode).toBe(201);
    const body = raw.json();
    expect(body).toMatchObject({
      workspaceId: editor.workspace.id,
      user: { id: editor.user.id, name: editor.user.name },
      kind: 'photo_avatar',
      subjectName: 'Ana García López',
      relationship: 'self',
      statementVersion: CONSENT_STATEMENT_VERSION,
      statement: CONSENT_STATEMENTS.photo_avatar[CONSENT_STATEMENT_VERSION]?.en,
      resourceId: null,
      revokedAt: null,
    });
    expect(Date.now() - Date.parse(body.createdAt)).toBeLessThan(60_000);
    // The address is evidence for the audit trail, not something the API hands out.
    expect(raw.body).not.toContain('203.0.113.77');

    const [row] = await t.db.select().from(consentRecords);
    expect(row).toMatchObject({
      userId: editor.user.id,
      ip: '203.0.113.77',
      userAgent: 'ParlanteTest/1.0',
      locale: 'en',
      usedAt: null,
    });

    const spanish = await createConsent(editor, voiceBody);
    expect(spanish.statement).toBe(CONSENT_STATEMENTS.voice_clone[CONSENT_STATEMENT_VERSION]?.es);
  });

  it('requires the explicit declaration, the current statement and at least the editor role', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const create = (as: TestActor | undefined, body: Record<string, unknown>) =>
      t.call(api.consents.create, { as, body });

    expect((await create(owner, { ...photoBody, accepted: false })).status).toBe(400);
    const { accepted: _accepted, ...unticked } = photoBody;
    expect((await create(owner, unticked)).status).toBe(400);
    expect((await create(owner, { ...photoBody, subjectName: 'A' })).status).toBe(400);
    expect((await create(owner, { ...photoBody, kind: 'fingerprint' })).status).toBe(400);
    expect((await create(owner, { ...photoBody, relationship: 'none' })).status).toBe(400);
    const stale = await create(owner, { ...photoBody, statementVersion: '2020-01' });
    expect(stale.status).toBe(400);
    expect(stale.error.details).toMatchObject({ currentVersion: CONSENT_STATEMENT_VERSION });
    expect((await create(viewer, photoBody)).status).toBe(403);
    expect((await create(undefined, photoBody)).status).toBe(401);
    expect(await t.db.select().from(consentRecords)).toHaveLength(0);
  });

  it('lists the records of the workspace for admins, newest first, by kind and by page', async () => {
    const owner = await t.signUp();
    const admin = await t.addMember(owner.workspace, 'admin');
    const editor = await t.addMember(owner.workspace, 'editor');
    const other = await t.signUp();
    const first = await createConsent(editor, photoBody);
    const second = await createConsent(owner, voiceBody);
    const third = await createConsent(owner, photoBody);
    await createConsent(other, photoBody);
    for (const [id, minutes] of [
      [first.id, 3],
      [second.id, 2],
      [third.id, 1],
    ] as const) {
      await t.db
        .update(consentRecords)
        .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
        .where(eq(consentRecords.id, id));
    }

    const all = await t.call(api.consents.list, { as: admin });
    expect(all.status).toBe(200);
    expect(all.body.items.map((c) => c.id)).toEqual([third.id, second.id, first.id]);
    expect(all.body.items[2]?.user).toEqual({ id: editor.user.id, name: editor.user.name });
    expect(all.raw.body).not.toMatch(/"ip"|userAgent|127\.0\.0\.1/);

    const photos = await t.call(api.consents.list, { as: owner, query: { kind: 'photo_avatar' } });
    expect(photos.body.items.map((c) => c.id)).toEqual([third.id, first.id]);
    const page1 = await t.call(api.consents.list, { as: owner, query: { limit: 2 } });
    expect(page1.body.items.map((c) => c.id)).toEqual([third.id, second.id]);
    const page2 = await t.call(api.consents.list, {
      as: owner,
      query: { limit: 2, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((c) => c.id)).toEqual([first.id]);
    expect(page2.body.nextCursor).toBeNull();

    expect((await t.call(api.consents.list, { as: editor })).status).toBe(403);
    expect((await t.call(api.consents.list)).status).toBe(401);
    expect(
      (await t.call(api.consents.list, { as: owner, query: { kind: 'x' as never } })).status,
    ).toBe(400);
    expect((await t.call(api.consents.list, { as: other })).body.items).toHaveLength(1);
  });
});

describe('revoking a consent', () => {
  it('deletes the photo avatar, all its files and the source photo; keeps the record', async () => {
    const owner = await t.signUp({ plan: 'team' });
    const consent = await createConsent(owner);
    const avatar = await seedPhotoAvatar(owner, consent.id);
    // Things that must survive: another avatar of the workspace and a library asset.
    const keptConsent = await createConsent(owner);
    const kept = await seedPhotoAvatar(owner, keptConsent.id);
    expect(t.queues.jobIds('photoAvatar')).toEqual([avatar.id, kept.id]);

    const res = await t.call(api.consents.revoke, { as: owner, params: { consentId: consent.id } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: consent.id, resourceId: avatar.id, kind: 'photo_avatar' });
    expect(res.body.revokedAt).not.toBeNull();

    expect((await t.db.select({ id: avatars.id }).from(avatars)).map((a) => a.id)).toEqual([
      kept.id,
    ]);
    expect((await t.db.select({ id: assets.id }).from(assets)).map((a) => a.id)).toEqual([
      kept.source.id,
    ]);
    for (const key of [...avatar.files, avatar.source.storageKey, avatar.source.thumbnailKey]) {
      expect([key, await exists(key)]).toEqual([key, false]);
    }
    for (const key of [...kept.files, kept.source.storageKey]) {
      expect([key, await exists(key)]).toEqual([key, true]);
    }
    // The pending preparation job is withdrawn.
    expect(t.queues.jobIds('photoAvatar')).toEqual([kept.id]);
    // The record stays as the audit trail.
    const [row] = await t.db.select().from(consentRecords).where(eq(consentRecords.id, consent.id));
    expect(row?.revokedAt).toBeInstanceOf(Date);
    expect(row?.subjectName).toBe('Ana García López');

    // Idempotent.
    const again = await t.call(api.consents.revoke, {
      as: owner,
      params: { consentId: consent.id },
    });
    expect(again.status).toBe(200);
    expect(again.body.revokedAt).toBe(res.body.revokedAt);
  });

  it('deletes the cloned voice, its sample and the source recording', async () => {
    const owner = await t.signUp();
    const consent = await createConsent(owner, voiceBody);
    const voice = await seedVoice(owner, consent.id);
    const deleteVoice = vi.fn(async () => undefined);
    useVoiceCloneProvider(LOCAL, deleteVoice);

    const res = await t.call(api.consents.revoke, { as: owner, params: { consentId: consent.id } });
    expect(res.status).toBe(200);
    expect(res.body.revokedAt).not.toBeNull();
    expect(await t.db.select().from(voices)).toHaveLength(0);
    expect(await t.db.select().from(assets)).toHaveLength(0);
    for (const key of [voice.sample, voice.source.storageKey, voice.source.thumbnailKey]) {
      expect([key, await exists(key)]).toEqual([key, false]);
    }
    // A local voice profile has nothing outside this machine.
    expect(deleteVoice).not.toHaveBeenCalled();
  });

  it('removes the voice at the external provider, and can be retried when that fails', async () => {
    const owner = await t.signUp();
    const consent = await createConsent(owner, voiceBody);
    const voice = await seedVoice(owner, consent.id, EXTERNAL);
    const params = { consentId: consent.id };

    // 1. The provider that hosts the voice is not the configured one.
    useVoiceCloneProvider(LOCAL, async () => undefined);
    const unconfigured = await t.call(api.consents.revoke, { as: owner, params });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    // Everything local is gone already and the voice can no longer be used…
    expect(await exists(voice.sample)).toBe(false);
    expect(await exists(voice.source.storageKey)).toBe(false);
    expect(await t.db.select().from(assets)).toHaveLength(0);
    const [pending] = await t.db.select().from(voices);
    expect(pending).toMatchObject({
      id: voice.id,
      status: 'failed',
      providerVoiceId: 'ext-voice-42',
    });
    expect(pending?.error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    // …and the consent is revoked: nothing new can be made with it.
    const [record] = await t.db.select().from(consentRecords);
    expect(record?.revokedAt).toBeInstanceOf(Date);

    // 2. The provider is configured but fails.
    const failing = vi.fn(async () => {
      throw new Error('upstream 500');
    });
    useVoiceCloneProvider(EXTERNAL, failing);
    const failed = await t.call(api.consents.revoke, { as: owner, params });
    expect(failed.status).toBe(502);
    expect(failed.error.code).toBe('PROVIDER_ERROR');
    expect(failed.raw.body).not.toContain('upstream 500');
    expect(await t.db.select().from(voices)).toHaveLength(1);

    // 3. Retrying once it works finishes the job.
    const deleteVoice = vi.fn(async () => undefined);
    useVoiceCloneProvider(EXTERNAL, deleteVoice);
    const done = await t.call(api.consents.revoke, { as: owner, params });
    expect(done.status).toBe(200);
    expect(deleteVoice).toHaveBeenCalledExactlyOnceWith('ext-voice-42');
    expect(await t.db.select().from(voices)).toHaveLength(0);
  });

  it('makes an unused consent unusable', async () => {
    const owner = await t.signUp();
    const consent = await createConsent(owner);
    const res = await t.call(api.consents.revoke, { as: owner, params: { consentId: consent.id } });
    expect(res.body).toMatchObject({ id: consent.id, resourceId: null });
    expect(res.body.revokedAt).not.toBeNull();
    await expect(
      consumeConsent(t.db, {
        consentId: consent.id,
        kind: 'photo_avatar',
        workspaceId: owner.workspace.id,
        userId: owner.user.id,
        resourceId: newId('avatar'),
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('is for admins and never touches another workspace', async () => {
    const owner = await t.signUp();
    const editor = await t.addMember(owner.workspace, 'editor');
    const other = await t.signUp();
    const consent = await createConsent(owner);
    const avatar = await seedPhotoAvatar(owner, consent.id);
    const params = { consentId: consent.id };

    expect((await t.call(api.consents.revoke, { as: editor, params })).status).toBe(403);
    expect((await t.call(api.consents.revoke, { params })).status).toBe(401);
    expect((await t.call(api.consents.revoke, { as: other, params })).status).toBe(404);
    expect(
      (await t.call(api.consents.revoke, { as: owner, params: { consentId: 'nope' } })).status,
    ).toBe(400);
    expect(
      (await t.call(api.consents.revoke, { as: owner, params: { consentId: newId('consent') } }))
        .status,
    ).toBe(404);

    const [row] = await t.db.select().from(consentRecords);
    expect(row?.revokedAt).toBeNull();
    expect(await t.db.select().from(avatars)).toHaveLength(1);
    expect(await exists(avatar.files[0] ?? '')).toBe(true);
  });
});
