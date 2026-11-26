import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, CREDIT_COSTS, newId } from '@parlante/shared';
import type { ProviderRef, VoiceCloneProvider, VoiceCloneRequest } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  assets,
  chargeCredits,
  consentRecords,
  eq,
  getCreditBalance,
  netCharged,
  voices,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import { ffprobe } from '../../lib/ffmpeg';
import { createTestWorker } from '../../testing/index';
import type { TestWorker } from '../../testing/index';
import job, { MAX_SAMPLE_SEC, SAMPLE_RATE } from './index';

let t: TestWorker;
let realVoiceClone: VoiceCloneProvider;

beforeAll(async () => {
  t = await createTestWorker();
  realVoiceClone = t.ctx.providers.voiceClone;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  t.ctx.providers.voiceClone = realVoiceClone;
});

const COST = CREDIT_COSTS.voiceClone;

/** A voice exactly as `POST /api/voice-clones` leaves it: consent, sample asset, charge, row. */
async function seedVoice(sample: { bytes: Uint8Array; ext: string; kind?: 'audio' | 'image' }) {
  const account = await seedAccount(t.ctx.db, { credits: 100 });
  const workspaceId = account.workspace.id;
  const consentId = newId('consent');
  await t.ctx.db.insert(consentRecords).values({
    id: consentId,
    workspaceId,
    userId: account.user.id,
    kind: 'voice_clone',
    subjectName: 'Ada Example',
    relationship: 'self',
    statementVersion: 'test',
    statement: 'I consent',
    locale: 'es',
    ip: '203.0.113.9',
  });
  const assetId = newId('asset');
  const storageKey = storageKeys.asset(workspaceId, assetId, sample.ext);
  await t.ctx.providers.storage.put(storageKey, sample.bytes, {
    contentType: 'application/octet-stream',
  });
  await t.ctx.db.insert(assets).values({
    id: assetId,
    workspaceId,
    kind: sample.kind ?? 'audio',
    purpose: 'voice_sample',
    name: `sample.${sample.ext}`,
    mimeType: 'audio/wav',
    sizeBytes: sample.bytes.length,
    storageKey,
  });
  const voiceId = newId('voice');
  await t.ctx.db.transaction(async (tx) => {
    await chargeCredits(tx, {
      workspaceId,
      amount: COST,
      reason: 'voice_clone',
      refType: 'voice',
      refId: voiceId,
    });
    await tx.insert(voices).values({
      id: voiceId,
      workspaceId,
      name: 'Ada',
      language: 'es',
      gender: 'female',
      status: 'processing',
      provider: t.ctx.providers.voiceClone.info,
      sampleAssetId: assetId,
      consentId,
    });
  });
  return { workspaceId, voiceId, assetId, payload: { voiceId, workspaceId } };
}

/** Real speech from the local TTS provider (≈ 4 s), as a WAV file. */
async function spokenSample(): Promise<Uint8Array> {
  const tts = t.ctx.providers.tts.default;
  const [voice] = (await tts.listVoices()).filter((v) => v.language.startsWith('es'));
  if (!voice) throw new Error('The local TTS has no Spanish voice');
  const speech = await tts.synthesize({
    text: 'Hola, esta es una muestra de mi voz para crear un clon. Hablo con calma y con claridad durante unos segundos.',
    providerVoiceId: voice.providerVoiceId,
    language: 'es',
    speed: 1,
    pitch: 0,
  });
  return speech.audio;
}

async function voiceRow(voiceId: string) {
  const [row] = await t.ctx.db.select().from(voices).where(eq(voices.id, voiceId));
  return row;
}

/** Net credits held for the voice (`+ 0`: the ledger sum of a refunded ref is `-0`). */
const charged = async (workspaceId: string, voiceId: string) =>
  (await netCharged(t.ctx.db, workspaceId, { refType: 'voice', refId: voiceId })) + 0;

const EXTERNAL: ProviderRef = { id: 'fake-cloud', name: 'Fake', quality: 'premium', local: false };

