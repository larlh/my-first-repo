import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, CREDIT_COSTS, api, newId } from '@parlante/shared';
import type { ProviderRef, VoiceCloneProvider } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { assets, consentRecords, eq, voices } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import consentModule from '../consent/index';
import {
  balanceOf,
  breakQueue,
  ledgerOf,
  recordConsent,
  seedAsset,
} from '../interactive/test-doubles';
import voiceClonesModule from './index';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    modules: [voiceClonesModule, consentModule],
    env: { MODERATION_EXTRA_BLOCKLIST: 'zzprohibido' },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function prepared(actor: TestActor) {
  const sample = await seedAsset(t, actor, { kind: 'audio', durationMs: 15_000 });
  const consentId = await recordConsent(t, actor, 'voice_clone');
  return { sample, consentId };
}

function createBody(sampleAssetId: string, consentId: string, name = 'Mi voz') {
  return { name, sampleAssetId, consentId, language: 'es' as const, gender: 'female' as const };
}

async function voiceCount(actor: TestActor): Promise<number> {
  const rows = await t.db.select().from(voices).where(eq(voices.workspaceId, actor.workspace.id));
  return rows.length;
}

describe('POST /api/voice-clones', () => {
  it('consumes the consent, charges, stores the voice as processing and queues the job', async () => {
    const alice = await t.signUp();
    const { sample, consentId } = await prepared(alice);
    const before = await balanceOf(t, alice);

    const res = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(sample.id, consentId),
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      kind: 'cloned',
      name: 'Mi voz',
      language: 'es',
      gender: 'female',
      status: 'processing',
      workspaceId: alice.workspace.id,
      consentId,
      profile: null,
      error: null,
      // Honesty rule: who is going to do the cloning (local profile = basic).
      provider: t.app.providers.voiceClone.info,
    });
    expect(res.body.id).toMatch(/^vcl_/);

    expect(await balanceOf(t, alice)).toBe(before - CREDIT_COSTS.voiceClone);
    const charge = (await ledgerOf(t, alice)).find((entry) => entry.reason === 'voice_clone');
    expect(charge).toMatchObject({
      delta: -CREDIT_COSTS.voiceClone,
      refType: 'voice',
      refId: res.body.id,
      createdBy: alice.user.id,
    });
    expect(t.queues.jobs('voiceClone')).toEqual([
      { voiceId: res.body.id, workspaceId: alice.workspace.id },
    ]);
    expect(t.queues.jobIds('voiceClone')).toEqual([res.body.id]);

    const [row] = await t.db.select().from(voices).where(eq(voices.id, res.body.id));
    expect(row).toMatchObject({ sampleAssetId: sample.id, consentId, createdBy: alice.user.id });
    const [consent] = await t.db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.id, consentId));
    expect(consent?.resourceId).toBe(res.body.id);
    expect(consent?.usedAt).toBeInstanceOf(Date);
    // The sample is now tied to the voice (hidden from the library, deleted with it).
    const [asset] = await t.db.select().from(assets).where(eq(assets.id, sample.id));
    expect(asset?.purpose).toBe('voice_sample');
  });

  it('REJECTS the operation without a valid consent record (nothing created or charged)', async () => {
    const alice = await t.signUp({ credits: 200 });
    const colleague = await t.addMember(alice.workspace, 'editor');
    const mallory = await t.signUp();
    const sample = await seedAsset(t, alice, { kind: 'audio', durationMs: 15_000 });
    const before = await balanceOf(t, alice);

    const attempt = async (consentId: string, as: TestActor = alice) => {
      const res = await t.call(api.voiceClones.create, {
        as,
        body: createBody(sample.id, consentId),
      });
      expect(res.status, consentId).toBe(403);
      expect(res.error.code).toBe('CONSENT_REQUIRED');
    };

    // 1. a consent id that does not exist
    await attempt(newId('consent'));
    // 2. a consent of the wrong kind (photo avatar)
    await attempt(await recordConsent(t, alice, 'photo_avatar'));
    // 3. a consent recorded by ANOTHER user of the same workspace
    await attempt(await recordConsent(t, colleague, 'voice_clone'));
    // 4. a consent of another workspace
    await attempt(await recordConsent(t, mallory, 'voice_clone'));
    // 5. a revoked consent
    const revoked = await recordConsent(t, alice, 'voice_clone');
    expect(
      (await t.call(api.consents.revoke, { as: alice, params: { consentId: revoked } })).status,
    ).toBe(200);
    await attempt(revoked);
    // 6. no consent field at all is a validation error
    const missing = await t.call(api.voiceClones.create, {
      as: alice,
      body: { name: 'x', sampleAssetId: sample.id, language: 'es' },
    });
    expect(missing.status).toBe(400);

    expect(await voiceCount(alice)).toBe(0);
    expect(await balanceOf(t, alice)).toBe(before);
    expect(t.queues.size).toBe(0);

    // 7. a consent can back ONE voice only
    const consentId = await recordConsent(t, alice, 'voice_clone');
    const first = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(sample.id, consentId),
    });
    expect(first.status).toBe(202);
    // (a failed voice does not count for the plan limit, so only the consent can stop this)
    await t.db
      .update(voices)
      .set({ status: 'failed' })
      .where(eq(voices.workspaceId, alice.workspace.id));
    const otherSample = await seedAsset(t, alice, { kind: 'audio', durationMs: 15_000 });
    const reused = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(otherSample.id, consentId),
    });
    expect(reused.status).toBe(403);
    expect(reused.error.code).toBe('CONSENT_REQUIRED');
  });

  it('validates the sample and the name', async () => {
    const alice = await t.signUp();
    const consentId = await recordConsent(t, alice, 'voice_clone');
    const image = await seedAsset(t, alice, { kind: 'image' });
    const short = await seedAsset(t, alice, { kind: 'audio', durationMs: 4_000 });
    const long = await seedAsset(t, alice, { kind: 'audio', durationMs: 6 * 60_000 });
    const good = await seedAsset(t, alice, { kind: 'audio', durationMs: 20_000 });

    const notAudio = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(image.id, consentId),
    });
    expect(notAudio.status).toBe(400);
    expect(notAudio.error.code).toBe('VALIDATION_ERROR');
    for (const sample of [short, long]) {
      const res = await t.call(api.voiceClones.create, {
        as: alice,
        body: createBody(sample.id, consentId),
      });
      expect(res.status).toBe(400);
      expect(res.error.details).toMatchObject({ minMs: 10_000, maxMs: 300_000 });
    }
    const unknown = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(newId('asset'), consentId),
    });
    expect(unknown.status).toBe(404);
    const badId = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody('nope', consentId),
    });
    expect(badId.status).toBe(400);
    const blocked = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(good.id, consentId, 'Voz zzprohibido'),
    });
    expect(blocked.status).toBe(422);
    expect(blocked.error.code).toBe('CONTENT_BLOCKED');
    expect(blocked.error.details).toMatchObject({ field: 'name' });

    // None of the failed attempts used up the consent.
    const ok = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(good.id, consentId),
    });
    expect(ok.status).toBe(202);

    // A sample that already backs a voice cannot back another one.
    const again = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(good.id, await recordConsent(t, alice, 'voice_clone')),
    });
    expect(again.status).toBe(409);
    expect(again.error.details).toMatchObject({ usedBy: [{ type: 'voice', id: ok.body.id }] });
  });

  it('applies the plan limit and the credit balance, keeping the consent usable', async () => {
    const alice = await t.signUp({ credits: 100 }); // free plan: 1 cloned voice
    const one = await prepared(alice);
    expect(
      (
        await t.call(api.voiceClones.create, {
          as: alice,
          body: createBody(one.sample.id, one.consentId),
        })
      ).status,
    ).toBe(202);
    const two = await prepared(alice);
    const overLimit = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(two.sample.id, two.consentId),
    });
    expect(overLimit.status).toBe(403);
    expect(overLimit.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(overLimit.error.details).toMatchObject({ limit: 'maxClonedVoices', max: 1, value: 2 });
    expect(await balanceOf(t, alice)).toBe(100 - CREDIT_COSTS.voiceClone);

    const poor = await t.signUp({ credits: CREDIT_COSTS.voiceClone - 1 });
    const mine = await prepared(poor);
    const noCredits = await t.call(api.voiceClones.create, {
      as: poor,
      body: createBody(mine.sample.id, mine.consentId),
    });
    expect(noCredits.status).toBe(402);
    expect(noCredits.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(await voiceCount(poor)).toBe(0);
    const [consent] = await t.db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.id, mine.consentId));
    expect(consent?.usedAt).toBeNull();
    expect(t.queues.jobs('voiceClone')).toHaveLength(1);
  });

  it('fails the voice and refunds when the queue is down', async () => {
    const alice = await t.signUp();
    const { sample, consentId } = await prepared(alice);
    const before = await balanceOf(t, alice);
    const restore = breakQueue(t);
    const res = await t.call(api.voiceClones.create, {
      as: alice,
      body: createBody(sample.id, consentId),
    });
    restore();
    expect(res.status).toBe(503);
    expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await balanceOf(t, alice)).toBe(before);
    const rows = await t.db.select().from(voices).where(eq(voices.workspaceId, alice.workspace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', error: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('requires authentication and the editor role', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const { sample, consentId } = await prepared(owner);
    const body = createBody(sample.id, consentId);
    expect((await t.call(api.voiceClones.create, { body })).status).toBe(401);
    expect((await t.call(api.voiceClones.create, { as: viewer, body })).status).toBe(403);
    expect(t.queues.size).toBe(0);
  });
});

