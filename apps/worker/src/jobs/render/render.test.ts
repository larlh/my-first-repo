import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_GENERATED_METADATA,
  AppError,
  createComposition,
  creditsForRender,
  newId,
} from '@parlante/shared';
import type { Composition, LipSyncProvider, PlanId, Resolution } from '@parlante/shared';
import { baseEnvSchema, parseEnv, storageKeys } from '@parlante/shared/node';
import {
  assets,
  avatars,
  chargeCredits,
  creditLedger,
  eq,
  getCreditBalance,
  netCharged,
  refundCredits,
  renderJobs,
  videos,
  webhookDeliveries,
  webhookEndpoints,
} from '@parlante/db';
import { seedAccount } from '@parlante/db/testing';
import type { SeededAccount } from '@parlante/db/testing';
import { BullQueueClient, createRedisConnection, startRender } from '@parlante/jobs';
import type { RenderRef } from '@parlante/jobs';
import { getStockPhotorealAvatar } from '@parlante/stock-assets';
import { stockPhotorealAvatarFiles } from '@parlante/stock-assets/node';
import { ffprobe, runFfmpeg, runProcess, ffprobePath } from '../../lib/ffmpeg';
import { startWorkers } from '../../lib/runner';
import { createTestWorker } from '../../testing/index';
import type { TestWorker } from '../../testing/index';
import renderJob from './index';
import { outputKeys } from './outputs';
import { FAKE_LIPSYNC_INFO, createFakeLipSync } from './testing/fake-lipsync';
import type { FakeLipSync } from './testing/fake-lipsync';
import { demoComposition, shortComposition } from './testing/fixtures';
import { encodeMonoPcm16Wav } from './wav';

/* -------------------------------------------------------------------------------------------
 * The render job end to end: real test database, in-memory queue, temp storage, the real
 * local TTS (eSpeak), the real renderer and real ffmpeg. Only the neural engine is replaced
 * (./testing/fake-lipsync) — it needs a Python service and a second of CPU per frame.
 * Renders are started with the real `startRender`, like the API does.
 * ----------------------------------------------------------------------------------------- */

const LONG = 180_000;

let t: TestWorker;
let lipsync: FakeLipSync;
let realLipsync: LipSyncProvider;

beforeAll(async () => {
  t = await createTestWorker();
  realLipsync = t.ctx.providers.lipsync;
});
afterAll(async () => {
  t.ctx.providers.lipsync = realLipsync;
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  lipsync = createFakeLipSync();
  t.ctx.providers.lipsync = lipsync;
});

interface Started {
  account: SeededAccount;
  ref: RenderRef;
  reserved: number;
}

async function start(
  composition: Composition,
  options: {
    plan?: PlanId;
    resolution?: Resolution;
    account?: SeededAccount;
    videoId?: string;
  } = {},
): Promise<Started> {
  const account =
    options.account ?? (await seedAccount(t.ctx.db, { plan: options.plan ?? 'free', credits: 50 }));
  const workspaceId = account.workspace.id;
  if (!options.account) {
    await t.ctx.db.insert(webhookEndpoints).values({
      id: newId('webhookEndpoint'),
      workspaceId,
      url: 'https://hooks.example.test/x',
      events: ['video.completed', 'video.failed'],
      secretEncrypted: 'v1.x.y.z',
      secretPreview: 'abcd',
    });
  }
  const videoId = options.videoId ?? newId('video');
  if (!options.videoId) {
    await t.ctx.db.insert(videos).values({
      id: videoId,
      workspaceId,
      title: 'Prueba',
      composition,
      aspect: composition.canvas.aspect,
      createdBy: account.user.id,
    });
  }
  const started = await startRender(
    { db: t.ctx.db, queues: t.queues, providers: t.ctx.providers },
    {
      workspaceId,
      videoId,
      resolution: options.resolution ?? '720p',
      createdBy: account.user.id,
    },
  );
  return {
    account,
    ref: { renderJobId: started.renderJob.id, videoId, workspaceId },
    reserved: started.renderJob.creditsCharged,
  };
}

const readJob = async (ref: RenderRef) =>
  (await t.ctx.db.select().from(renderJobs).where(eq(renderJobs.id, ref.renderJobId)))[0];
const readVideo = async (ref: RenderRef) =>
  (await t.ctx.db.select().from(videos).where(eq(videos.id, ref.videoId)))[0];
/** Net credits charged for the render (`|| 0` folds the `-0` of a fully refunded ledger). */
const charged = async (ref: RenderRef) =>
  (await netCharged(t.ctx.db, ref.workspaceId, {
    refType: 'renderJob',
    refId: ref.renderJobId,
  })) || 0;
const ledgerOf = (ref: RenderRef) =>
  t.ctx.db
    .select({ delta: creditLedger.delta, reason: creditLedger.reason })
    .from(creditLedger)
    .where(eq(creditLedger.refId, ref.renderJobId));
const deliveries = async () =>
  (await t.ctx.db.select().from(webhookDeliveries)).map((row) => row.eventType);
const stored = (key: string) => t.ctx.providers.storage.exists(key);
const localFile = (key: string) => {
  const file = t.ctx.providers.storage.localPath(key);
  if (!file) throw new Error('test storage is local');
  return file;
};
const text = async (key: string) =>
  new TextDecoder().decode(await t.ctx.providers.storage.get(key));

async function outputsExist(ref: RenderRef): Promise<boolean[]> {
  return Promise.all(Object.values(outputKeys(ref)).map((key) => stored(key)));
}

/** The job's temp directory must be empty after every run (success, failure, cancel). */
async function tempLeftovers(): Promise<string[]> {
  return fs.readdir(path.join(t.storageDir, '_tmp')).catch(() => []);
}

async function untilStage(ref: RenderRef, stage: string): Promise<number> {
  for (let i = 0; i < 1200; i += 1) {
    const row = await readJob(ref);
    if (row?.status === 'running' && row.stage === stage) return row.progress;
    if (row && row.status !== 'running' && row.status !== 'queued') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`The render never reached stage ${stage}`);
}