function fakeProvider(
  createVoice: (request: VoiceCloneRequest) => Promise<{ providerVoiceId: string }>,
): VoiceCloneProvider & { requests: VoiceCloneRequest[]; deleted: string[] } {
  const requests: VoiceCloneRequest[] = [];
  const deleted: string[] = [];
  return {
    info: EXTERNAL,
    requests,
    deleted,
    async createVoice(request) {
      requests.push(request);
      const { providerVoiceId } = await createVoice(request);
      return { ttsProviderId: 'fake-tts', providerVoiceId, profile: null, provider: EXTERNAL };
    },
    async deleteVoice(providerVoiceId) {
      deleted.push(providerVoiceId);
    },
  };
}

describe('voice-clone job', () => {
  it('clones a voice with the real local provider and stores sample.wav and the profile', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    const { result, progress } = await t.run(job, seeded.payload);

    expect(result).toEqual({ voiceId: seeded.voiceId, provider: 'local' });
    // Queue progress is throttled (the last update may be dropped): it starts and only grows.
    expect(progress[0]).toEqual({ percent: 5 });
    const percents = progress.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    const row = await voiceRow(seeded.voiceId);
    expect(row?.status).toBe('ready');
    expect(row?.error).toBeNull();
    expect(row?.provider).toMatchObject({ id: 'local', quality: 'basic', local: true });
    expect(row?.ttsProviderId).toBe('espeak');
    expect(row?.providerVoiceId).toBeTruthy();
    expect(row?.profile?.baseVoiceId).toBe(row?.providerVoiceId);
    expect(row?.profile?.meanF0Hz).toBeGreaterThan(50);

    // The normalised sample is kept under the voice prefix: WAV PCM16 mono at SAMPLE_RATE.
    const sampleKey = storageKeys.voiceSample(seeded.workspaceId, seeded.voiceId);
    const samplePath = t.ctx.providers.storage.localPath(sampleKey);
    expect(samplePath).toBeTruthy();
    const info = await ffprobe(samplePath ?? '');
    expect(info).toMatchObject({ audioCodec: 'pcm_s16le', sampleRate: SAMPLE_RATE, channels: 1 });
    expect(info.durationMs).toBeGreaterThan(2000);
    expect(info.durationMs).toBeLessThanOrEqual(MAX_SAMPLE_SEC * 1000);

    // A successful clone keeps its fixed price.
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(COST);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(100 - COST);
  });

  it('is idempotent: a second run of a ready voice clones nothing again', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    const provider = fakeProvider(async () => ({ providerVoiceId: 'ext_1' }));
    t.ctx.providers.voiceClone = provider;
    const first = await t.run(job, seeded.payload);
    const second = await t.run(job, seeded.payload);

    expect(first.result).toEqual({ voiceId: seeded.voiceId, provider: 'fake-cloud' });
    expect(second.result).toEqual(first.result);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toMatchObject({
      name: 'Ada',
      sampleRate: SAMPLE_RATE,
      language: 'es',
      gender: 'female',
    });
    expect(provider.requests[0]?.consentId).toMatch(/^cns_/);
    // What the provider received is a WAV file.
    expect(
      Buffer.from(provider.requests[0]?.sample ?? [])
        .subarray(0, 4)
        .toString(),
    ).toBe('RIFF');
    expect(provider.deleted).toEqual([]);
    const row = await voiceRow(seeded.voiceId);
    expect(row).toMatchObject({
      status: 'ready',
      ttsProviderId: 'fake-tts',
      providerVoiceId: 'ext_1',
    });
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(COST);
  });

  it('fails for good and refunds when the sample is not audio', async () => {
    const seeded = await seedVoice({ bytes: Buffer.from('this is not a recording'), ext: 'wav' });
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/UNPROCESSABLE/);

    const row = await voiceRow(seeded.voiceId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toEqual({
      code: 'UNPROCESSABLE',
      message: 'The voice sample could not be read as audio',
    });
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(100);
    expect(
      await t.ctx.providers.storage.exists(
        storageKeys.voiceSample(seeded.workspaceId, seeded.voiceId),
      ),
    ).toBe(false);
  });

  it('retries a provider outage and only fails (with refund) on the last attempt', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    const provider = fakeProvider(async () => {
      throw new AppError('PROVIDER_ERROR', 'The cloning service is down');
    });
    t.ctx.providers.voiceClone = provider;

    // Attempt 1 of 2: nothing is decided yet — still processing, still charged.
    await expect(t.run(job, seeded.payload)).rejects.toThrow('The cloning service is down');
    expect((await voiceRow(seeded.voiceId))?.status).toBe('processing');
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(COST);

    // Attempt 2 of 2: final.
    await expect(t.run(job, seeded.payload, { attemptsMade: 1 })).rejects.toThrow(
      'The cloning service is down',
    );
    const row = await voiceRow(seeded.voiceId);
    expect(row?.status).toBe('failed');
    expect(row?.error).toEqual({ code: 'PROVIDER_ERROR', message: 'The cloning service is down' });
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(0);
    expect(provider.requests).toHaveLength(2);

    // A failed voice is not processed again and never charged again.
    await expect(t.run(job, seeded.payload)).rejects.toThrow(/INVALID_STATE/);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(100);
  });

  it('succeeds on the retry after a temporary failure', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    let calls = 0;
    t.ctx.providers.voiceClone = fakeProvider(async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return { providerVoiceId: 'ext_retry' };
    });
    await expect(t.run(job, seeded.payload)).rejects.toThrow('socket hang up');
    const { result } = await t.run(job, seeded.payload, { attemptsMade: 1 });
    expect(result.provider).toBe('fake-cloud');
    expect(await voiceRow(seeded.voiceId)).toMatchObject({
      status: 'ready',
      providerVoiceId: 'ext_retry',
      error: null,
    });
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(COST);
  });

  it('never loads a voice through another workspace', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    const other = await seedAccount(t.ctx.db);
    await expect(
      t.run(job, { voiceId: seeded.voiceId, workspaceId: other.workspace.id }),
    ).rejects.toThrow(/NOT_FOUND/);
    expect((await voiceRow(seeded.voiceId))?.status).toBe('processing');
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(COST);
  });

  it('leaves nothing behind when the voice is deleted while it is being cloned', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    const provider = fakeProvider(async () => {
      // The user revokes the consent (the API deletes the voice) while the provider works.
      await t.ctx.db.delete(voices).where(eq(voices.id, seeded.voiceId));
      return { providerVoiceId: 'ext_orphan' };
    });
    t.ctx.providers.voiceClone = provider;

    await expect(t.run(job, seeded.payload)).rejects.toThrow(/NOT_FOUND/);
    expect(await voiceRow(seeded.voiceId)).toBeUndefined();
    // The clone created at the external provider is removed, and so is the stored sample.
    expect(provider.deleted).toEqual(['ext_orphan']);
    expect(
      await t.ctx.providers.storage.exists(
        storageKeys.voiceSample(seeded.workspaceId, seeded.voiceId),
      ),
    ).toBe(false);
  });

  it('onFinalFailure fails and refunds a voice whose worker died, exactly once', async () => {
    const seeded = await seedVoice({ bytes: await spokenSample(), ext: 'wav' });
    const error = { code: 'SERVICE_UNAVAILABLE' as const, message: 'The worker stopped' };
    await job.onFinalFailure?.(t.ctx, seeded.payload, error);
    await job.onFinalFailure?.(t.ctx, seeded.payload, error);

    expect(await voiceRow(seeded.voiceId)).toMatchObject({ status: 'failed', error });
    expect(await charged(seeded.workspaceId, seeded.voiceId)).toBe(0);
    expect(await getCreditBalance(t.ctx.db, seeded.workspaceId)).toBe(100);
  });
});
