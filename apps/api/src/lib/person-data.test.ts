import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@parlante/shared';
import type { ProviderRef } from '@parlante/shared';
import { sha256Hex, storageKeys } from '@parlante/shared/node';
import { assets, avatars, consentRecords, voices } from '@parlante/db';
import { createTestApp } from '../testing/index';
import type { TestActor, TestApp } from '../testing/index';
import { deleteAvatarCascade, deleteExternalVoice, deleteVoiceCascade } from './person-data';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ modules: [] });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

const EXTERNAL: ProviderRef = { id: 'acme', name: 'Acme Voices', quality: 'premium', local: false };
const LOCAL: ProviderRef = { id: 'local', name: 'Local', quality: 'basic', local: true };

const deps = () => ({ db: t.db, providers: t.app.providers, queues: t.queues });
const put = (key: string) =>
  t.app.providers.storage.put(key, Buffer.from('x'), { contentType: 'application/octet-stream' });
const exists = (key: string) => t.app.providers.storage.exists(key);

async function seedConsent(actor: TestActor, kind: 'photo_avatar' | 'voice_clone') {
  const id = newId('consent');
  await t.db.insert(consentRecords).values({
    id,
    workspaceId: actor.workspace.id,
    userId: actor.user.id,
    kind,
    subjectName: 'Someone',
    relationship: 'self',
    statementVersion: '2026-01',
    statement: 'text',
    locale: 'es',
    ip: '203.0.113.1',
  });
  return id;
}

async function seedAsset(actor: TestActor, kind: 'image' | 'audio') {
  const id = newId('asset');
  const storageKey = storageKeys.asset(actor.workspace.id, id, kind === 'image' ? 'jpg' : 'wav');
  await put(storageKey);
  await t.db.insert(assets).values({
    id,
    workspaceId: actor.workspace.id,
    kind,
    purpose: kind === 'image' ? 'avatar_source' : 'voice_sample',
    name: 'source',
    mimeType: kind === 'image' ? 'image/jpeg' : 'audio/wav',
    sizeBytes: 1,
    storageKey,
  });
  return { id, storageKey };
}

describe('deleteAvatarCascade', () => {
  it('removes row, prefix and source photo, only inside the given workspace', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const source = await seedAsset(alice, 'image');
    const avatarId = newId('avatar');
    await t.db.insert(avatars).values({
      id: avatarId,
      workspaceId: alice.workspace.id,
      name: 'A',
      origin: 'photo',
      sourceAssetId: source.id,
      consentId: await seedConsent(alice, 'photo_avatar'),
    });
    const image = storageKeys.avatarFile(alice.workspace.id, avatarId, 'image.png');
    await put(image);
    await t.queues.enqueue(
      'photoAvatar',
      { avatarId, workspaceId: alice.workspace.id },
      { jobId: avatarId },
    );

    // Asked through the wrong workspace: nothing of Alice is touched.
    expect(await deleteAvatarCascade(deps(), bob.workspace.id, avatarId)).toBe(false);
    expect(await exists(image)).toBe(true);
    expect(await exists(source.storageKey)).toBe(true);
    expect(await t.db.select().from(avatars)).toHaveLength(1);
    expect(t.queues.jobIds('photoAvatar')).toEqual([avatarId]);

    expect(await deleteAvatarCascade(deps(), alice.workspace.id, avatarId)).toBe(true);
    expect(await exists(image)).toBe(false);
    expect(await exists(source.storageKey)).toBe(false);
    expect(await t.db.select().from(avatars)).toHaveLength(0);
    expect(await t.db.select().from(assets)).toHaveLength(0);
    expect(t.queues.jobIds('photoAvatar')).toEqual([]);
    // Again: nothing left to do.
    expect(await deleteAvatarCascade(deps(), alice.workspace.id, avatarId)).toBe(false);
  });

  it('keeps generated avatars free of any source asset handling', async () => {
    const alice = await t.signUp();
    const avatarId = newId('avatar');
    await t.db.insert(avatars).values({
      id: avatarId,
      workspaceId: alice.workspace.id,
      name: 'Synthetic',
      origin: 'generated',
      prompt: 'a person',
    });
    const library = await seedAsset(alice, 'image');
    expect(await deleteAvatarCascade(deps(), alice.workspace.id, avatarId)).toBe(true);
    expect(await exists(library.storageKey)).toBe(true);
    expect(await t.db.select().from(assets)).toHaveLength(1);
  });

  it('asks the engine to forget what it derived from the portrait, before the file is gone', async () => {
    const alice = await t.signUp();
    const bob = await t.signUp();
    const avatarId = newId('avatar');
    const image = storageKeys.avatarFile(alice.workspace.id, avatarId, 'image.png');
    const bytes = Buffer.from('PREPARED PORTRAIT OF A PERSON');
    await t.app.providers.storage.put(image, bytes, { contentType: 'image/png' });
    await t.db.insert(avatars).values({
      id: avatarId,
      workspaceId: alice.workspace.id,
      name: 'A',
      origin: 'photo',
      status: 'ready',
      imageKey: image,
      consentId: await seedConsent(alice, 'photo_avatar'),
    });
    // The engine caches features keyed by the hash of the portrait FILE: the provider is
    // told that hash while the file can still be read.
    const forgotten: { sha: string; fileStillThere: boolean }[] = [];
    const forget = vi
      .spyOn(t.app.providers.portrait, 'forget')
      .mockImplementation(async ({ portraitSha256 }) => {
        forgotten.push({ sha: portraitSha256, fileStillThere: await exists(image) });
      });
    try {
      // Through another workspace: nothing is forgotten.
      expect(await deleteAvatarCascade(deps(), bob.workspace.id, avatarId)).toBe(false);
      expect(forgotten).toEqual([]);

      expect(await deleteAvatarCascade(deps(), alice.workspace.id, avatarId)).toBe(true);
      expect(forgotten).toEqual([{ sha: sha256Hex(bytes), fileStillThere: true }]);
      expect(await exists(image)).toBe(false);

      // An avatar that never got a portrait (still processing, failed) has nothing cached
      // that the API could name; the job drops it (photo-avatar job tests).
      const pending = newId('avatar');
      await t.db.insert(avatars).values({
        id: pending,
        workspaceId: alice.workspace.id,
        name: 'B',
        origin: 'generated',
        prompt: 'a person',
      });
      expect(await deleteAvatarCascade(deps(), alice.workspace.id, pending)).toBe(true);
      expect(forgotten).toHaveLength(1);

      // The engine cache cannot be reached: the deletion fails as a whole and can be retried,
      // instead of reporting success with data derived from the person left behind.
      const retried = newId('avatar');
      const retriedImage = storageKeys.avatarFile(alice.workspace.id, retried, 'image.png');
      await t.app.providers.storage.put(retriedImage, bytes, { contentType: 'image/png' });
      await t.db.insert(avatars).values({
        id: retried,
        workspaceId: alice.workspace.id,
        name: 'C',
        origin: 'generated',
        prompt: 'a person',
        status: 'ready',
        imageKey: retriedImage,
      });
      forget.mockRejectedValueOnce(new Error('EACCES: permission denied'));
      await expect(deleteAvatarCascade(deps(), alice.workspace.id, retried)).rejects.toThrow(
        /EACCES/,
      );
      expect(await exists(retriedImage)).toBe(true);
      expect(await t.db.select().from(avatars)).toHaveLength(1);
      expect(await deleteAvatarCascade(deps(), alice.workspace.id, retried)).toBe(true);
      expect(await t.db.select().from(avatars)).toHaveLength(0);
    } finally {
      forget.mockRestore();
    }
  });
});