/** What `POST /api/videos/:id/cancel-render` does. */
async function cancelLikeTheApi(ref: RenderRef): Promise<void> {
  await t.ctx.db
    .update(renderJobs)
    .set({ status: 'canceled', finishedAt: new Date() })
    .where(eq(renderJobs.id, ref.renderJobId));
  await refundCredits(t.ctx.db, {
    workspaceId: ref.workspaceId,
    refType: 'renderJob',
    refId: ref.renderJobId,
  });
  await t.ctx.db
    .update(videos)
    .set({ status: 'draft', progress: 0 })
    .where(eq(videos.id, ref.videoId));
}

interface Frame {
  width: number;
  height: number;
  at(x: number, y: number): [number, number, number];
  /** Pixels of a region (fractions of the frame) that satisfy `test`. */
  count(
    region: { x0: number; y0: number; x1: number; y1: number },
    test: (r: number, g: number, b: number) => boolean,
  ): number;
}

async function frameAt(file: string, seconds: number): Promise<Frame> {
  const info = await ffprobe(file);
  const width = info.width ?? 0;
  const height = info.height ?? 0;
  const { stdout } = await runFfmpeg(
    [
      '-ss',
      seconds.toFixed(3),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { maxStdoutBytes: 64 * 1024 * 1024 },
  );
  expect(stdout.length).toBe(width * height * 3);
  const at = (x: number, y: number): [number, number, number] => {
    const i = (Math.round(y) * width + Math.round(x)) * 3;
    return [stdout[i] ?? 0, stdout[i + 1] ?? 0, stdout[i + 2] ?? 0];
  };
  return {
    width,
    height,
    at,
    count(region, test) {
      let n = 0;
      for (let y = Math.floor(region.y0 * height); y < Math.floor(region.y1 * height); y += 1) {
        for (let x = Math.floor(region.x0 * width); x < Math.floor(region.x1 * width); x += 1) {
          const [r, g, b] = at(x, y);
          if (test(r, g, b)) n += 1;
        }
      }
      return n;
    },
  };
}

async function probeStreams(file: string): Promise<{
  streams: Record<string, string | number>[];
  format: { duration: string; tags?: Record<string, string> };
}> {
  const { stdout } = await runProcess(ffprobePath(), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-count_frames',
    '--',
    file,
  ]);
  return JSON.parse(stdout.toString('utf8'));
}

/** Position of the `moov` and `mdat` boxes: faststart = index before the media data. */
async function topLevelBoxes(file: string): Promise<string[]> {
  const bytes = await fs.readFile(file);
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    boxes.push(bytes.toString('ascii', offset + 4, offset + 8));
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return boxes;
}

/** A blank scene of a given length: the cheapest thing to render. */
function blankComposition(seconds = 0.5): Composition {
  return createComposition({
    scenes: [
      {
        duration: { mode: 'fixed', seconds },
        background: { type: 'color', color: '#1d2b53' },
      },
    ],
  });
}

const isBackground = (r: number, g: number, b: number) =>
  Math.abs(r - 0x1d) < 12 && Math.abs(g - 0x2b) < 12 && Math.abs(b - 0x53) < 12;
const WATERMARK_AREA = { x0: 0.8, y0: 0.9, x1: 1, y1: 1 };

