import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, api, createComposition, newId } from '@parlante/shared';
import type { STTProvider } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { assets, eq, translationJobs, translationOutputs, videos } from '@parlante/db';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import {
  balanceOf,
  breakQueue,
  installFakeTts,
  ledgerOf,
  seedAsset,
} from '../interactive/test-doubles';
import translationsModule from './index';

/* TTS voices come from a deterministic double (es, en-US, fr, de). STT is the REAL default
 * provider (`manual`: the user supplies the transcript) unless a test installs a capable one.
 * Routes, moderation, credits, storage, signed URLs and the database are the real ones. */

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hola y bienvenidos a esta demostración.

2
00:00:05,000 --> 00:00:09,500
Hoy veremos cómo funciona el producto.
`;

let t: TestApp;
let manualStt: STTProvider;

beforeAll(async () => {
  t = await createTestApp({
    modules: [translationsModule],
    env: { MODERATION_EXTRA_BLOCKLIST: 'zzprohibido' },
  });
  manualStt = t.app.providers.stt;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  installFakeTts(t);
  t.app.providers.stt = manualStt;
});

function useCapableStt(): void {
  t.app.providers.stt = {
    info: { id: 'acme-stt', name: 'Acme STT', quality: 'premium', local: false },
    requiresUserTranscript: false,
    transcribe: () => Promise.reject(new AppError('NOT_IMPLEMENTED', 'not used by the API')),
  };
}

/** A 65 s video asset: 2 started minutes → 4 credits per target language. */
function sourceVideo(actor: TestActor, overrides: { durationMs?: number | null } = {}) {
  return seedAsset(t, actor, {
    kind: 'video',
    purpose: 'translation_source',
    name: 'Demo del producto.mp4',
    durationMs: overrides.durationMs === undefined ? 65_000 : overrides.durationMs,
    bytes: Buffer.from('source video bytes'),
  });
}

const transcript = { format: 'srt' as const, content: SRT };

async function jobRows(actor: TestActor) {
  return t.db
    .select()
    .from(translationJobs)
    .where(eq(translationJobs.workspaceId, actor.workspace.id));
}

describe('POST /api/translations', () => {
  it('charges per minute and language, stores job and outputs, and queues the job', async () => {
    const alice = await t.signUp({ plan: 'creator', credits: 300 });
    const source = await sourceVideo(alice);
    const res = await t.call(api.translations.create, {
      as: alice,
      body: {
        sourceAssetId: source.id,
        sourceLanguage: 'es',
        targetLanguages: ['en', 'fr', 'en'],
        transcript,
        voices: { fr: 'espeak:fr-f1' },
        options: { burnSubtitles: true },
      },
    });
    expect(res.status, res.raw.body).toBe(202);
    expect(res.body).toMatchObject({
      workspaceId: alice.workspace.id,
      name: 'Demo del producto',
      sourceAssetId: source.id,
      sourceDurationMs: 65_000,
      sourceLanguage: 'es',
      targetLanguages: ['en', 'fr'],
      status: 'queued',
      stage: null,
      progress: 0,
      transcriptSource: 'user',
      options: { originalAudioVolume: 0.08, burnSubtitles: true },
      providers: null,
      creditsCharged: 8,
      error: null,
      createdBy: { id: alice.user.id, name: alice.user.name },
    });
    // The chosen voice for French; the first stock voice of the language for English.
    expect(res.body.outputs).toMatchObject([
      {
        language: 'en',
        voiceId: 'espeak:en-m1',
        status: 'pending',
        videoUrl: null,
        downloadUrl: null,
        srtUrl: null,
        vttUrl: null,
        error: null,
      },
      { language: 'fr', voiceId: 'espeak:fr-f1', status: 'pending' },
    ]);
    const sourceUrl = new URL(res.body.sourceUrl ?? '');
    const file = await t.inject({ method: 'GET', url: sourceUrl.pathname + sourceUrl.search });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('source video bytes');

    expect(await balanceOf(t, alice)).toBe(300 - 8);
    expect(
      (await ledgerOf(t, alice)).find((entry) => entry.reason === 'translation'),
    ).toMatchObject({
      delta: -8,
      refType: 'translationJob',
      refId: res.body.id,
      createdBy: alice.user.id,
    });
    expect(t.queues.jobs('translation')).toEqual([
      { translationJobId: res.body.id, workspaceId: alice.workspace.id },
    ]);
    expect(t.queues.jobIds('translation')).toEqual([res.body.id]);

    // The transcript is stored parsed and timed, ready for the job.
    const [row] = await jobRows(alice);
    expect(row?.transcript).toEqual([
      { startMs: 1000, endMs: 4000, text: 'Hola y bienvenidos a esta demostración.' },
      { startMs: 5000, endMs: 9500, text: 'Hoy veremos cómo funciona el producto.' },
    ]);
    // A library purpose is not rewritten by translating.
    const [asset] = await t.db.select().from(assets).where(eq(assets.id, source.id));
    expect(asset?.purpose).toBe('translation_source');
  });

  it('requires the transcript while the STT provider is manual, and not when it can transcribe', async () => {
    const alice = await t.signUp();
    const source = await sourceVideo(alice);
    const body = {
      sourceAssetId: source.id,
      sourceLanguage: 'es' as const,
      targetLanguages: ['en' as const],
    };
    const before = await balanceOf(t, alice);

    const required = await t.call(api.translations.create, { as: alice, body });
    expect(required.status).toBe(422);
    expect(required.error).toMatchObject({
      code: 'TRANSCRIPT_REQUIRED',
      details: { sttProvider: 'manual' },
    });
    expect(await jobRows(alice)).toEqual([]);
    expect(await balanceOf(t, alice)).toBe(before);

    const plain = await t.call(api.translations.create, {
      as: alice,
      body: {
        ...body,
        name: 'Con texto',
        transcript: { format: 'text', content: 'Hola a todos. Esto es una prueba.' },
      },
    });
    expect(plain.status).toBe(202);
    expect(plain.body.name).toBe('Con texto');
    const [withText] = await jobRows(alice);
    // Plain text is spread over the length of the video.
    expect(withText?.transcript?.map((cue) => cue.text)).toEqual([
      'Hola a todos.',
      'Esto es una prueba.',
    ]);
    expect(withText?.transcript?.at(-1)?.endMs).toBeLessThanOrEqual(65_000);

    useCapableStt();
    const auto = await t.call(api.translations.create, { as: alice, body });
    expect(auto.status).toBe(202);
    expect(auto.body.transcriptSource).toBe('stt');
    const rows = await jobRows(alice);
    expect(rows.find((row) => row.id === auto.body.id)?.transcript).toBeNull();
  });

  it('applies plan limits and the credit balance before creating anything', async () => {
    const free = await t.signUp(); // free: 1 target, 300 s, 30 credits
    const source = await sourceVideo(free);
    const tooMany = await t.call(api.translations.create, {
      as: free,
      body: {
        sourceAssetId: source.id,
        sourceLanguage: 'es',
        targetLanguages: ['en', 'fr'],
        transcript,
      },
    });
    expect(tooMany.status).toBe(403);
    expect(tooMany.error).toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxTranslationTargets', max: 1, value: 2 },
    });
    const long = await sourceVideo(free, { durationMs: 301_000 });
    const tooLong = await t.call(api.translations.create, {
      as: free,
      body: { sourceAssetId: long.id, sourceLanguage: 'es', targetLanguages: ['en'], transcript },
    });
    expect(tooLong.status).toBe(403);
    expect(tooLong.error.details).toMatchObject({
      limit: 'maxTranslationSourceSec',
      max: 300,
      value: 301,
    });

    const poor = await t.signUp({ credits: 3 });
    const mine = await sourceVideo(poor);
    const noCredits = await t.call(api.translations.create, {
      as: poor,
      body: { sourceAssetId: mine.id, sourceLanguage: 'es', targetLanguages: ['en'], transcript },
    });
    expect(noCredits.status).toBe(402);
    expect(noCredits.error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      details: { required: 4, available: 3 },
    });
    expect(await jobRows(free)).toEqual([]);
    expect(await jobRows(poor)).toEqual([]);
    expect(t.queues.size).toBe(0);
  });

  it('validates source, languages, transcript and voices', async () => {
    const alice = await t.signUp({ plan: 'creator', credits: 300 });
    const mallory = await t.signUp();
    const source = await sourceVideo(alice);
    const audio = await seedAsset(t, alice, { kind: 'audio' });
    const noDuration = await sourceVideo(alice, { durationMs: null });
    const foreign = await sourceVideo(mallory);
    const base = {
      sourceAssetId: source.id,
      sourceLanguage: 'es',
      targetLanguages: ['en'],
      transcript,
    };
    const call = (overrides: Record<string, unknown>) =>
      t.call(api.translations.create, { as: alice, body: { ...base, ...overrides } });

    const notVideo = await call({ sourceAssetId: audio.id });
    expect(notVideo.status).toBe(422);
    expect(notVideo.error.code).toBe('UNPROCESSABLE');
    expect((await call({ sourceAssetId: noDuration.id })).status).toBe(422);
    expect((await call({ sourceAssetId: newId('asset') })).status).toBe(404);
    expect((await call({ sourceAssetId: foreign.id })).status).toBe(404);
    expect((await call({ sourceAssetId: 'nope' })).status).toBe(400);
    expect((await call({ sourceAssetId: undefined })).status).toBe(400);
    expect((await call({ sourceVideoId: newId('video') })).status).toBe(400); // both given
    expect((await call({ targetLanguages: [] })).status).toBe(400);
    expect((await call({ targetLanguages: ['xx'] })).status).toBe(400);
    const same = await call({ targetLanguages: ['en', 'es'] });
    expect(same.status).toBe(400);
    expect(same.error.code).toBe('VALIDATION_ERROR');

    const noCues = await call({ transcript: { format: 'srt', content: 'esto no es un SRT' } });
    expect(noCues.status).toBe(422);
    expect(noCues.error.code).toBe('UNPROCESSABLE');
    const lateCues = await call({
      transcript: {
        format: 'vtt',
        content: 'WEBVTT\n\n00:05:00.000 --> 00:05:04.000\nFuera del vídeo\n',
      },
    });
    expect(lateCues.status).toBe(422);
    const blocked = await call({
      transcript: { format: 'text', content: 'Un texto que menciona zzprohibido en mitad.' },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.error).toMatchObject({
      code: 'CONTENT_BLOCKED',
      details: { field: 'transcript' },
    });
    expect((await call({ name: 'zzprohibido' })).error.code).toBe('CONTENT_BLOCKED');

    const wrongLanguage = await call({ voices: { en: 'espeak:es-f1' } });
    expect(wrongLanguage.status).toBe(400);
    expect(wrongLanguage.error.message).toContain('does not speak English');
    expect((await call({ voices: { en: 'espeak:nadie' } })).status).toBe(404);
    expect((await call({ voices: { en: newId('voice') } })).status).toBe(404);
    // No stock voice for Portuguese among the active providers.
    const noVoice = await call({ targetLanguages: ['pt'] });
    expect(noVoice.status).toBe(422);
    expect(noVoice.error).toMatchObject({ code: 'UNPROCESSABLE', details: { language: 'pt' } });

    expect(await jobRows(alice)).toEqual([]);
    expect(await balanceOf(t, alice)).toBe(300);
    expect(t.queues.size).toBe(0);
  });

  it('translates an own rendered video by copying it into a translation_source asset', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const insertVideo = async (owner: TestActor, status: 'completed' | 'draft') => {
      const id = newId('video');
      const renderJobId = newId('renderJob');
      const videoKey = storageKeys.videoOutput(owner.workspace.id, id, renderJobId, 'video.mp4');
      const thumbnailKey = storageKeys.videoOutput(
        owner.workspace.id,
        id,
        renderJobId,
        'thumb.jpg',
      );
      if (status === 'completed') {
        await t.app.providers.storage.put(videoKey, Buffer.from('rendered mp4 bytes'), {
          contentType: 'video/mp4',
        });
        await t.app.providers.storage.put(thumbnailKey, Buffer.from('jpg'), {
          contentType: 'image/jpeg',
        });
      }
      await t.db.insert(videos).values({
        id,
        workspaceId: owner.workspace.id,
        title: 'Presentación trimestral',
        composition: createComposition(),
        aspect: '16:9',
        status,
        ...(status === 'completed'
          ? { resolution: '720p' as const, durationMs: 42_000, videoKey, thumbnailKey }
          : {}),
      });
      return id;
    };
    const rendered = await insertVideo(alice, 'completed');
    const draft = await insertVideo(alice, 'draft');
    const foreign = await insertVideo(mallory, 'completed');
    const body = { sourceLanguage: 'es' as const, targetLanguages: ['en' as const], transcript };

    const notRendered = await t.call(api.translations.create, {
      as: alice,
      body: { ...body, sourceVideoId: draft },
    });
    expect(notRendered.status).toBe(422);
    expect(notRendered.error.code).toBe('UNPROCESSABLE');
    expect(
      (
        await t.call(api.translations.create, {
          as: alice,
          body: { ...body, sourceVideoId: foreign },
        })
      ).status,
    ).toBe(404);
    expect(await t.db.select().from(assets)).toEqual([]);

    const res = await t.call(api.translations.create, {
      as: alice,
      body: { ...body, sourceVideoId: rendered },
    });
    expect(res.status, res.raw.body).toBe(202);
    expect(res.body).toMatchObject({
      name: 'Presentación trimestral',
      sourceDurationMs: 42_000,
      creditsCharged: 2,
    });
    const [copy] = await t.db.select().from(assets).where(eq(assets.id, res.body.sourceAssetId));
    expect(copy).toMatchObject({
      workspaceId: alice.workspace.id,
      kind: 'video',
      purpose: 'translation_source',
      name: 'Presentación trimestral.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 'rendered mp4 bytes'.length,
      width: 1280,
      height: 720,
      durationMs: 42_000,
    });
    expect(Buffer.from(await t.app.providers.storage.get(copy?.storageKey ?? '')).toString()).toBe(
      'rendered mp4 bytes',
    );
    expect(await t.app.providers.storage.exists(copy?.thumbnailKey ?? '')).toBe(true);

    // When the job cannot be paid for, no copy is left behind.
    const poor = await t.signUp({ credits: 1 });
    const theirs = await insertVideo(poor, 'completed');
    const noCredits = await t.call(api.translations.create, {
      as: poor,
      body: { ...body, sourceVideoId: theirs },
    });
    expect(noCredits.status).toBe(402);
    expect(
      await t.db.select().from(assets).where(eq(assets.workspaceId, poor.workspace.id)),
    ).toEqual([]);
  });

  it('fails the job and refunds when the queue is down', async () => {
    const alice = await t.signUp();
    const source = await sourceVideo(alice);
    const before = await balanceOf(t, alice);
    const restore = breakQueue(t);
    const res = await t.call(api.translations.create, {
      as: alice,
      body: { sourceAssetId: source.id, sourceLanguage: 'es', targetLanguages: ['en'], transcript },
    });
    restore();
    expect(res.status).toBe(503);
    expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await balanceOf(t, alice)).toBe(before);
    const [row] = await jobRows(alice);
    expect(row).toMatchObject({
      status: 'failed',
      creditsCharged: 0,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    const outputs = await t.db.select().from(translationOutputs);
    expect(outputs.map((output) => output.status)).toEqual(['failed']);
  });

  it('requires a session and the editor role', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const source = await sourceVideo(owner);
    const body = {
      sourceAssetId: source.id,
      sourceLanguage: 'es',
      targetLanguages: ['en'],
      transcript,
    };
    expect((await t.call(api.translations.create, { body })).status).toBe(401);
    expect((await t.call(api.translations.create, { as: viewer, body })).status).toBe(403);
    expect(await jobRows(owner)).toEqual([]);
  });
});

describe('GET /api/translations and /api/translations/:translationId', () => {
  async function queued(actor: TestActor, name: string, targets: ('en' | 'fr' | 'de')[] = ['en']) {
    const source = await sourceVideo(actor);
    const res = await t.call(api.translations.create, {
      as: actor,
      body: {
        name,
        sourceAssetId: source.id,
        sourceLanguage: 'es',
        targetLanguages: targets,
        transcript,
      },
    });
    expect(res.status, res.raw.body).toBe(202);
    return res.body;
  }

  it('shows progress and, per language, playable, downloadable and subtitle files', async () => {
    const alice = await t.signUp({ plan: 'creator', credits: 300 });
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const job = await queued(alice, 'Demo: lanzamiento', ['en', 'fr']);
    const params = { translationId: job.id };

    // What the worker job persists while it runs and when it ends.
    const storage = t.app.providers.storage;
    const key = (file: 'video.mp4' | 'subtitles.srt' | 'subtitles.vtt') =>
      storageKeys.translationOutput(alice.workspace.id, job.id, 'en', file);
    await storage.put(key('video.mp4'), Buffer.from('dubbed mp4'), { contentType: 'video/mp4' });
    await storage.put(
      key('subtitles.srt'),
      Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nHello\n'),
      { contentType: 'application/x-subrip' },
    );
    await storage.put(key('subtitles.vtt'), Buffer.from('WEBVTT\n'), { contentType: 'text/vtt' });
    await t.db
      .update(translationJobs)
      .set({ status: 'processing', stage: 'dubbing', progress: 55 })
      .where(eq(translationJobs.id, job.id));
    const running = await t.call(api.translations.get, { as: viewer, params });
    expect(running.status).toBe(200);
    expect(running.body).toMatchObject({ status: 'processing', stage: 'dubbing', progress: 55 });

    const [en, fr] = job.outputs;
    await t.db
      .update(translationOutputs)
      .set({
        status: 'completed',
        videoKey: key('video.mp4'),
        srtKey: key('subtitles.srt'),
        vttKey: key('subtitles.vtt'),
      })
      .where(eq(translationOutputs.id, en?.id ?? ''));
    await t.db
      .update(translationOutputs)
      .set({ status: 'failed', error: { code: 'PROVIDER_ERROR', message: 'TTS failed' } })
      .where(eq(translationOutputs.id, fr?.id ?? ''));
    const providers = {
      translation: { id: 'local', name: 'Glosario local', quality: 'basic' as const, local: true },
    };
    await t.db
      .update(translationJobs)
      .set({ status: 'partial', stage: null, progress: 100, creditsCharged: 4, providers })
      .where(eq(translationJobs.id, job.id));

    const done = await t.call(api.translations.get, { as: alice, params });
    expect(done.body).toMatchObject({
      status: 'partial',
      progress: 100,
      creditsCharged: 4,
      providers,
    });
    const [enOut, frOut] = done.body.outputs;
    expect(frOut).toMatchObject({
      language: 'fr',
      status: 'failed',
      videoUrl: null,
      downloadUrl: null,
      srtUrl: null,
      vttUrl: null,
      error: { code: 'PROVIDER_ERROR', message: 'TTS failed' },
    });
    expect(enOut).toMatchObject({ language: 'en', status: 'completed', error: null });
    const fetchFile = async (url: string | null | undefined) => {
      const parsed = new URL(url ?? '');
      return t.inject({ method: 'GET', url: parsed.pathname + parsed.search });
    };
    const video = await fetchFile(enOut?.videoUrl);
    expect(video.statusCode).toBe(200);
    expect(video.body).toBe('dubbed mp4');
    const download = await fetchFile(enOut?.downloadUrl);
    expect(download.statusCode).toBe(200);
    expect(String(download.headers['content-disposition'])).toMatch(
      /^attachment; .*Demo_ lanzamiento-en\.mp4/,
    );
    expect((await fetchFile(enOut?.srtUrl)).body).toContain('Hello');
    expect((await fetchFile(enOut?.vttUrl)).body).toContain('WEBVTT');
  });

  it('lists newest first with a cursor, only for the workspace', async () => {
    const alice = await t.signUp({ plan: 'creator', credits: 300 });
    const mallory = await t.signUp();
    const names = ['Primera', 'Segunda', 'Tercera'];
    const ids: string[] = [];
    for (const [index, name] of names.entries()) {
      const job = await queued(alice, name);
      ids.push(job.id);
      await t.db
        .update(translationJobs)
        .set({ createdAt: new Date(Date.now() - (3 - index) * 60_000) })
        .where(eq(translationJobs.id, job.id));
    }
    await queued(mallory, 'Ajena');

    const page1 = await t.call(api.translations.list, { as: alice, query: { limit: 2 } });
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((job) => job.name)).toEqual(['Tercera', 'Segunda']);
    expect(page1.body.items[0]?.outputs).toHaveLength(1);
    const page2 = await t.call(api.translations.list, {
      as: alice,
      query: { limit: 2, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((job) => job.name)).toEqual(['Primera']);
    expect(page2.body.nextCursor).toBeNull();

    expect((await t.call(api.translations.list)).status).toBe(401);
    expect(
      (await t.call(api.translations.list, { as: mallory })).body.items.map((j) => j.name),
    ).toEqual(['Ajena']);
    const params = { translationId: ids[0] ?? '' };
    expect((await t.call(api.translations.get, { params })).status).toBe(401);
    expect((await t.call(api.translations.get, { as: mallory, params })).status).toBe(404);
    expect(
      (await t.call(api.translations.get, { as: alice, params: { translationId: 'nope' } })).status,
    ).toBe(400);
  });
});

describe('DELETE /api/translations/:translationId', () => {
  it('cancels a job still queued (refund), removes outputs, row and the hidden source file', async () => {
    const alice = await t.signUp({ plan: 'creator', credits: 300 });
    const viewer = await t.addMember(alice.workspace, 'viewer');
    const mallory = await t.signUp();
    const source = await sourceVideo(alice);
    const body = {
      sourceAssetId: source.id,
      sourceLanguage: 'es' as const,
      targetLanguages: ['en' as const],
      transcript,
    };
    const first = await t.call(api.translations.create, { as: alice, body });
    const second = await t.call(api.translations.create, { as: alice, body });
    expect(await balanceOf(t, alice)).toBe(300 - 8);
    const storage = t.app.providers.storage;
    const outputKey = storageKeys.translationOutput(
      alice.workspace.id,
      first.body.id,
      'en',
      'video.mp4',
    );
    await storage.put(outputKey, Buffer.from('partial'), { contentType: 'video/mp4' });
    const params = { translationId: first.body.id };

    expect((await t.call(api.translations.remove, { params })).status).toBe(401);
    expect((await t.call(api.translations.remove, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.translations.remove, { as: mallory, params })).status).toBe(404);
    expect(await jobRows(alice)).toHaveLength(2);

    const res = await t.call(api.translations.remove, { as: alice, params });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await jobRows(alice)).map((row) => row.id)).toEqual([second.body.id]);
    expect(
      await t.db
        .select()
        .from(translationOutputs)
        .where(eq(translationOutputs.jobId, first.body.id)),
    ).toEqual([]);
    expect(await storage.exists(outputKey)).toBe(false);
    expect(t.queues.jobIds('translation')).toEqual([second.body.id]);
    // The reservation of the cancelled job goes back.
    expect(await balanceOf(t, alice)).toBe(300 - 4);
    const refund = (await ledgerOf(t, alice)).find((entry) => entry.reason === 'refund');
    expect(refund).toMatchObject({ delta: 4, refType: 'translationJob', refId: first.body.id });
    // The source is still used by the other job: it stays.
    expect(await storage.exists(source.storageKey)).toBe(true);
    expect((await t.call(api.translations.remove, { as: alice, params })).status).toBe(404);

    // A finished job keeps its charge; its source (uploaded only to translate) goes with it.
    await t.db
      .update(translationJobs)
      .set({ status: 'completed', progress: 100 })
      .where(eq(translationJobs.id, second.body.id));
    expect(
      (
        await t.call(api.translations.remove, {
          as: alice,
          params: { translationId: second.body.id },
        })
      ).status,
    ).toBe(200);
    expect(await balanceOf(t, alice)).toBe(300 - 4);
    expect(await jobRows(alice)).toEqual([]);
    expect(await storage.exists(source.storageKey)).toBe(false);
    expect(await t.db.select().from(assets).where(eq(assets.id, source.id))).toEqual([]);
  });

  it('keeps a source video that belongs to the library', async () => {
    const alice = await t.signUp();
    const libraryVideo = await seedAsset(t, alice, {
      kind: 'video',
      purpose: 'library',
      durationMs: 30_000,
    });
    const job = await t.call(api.translations.create, {
      as: alice,
      body: {
        sourceAssetId: libraryVideo.id,
        sourceLanguage: 'es',
        targetLanguages: ['en'],
        transcript,
      },
    });
    expect(job.status).toBe(202);
    expect(
      (await t.call(api.translations.remove, { as: alice, params: { translationId: job.body.id } }))
        .status,
    ).toBe(200);
    const [asset] = await t.db.select().from(assets).where(eq(assets.id, libraryVideo.id));
    expect(asset?.purpose).toBe('library');
    expect(await t.app.providers.storage.exists(libraryVideo.storageKey)).toBe(true);
  });
});
