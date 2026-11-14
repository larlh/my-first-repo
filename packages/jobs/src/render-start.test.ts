import {
  and,
  assets,
  avatars,
  batchItems,
  batchJobs,
  consentRecords,
  creditLedger,
  eq,
  getCreditBalance,
  netCharged,
  renderJobs,
  videos,
  voices,
} from '@parlante/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PublicVideoSchema,
  TtsCacheMetaSchema,
  createComposition,
  creditsForRender,
  estimateCompositionDurationMs,
  newId,
} from '@parlante/shared';
import type {
  Composition,
  EngineStatus,
  ModerationRequest,
  Providers,
  StorageProvider,
  TTSProvider,
  TTSRequest,
} from '@parlante/shared';
import { storageKeys, ttsCacheKey } from '@parlante/shared/node';
import type { DbHandle } from '@parlante/db';
import { connectTestDb, resetDatabase, seedAccount } from '@parlante/db/testing';
import {
  InMemoryQueueClient,
  createFileUrlBuilder,
  failRenderJob,
  recomputeBatchStatus,
  resolveVoice,
  startRender,
  synthesizeCached,
  toPublicVideo,
} from './index';
import type { QueueClient } from './index';

let handle: DbHandle;
let queues: InMemoryQueueClient;

beforeAll(() => {
  handle = connectTestDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDatabase(handle.db);
  queues = new InMemoryQueueClient();
});

/* ---------- fakes ---------- */

interface FakeProviders {
  providers: Pick<Providers, 'moderation' | 'lipsync' | 'tts' | 'storage'>;
  moderated: ModerationRequest[];
  synthesized: TTSRequest[];
  objects: Map<string, Uint8Array>;
  engine: EngineStatus;
}