describe('render job: success', () => {
  it(
    'turns a three-scene composition into MP4 + thumbnail + SRT/VTT and settles the credits',
    async () => {
      const { ref, reserved, account } = await start(demoComposition());
      expect(t.queues.jobs('render')).toEqual([ref]);
      expect(reserved).toBe(1);

      const { result, progress } = await t.run(renderJob, ref);
      if ('canceled' in result) throw new Error('unexpected cancellation');

      // Result = storage keys built by storageKeys, all present.
      expect(result).toMatchObject({
        videoId: ref.videoId,
        resolution: '720p',
        ...outputKeys(ref),
      });
      expect(result.videoKey).toBe(
        storageKeys.videoOutput(ref.workspaceId, ref.videoId, ref.renderJobId, 'video.mp4'),
      );
      expect(await outputsExist(ref)).toEqual([true, true, true, true]);
      expect(result.providers).toEqual({
        tts: { id: 'espeak', name: expect.any(String), quality: 'basic', local: true },
      });

      // The MP4: H.264 yuv420p 1280×720 @ 30 fps + AAC, audio as long as the video, faststart.
      const file = localFile(result.videoKey);
      const probe = await probeStreams(file);
      const video = probe.streams.find((s) => s.codec_type === 'video');
      const audio = probe.streams.find((s) => s.codec_type === 'audio');
      expect(video).toMatchObject({
        codec_name: 'h264',
        pix_fmt: 'yuv420p',
        width: 1280,
        height: 720,
        r_frame_rate: '30/1',
        color_space: 'bt709',
      });
      expect(audio).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
      const frames = Number(video?.nb_read_frames);
      expect(frames).toBe(Math.ceil((result.durationMs / 1000) * 30));
      expect(Number(video?.duration)).toBeCloseTo(frames / 30, 2);
      expect(Math.abs(Number(audio?.duration) - Number(video?.duration))).toBeLessThan(0.03);
      expect(probe.format.tags?.['com.parlante.ai_generated']).toBeUndefined();
      const boxes = await topLevelBoxes(file);
      expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
      expect(result.durationMs).toBeGreaterThan(9000);
      expect(result.durationMs).toBeLessThan(20000);

      // Free plan: the watermark is burned in; the avatar is drawn; the scene background shows.
      const frame = await frameAt(file, 1.5);
      const light = (r: number, g: number, b: number) => r > 200 && g > 200 && b > 200;
      expect(frame.count(WATERMARK_AREA, light)).toBeGreaterThan(40);
      const skin = (r: number, g: number, b: number) =>
        r > 190 && g > 140 && g < 200 && b > 100 && b < 170;
      expect(frame.count({ x0: 0.6, y0: 0.2, x1: 0.9, y1: 0.6 }, skin)).toBeGreaterThan(2000);

      // Subtitles: SRT and VTT from the word timings, on the video clock.
      const srt = await text(result.srtKey);
      const vtt = await text(result.vttKey);
      expect(srt).toMatch(
        /^1\n00:00:00,\d{3} --> 00:00:0\d,\d{3}\nHola, soy tu presentadora virtual\./,
      );
      expect(srt).toContain('¡Hasta pronto!');
      expect(vtt.startsWith('WEBVTT\n\n00:00:00.')).toBe(true);
      expect(vtt.match(/-->/g)?.length).toBe(srt.match(/-->/g)?.length);
      const lastCue = [...srt.matchAll(/--> (\d\d):(\d\d):(\d\d),(\d{3})/g)].at(-1);
      const lastEnd = lastCue
        ? Number(lastCue[2]) * 60_000 + Number(lastCue[3]) * 1000 + Number(lastCue[4])
        : 0;
      expect(lastEnd).toBeGreaterThan(result.durationMs - 2000);
      expect(lastEnd).toBeLessThanOrEqual(result.durationMs);

      // Thumbnail: a JPEG with the proportions of the video.
      const thumb = await ffprobe(localFile(result.thumbnailKey));
      expect([thumb.videoCodec, thumb.width, thumb.height]).toEqual(['mjpeg', 640, 360]);

      // Rows: job and video completed, progress persisted, outputs on the video.
      expect(await readJob(ref)).toMatchObject({
        status: 'completed',
        stage: 'finalize',
        progress: 100,
        etaSec: null,
        creditsCharged: creditsForRender(result.durationMs, '720p'),
        error: null,
      });
      expect(await readVideo(ref)).toMatchObject({
        status: 'completed',
        progress: 100,
        durationMs: result.durationMs,
        resolution: '720p',
        videoKey: result.videoKey,
        thumbnailKey: result.thumbnailKey,
        srtKey: result.srtKey,
        vttKey: result.vttKey,
        renderedRevision: 1,
        providers: result.providers,
      });

      // Progress went through the stages in order (no `avatars` stage for instant avatars).
      const order = ['prepare', 'audio', 'avatars', 'frames', 'encode', 'finalize'];
      const stages: string[] = progress.map((p) => p.stage);
      expect(stages).toContain('frames');
      expect(stages).not.toContain('avatars');
      for (let i = 1; i < progress.length; i += 1) {
        expect(order.indexOf(stages[i] ?? '')).toBeGreaterThanOrEqual(
          order.indexOf(stages[i - 1] ?? ''),
        );
        expect(progress[i]?.percent).toBeGreaterThanOrEqual(progress[i - 1]?.percent ?? 0);
      }
      // (BullMQ progress is throttled to ~4 updates a second, so the short closing stages may
      // be dropped there: what the user sees is the ROW, checked above — finalize, 100 %.)
      expect(['frames', 'encode', 'finalize']).toContain(progress.at(-1)?.stage);

      // Credits: charged once, at the real cost. Webhook: video.completed queued.
      expect(await charged(ref)).toBe(1);
      expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(49);
      expect(await deliveries()).toEqual(['video.completed']);
      expect(t.queues.jobs('webhookDelivery')).toHaveLength(1);
      expect(await tempLeftovers()).toEqual([]);
    },
    LONG,
  );

  it(
    'settles an over-reserved render down to its real cost and reports a finished job again without re-rendering',
    async () => {
      const { ref, account } = await start(blankComposition(1));
      // Pretend the estimate was three credits too high.
      await chargeCredits(t.ctx.db, {
        workspaceId: ref.workspaceId,
        amount: 3,
        reason: 'render',
        refType: 'renderJob',
        refId: ref.renderJobId,
      });
      expect(await charged(ref)).toBe(4);

      const first = await t.run(renderJob, ref);
      expect(await charged(ref)).toBe(1);
      expect((await readJob(ref))?.creditsCharged).toBe(1);
      expect((await ledgerOf(ref)).map((e) => e.reason).sort()).toEqual([
        'render',
        'render',
        'render_adjustment',
      ]);
      // A silent video still has an (empty) audio track and empty subtitle files.
      if ('canceled' in first.result) throw new Error('unexpected cancellation');
      const info = await ffprobe(localFile(first.result.videoKey));
      expect(info).toMatchObject({ hasVideo: true, hasAudio: true, audioCodec: 'aac' });
      expect(first.result.providers).toEqual({});
      expect(await text(first.result.srtKey)).toBe('');
      expect(await text(first.result.vttKey)).toBe('WEBVTT\n\n');

      // Re-delivered after it completed: same result, nothing rendered, charged or notified again.
      const before = await fs.stat(localFile(first.result.videoKey));
      const again = await t.run(renderJob, ref);
      expect(again.result).toEqual(first.result);
      expect(again.progress).toEqual([]);
      expect((await fs.stat(localFile(first.result.videoKey))).mtimeMs).toBe(before.mtimeMs);
      expect(await charged(ref)).toBe(1);
      expect(await deliveries()).toEqual(['video.completed']);
      expect(account.workspace.id).toBe(ref.workspaceId);
    },
    LONG,
  );

  it(
    'renders 1080p without watermark on a paid plan, and never above the limit of the current plan',
    async () => {
      const paid = await start(blankComposition(), { plan: 'creator', resolution: '1080p' });
      expect(paid.reserved).toBe(2);
      const { result } = await t.run(renderJob, paid.ref);
      if ('canceled' in result) throw new Error('unexpected cancellation');
      expect(result.resolution).toBe('1080p');
      const frame = await frameAt(localFile(result.videoKey), 0.2);
      expect([frame.width, frame.height]).toEqual([1920, 1080]);
      expect(frame.count(WATERMARK_AREA, (r, g, b) => !isBackground(r, g, b))).toBe(0);
      expect(await charged(paid.ref)).toBe(2);

      // A job queued at 1080p whose workspace is on the free plan when it runs.
      const free = await start(blankComposition(), { plan: 'free' });
      await t.ctx.db
        .update(renderJobs)
        .set({ resolution: '1080p' })
        .where(eq(renderJobs.id, free.ref.renderJobId));
      const downgraded = await t.run(renderJob, free.ref);
      if ('canceled' in downgraded.result) throw new Error('unexpected cancellation');
      expect(downgraded.result.resolution).toBe('720p');
      const small = await frameAt(localFile(downgraded.result.videoKey), 0.2);
      expect([small.width, small.height]).toEqual([1280, 720]);
      expect(small.count(WATERMARK_AREA, (r, g, b) => !isBackground(r, g, b))).toBeGreaterThan(100);
      expect(await charged(free.ref)).toBe(1);
      expect((await readVideo(free.ref))?.resolution).toBe('720p');
    },
    LONG,
  );

  it(
    'renders vertical videos and replaces the files of the previous render of the same video',
    async () => {
      const first = await start(shortComposition({ aspect: '9:16' }));
      const one = await t.run(renderJob, first.ref);
      if ('canceled' in one.result) throw new Error('unexpected cancellation');
      const frame = await frameAt(localFile(one.result.videoKey), 0.5);
      expect([frame.width, frame.height]).toEqual([720, 1280]);
      const thumb = await ffprobe(localFile(one.result.thumbnailKey));
      expect([thumb.width, thumb.height]).toEqual([360, 640]);

      const second = await start(shortComposition({ aspect: '9:16' }), {
        account: first.account,
        videoId: first.ref.videoId,
      });
      expect(second.ref.renderJobId).not.toBe(first.ref.renderJobId);
      // While the new render runs, the previous output is still what the video serves.
      expect(await outputsExist(first.ref)).toEqual([true, true, true, true]);
      const two = await t.run(renderJob, second.ref);
      if ('canceled' in two.result) throw new Error('unexpected cancellation');
      expect(await outputsExist(second.ref)).toEqual([true, true, true, true]);
      expect(await outputsExist(first.ref)).toEqual([false, false, false, false]);
      expect((await readVideo(second.ref))?.videoKey).toBe(two.result.videoKey);
      // The narration came from the shared TTS cache the second time: same duration exactly.
      expect(two.result.durationMs).toBe(one.result.durationMs);
    },
    LONG,
  );
});