describe('deleteVoiceCascade', () => {
  async function seedVoice(actor: TestActor, provider: ProviderRef) {
    const sample = await seedAsset(actor, 'audio');
    const id = newId('voice');
    await t.db.insert(voices).values({
      id,
      workspaceId: actor.workspace.id,
      name: 'V',
      language: 'es',
      status: 'ready',
      sampleAssetId: sample.id,
      consentId: await seedConsent(actor, 'voice_clone'),
      provider,
      providerVoiceId: 'pv-1',
    });
    const file = storageKeys.voiceSample(actor.workspace.id, id);
    await put(file);
    return { id, sample, file };
  }

  it('removes row, sample and source recording of a local voice', async () => {
    const alice = await t.signUp();
    const voice = await seedVoice(alice, LOCAL);
    expect(await deleteVoiceCascade(deps(), alice.workspace.id, voice.id)).toBe(true);
    expect(await exists(voice.file)).toBe(false);
    expect(await exists(voice.sample.storageKey)).toBe(false);
    expect(await t.db.select().from(voices)).toHaveLength(0);
    expect(await deleteVoiceCascade(deps(), alice.workspace.id, voice.id)).toBe(false);
  });

  it('keeps an unusable row to retry when the external voice cannot be deleted', async () => {
    const alice = await t.signUp();
    const voice = await seedVoice(alice, EXTERNAL);
    const storage = t.app.providers.storage;

    const failing = {
      info: EXTERNAL,
      createVoice: vi.fn(),
      deleteVoice: vi.fn().mockRejectedValue(new Error('boom')),
    };
    await expect(
      deleteVoiceCascade(
        { db: t.db, queues: t.queues, providers: { storage, voiceClone: failing } },
        alice.workspace.id,
        voice.id,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    const [row] = await t.db.select().from(voices);
    expect(row).toMatchObject({ status: 'failed', providerVoiceId: 'pv-1' });
    expect(await exists(voice.file)).toBe(false);

    const working = {
      info: EXTERNAL,
      createVoice: vi.fn(),
      deleteVoice: vi.fn().mockResolvedValue(undefined),
    };
    expect(
      await deleteVoiceCascade(
        { db: t.db, queues: t.queues, providers: { storage, voiceClone: working } },
        alice.workspace.id,
        voice.id,
      ),
    ).toBe(true);
    expect(working.deleteVoice).toHaveBeenCalledWith('pv-1');
    expect(await t.db.select().from(voices)).toHaveLength(0);
  });
});

describe('deleteExternalVoice', () => {
  it('does nothing for local voices and refuses a provider that does not host the voice', async () => {
    const other = { info: LOCAL, createVoice: vi.fn(), deleteVoice: vi.fn() };
    await deleteExternalVoice({ voiceClone: other }, { provider: LOCAL, providerVoiceId: 'es' });
    await deleteExternalVoice({ voiceClone: other }, { provider: EXTERNAL, providerVoiceId: null });
    await deleteExternalVoice({ voiceClone: other }, { provider: null, providerVoiceId: 'x' });
    await expect(
      deleteExternalVoice({ voiceClone: other }, { provider: EXTERNAL, providerVoiceId: 'pv-1' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(other.deleteVoice).not.toHaveBeenCalled();
  });
});