function fakeProviders(options: { blockWord?: string } = {}): FakeProviders {
  const moderated: ModerationRequest[] = [];
  const synthesized: TTSRequest[] = [];
  const objects = new Map<string, Uint8Array>();
  const ref = { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic' as const, local: true };
  const state: FakeProviders = {
    moderated,
    synthesized,
    objects,
    engine: {
      available: false,
      reason: 'Engine stopped',
      device: null,
      secondsPerVideoSecond: null,
    },
    providers: undefined as never,
  };
  const tts: TTSProvider = {
    info: ref,
    listVoices: async () => [],
    synthesize: async (request) => {
      synthesized.push(request);
      const durationMs = request.text.length * 60;
      return {
        audio: new Uint8Array([82, 73, 70, 70, request.text.length]),
        format: 'wav',
        sampleRate: 22050,
        durationMs,
        visemes: [
          { tMs: 0, viseme: 'rest' },
          { tMs: 10, viseme: 'A' },
          { tMs: durationMs, viseme: 'rest' },
        ],
        words: [{ tMs: 10, durMs: durationMs - 10, text: request.text }],
        provider: ref,
      };
    },
  };
  const storage = {
    info: { id: 'memory', name: 'Memory', quality: 'basic', local: true },
    put: async (key: string, body: Uint8Array) => {
      objects.set(key, body);
      return { key, size: body.length, contentType: null, lastModified: null };
    },
    get: async (key: string) => {
      const found = objects.get(key);
      if (!found) throw new Error('missing object');
      return found;
    },
    exists: async (key: string) => objects.has(key),
    signedUrl: async () => null,
  } as unknown as StorageProvider;
  state.providers = {
    moderation: {
      info: { id: 'local', name: 'Blocklist', quality: 'basic', local: true },
      check: async (request) => {
        moderated.push(request);
        const blocked = options.blockWord !== undefined && request.text.includes(options.blockWord);
        return {
          allowed: !blocked,
          flags: blocked ? [{ category: 'blocklist', reason: 'Blocked term' }] : [],
          provider: { id: 'local', name: 'Blocklist', quality: 'basic', local: true },
        };
      },
    },
    lipsync: {
      info: { id: 'local-neural', name: 'Motor neuronal local', quality: 'premium', local: true },
      status: async () => state.engine,
      animate: async () => {
        throw new Error('not used');
      },
    },
    tts: { default: tts, get: (id) => (id === 'espeak' ? tts : null), all: () => [tts] },
    storage,
  };
  return state;
}

function talkingComposition(text = 'Hola {{nombre}}, bienvenida a Parlante.'): Composition {
  return createComposition({
    scenes: [
      {
        id: 'scene1',
        script: { kind: 'tts', text, voiceId: 'espeak:es-f1', language: 'es' },
        layers: [
          {
            id: 'avatar1',
            type: 'avatar',
            avatarId: 'stock_lucia',
            box: { x: 0.3, y: 0.1, w: 0.4, h: 0.9 },
          },
          {
            id: 'title1',
            type: 'text',
            text: 'Oferta para {{nombre}}',
            box: { x: 0.1, y: 0.05, w: 0.8, h: 0.15 },
          },
        ],
      },
    ],
  });
}

async function seedVideo(workspaceId: string, overrides: Partial<typeof videos.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(videos)
    .values({
      id: newId('video'),
      workspaceId,
      title: 'Demo: lanzamiento/2026',
      composition: talkingComposition(),
      aspect: '16:9',
      revision: 3,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('seed');
  return row;
}

async function tableCounts() {
  return {
    renderJobs: (await handle.db.select().from(renderJobs)).length,
    ledger: (await handle.db.select().from(creditLedger)).filter((r) => r.refType === 'renderJob')
      .length,
  };
}

/* ---------- startRender ---------- */

describe('startRender', () => {
  it('moderates, charges the estimate, snapshots with variables applied and enqueues', async () => {
    const { workspace, user } = await seedAccount(handle.db, { credits: 30 });
    const video = await seedVideo(workspace.id);
    const fake = fakeProviders();

    const { video: updated, renderJob } = await startRender(
      { db: handle.db, queues, providers: fake.providers },
      {
        workspaceId: workspace.id,
        videoId: video.id,
        resolution: '720p',
        createdBy: user.id,
        variables: { nombre: 'Ana' },
      },
    );

    // Every user text was moderated AFTER variables were applied.
    expect(fake.moderated.map((m) => [m.context, m.text])).toEqual([
      ['script', 'Hola Ana, bienvenida a Parlante.'],
      ['script', 'Oferta para Ana'],
    ]);
    // Snapshot is concrete; the video keeps its placeholders.
    const snapshotScript = renderJob.composition.scenes[0]?.script;
    expect(snapshotScript).toMatchObject({ kind: 'tts', text: 'Hola Ana, bienvenida a Parlante.' });
    expect(renderJob.composition.variables).toEqual([]);
    expect(updated.composition.scenes[0]?.script).toMatchObject({
      text: 'Hola {{nombre}}, bienvenida a Parlante.',
    });

    const expectedCost = creditsForRender(
      estimateCompositionDurationMs(renderJob.composition),
      '720p',
    );
    expect(renderJob).toMatchObject({
      status: 'queued',
      videoId: video.id,
      workspaceId: workspace.id,
      resolution: '720p',
      revision: 3,
      watermark: true, // free plan
      creditsCharged: expectedCost,
      createdBy: user.id,
    });
    expect(updated).toMatchObject({
      status: 'queued',
      progress: 0,
      currentRenderJobId: renderJob.id,
      error: null,
    });
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(30 - expectedCost);
    expect(
      await netCharged(handle.db, workspace.id, { refType: 'renderJob', refId: renderJob.id }),
    ).toBe(expectedCost);
    const [entry] = await handle.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.refId, renderJob.id));
    expect(entry).toMatchObject({ reason: 'render', delta: -expectedCost, createdBy: user.id });

    expect(queues.jobs('render')).toEqual([
      { renderJobId: renderJob.id, videoId: video.id, workspaceId: workspace.id },
    ]);
    expect(queues.jobIds('render')).toEqual([renderJob.id]);
  });

  it('charges nothing and creates nothing when moderation blocks the content', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 30 });
    const video = await seedVideo(workspace.id);
    const fake = fakeProviders({ blockWord: 'Oferta' });
    await expect(
      startRender(
        { db: handle.db, queues, providers: fake.providers },
        { workspaceId: workspace.id, videoId: video.id, resolution: '720p', createdBy: null },
      ),
    ).rejects.toMatchObject({
      code: 'CONTENT_BLOCKED',
      details: { sceneId: 'scene1', layerId: 'title1', kind: 'text-layer' },
    });
    expect(await tableCounts()).toEqual({ renderJobs: 0, ledger: 0 });
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(30);
    expect(queues.size).toBe(0);
    const [after] = await handle.db.select().from(videos).where(eq(videos.id, video.id));
    expect(after?.status).toBe('draft');
  });

  it('rolls everything back when credits are insufficient', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 0 });
    const video = await seedVideo(workspace.id);
    await expect(
      startRender(
        { db: handle.db, queues, providers: fakeProviders().providers },
        { workspaceId: workspace.id, videoId: video.id, resolution: '720p', createdBy: null },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(await tableCounts()).toEqual({ renderJobs: 0, ledger: 0 });
    expect(queues.size).toBe(0);
    const [after] = await handle.db.select().from(videos).where(eq(videos.id, video.id));
    expect(after).toMatchObject({ status: 'draft', currentRenderJobId: null });
  });

  it('is workspace-scoped and refuses a second render of the same video', async () => {
    const a = await seedAccount(handle.db, { credits: 30, plan: 'team' });
    const b = await seedAccount(handle.db, { credits: 30 });
    const video = await seedVideo(a.workspace.id);
    const deps = { db: handle.db, queues, providers: fakeProviders().providers };
    await expect(
      startRender(deps, {
        workspaceId: b.workspace.id,
        videoId: video.id,
        resolution: '720p',
        createdBy: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await startRender(deps, {
      workspaceId: a.workspace.id,
      videoId: video.id,
      resolution: '720p',
      createdBy: null,
    });
    await expect(
      startRender(deps, {
        workspaceId: a.workspace.id,
        videoId: video.id,
        resolution: '720p',
        createdBy: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await tableCounts()).renderJobs).toBe(1);
  });

  it('applies plan limits: resolution, duration and interactive concurrency (batches exempt)', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 30 }); // free: 720p, 1 render
    const deps = { db: handle.db, queues, providers: fakeProviders().providers };
    const base = { workspaceId: workspace.id, createdBy: null } as const;
    const first = await seedVideo(workspace.id);
    await expect(
      startRender(deps, { ...base, videoId: first.id, resolution: '1080p' }),
    ).rejects.toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED', details: { limit: 'maxResolution' } });

    const long = await seedVideo(workspace.id, {
      composition: createComposition({
        scenes: [{ duration: { mode: 'fixed', seconds: 200 } }],
      }),
    });
    await expect(
      startRender(deps, { ...base, videoId: long.id, resolution: '720p' }),
    ).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxVideoDurationSec', max: 180, value: 200 },
    });

    await startRender(deps, { ...base, videoId: first.id, resolution: '720p' });
    const second = await seedVideo(workspace.id);
    await expect(
      startRender(deps, { ...base, videoId: second.id, resolution: '720p' }),
    ).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      details: { limit: 'maxConcurrentRenders', max: 1 },
    });

    // Batch fan-out: exempt, and its renders do not count against interactive ones.
    const [batch] = await handle.db
      .insert(batchJobs)
      .values({
        id: newId('batchJob'),
        workspaceId: workspace.id,
        name: 'Lote',
        composition: talkingComposition(),
        resolution: '720p',
        status: 'processing',
        total: 2,
      })
      .returning();
    const batchVideos = [
      await seedVideo(workspace.id, { batchJobId: batch?.id, source: 'batch' }),
      await seedVideo(workspace.id, { batchJobId: batch?.id, source: 'batch' }),
    ];
    for (const [index, video] of batchVideos.entries()) {
      const started = await startRender(deps, {
        ...base,
        videoId: video.id,
        resolution: '720p',
        variables: { nombre: `Fila ${index}` },
        skipConcurrencyLimit: true,
      });
      await handle.db.insert(batchItems).values({
        id: newId('batchItem'),
        workspaceId: workspace.id,
        batchJobId: batch?.id ?? '',
        index,
        values: { nombre: `Fila ${index}` },
        status: 'queued',
        videoId: started.video.id,
      });
    }
    expect((await tableCounts()).renderJobs).toBe(3);

    // The batch's cost is the sum of its renders (it is never charged itself).
    await recomputeBatchStatus(handle.db, workspace.id, batch?.id ?? '');
    const [batchAfter] = await handle.db
      .select()
      .from(batchJobs)
      .where(eq(batchJobs.id, batch?.id ?? ''));
    const perRender = creditsForRender(
      estimateCompositionDurationMs(talkingComposition('Hola Fila 0, bienvenida a Parlante.')),
      '720p',
    );
    expect(batchAfter?.creditsCharged).toBe(perRender * 2);
    const ledgerRefs = await handle.db
      .select({ refType: creditLedger.refType })
      .from(creditLedger)
      .where(and(eq(creditLedger.workspaceId, workspace.id), eq(creditLedger.reason, 'render')));
    expect(ledgerRefs.every((r) => r.refType === 'renderJob')).toBe(true);
  });

  it('rejects compositions whose avatars, voices or narration audio are not usable', async () => {
    const a = await seedAccount(handle.db, { credits: 30 });
    const b = await seedAccount(handle.db, { credits: 30 });
    const deps = { db: handle.db, queues, providers: fakeProviders().providers };
    const run = (composition: Composition) =>
      seedVideo(a.workspace.id, { composition }).then((video) =>
        startRender(deps, {
          workspaceId: a.workspace.id,
          videoId: video.id,
          resolution: '720p',
          createdBy: null,
        }),
      );
    const withAvatar = (avatarId: string) =>
      createComposition({
        scenes: [{ layers: [{ type: 'avatar', avatarId, box: { x: 0, y: 0, w: 0.5, h: 1 } }] }],
      });

    await expect(run(withAvatar('stock_no-such-avatar'))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      details: { avatarId: 'stock_no-such-avatar' },
    });
    await expect(run(withAvatar('real_no-such-person'))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });

    // An avatar of ANOTHER workspace is indistinguishable from a missing one.
    const foreignAvatar = newId('avatar');
    await handle.db.insert(avatars).values({
      id: foreignAvatar,
      workspaceId: b.workspace.id,
      name: 'Ajeno',
      origin: 'generated',
      status: 'ready',
    });
    await expect(run(withAvatar(foreignAvatar))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      details: { avatarId: foreignAvatar },
    });
    const processing = newId('avatar');
    await handle.db.insert(avatars).values({
      id: processing,
      workspaceId: a.workspace.id,
      name: 'En preparación',
      origin: 'generated',
    });
    await expect(run(withAvatar(processing))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      details: { avatarId: processing, status: 'processing' },
    });

    const withVoice = (voiceId: string) =>
      createComposition({
        scenes: [{ script: { kind: 'tts', text: 'Hola', voiceId, language: 'es' } }],
      });
    await expect(run(withVoice('elevenlabs:abc'))).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    await expect(run(withVoice(newId('voice')))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });

    await expect(
      run(
        createComposition({
          scenes: [{ script: { kind: 'audio', assetId: newId('asset') } }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
    expect(await tableCounts()).toEqual({ renderJobs: 0, ledger: 0 });
  });

  it('uses the real length of uploaded narration for limits and cost', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 30 });
    const assetId = newId('asset');
    await handle.db.insert(assets).values({
      id: assetId,
      workspaceId: workspace.id,
      kind: 'audio',
      name: 'locucion.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 1000,
      durationMs: 65_000,
      storageKey: storageKeys.asset(workspace.id, assetId, 'mp3'),
    });
    const video = await seedVideo(workspace.id, {
      composition: createComposition({
        scenes: [{ script: { kind: 'audio', assetId, transcript: 'Texto' } }],
      }),
    });
    const { renderJob } = await startRender(
      { db: handle.db, queues, providers: fakeProviders().providers },
      { workspaceId: workspace.id, videoId: video.id, resolution: '720p', createdBy: null },
    );
    expect(renderJob.creditsCharged).toBe(creditsForRender(65_800, '720p')); // 3 units
    expect(renderJob.creditsCharged).toBe(3);
  });

  it('needs the engine for photorealistic avatars and charges them at the photoreal rate', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 30 });
    const avatarId = newId('avatar');
    await handle.db.insert(avatars).values({
      id: avatarId,
      workspaceId: workspace.id,
      name: 'Sintética',
      origin: 'generated',
      status: 'ready',
    });
    const video = await seedVideo(workspace.id, {
      composition: createComposition({
        scenes: [
          {
            script: { kind: 'tts', text: 'Hola', voiceId: 'espeak:es-f1', language: 'es' },
            layers: [{ type: 'avatar', avatarId, box: { x: 0, y: 0, w: 0.5, h: 1 } }],
          },
        ],
      }),
    });
    const fake = fakeProviders();
    const input = {
      workspaceId: workspace.id,
      videoId: video.id,
      resolution: '720p',
      createdBy: null,
    } as const;
    await expect(
      startRender({ db: handle.db, queues, providers: fake.providers }, input),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'Engine stopped' });
    expect(await tableCounts()).toEqual({ renderJobs: 0, ledger: 0 });

    // Engine up but without animation weights: still refused before charging.
    fake.engine = {
      available: true,
      reason: 'Animation weights are not downloaded',
      device: 'cpu',
      secondsPerVideoSecond: null,
      operations: { generate: true, prepare: true, animate: false },
    };
    await expect(
      startRender({ db: handle.db, queues, providers: fake.providers }, input),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    fake.engine = {
      available: true,
      reason: null,
      device: 'cpu',
      secondsPerVideoSecond: 28,
      operations: { generate: false, prepare: true, animate: true },
    };
    const { renderJob } = await startRender(
      { db: handle.db, queues, providers: fake.providers },
      input,
    );
    const estimate = estimateCompositionDurationMs(renderJob.composition);
    expect(renderJob.creditsCharged).toBe(creditsForRender(estimate, '720p', { photoreal: true }));
    expect(renderJob.creditsCharged).toBe(2 * creditsForRender(estimate, '720p'));
  });

  it('fails and refunds the job when the queue cannot take it', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 30 });
    const video = await seedVideo(workspace.id);
    const brokenQueues = {
      enqueue: async () => {
        throw new Error('ECONNREFUSED redis');
      },
    } as unknown as QueueClient;
    await expect(
      startRender(
        { db: handle.db, queues: brokenQueues, providers: fakeProviders().providers },
        { workspaceId: workspace.id, videoId: video.id, resolution: '720p', createdBy: null },
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const [job] = await handle.db.select().from(renderJobs);
    expect(job).toMatchObject({
      status: 'failed',
      creditsCharged: 0,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(30);
    const [after] = await handle.db.select().from(videos).where(eq(videos.id, video.id));
    expect(after).toMatchObject({ status: 'failed', error: { code: 'SERVICE_UNAVAILABLE' } });
    // The video can be rendered again afterwards.
    await startRender(
      { db: handle.db, queues, providers: fakeProviders().providers },
      { workspaceId: workspace.id, videoId: video.id, resolution: '720p', createdBy: null },
    );
    expect(queues.jobs('render')).toHaveLength(1);
  });
});