describe('render job: uploaded media', () => {
  async function addAsset(
    workspaceId: string,
    kind: 'image' | 'video' | 'audio',
    ext: string,
    mimeType: string,
    produce: (file: string) => Promise<void>,
  ): Promise<string> {
    const id = newId('asset');
    const storageKey = storageKeys.asset(workspaceId, id, ext);
    const tmp = path.join(t.storageDir, `fixture-${id}.${ext}`);
    await produce(tmp);
    const info = kind === 'image' ? null : await ffprobe(tmp);
    await t.ctx.providers.storage.put(storageKey, { filePath: tmp }, { contentType: mimeType });
    await fs.rm(tmp, { force: true });
    await t.ctx.db.insert(assets).values({
      id,
      workspaceId,
      kind,
      name: `${kind}.${ext}`,
      mimeType,
      sizeBytes: 1,
      durationMs: info?.durationMs ?? null,
      storageKey,
    });
    return id;
  }
  const lavfi = (source: string, extra: string[]) => (file: string) =>
    runFfmpeg(['-f', 'lavfi', '-i', source, ...extra, file]).then(() => undefined);
  const burst = (file: string) => {
    // 1.2 s: 0.4 s of a 300 Hz tone, 0.4 s of silence, 0.4 s of tone.
    const samples = new Int16Array(26_460);
    for (let i = 0; i < samples.length; i += 1) {
      const on = i < 8820 || i >= 17_640;
      samples[i] = on ? Math.round(Math.sin((2 * Math.PI * 300 * i) / 22_050) * 16_000) : 0;
    }
    return fs.writeFile(file, encodeMonoPcm16Wav(samples, 22_050));
  };

  function uploadedComposition(ids: {
    narration: string;
    video: string;
    image: string;
    music: string;
  }) {
    const composition = createComposition({
      scenes: [
        {
          script: {
            kind: 'audio',
            assetId: ids.narration,
            transcript: 'Hola a todos desde el audio subido.',
            language: 'es-ES',
          },
          background: {
            type: 'video',
            src: { source: 'asset', assetId: ids.video },
            volume: 0.5,
            loop: true,
          },
          layers: [
            {
              type: 'image',
              src: { source: 'asset', assetId: ids.image },
              box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
              fit: 'cover',
            },
            { type: 'avatar', avatarId: 'stock_mateo', box: { x: 0.5, y: 0.2, w: 0.4, h: 0.8 } },
          ],
        },
      ],
    });
    composition.music = {
      src: { source: 'asset', assetId: ids.music },
      volume: 0.3,
      ducking: true,
      fadeInMs: 0,
      fadeOutMs: 0,
      loop: true,
    };
    return composition;
  }

  it(
    'uses uploaded narration (words from the transcript, mouth from the audio), video sound, images and music',
    async () => {
      const account = await seedAccount(t.ctx.db, { credits: 50 });
      const ws = account.workspace.id;
      const ids = {
        narration: await addAsset(ws, 'audio', 'wav', 'audio/wav', burst),
        video: await addAsset(ws, 'video', 'mp4', 'video/mp4', (file) =>
          runFfmpeg([
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=320x180:r=30:d=1',
            '-f',
            'lavfi',
            '-i',
            'sine=f=1000:d=1',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-shortest',
            file,
          ]).then(() => undefined),
        ),
        image: await addAsset(
          ws,
          'image',
          'png',
          'image/png',
          lavfi('color=c=red:s=64x64', ['-frames:v', '1']),
        ),
        music: await addAsset(ws, 'audio', 'wav', 'audio/wav', lavfi('sine=f=3000:d=0.5', [])),
      };
      const { ref } = await start(uploadedComposition(ids), { account });
      const { result } = await t.run(renderJob, ref);
      if ('canceled' in result) throw new Error('unexpected cancellation');

      // 300 ms padding + 1200 ms narration + 500 ms padding.
      expect(result.durationMs).toBe(2000);
      expect(result.providers).toEqual({}); // nothing was synthesised
      expect(await text(result.srtKey)).toContain('Hola a todos desde el audio subido.');

      const file = localFile(result.videoKey);
      const frame = await frameAt(file, 1);
      expect(frame.at(0.2 * 1280, 0.2 * 720)).toSatisfy(
        ([r, g, b]: number[]) => (r ?? 0) > 200 && (g ?? 255) < 60 && (b ?? 255) < 60,
      );
      // The looping test pattern is behind everything: the frame is not one flat colour.
      expect(
        frame.count({ x0: 0, y0: 0.5, x1: 0.4, y1: 1 }, (r, g, b) => r + g + b > 600),
      ).toBeGreaterThan(500);

      // Soundtrack: narration bursts at their place, video sound and music all the way through.
      const { stdout } = await runFfmpeg(
        ['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'],
        { maxStdoutBytes: 64 * 1024 * 1024 },
      );
      const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
      const tone = (hz: number, fromMs: number, toMs: number) => {
        let re = 0;
        let im = 0;
        for (let i = fromMs * 48; i < toMs * 48; i += 1) {
          const v = (pcm[i] ?? 0) / 32768;
          re += v * Math.cos((2 * Math.PI * hz * i) / 48000);
          im += v * Math.sin((2 * Math.PI * hz * i) / 48000);
        }
        return (2 * Math.hypot(re, im)) / ((toMs - fromMs) * 48);
      };
      expect(tone(300, 350, 650)).toBeGreaterThan(0.3); // first burst (starts at 300 ms)
      expect(tone(300, 750, 1050)).toBeLessThan(0.05); // the gap inside the narration
      expect(tone(300, 1150, 1450)).toBeGreaterThan(0.3); // second burst
      expect(tone(300, 1600, 1950)).toBeLessThan(0.05); // after the narration
      expect(tone(1000, 100, 250)).toBeGreaterThan(0.02); // sound of the background video…
      expect(tone(1000, 1600, 1950)).toBeGreaterThan(0.02); // …still there after it looped
      expect(tone(3000, 1700, 1950)).toBeGreaterThan(tone(3000, 500, 1300) * 1.5); // music ducks
    },
    LONG,
  );

  it(
    'fails for good, with a refund, when a file of the snapshot is not in this workspace',
    async () => {
      const stranger = await seedAccount(t.ctx.db, { credits: 5 });
      const foreign = await addAsset(
        stranger.workspace.id,
        'image',
        'png',
        'image/png',
        lavfi('color=c=red:s=64x64', ['-frames:v', '1']),
      );
      const composition = createComposition({
        scenes: [
          {
            duration: { mode: 'fixed', seconds: 0.5 },
            layers: [
              {
                type: 'image',
                src: { source: 'asset', assetId: foreign },
                box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
              },
            ],
          },
        ],
      });
      const { ref, account } = await start(composition);
      await expect(t.run(renderJob, ref)).rejects.toThrow(
        /^UNPROCESSABLE: A file used by this video/,
      );

      expect(await readJob(ref)).toMatchObject({
        status: 'failed',
        creditsCharged: 0,
        error: { code: 'UNPROCESSABLE' },
      });
      expect(await readVideo(ref)).toMatchObject({
        status: 'failed',
        error: { code: 'UNPROCESSABLE' },
      });
      expect(await charged(ref)).toBe(0);
      expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
      expect((await ledgerOf(ref)).map((e) => e.reason)).toEqual(['render', 'refund']);
      expect(await outputsExist(ref)).toEqual([false, false, false, false]);
      expect(await deliveries()).toEqual(['video.failed']);
      expect(await tempLeftovers()).toEqual([]);
    },
    LONG,
  );
});

