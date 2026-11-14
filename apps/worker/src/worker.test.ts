import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnrecoverableError, Worker } from 'bullmq';
import { AppError, createComposition, creditsForRender, newId } from '@parlante/shared';
import type { Composition, StoredError } from '@parlante/shared';
import { baseEnvSchema, parseEnv } from '@parlante/shared/node';
import {
  avatars,
  chargeCredits,
  creditLedger,
  eq,
  getCreditBalance,
  refundCredits,
  renderJobs,
  videos,
  webhookEndpoints,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import { BullQueueClient, createRedisConnection } from '@parlante/jobs';
import { startWorker } from './bootstrap';
import { concurrencyFor, enabledQueues, loadConfig } from './config';
import systemJob from './jobs/system/index';
import { finalFailure, isFinalError } from './lib/errors';
import { ffprobe, parseFfmpegTime, runFfmpeg, runProcess } from './lib/ffmpeg';
import { defineJob } from './lib/job';
import { loadJobs } from './lib/loader';
import { markAvatarFailed, reportAvatarProgress } from './lib/avatar-status';
import { scale, throttled } from './lib/progress';
import { handleFailedJob, startWorkers, storedErrorFromFailedReason } from './lib/runner';
import {
  actualRenderCredits,
  isRenderCanceled,
  loadRenderJob,
  markRenderCompleted,
  markRenderFailed,
  markRenderStarted,
  reportRenderProgress,
} from './lib/render-status';
import { createTempDir, withTempDir } from './lib/tmp';
import { createTestWorker } from './testing/index';
import type { TestWorker } from './testing/index';

let t: TestWorker;

beforeAll(async () => {
  t = await createTestWorker();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe('job loading and config', () => {
  it('autoloads jobs/*/index.ts with one processor per queue', async () => {
    const jobs = await loadJobs();
    const queues = jobs.map((j) => j.queue);
    expect(queues).toContain('system');
    expect(new Set(queues).size).toBe(queues.length);
  });

  it('reads concurrency overrides and queue selection from the environment', () => {
    const config = loadConfig({ WORKER_CONCURRENCY_RENDER: '3', WORKER_QUEUES: 'render, system' });
    expect(concurrencyFor(config, 'render')).toBe(3);
    expect(concurrencyFor(config, 'webhookDelivery')).toBe(5);
    expect(enabledQueues(config)).toEqual(['render', 'system']);
    expect(enabledQueues(loadConfig({})).length).toBe(7);
  });
});

describe('example job (system ping)', () => {
  it('processes a ping through the same wrapper as the real runner', async () => {
    const { result, progress } = await t.run(systemJob, { kind: 'ping', echo: 'hola' });
    expect(result.kind).toBe('pong');
    expect(result.echo).toBe('hola');
    expect(Number.isNaN(Date.parse(result.processedAt))).toBe(false);
    expect(progress[0]).toEqual({ percent: 50 });
  });

  it('rejects invalid payloads and invalid results', async () => {
    await expect(t.run(systemJob, { kind: 'nope' } as never)).rejects.toThrow();
    const broken = defineJob({ queue: 'system', handler: async () => ({ kind: 'pong' }) as never });
    await expect(t.run(broken, { kind: 'ping' })).rejects.toThrow();
  });

  it('marks 4xx domain errors as final and lets other errors retry', async () => {
    const blocked = defineJob({
      queue: 'system',
      handler: async () => {
        throw new AppError('CONTENT_BLOCKED', 'no');
      },
    });
    await expect(t.run(blocked, { kind: 'ping' })).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    const flaky = defineJob({
      queue: 'system',
      handler: async () => {
        throw new AppError('PROVIDER_ERROR', 'upstream down');
      },
    });
    await expect(t.run(flaky, { kind: 'ping' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(isFinalError(new AppError('CONSENT_REQUIRED', 'x'))).toBe(true);
    expect(isFinalError(new Error('boom'))).toBe(false);
    expect(finalFailure(new Error('boom'), { isLastAttempt: true })).toBe(true);
    expect(finalFailure(new Error('boom'), { isLastAttempt: false })).toBe(false);
  });

  it('tells handlers which attempt they are on', async () => {
    const seen: [number, boolean][] = [];
    const probe = defineJob({
      queue: 'webhookDelivery',
      handler: async (_ctx, job) => {
        seen.push([job.attempt, job.isLastAttempt]);
        return {
          deliveryId: job.payload.deliveryId,
          eventType: 'ping' as const,
          responseStatus: 200,
        };
      },
    });
    const payload = { deliveryId: newId('webhookDelivery'), workspaceId: newId('workspace') };
    await t.run(probe, payload);
    await t.run(probe, payload, { attemptsMade: 4 });
    expect(seen).toEqual([
      [1, false],
      [5, true],
    ]);
  });
});

describe('worker process (real Redis, isolated prefix)', () => {
  it('starts, processes the example job end to end and shuts down cleanly', async () => {
    const prefix = `parlante-test-${randomBytes(4).toString('hex')}`;
    const redisUrl = parseEnv(baseEnvSchema, {}).REDIS_URL;
    const worker = await startWorker(
      { ...t.ctx.config, QUEUE_PREFIX: prefix, REDIS_URL: redisUrl },
      t.ctx.logger,
    );
    const client = new BullQueueClient({ redisUrl, prefix });
    try {
      expect(worker.queues).toContain('system');
      const { jobId } = await client.enqueue(
        'system',
        { kind: 'ping', echo: 'round trip' },
        { jobId: 'ping-1' },
      );
      let state = 'waiting';
      let result = null;
      for (let i = 0; i < 100 && state !== 'completed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const snapshot = await client.getJob('system', jobId);
        state = snapshot?.state ?? 'unknown';
        result = snapshot?.result ?? null;
      }
      expect(state).toBe('completed');
      expect(result).toMatchObject({ kind: 'pong', echo: 'round trip' });
    } finally {
      await client.close();
      await worker.stop(2000);
    }
  });
});

describe('dead worker recovery (real Redis, isolated prefix)', () => {
  it('fails a job whose worker died through onFinalFailure, without running the handler', async () => {
    const prefix = `parlante-test-${randomBytes(4).toString('hex')}`;
    const redisUrl = parseEnv(baseEnvSchema, {}).REDIS_URL;
    const client = new BullQueueClient({ redisUrl, prefix });
    // 1. A worker takes the job and "dies": closed by force while the handler is still running,
    //    so the job stays active with a lock nobody renews.
    const victimConnection = createRedisConnection(redisUrl);
    let taken = () => {};
    const active = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const victim = new Worker(
      'system',
      async () => {
        taken();
        await new Promise(() => undefined); // never finishes
      },
      // Same (short) stalled-check interval as the survivor: BullMQ debounces the check per
      // queue with a key that lives one interval.
      { connection: victimConnection, prefix, lockDuration: 1000, stalledInterval: 300 },
    );
    victim.on('error', () => undefined);
    let handlerRuns = 0;
    let recovered: (value: { payload: unknown; error: StoredError }) => void = () => {};
    const finalFailure = new Promise<{ payload: unknown; error: StoredError }>((resolve) => {
      recovered = resolve;
    });
    const definition = defineJob({
      queue: 'system',
      handler: async (_ctx, job) => {
        handlerRuns += 1;
        return { kind: 'pong' as const, echo: job.payload.echo, processedAt: 'never' };
      },
      onFinalFailure: async (_ctx, payload, error) => {
        recovered({ payload, error });
      },
    });
    let survivors: ReturnType<typeof startWorkers> | null = null;
    try {
      await client.enqueue('system', { kind: 'ping', echo: 'doomed' }, { jobId: 'doomed-1' });
      await active;
      await victim.close(true);
      victimConnection.disconnect();

      // 2. A healthy worker process comes up (the container restarted).
      survivors = startWorkers(
        { ...t.ctx, config: { ...t.ctx.config, QUEUE_PREFIX: prefix, REDIS_URL: redisUrl } },
        [definition],
        { lockDurationMs: 1000, stalledIntervalMs: 300, maxStalledCount: 0 },
      );
      const outcome = await Promise.race([
        finalFailure,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
      expect(outcome).toEqual({
        payload: { kind: 'ping', echo: 'doomed' },
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'The worker stopped while processing this job. Nothing was charged; try again.',
        },
      });
      expect(handlerRuns).toBe(0);
      expect((await client.getJob('system', 'doomed-1'))?.state).toBe('failed');
    } finally {
      await survivors?.close(1000);
      await client.close();
    }
  }, 30_000);
});

describe('utilities', () => {
  it('creates and removes private temp directories with safe file names', async () => {
    const tmp = await createTempDir(t.ctx, 'render');
    expect((await fs.stat(tmp.path)).isDirectory()).toBe(true);
    expect(tmp.file('frame.png').startsWith(tmp.path)).toBe(true);
    for (const bad of ['../x', 'a/b', '', '.hidden']) expect(() => tmp.file(bad), bad).toThrow();
    await tmp.remove();
    await expect(fs.stat(tmp.path)).rejects.toThrow();

    let seen = '';
    await expect(
      withTempDir(t.ctx, 'x', async (dir) => {
        seen = dir.path;
        await fs.writeFile(dir.file('a.txt'), 'x');
        throw new Error('fail inside');
      }),
    ).rejects.toThrow('fail inside');
    await expect(fs.stat(seen)).rejects.toThrow();
  });

  it('runs ffmpeg and ffprobe with argument arrays', async () => {
    await withTempDir(t.ctx, 'ffmpeg', async (tmp) => {
      const out = tmp.file('tone.mp4');
      const lines: string[] = [];
      await runFfmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=320x180:rate=30:duration=1',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          '-movflags',
          '+faststart',
          out,
        ],
        { onStderrLine: (line) => lines.push(line), timeoutMs: 60_000 },
      );
      const info = await ffprobe(out);
      expect(info).toMatchObject({
        hasVideo: true,
        hasAudio: true,
        width: 320,
        height: 180,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
      expect(info.durationMs).toBeGreaterThan(900);
      expect(info.durationMs).toBeLessThan(1200);
      expect(Math.round(info.fps ?? 0)).toBe(30);
      expect(lines.length).toBeGreaterThan(0);

      await fs.writeFile(tmp.file('junk.mp4'), 'this is not a video');
      await expect(ffprobe(tmp.file('junk.mp4'))).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
      await expect(
        runFfmpeg(['-i', tmp.file('missing.mp4'), tmp.file('o.mp4')]),
      ).rejects.toMatchObject({
        name: 'ProcessError',
      });
    });
  });

  it('never goes through a shell and enforces timeouts', async () => {
    const res = await runProcess('node', [
      '-e',
      'process.stdout.write(process.argv[1])',
      '$(echo injected); rm -rf /',
    ]);
    expect(res.stdout.toString()).toBe('$(echo injected); rm -rf /');
    await expect(
      runProcess('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
    await expect(runProcess('definitely-not-a-binary-xyz', [])).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const piped = await runProcess('node', ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'via stdin',
    });
    expect(piped.stdout.toString()).toBe('via stdin');
  });

  it('parses ffmpeg progress and throttles side effects', async () => {
    expect(
      parseFfmpegTime('frame=  96 fps=0.0 q=28.0 size=0kB time=00:00:03.20 bitrate=0.1kbits/s'),
    ).toBe(3200);
    expect(parseFfmpegTime('time=01:02:03.5')).toBe(3_723_500);
    expect(parseFfmpegTime('Stream #0:0: Video: h264')).toBeNull();
    expect(scale(0.5, 20, 80)).toBe(50);
    expect(scale(7, 20, 80)).toBe(80);

    const calls: number[] = [];
    const update = throttled(async (n: number) => {
      calls.push(n);
    }, 10_000);
    await update(1);
    await update(2);
    await update(3);
    expect(calls).toEqual([1]);
    await update.flush();
    expect(calls).toEqual([1, 3]);
    await update.flush();
    expect(calls).toEqual([1, 3]);
  });
});

describe('render status helpers', () => {
  async function seedRender(credits = 20, composition: Composition = createComposition()) {
    const { workspace, user } = await seedAccount(t.ctx.db, { credits });
    const videoId = newId('video');
    const renderJobId = newId('renderJob');
    await t.ctx.db.insert(videos).values({
      id: videoId,
      workspaceId: workspace.id,
      title: 'Demo',
      composition,
      aspect: '16:9',
      status: 'queued',
      revision: 3,
      currentRenderJobId: renderJobId,
      createdBy: user.id,
    });
    await t.ctx.db.insert(renderJobs).values({
      id: renderJobId,
      workspaceId: workspace.id,
      videoId,
      resolution: '720p',
      composition,
      revision: 3,
      creditsCharged: 4,
    });
    await chargeCredits(t.ctx.db, {
      workspaceId: workspace.id,
      amount: 4,
      reason: 'render',
      refType: 'renderJob',
      refId: renderJobId,
    });
    await t.ctx.db.insert(webhookEndpoints).values({
      id: newId('webhookEndpoint'),
      workspaceId: workspace.id,
      url: 'https://hooks.example.test/x',
      events: ['video.completed', 'video.failed'],
      secretEncrypted: 'v1.x.y.z',
      secretPreview: 'abcd',
    });
    return { ref: { renderJobId, videoId, workspaceId: workspace.id }, workspace };
  }
  const readVideo = async (id: string) =>
    (await t.ctx.db.select().from(videos).where(eq(videos.id, id)))[0];
  const readJob = async (id: string) =>
    (await t.ctx.db.select().from(renderJobs).where(eq(renderJobs.id, id)))[0];

  it('drives a successful render: progress, outputs, credit settlement, webhook', async () => {
    const { ref, workspace } = await seedRender();
    expect((await loadRenderJob(t.ctx, ref))?.revision).toBe(3);
    expect(await loadRenderJob(t.ctx, { ...ref, workspaceId: newId('workspace') })).toBeNull();

    expect(await markRenderStarted(t.ctx, ref)).toBe(true);
    expect(await readVideo(ref.videoId)).toMatchObject({ status: 'rendering', progress: 0 });
    await reportRenderProgress(t.ctx, ref, 'avatars', 41.6, 93.4);
    expect(await readJob(ref.renderJobId)).toMatchObject({
      status: 'running',
      stage: 'avatars',
      progress: 42,
      etaSec: 93,
    });
    expect((await readVideo(ref.videoId))?.progress).toBe(42);

    const durationMs = 45_000;
    const output = {
      durationMs,
      videoKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/video.mp4`,
      thumbnailKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/thumb.jpg`,
      srtKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/subtitles.srt`,
      vttKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/subtitles.vtt`,
      providers: {
        tts: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic' as const, local: true },
      },
    };
    expect(await markRenderCompleted(t.ctx, ref, { ...output, resolution: '720p' })).toBe(true);
    expect(await readVideo(ref.videoId)).toMatchObject({
      status: 'completed',
      progress: 100,
      durationMs,
      renderedRevision: 3,
      providers: { tts: { id: 'espeak' } },
    });
    expect(await readJob(ref.renderJobId)).toMatchObject({
      status: 'completed',
      progress: 100,
      creditsCharged: 2,
    });
    // Reserved 4, real cost 2 → 2 refunded.
    expect(creditsForRender(durationMs, '720p')).toBe(2);
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(18);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
    // Terminal helpers are no-ops afterwards: no second webhook, no failure over a success.
    expect(await markRenderCompleted(t.ctx, ref, { ...output, resolution: '720p' })).toBe(false);
    expect(await markRenderFailed(t.ctx, ref, { code: 'INTERNAL', message: 'late' })).toBe(false);
    expect((await readVideo(ref.videoId))?.status).toBe('completed');
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(18);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
  });

  it('settles photorealistic renders with the photoreal multiplier', async () => {
    const photoreal = createComposition({
      scenes: [
        {
          layers: [
            {
              type: 'avatar',
              avatarId: 'avt_abcdefgh12345678',
              box: { x: 0, y: 0, w: 0.5, h: 1 },
            },
          ],
        },
      ],
    });
    const { ref, workspace } = await seedRender(20, photoreal);
    await markRenderStarted(t.ctx, ref);
    const job = await loadRenderJob(t.ctx, ref);
    if (!job) throw new Error('job');
    // 45 s at 720p = 2 units; photoreal doubles it — the same formula startRender reserved with.
    expect(actualRenderCredits(job, { durationMs: 45_000, resolution: '720p' })).toBe(4);
    expect(
      await markRenderCompleted(t.ctx, ref, {
        durationMs: 45_000,
        resolution: '720p',
        videoKey: 'k/video.mp4',
        thumbnailKey: 'k/thumb.jpg',
        srtKey: 'k/subtitles.srt',
        vttKey: 'k/subtitles.vtt',
        providers: {},
      }),
    ).toBe(true);
    // Reserved 4 and the real cost is 4: nothing refunded, nothing charged twice.
    expect(await readJob(ref.renderJobId)).toMatchObject({
      status: 'completed',
      creditsCharged: 4,
    });
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(16);
  });

  it('never completes, fails or re-charges a render the user cancelled', async () => {
    const { ref, workspace } = await seedRender();
    await markRenderStarted(t.ctx, ref);
    // What the API's cancel does while the worker is encoding: cancel + refund + reset video.
    await t.ctx.db
      .update(renderJobs)
      .set({ status: 'canceled', creditsCharged: 0 })
      .where(eq(renderJobs.id, ref.renderJobId));
    await refundCredits(t.ctx.db, {
      workspaceId: workspace.id,
      refType: 'renderJob',
      refId: ref.renderJobId,
    });
    await t.ctx.db.update(videos).set({ status: 'draft' }).where(eq(videos.id, ref.videoId));
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);

    expect(
      await markRenderCompleted(t.ctx, ref, {
        durationMs: 45_000,
        resolution: '720p',
        videoKey: 'k/video.mp4',
        thumbnailKey: 'k/thumb.jpg',
        srtKey: 'k/subtitles.srt',
        vttKey: 'k/subtitles.vtt',
        providers: {},
      }),
    ).toBe(false);
    expect(await markRenderFailed(t.ctx, ref, { code: 'INTERNAL', message: 'aborted' })).toBe(
      false,
    );
    expect((await readJob(ref.renderJobId))?.status).toBe('canceled');
    expect(await readVideo(ref.videoId)).toMatchObject({ status: 'draft', videoKey: null });
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20); // not charged again
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(0);
    // A job cancelled before the worker picked it up is not started either.
    expect(await markRenderStarted(t.ctx, ref)).toBe(false);
    expect((await readJob(ref.renderJobId))?.status).toBe('canceled');
  });

  it('drives a failed render: error stored, full refund, webhook', async () => {
    const { ref, workspace } = await seedRender();
    await markRenderStarted(t.ctx, ref);
    expect(
      await markRenderFailed(t.ctx, ref, { code: 'PROVIDER_ERROR', message: 'TTS unavailable' }),
    ).toBe(true);
    expect(await readVideo(ref.videoId)).toMatchObject({
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'TTS unavailable' },
    });
    expect(await readJob(ref.renderJobId)).toMatchObject({ status: 'failed', creditsCharged: 0 });
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
    const ledger = await t.ctx.db
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.refId, ref.renderJobId));
    expect(ledger.map((l) => l.delta).sort()).toEqual([-4, 4]);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
    // Idempotent: no double refund, no second webhook.
    expect(
      await markRenderFailed(t.ctx, ref, { code: 'PROVIDER_ERROR', message: 'TTS unavailable' }),
    ).toBe(false);
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
  });

  it('recovers a render whose worker died: the final-failure hook fails and refunds it', async () => {
    const { ref, workspace } = await seedRender();
    await markRenderStarted(t.ctx, ref); // …and then the process is killed mid-render
    const seen: StoredError[] = [];
    const renderLike = defineJob({
      queue: 'render',
      handler: async () => {
        throw new Error('never reached for a stalled job');
      },
      onFinalFailure: async (ctx, payload, error) => {
        seen.push(error);
        await markRenderFailed(ctx, payload, error);
      },
    });
    const stalled = {
      id: ref.renderJobId,
      data: ref,
      attemptsMade: 1,
      opts: { attempts: 1 },
      failedReason: 'job stalled more than allowable limit',
    };
    expect(await handleFailedJob(t.ctx, renderLike, stalled, new Error(stalled.failedReason))).toBe(
      true,
    );
    expect(seen).toEqual([
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The worker stopped while processing this job. Nothing was charged; try again.',
      },
    ]);
    expect(await readJob(ref.renderJobId)).toMatchObject({
      status: 'failed',
      creditsCharged: 0,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
    expect((await readVideo(ref.videoId))?.status).toBe('failed');
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
    // Delivered again (BullMQ may emit twice): still one refund, one webhook.
    await handleFailedJob(t.ctx, renderLike, stalled, new Error(stalled.failedReason));
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
  });

  it('does not overwrite a video whose current render is a newer job, and sees cancellations', async () => {
    const { ref } = await seedRender();
    await t.ctx.db
      .update(videos)
      .set({ currentRenderJobId: newId('renderJob'), status: 'queued' })
      .where(eq(videos.id, ref.videoId));
    await markRenderStarted(t.ctx, ref);
    expect((await readVideo(ref.videoId))?.status).toBe('queued');
    expect(await isRenderCanceled(t.ctx, ref)).toBe(false);
    await t.ctx.db
      .update(renderJobs)
      .set({ status: 'canceled' })
      .where(eq(renderJobs.id, ref.renderJobId));
    expect(await isRenderCanceled(t.ctx, ref)).toBe(true);
  });
});

describe('final-failure hook', () => {
  const calls: { payload: unknown; error: StoredError }[] = [];
  const job = defineJob({
    queue: 'photoAvatar',
    handler: async () => {
      throw new Error('unused');
    },
    onFinalFailure: async (_ctx, payload, error) => {
      calls.push({ payload, error });
    },
  });
  const payload = { avatarId: newId('avatar'), workspaceId: newId('workspace') };
  const bull = (attemptsMade: number, failedReason: string) => ({
    id: payload.avatarId,
    data: payload,
    attemptsMade,
    opts: { attempts: 2 },
    failedReason,
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('runs only when no attempts are left, with the stored error', async () => {
    // First of two attempts failed with a retryable error: BullMQ will retry → no hook.
    expect(await handleFailedJob(t.ctx, job, bull(1, 'boom'), new Error('boom'))).toBe(false);
    expect(calls).toHaveLength(0);
    // Last attempt.
    expect(await handleFailedJob(t.ctx, job, bull(2, 'boom'), new Error('boom'))).toBe(true);
    expect(calls[0]).toEqual({ payload, error: { code: 'INTERNAL', message: 'boom' } });
    // Final domain error on the first attempt (processJob throws UnrecoverableError).
    const reason = 'UNPROCESSABLE: No face was found in the photo';
    expect(await handleFailedJob(t.ctx, job, bull(1, reason), new UnrecoverableError(reason))).toBe(
      true,
    );
    expect(calls[1]?.error).toEqual({
      code: 'UNPROCESSABLE',
      message: 'No face was found in the photo',
    });
  });

  it('tolerates missing jobs, bad payloads, jobs without a hook and throwing hooks', async () => {
    expect(await handleFailedJob(t.ctx, job, undefined, new Error('x'))).toBe(false);
    expect(
      await handleFailedJob(t.ctx, job, { ...bull(2, 'x'), data: { nope: true } }, new Error('x')),
    ).toBe(false);
    expect(await handleFailedJob(t.ctx, systemJob, bull(2, 'x'), new Error('x'))).toBe(false);
    const throwing = defineJob({
      queue: 'photoAvatar',
      handler: async () => {
        throw new Error('unused');
      },
      onFinalFailure: async () => {
        throw new Error('db down');
      },
    });
    expect(await handleFailedJob(t.ctx, throwing, bull(2, 'x'), new Error('x'))).toBe(false);
    expect(storedErrorFromFailedReason(undefined)).toEqual({
      code: 'INTERNAL',
      message: 'The job failed',
    });
    expect(storedErrorFromFailedReason('NOT_A_CODE: hi').code).toBe('INTERNAL');
  });
});

describe('avatar status helpers', () => {
  it('persists progress and ETA while processing, then fails and refunds exactly once', async () => {
    const { workspace } = await seedAccount(t.ctx.db, { credits: 20 });
    const avatarId = newId('avatar');
    await t.ctx.db.insert(avatars).values({
      id: avatarId,
      workspaceId: workspace.id,
      name: 'Sintética',
      origin: 'generated',
      prompt: 'mujer de unos 40 años',
    });
    await chargeCredits(t.ctx.db, {
      workspaceId: workspace.id,
      amount: 8,
      reason: 'generated_avatar',
      refType: 'avatar',
      refId: avatarId,
    });
    const ref = { avatarId, workspaceId: workspace.id };
    const read = async () =>
      (await t.ctx.db.select().from(avatars).where(eq(avatars.id, avatarId)))[0];

    await reportAvatarProgress(t.ctx, ref, 41.6, 93.4);
    expect(await read()).toMatchObject({ status: 'processing', progress: 42, etaSec: 93 });
    await reportAvatarProgress(t.ctx, ref, 250);
    expect(await read()).toMatchObject({ progress: 99, etaSec: null });
    // Another workspace cannot touch it.
    await reportAvatarProgress(t.ctx, { avatarId, workspaceId: newId('workspace') }, 5, 1);
    expect((await read())?.progress).toBe(99);

    const error = { code: 'UNPROCESSABLE' as const, message: 'No face found' };
    expect(await markAvatarFailed(t.ctx, ref, error)).toBe(true);
    expect(await read()).toMatchObject({ status: 'failed', error, etaSec: null });
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
    expect(await markAvatarFailed(t.ctx, ref, error)).toBe(false);
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
    // Progress reports after the terminal state are ignored.
    await reportAvatarProgress(t.ctx, ref, 10, 5);
    expect(await read()).toMatchObject({ status: 'failed', progress: 99 });
  });
});