describe('failRenderJob', () => {
  it('fails and refunds once, and never touches a cancelled job', async () => {
    const { workspace } = await seedAccount(handle.db, { credits: 30 });
    const deps = { db: handle.db, queues, providers: fakeProviders().providers };
    const video = await seedVideo(workspace.id);
    const { renderJob } = await startRender(deps, {
      workspaceId: workspace.id,
      videoId: video.id,
      resolution: '720p',
      createdBy: null,
    });
    const ref = { renderJobId: renderJob.id, videoId: video.id, workspaceId: workspace.id };
    const error = { code: 'PROVIDER_ERROR' as const, message: 'TTS down' };
    expect(await failRenderJob(handle.db, ref, error)).toBe(true);
    expect(await failRenderJob(handle.db, ref, error)).toBe(false);
    expect(await getCreditBalance(handle.db, workspace.id)).toBe(30);

    // Cancelled by the user (API already refunded): a late failure must not change anything.
    const other = await seedVideo(workspace.id);
    const second = await startRender(deps, {
      workspaceId: workspace.id,
      videoId: other.id,
      resolution: '720p',
      createdBy: null,
    });
    await handle.db
      .update(renderJobs)
      .set({ status: 'canceled' })
      .where(eq(renderJobs.id, second.renderJob.id));
    await handle.db.update(videos).set({ status: 'draft' }).where(eq(videos.id, other.id));
    expect(
      await failRenderJob(
        handle.db,
        { renderJobId: second.renderJob.id, videoId: other.id, workspaceId: workspace.id },
        error,
      ),
    ).toBe(false);
    const [job] = await handle.db
      .select()
      .from(renderJobs)
      .where(eq(renderJobs.id, second.renderJob.id));
    expect(job?.status).toBe('canceled');
    const [untouched] = await handle.db.select().from(videos).where(eq(videos.id, other.id));
    expect(untouched).toMatchObject({ status: 'draft', error: null });
  });
});