describe('render job: failures and retries', () => {
  /** Make the upload of the MP4 fail `times` times (an infrastructure hiccup). */
  function breakUploads(times: number): () => void {
    const storage = t.ctx.providers.storage;
    const original = storage.put.bind(storage);
    let left = times;
    storage.put = (key, body, options) => {
      if (left > 0 && key.endsWith('/video.mp4')) {
        left -= 1;
        return Promise.reject(new Error('EIO: write failed at /var/secret/storage/path'));
      }
      return original(key, body, options);
    };
    return () => {
      storage.put = original;
    };
  }

  it(
    'keeps the job alive on a retryable failure and completes it, charged once, on the next attempt',
    async () => {
      const { ref } = await start(shortComposition());
      const restore = breakUploads(1);
      try {
        // Attempt 1 of 2: fails, but not for good — nothing is marked or refunded.
        await expect(t.run(renderJob, ref, { attempts: 2 })).rejects.toMatchObject({
          code: 'INTERNAL',
        });
        expect(await readJob(ref)).toMatchObject({ status: 'running', error: null });
        expect((await readVideo(ref))?.status).toBe('rendering');
        expect(await charged(ref)).toBe(1);
        expect(await outputsExist(ref)).toEqual([false, false, false, false]);
        expect(await deliveries()).toEqual([]);
        expect(await tempLeftovers()).toEqual([]);

        // Attempt 2 of 2 starts over on the same rows and completes.
        const { result } = await t.run(renderJob, ref, { attempts: 2, attemptsMade: 1 });
        expect('canceled' in result).toBe(false);
      } finally {
        restore();
      }
      expect(await readJob(ref)).toMatchObject({ status: 'completed', progress: 100, error: null });
      expect((await readVideo(ref))?.status).toBe('completed');
      expect(await outputsExist(ref)).toEqual([true, true, true, true]);
      expect(await charged(ref)).toBe(1);
      expect((await ledgerOf(ref)).map((e) => e.reason)).toEqual(['render']);
      expect(await deliveries()).toEqual(['video.completed']);
    },
    LONG,
  );

  it(
    'marks the job failed, refunds and notifies when the last attempt fails — without leaking internals',
    async () => {
      const { ref, account } = await start(shortComposition());
      const restore = breakUploads(1);
      try {
        await expect(t.run(renderJob, ref)).rejects.toMatchObject({ code: 'INTERNAL' });
      } finally {
        restore();
      }
      const row = await readJob(ref);
      expect(row).toMatchObject({
        status: 'failed',
        creditsCharged: 0,
        error: { code: 'INTERNAL' },
      });
      expect(row?.error?.message).not.toContain('/var/secret');
      expect(row?.finishedAt).toBeInstanceOf(Date);
      expect(await readVideo(ref)).toMatchObject({ status: 'failed', error: { code: 'INTERNAL' } });
      expect(await charged(ref)).toBe(0);
      expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
      expect(await outputsExist(ref)).toEqual([false, false, false, false]);
      expect(await deliveries()).toEqual(['video.failed']);
      expect(await tempLeftovers()).toEqual([]);

      // Delivered again after it failed: nothing happens (no second refund, no render).
      const again = await t.run(renderJob, ref);
      expect(again.result).toEqual({ canceled: true, videoId: ref.videoId });
      expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
      expect(await deliveries()).toEqual(['video.failed']);
    },
    LONG,
  );

  it('recovers a job whose worker died: onFinalFailure fails it and refunds, once', async () => {
    const { ref, account } = await start(shortComposition());
    await t.ctx.db
      .update(renderJobs)
      .set({ status: 'running', stage: 'frames', progress: 40 })
      .where(eq(renderJobs.id, ref.renderJobId));
    const error = { code: 'SERVICE_UNAVAILABLE' as const, message: 'The worker stopped' };
    await renderJob.onFinalFailure?.(t.ctx, ref, error);
    await renderJob.onFinalFailure?.(t.ctx, ref, error);
    expect(await readJob(ref)).toMatchObject({ status: 'failed', error });
    expect((await readVideo(ref))?.status).toBe('failed');
    expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
    expect((await ledgerOf(ref)).map((e) => e.reason)).toEqual(['render', 'refund']);
    expect(await deliveries()).toEqual(['video.failed']);
  });

  it(
    'fails with a clear message and a refund when the worker shuts down mid-render',
    async () => {
      const { ref, account } = await start(demoComposition());
      const shutdown = new AbortController();
      const running = t.run(renderJob, ref, { signal: shutdown.signal });
      const outcome = running.then(
        () => null,
        (err: unknown) => err,
      );
      await untilStage(ref, 'frames');
      shutdown.abort();
      expect(await outcome).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(await readJob(ref)).toMatchObject({
        status: 'failed',
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
      expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
      expect(await outputsExist(ref)).toEqual([false, false, false, false]);
      expect(await tempLeftovers()).toEqual([]);
    },
    LONG,
  );

  it('ignores payloads of another workspace and rows that no longer exist', async () => {
    const { ref } = await start(shortComposition());
    const other = await seedAccount(t.ctx.db, { credits: 5 });
    const foreign = await t.run(renderJob, { ...ref, workspaceId: other.workspace.id });
    expect(foreign.result).toEqual({ canceled: true, videoId: ref.videoId });
    expect(await readJob(ref)).toMatchObject({ status: 'queued', progress: 0 });
    expect(await charged(ref)).toBe(1);

    await t.ctx.db.delete(videos).where(eq(videos.id, ref.videoId)); // cascades to the job
    const gone = await t.run(renderJob, ref);
    expect(gone.result).toEqual({ canceled: true, videoId: ref.videoId });
  });
});

describe('render job: cancellation', () => {
  it('does nothing for a render cancelled before the worker picked it up', async () => {
    const { ref, account } = await start(shortComposition());
    await cancelLikeTheApi(ref);
    const { result, progress } = await t.run(renderJob, ref);
    expect(result).toEqual({ canceled: true, videoId: ref.videoId });
    expect(progress).toEqual([]);
    expect(await readJob(ref)).toMatchObject({ status: 'canceled', error: null });
    expect((await readVideo(ref))?.status).toBe('draft');
    expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
    expect(await outputsExist(ref)).toEqual([false, false, false, false]);
    expect(await deliveries()).toEqual([]);
  });

  it(
    'stops quietly when the user cancels while frames are being rendered',
    async () => {
      const { ref, account } = await start(demoComposition());
      const running = t.run(renderJob, ref);
      // The persisted stage/progress is what the user sees while it renders.
      const seen = await untilStage(ref, 'frames');
      expect(seen).toBeGreaterThanOrEqual(14);
      await cancelLikeTheApi(ref);
      const startedAt = Date.now();
      const { result } = await running;
      expect(Date.now() - startedAt).toBeLessThan(5000);

      expect(result).toEqual({ canceled: true, videoId: ref.videoId });
      expect(await readJob(ref)).toMatchObject({ status: 'canceled', error: null });
      expect(await readVideo(ref)).toMatchObject({ status: 'draft', videoKey: null });
      // Refunded exactly once (by the cancel), never charged again, nothing notified.
      expect(await charged(ref)).toBe(0);
      expect(await getCreditBalance(t.ctx.db, account.workspace.id)).toBe(50);
      expect((await ledgerOf(ref)).map((e) => e.reason)).toEqual(['render', 'refund']);
      expect(await deliveries()).toEqual([]);
      expect(await outputsExist(ref)).toEqual([false, false, false, false]);
      expect(await tempLeftovers()).toEqual([]);
    },
    LONG,
  );
});

describe('render job: photorealistic avatars', () => {
  const magenta = (r: number, g: number, b: number) => r > 180 && g < 90 && b > 180;
  const AVATAR_AREA = { x0: 0.54, y0: 0.12, x1: 0.94, y1: 1 };

  it(
    'animates the clip through the lip-sync provider, composites it, tags the MP4 and caches the clip',
    async () => {
      const first = await start(shortComposition({ avatarId: 'real_lucia' }));
      expect(first.reserved).toBe(2); // ×2 photoreal
      const one = await t.run(renderJob, first.ref);
      if ('canceled' in one.result) throw new Error('unexpected cancellation');

      // One request: prepared portrait + matte of the stock avatar, the padded scene audio
      // (as long as the whole scene), the viseme hint shifted to the scene clock.
      expect(lipsync.calls).toHaveLength(1);
      const request = lipsync.calls[0];
      expect(request?.portraitPath.endsWith(path.join('avatars', 'lucia.jpg'))).toBe(true);
      expect(request?.maskPath?.endsWith('lucia.mask.png')).toBe(true);
      expect(request).toMatchObject({ fps: 30, maxSize: 512 });
      expect(request?.clientRef?.startsWith(`${first.ref.renderJobId}:scn_`)).toBe(true);
      expect(request?.visemes?.[0]?.tMs).toBeGreaterThanOrEqual(300);
      expect(request?.visemes?.at(-1)?.viseme).toBe('rest');

      // The clip (magenta where its matte is white) is what the avatar layer shows.
      const file = localFile(one.result.videoKey);
      const frame = await frameAt(file, 1);
      expect(frame.count(AVATAR_AREA, magenta)).toBeGreaterThan(20_000);
      expect(frame.count({ x0: 0, y0: 0, x1: 0.5, y1: 0.85 }, magenta)).toBe(0);
      // Around the matte the scene background shows through (alpha, not a rectangle).
      expect(frame.count(AVATAR_AREA, isBackground)).toBeGreaterThan(20_000);
      // First and last frame too: the clip covers the whole scene (originMs 0).
      expect((await frameAt(file, 0)).count(AVATAR_AREA, magenta)).toBeGreaterThan(20_000);
      const lastFrame = await frameAt(file, one.result.durationMs / 1000 - 0.05);
      expect(lastFrame.count(AVATAR_AREA, magenta)).toBeGreaterThan(20_000);

      // The file itself says it is AI-generated; provenance names the lip-sync provider.
      const probe = await probeStreams(file);
      for (const [key, value] of Object.entries(AI_GENERATED_METADATA)) {
        expect(probe.format.tags?.[key]).toBe(value);
      }
      expect(one.result.providers.lipsync).toEqual(FAKE_LIPSYNC_INFO);
      expect(one.result.providers.tts?.id).toBe('espeak');

      // Progress went through the `avatars` stage with a measured ETA, persisted cost ×2.
      const avatars = one.progress.filter((p) => p.stage === 'avatars');
      expect(avatars.length).toBeGreaterThan(0);
      expect(avatars.some((p) => typeof p.etaSec === 'number')).toBe(true);
      expect(await charged(first.ref)).toBe(
        creditsForRender(one.result.durationMs, '720p', { photoreal: true }),
      );
      expect(await charged(first.ref)).toBe(2);

      // The clip and its metadata are in the shared cache of stock avatars.
      const cacheRoot = path.join(t.storageDir, 'cache', 'avatar-clips');
      const [hash] = await fs.readdir(cacheRoot);
      const cachedFiles = (await fs.readdir(path.join(cacheRoot, hash ?? ''))).filter(
        (name) => !name.endsWith('.meta.json'), // sidecars of the local storage provider
      );
      expect(cachedFiles.sort()).toEqual(['clip.json', 'clip.mp4', 'mask.mp4']);
      expect(
        JSON.parse(await text(storageKeys.avatarClipCache(null, hash ?? '', 'clip.json'))),
      ).toMatchObject({
        v: 1,
        alpha: 'mask-video',
        width: 256,
        height: 256,
        fps: 30,
        provider: FAKE_LIPSYNC_INFO,
      });

      // Same scene rendered again (another video): the engine is not asked a second time.
      const second = await start(shortComposition({ avatarId: 'real_lucia' }), {
        account: first.account,
      });
      const two = await t.run(renderJob, second.ref);
      if ('canceled' in two.result) throw new Error('unexpected cancellation');
      expect(lipsync.calls).toHaveLength(1);
      expect(two.result.providers.lipsync).toEqual(FAKE_LIPSYNC_INFO);
      const cachedFrame = await frameAt(localFile(two.result.videoKey), 1);
      expect(cachedFrame.count(AVATAR_AREA, magenta)).toBeGreaterThan(20_000);
      expect(await tempLeftovers()).toEqual([]);
    },
    LONG,
  );

  it(
    'animates silent scenes too and one clip per scene',
    async () => {
      const composition = shortComposition({ avatarId: 'real_samuel' });
      const speaking = composition.scenes[0];
      if (!speaking) throw new Error('fixture');
      composition.scenes.push({
        ...structuredClone(speaking),
        id: newId('scene'),
        script: { kind: 'none' },
        duration: { mode: 'fixed', seconds: 0.5 },
        layers: speaking.layers.map((layer) => ({ ...structuredClone(layer), id: newId('layer') })),
      });
      const { ref } = await start(composition);
      const { result } = await t.run(renderJob, ref);
      if ('canceled' in result) throw new Error('unexpected cancellation');
      expect(lipsync.calls).toHaveLength(2);
      // The silent scene: no viseme hint, and audio exactly as long as the scene (0.5 s).
      const silent = lipsync.calls[1];
      expect(silent?.visemes).toEqual([]);
      expect((await ffprobe(localFile(result.videoKey))).durationMs).toBeGreaterThan(2000);
      const frame = await frameAt(localFile(result.videoKey), result.durationMs / 1000 - 0.2);
      expect(frame.count(AVATAR_AREA, magenta)).toBeGreaterThan(20_000);
    },
    LONG,
  );

  it(
    'renders avatars of the workspace from storage and keeps their clips under the avatar prefix',
    async () => {
      const account = await seedAccount(t.ctx.db, { credits: 50 });
      const ws = account.workspace.id;
      const avatarId = newId('avatar');
      const stock = stockPhotorealAvatarFiles('real_lucia');
      const imageKey = storageKeys.avatarFile(ws, avatarId, 'image.png');
      const maskKey = storageKeys.avatarFile(ws, avatarId, 'mask.png');
      await t.ctx.providers.storage.put(
        imageKey,
        { filePath: stock.portraitPath },
        { contentType: 'image/jpeg' },
      );
      await t.ctx.providers.storage.put(
        maskKey,
        { filePath: stock.maskPath ?? '' },
        { contentType: 'image/png' },
      );
      await t.ctx.db.insert(avatars).values({
        id: avatarId,
        workspaceId: ws,
        name: 'Generada',
        origin: 'generated',
        prompt: 'mujer de unos treinta años',
        status: 'ready',
        progress: 100,
        imageKey,
        maskKey,
        rig: getStockPhotorealAvatar('real_lucia')?.rig,
      });
      const { ref } = await start(shortComposition({ avatarId }), { account });
      const { result } = await t.run(renderJob, ref);
      if ('canceled' in result) throw new Error('unexpected cancellation');

      expect(lipsync.calls).toHaveLength(1);
      expect(lipsync.calls[0]?.portraitPath).toBe(localFile(imageKey));
      expect(lipsync.calls[0]?.maskPath).toBe(localFile(maskKey));
      const frame = await frameAt(localFile(result.videoKey), 1);
      expect(frame.count(AVATAR_AREA, magenta)).toBeGreaterThan(20_000);
      // Deleting the avatar (or revoking a consent) deletes its prefix — clips included.
      const clipsDir = path.join(path.dirname(localFile(imageKey)), 'clips');
      const [hash] = await fs.readdir(clipsDir);
      expect(
        await stored(
          storageKeys.avatarClipCache({ workspaceId: ws, avatarId }, hash ?? '', 'clip.json'),
        ),
      ).toBe(true);
      expect(await fs.readdir(path.join(t.storageDir, 'cache')).catch(() => [])).not.toContain(
        'avatar-clips',
      );

      // An avatar of another workspace is not found: final failure with a refund.
      const stranger = await start(shortComposition(), {});
      await t.ctx.db
        .update(renderJobs)
        .set({ composition: shortComposition({ avatarId }) })
        .where(eq(renderJobs.id, stranger.ref.renderJobId));
      await expect(t.run(renderJob, stranger.ref)).rejects.toThrow(
        /^UNPROCESSABLE: An avatar used/,
      );
      expect(await readJob(stranger.ref)).toMatchObject({ status: 'failed' });
      expect(await charged(stranger.ref)).toBe(0);
      expect(lipsync.calls).toHaveLength(1);
    },
    LONG,
  );

  it(
    'refunds when the engine fails, and cancels the engine job when the user cancels',
    async () => {
      const failing = await start(shortComposition({ avatarId: 'real_lucia' }));
      lipsync.failWith = new AppError('PROVIDER_ERROR', 'The avatar engine ran out of memory');
      await expect(t.run(renderJob, failing.ref)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(await readJob(failing.ref)).toMatchObject({
        status: 'failed',
        stage: 'avatars',
        error: { code: 'PROVIDER_ERROR', message: 'The avatar engine ran out of memory' },
      });
      expect(await charged(failing.ref)).toBe(0);
      expect(await getCreditBalance(t.ctx.db, failing.account.workspace.id)).toBe(50);
      expect(await deliveries()).toEqual(['video.failed']);

      lipsync.failWith = null;
      lipsync.delayMs = 60_000;
      const slow = await start(shortComposition({ avatarId: 'real_lucia', text: 'Otra frase.' }), {
        account: failing.account,
      });
      const running = t.run(renderJob, slow.ref);
      await untilStage(slow.ref, 'avatars');
      // Wait until the engine is really working on the clip, then cancel.
      await expect.poll(() => lipsync.calls.length, { timeout: 20_000 }).toBe(2);
      await cancelLikeTheApi(slow.ref);
      const { result } = await running;
      expect(result).toEqual({ canceled: true, videoId: slow.ref.videoId });
      expect(lipsync.aborted).toBe(1); // the provider was told to stop
      expect(await readJob(slow.ref)).toMatchObject({ status: 'canceled' });
      expect(await getCreditBalance(t.ctx.db, slow.account.workspace.id)).toBe(50);
      expect(await deliveries()).toEqual(['video.failed']);
      expect(await tempLeftovers()).toEqual([]);
    },
    LONG,
  );
});

describe('render job: real queue (Redis, isolated prefix)', () => {
  it(
    'is picked up by a BullMQ worker when startRender enqueues it and completes the video',
    async () => {
      const prefix = `parlante-test-${randomBytes(4).toString('hex')}`;
      const redisUrl = parseEnv(baseEnvSchema, {}).REDIS_URL;
      const client = new BullQueueClient({ redisUrl, prefix });
      const ctx = {
        ...t.ctx,
        queues: client,
        config: { ...t.ctx.config, QUEUE_PREFIX: prefix, REDIS_URL: redisUrl },
      };
      const workers = startWorkers(ctx, [renderJob]);
      try {
        const account = await seedAccount(t.ctx.db, { credits: 50 });
        const videoId = newId('video');
        const composition = shortComposition();
        await t.ctx.db.insert(videos).values({
          id: videoId,
          workspaceId: account.workspace.id,
          title: 'Cola real',
          composition,
          aspect: '16:9',
        });
        const started = await startRender(
          { db: t.ctx.db, queues: client, providers: t.ctx.providers },
          { workspaceId: account.workspace.id, videoId, resolution: '720p', createdBy: null },
        );
        const ref = {
          renderJobId: started.renderJob.id,
          videoId,
          workspaceId: account.workspace.id,
        };
        // jobId of the queue = id of the row.
        await expect
          .poll(async () => (await client.getJob('render', ref.renderJobId))?.state, {
            timeout: 60_000,
            interval: 100,
          })
          .toBe('completed');
        const snapshot = await client.getJob('render', ref.renderJobId);
        expect(snapshot?.result).toMatchObject({ videoId, resolution: '720p', ...outputKeys(ref) });
        expect(await readJob(ref)).toMatchObject({ status: 'completed', progress: 100 });
        expect((await readVideo(ref))?.status).toBe('completed');
        expect(await outputsExist(ref)).toEqual([true, true, true, true]);
        expect(await charged(ref)).toBe(1);
      } finally {
        await workers.close(2000);
        await client.close();
        const redis = createRedisConnection(redisUrl);
        const keys = await redis.keys(`${prefix}:*`);
        if (keys.length > 0) await redis.del(...keys);
        redis.disconnect();
      }
    },
    LONG,
  );
});
