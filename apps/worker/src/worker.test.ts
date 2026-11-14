import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, createComposition, creditsForRender, newId } from '@parlante/shared';
import { baseEnvSchema, parseEnv } from '@parlante/shared/node';
import {
  chargeCredits,
  creditLedger,
  eq,
  getCreditBalance,
  renderJobs,
  videos,
  webhookEndpoints,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import { BullQueueClient } from '@parlante/jobs';
import { startWorker } from './bootstrap';
import { concurrencyFor, enabledQueues, loadConfig } from './config';
import systemJob from './jobs/system/index';
import { finalFailure, isFinalError } from './lib/errors';
import { ffprobe, parseFfmpegTime, runFfmpeg, runProcess } from './lib/ffmpeg';
import { defineJob } from './lib/job';
import { loadJobs } from './lib/loader';
import { scale, throttled } from './lib/progress';
import {
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
  async function seedRender(credits = 20) {
    const { workspace, user } = await seedAccount(t.ctx.db, { credits });
    const composition = createComposition();
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

    await markRenderStarted(t.ctx, ref);
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
    await markRenderCompleted(t.ctx, ref, {
      durationMs,
      resolution: '720p',
      videoKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/video.mp4`,
      thumbnailKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/thumb.jpg`,
      srtKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/subtitles.srt`,
      vttKey: `ws/${workspace.id}/videos/${ref.videoId}/${ref.renderJobId}/subtitles.vtt`,
      providers: {
        tts: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic', local: true },
      },
      actualCredits: creditsForRender(durationMs, '720p'),
    });
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
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(18);
    expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
  });

  it('drives a failed render: error stored, full refund, webhook', async () => {
    const { ref, workspace } = await seedRender();
    await markRenderStarted(t.ctx, ref);
    await markRenderFailed(t.ctx, ref, { code: 'PROVIDER_ERROR', message: 'TTS unavailable' });
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
    // Idempotent: no double refund.
    await markRenderFailed(t.ctx, ref, { code: 'PROVIDER_ERROR', message: 'TTS unavailable' });
    expect(await getCreditBalance(t.ctx.db, workspace.id)).toBe(20);
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