/* ---------- voices & shared TTS cache ---------- */

describe('resolveVoice', () => {
  it('resolves stock voices by provider and cloned voices by workspace and state', async () => {
    const a = await seedAccount(handle.db);
    const b = await seedAccount(handle.db);
    const { providers } = fakeProviders();
    const stock = await resolveVoice(handle.db, providers, a.workspace.id, 'espeak:es-f1');
    expect(stock).toMatchObject({ kind: 'stock', providerVoiceId: 'es-f1', profile: null });
    expect(stock.tts.info.id).toBe('espeak');
    await expect(
      resolveVoice(handle.db, providers, a.workspace.id, 'openai:alloy'),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });

    const voiceId = newId('voice');
    const consentId = newId('consent');
    await handle.db.insert(consentRecords).values({
      id: consentId,
      workspaceId: a.workspace.id,
      userId: a.user.id,
      kind: 'voice_clone',
      subjectName: 'Ana Pérez',
      relationship: 'self',
      statementVersion: 'v1',
      statement: 'Consiento',
      locale: 'es',
      ip: '127.0.0.1',
    });
    const profile = { baseVoiceId: 'es-f1', pitchSemitones: 2, speed: 1.1, meanF0Hz: 210 };
    await handle.db.insert(voices).values({
      id: voiceId,
      workspaceId: a.workspace.id,
      name: 'Mi voz',
      language: 'es',
      consentId,
    });
    await expect(resolveVoice(handle.db, providers, a.workspace.id, voiceId)).rejects.toMatchObject(
      { code: 'INVALID_STATE' },
    );
    await handle.db
      .update(voices)
      .set({ status: 'ready', ttsProviderId: 'espeak', providerVoiceId: 'es-f1', profile })
      .where(eq(voices.id, voiceId));
    expect(await resolveVoice(handle.db, providers, a.workspace.id, voiceId)).toMatchObject({
      kind: 'cloned',
      providerVoiceId: 'es-f1',
      profile,
      language: 'es',
    });
    // Never resolvable from another workspace.
    await expect(resolveVoice(handle.db, providers, b.workspace.id, voiceId)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});

describe('synthesizeCached', () => {
  it('synthesises once and serves API and worker from the same cache entry', async () => {
    const { workspace } = await seedAccount(handle.db);
    const fake = fakeProviders();
    const deps = { db: handle.db, providers: fake.providers };
    const request = { text: '  Hola mundo  ', voiceId: 'espeak:es-f1', language: 'es' };

    const first = await synthesizeCached(deps, workspace.id, request);
    expect(first.cached).toBe(false);
    expect(fake.synthesized).toHaveLength(1);
    expect(fake.synthesized[0]).toMatchObject({ text: 'Hola mundo', speed: 1, pitch: 0 });
    const hash = ttsCacheKey({
      provider: 'espeak',
      providerVoiceId: 'es-f1',
      text: 'Hola mundo',
      language: 'es',
      speed: 1,
      pitch: 0,
      profile: null,
    });
    expect(first.audioKey).toBe(storageKeys.ttsCacheAudio(hash));
    const meta = TtsCacheMetaSchema.parse(
      JSON.parse(new TextDecoder().decode(fake.objects.get(storageKeys.ttsCacheMeta(hash)))),
    );
    expect(meta).toMatchObject({ v: 1, sampleRate: 22050, provider: { id: 'espeak' } });
    expect(meta.runtime).toEqual(first.runtime);
    expect(first.runtime.audioDurationMs).toBe('Hola mundo'.length * 60);

    // Second caller (the worker, with an untrimmed/trimmed variant of the same text).
    const second = await synthesizeCached(deps, workspace.id, { ...request, text: 'Hola mundo' });
    expect(second).toMatchObject({ cached: true, audioKey: first.audioKey });
    expect(second.runtime).toEqual(first.runtime);
    expect(fake.synthesized).toHaveLength(1);

    // Different speed = different audio.
    await synthesizeCached(deps, workspace.id, { ...request, speed: 1.2 });
    expect(fake.synthesized).toHaveLength(2);

    // A sidecar written in any other shape is a miss and gets rewritten in the shared format.
    fake.objects.set(
      storageKeys.ttsCacheMeta(hash),
      new TextEncoder().encode(JSON.stringify({ visemes: [], words: [], durationMs: 600 })),
    );
    const third = await synthesizeCached(deps, workspace.id, request);
    expect(third.cached).toBe(false);
    expect(fake.synthesized).toHaveLength(3);
    expect(
      TtsCacheMetaSchema.safeParse(
        JSON.parse(new TextDecoder().decode(fake.objects.get(storageKeys.ttsCacheMeta(hash)))),
      ).success,
    ).toBe(true);
  });
});

describe('toPublicVideo', () => {
  it('adds a download URL named after the title and flags AI presenters', async () => {
    const { workspace } = await seedAccount(handle.db);
    const fileUrl = createFileUrlBuilder({
      storage: { signedUrl: async () => null } as unknown as StorageProvider,
      appSecret: 'jobs-test-secret-jobs-test-secret-1234',
      publicApiUrl: 'http://api.test',
    });
    const video = await seedVideo(workspace.id, {
      status: 'completed',
      videoKey: `ws/${workspace.id}/videos/v/r/video.mp4`,
    });
    const dto = PublicVideoSchema.parse(await toPublicVideo(video, fileUrl));
    expect(new URL(dto.downloadUrl ?? '').searchParams.get('download')).toBe(
      'Demo_ lanzamiento_2026.mp4',
    );
    expect(new URL(dto.videoUrl ?? '').searchParams.get('download')).toBeNull();
    expect(dto.aiGenerated).toBe(false);
    const draft = await seedVideo(workspace.id);
    expect((await toPublicVideo(draft, fileUrl)).downloadUrl).toBeNull();
  });
});