describe('PATCH and DELETE /api/voice-clones/:voiceId', () => {
  async function clonedVoice(actor: TestActor) {
    const { sample, consentId } = await prepared(actor);
    const res = await t.call(api.voiceClones.create, {
      as: actor,
      body: createBody(sample.id, consentId),
    });
    expect(res.status).toBe(202);
    return { voiceId: res.body.id, sample, consentId };
  }

  it('renames a voice of the workspace only', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mallory = await t.signUp();
    const { voiceId } = await clonedVoice(alice);
    const params = { voiceId };

    const renamed = await t.call(api.voiceClones.update, {
      as: alice,
      params,
      body: { name: 'Voz de Ana' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: voiceId, name: 'Voz de Ana', status: 'processing' });

    expect((await t.call(api.voiceClones.update, { params, body: { name: 'x' } })).status).toBe(
      401,
    );
    expect(
      (await t.call(api.voiceClones.update, { as: viewer, params, body: { name: 'x' } })).status,
    ).toBe(403);
    expect(
      (await t.call(api.voiceClones.update, { as: mallory, params, body: { name: 'hacked' } }))
        .status,
    ).toBe(404);
    expect(
      (await t.call(api.voiceClones.update, { as: alice, params, body: { name: '' } })).status,
    ).toBe(400);
    expect(
      (await t.call(api.voiceClones.update, { as: alice, params, body: { name: 'zzprohibido' } }))
        .error.code,
    ).toBe('CONTENT_BLOCKED');
    expect(
      (
        await t.call(api.voiceClones.update, {
          as: alice,
          params: { voiceId: 'espeak:es-f1' },
          body: { name: 'x' },
        })
      ).status,
    ).toBe(400);
    const [row] = await t.db.select().from(voices).where(eq(voices.id, voiceId));
    expect(row?.name).toBe('Voz de Ana');
  });

  it('deletes in cascade: row, sample file, source asset, pending job — and refunds', async () => {
    const alice = await t.signUp();
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mallory = await t.signUp();
    const before = await balanceOf(t, alice);
    const { voiceId, sample } = await clonedVoice(alice);
    const params = { voiceId };
    const sampleKey = storageKeys.voiceSample(alice.workspace.id, voiceId);
    await t.app.providers.storage.put(sampleKey, Buffer.from('wav'), { contentType: 'audio/wav' });

    expect((await t.call(api.voiceClones.remove, { params })).status).toBe(401);
    expect((await t.call(api.voiceClones.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.voiceClones.remove, { as: mallory, params })).status).toBe(404);
    expect(await voiceCount(alice)).toBe(1);
    expect(await t.app.providers.storage.exists(sampleKey)).toBe(true);

    const res = await t.call(api.voiceClones.remove, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await voiceCount(alice)).toBe(0);
    expect(await t.app.providers.storage.exists(sampleKey)).toBe(false);
    expect(await t.app.providers.storage.exists(sample.storageKey)).toBe(false);
    expect(await t.db.select().from(assets).where(eq(assets.id, sample.id))).toEqual([]);
    expect(t.queues.jobs('voiceClone')).toEqual([]);
    // It never became ready: the reservation goes back.
    expect(await balanceOf(t, alice)).toBe(before);
    expect((await t.call(api.voiceClones.remove, { as: alice, params })).status).toBe(404);
  });

  it('also deletes the voice at the external provider, and keeps the row if that fails', async () => {
    const alice = await t.signUp();
    const external: ProviderRef = {
      id: 'acme-clone',
      name: 'Acme Cloning',
      quality: 'premium',
      local: false,
    };
    const deleted: string[] = [];
    let failure: Error | null = null;
    const provider: VoiceCloneProvider = {
      info: external,
      createVoice: () => Promise.reject(new AppError('NOT_IMPLEMENTED', 'not used')),
      deleteVoice: (providerVoiceId) => {
        if (failure) return Promise.reject(failure);
        deleted.push(providerVoiceId);
        return Promise.resolve();
      },
    };
    const original = t.app.providers.voiceClone;
    t.app.providers.voiceClone = provider;
    try {
      const { voiceId } = await clonedVoice(alice);
      // What the worker job leaves behind when it finishes.
      await t.db
        .update(voices)
        .set({
          status: 'ready',
          ttsProviderId: 'acme',
          providerVoiceId: 'ext-voice-42',
          provider: external,
        })
        .where(eq(voices.id, voiceId));
      const afterCharge = await balanceOf(t, alice);

      failure = new Error('upstream 500');
      const failed = await t.call(api.voiceClones.remove, { as: alice, params: { voiceId } });
      expect(failed.status).toBe(502);
      expect(failed.error.code).toBe('PROVIDER_ERROR');
      const [kept] = await t.db.select().from(voices).where(eq(voices.id, voiceId));
      expect(kept).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_ERROR' } });

      failure = null;
      const ok = await t.call(api.voiceClones.remove, { as: alice, params: { voiceId } });
      expect(ok.status).toBe(200);
      expect(deleted).toEqual(['ext-voice-42']);
      expect(await voiceCount(alice)).toBe(0);
      // A voice that was ready keeps its charge.
      expect(await balanceOf(t, alice)).toBe(afterCharge);
    } finally {
      t.app.providers.voiceClone = original;
    }
  });
});
