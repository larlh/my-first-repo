import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineJobSchema, isAppError } from '@parlante/shared';
import type { EngineProgress, LipSyncRequest } from '@parlante/shared';
import { createEngineJobDir, engineRequestHeaders, runEngineJob } from '../engine';
import { providerEnvSchema } from '../env';
import type { ProviderEnv } from '../env';
import { createLipSyncProvider } from './index';
import { startFakeEngine } from './testing/fake-engine';
import type { FakeEngine } from './testing/fake-engine';

let root: string;
let workDir: string;
let callerDir: string;
let engine: FakeEngine;
let env: ProviderEnv;

const TOKEN = 'test-engine-token';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-lipsync-'));
  workDir = path.join(root, 'engine-work');
  callerDir = path.join(root, 'worker-tmp');
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(callerDir, { recursive: true });
  engine = await startFakeEngine({ workDir, token: TOKEN });
  env = providerEnvSchema.parse({
    AVATAR_ENGINE_URL: engine.url,
    AVATAR_ENGINE_TOKEN: TOKEN,
    AVATAR_ENGINE_WORK_DIR: workDir,
    AVATAR_ENGINE_POLL_MS: '20',
  });
});

afterEach(async () => {
  await engine.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function request(overrides: Partial<LipSyncRequest> = {}): Promise<LipSyncRequest> {
  const portraitPath = path.join(callerDir, 'avatar image.jpg');
  const maskPath = path.join(callerDir, 'matte.png');
  const audioPath = path.join(callerDir, 'narration.wav');
  await fs.writeFile(portraitPath, 'PORTRAIT');
  await fs.writeFile(maskPath, 'MASK');
  await fs.writeFile(audioPath, 'RIFF');
  return {
    portraitPath,
    maskPath,
    audioPath,
    visemes: [
      { tMs: 0, viseme: 'rest' },
      { tMs: 120, viseme: 'A' },
      { tMs: 400, viseme: 'rest' },
    ],
    fps: 30,
    maxSize: 512,
    outputDir: path.join(callerDir, 'out'),
    ...overrides,
  };
}

const workDirEntries = () => fs.readdir(workDir);

describe('local-neural lip-sync: status', () => {
  it('reports the measured figures, operations and licences of /health', async () => {
    const status = await createLipSyncProvider(env).status();
    expect(status).toMatchObject({
      available: true,
      reason: null,
      device: 'cpu',
      secondsPerVideoSecond: 46.5,
      secondsPerPortrait: 66,
      nonCommercial: false,
      operations: { generate: true, prepare: true, animate: true },
    });
    expect(status.models?.map((model) => `${model.id}: ${model.license}`)).toEqual([
      'liveportrait: MIT',
      'realistic-vision: CreativeML OpenRAIL-M',
    ]);
  });

  it('flags non-commercial models and missing animation weights', async () => {
    engine.health = {
      ...engine.health,
      capabilities: { generate: true, prepare: true, animate: false },
      models: [
        {
          id: 'nc-model',
          role: 'animation',
          downloaded: true,
          license: 'CC BY-NC 4.0',
          commercialUse: false,
        },
      ],
    };
    // A different token = a different cache entry (identical calls share one request for 2 s).
    const status = await createLipSyncProvider({ ...env, AVATAR_ENGINE_TOKEN: 'other' }).status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/weights/);
    expect(status.nonCommercial).toBe(true);
  });

  it('never throws when the engine is stopped: unavailable with a reason for the user', async () => {
    const stopped = createLipSyncProvider({ ...env, AVATAR_ENGINE_URL: 'http://127.0.0.1:9' });
    const status = await stopped.status();
    expect(status).toMatchObject({
      available: false,
      device: null,
      secondsPerVideoSecond: null,
      operations: { generate: false, prepare: false, animate: false },
    });
    expect(status.reason).toMatch(/avatar engine is not reachable at http:\/\/127\.0\.0\.1:9/);
    expect(status.reason).toMatch(/pnpm avatar-engine/);
  });
});

describe('local-neural lip-sync: animate', () => {
  it('moves the files through the engine work dir, reports progress and cleans up', async () => {
    const provider = createLipSyncProvider(env);
    const progress: EngineProgress[] = [];
    const req = await request({
      clientRef: 'rjb_1:scene_1:layer_1',
      onProgress: (p) => progress.push(p),
    });
    const result = await provider.animate(req);

    // What the engine received: paths INSIDE its work dir, under names chosen by the provider.
    expect(engine.submitted).toHaveLength(1);
    const body = engine.submitted[0]!.body;
    const jobDir = body.outputDir as string;
    expect(path.dirname(jobDir)).toBe(workDir);
    expect(body).toMatchObject({
      portraitPath: path.join(jobDir, 'portrait.jpg'),
      maskPath: path.join(jobDir, 'mask.png'),
      audioPath: path.join(jobDir, 'audio.wav'),
      fps: 30,
      maxSize: 512,
      clientRef: 'rjb_1:scene_1:layer_1',
      visemes: req.visemes,
    });

    // What the caller gets: files in ITS outputDir, described by the engine's result.
    expect(result).toEqual({
      videoPath: path.join(req.outputDir, 'avatar.mp4'),
      alpha: 'mask-video',
      maskPath: path.join(req.outputDir, 'avatar-matte.mp4'),
      width: 512,
      height: 512,
      fps: 30,
      frameCount: 45,
      provider: {
        id: 'local-neural',
        name: 'Motor neuronal local',
        quality: 'premium',
        local: true,
      },
    });
    expect(await fs.readFile(result.videoPath, 'utf8')).toBe('CLIP(PORTRAIT)');
    expect(await fs.readFile(result.maskPath!, 'utf8')).toBe('MATTE');

    // Progress with the engine's ETA, never going backwards, ending at 1.
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0]).toEqual({ fraction: 0, etaSec: 30 });
    expect(progress.at(-1)).toEqual({ fraction: 1, etaSec: 0 });
    const fractions = progress.map((p) => p.fraction);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);

    // Nothing is left in the shared volume, and nothing was cancelled.
    expect(await workDirEntries()).toEqual([]);
    expect(engine.canceled).toEqual([]);
    expect(engine.requests.filter((r) => r.startsWith('POST'))).toEqual(['POST /v1/animations']);
  });

  it('animates portraits without a matte and clamps sizes to the contract', async () => {
    const result = await createLipSyncProvider(env).animate(
      await request({ maskPath: null, maxSize: 4000, fps: 29.97, visemes: [] }),
    );
    expect(result).toMatchObject({ alpha: 'none', maskPath: null });
    const body = engine.submitted[0]!.body;
    expect(body).toMatchObject({ maskPath: null, maxSize: 1024, fps: 30 });
    expect(body).not.toHaveProperty('visemes');
    expect(body).not.toHaveProperty('clientRef');
    expect(await fs.readdir(path.join(callerDir, 'out'))).toEqual(['avatar.mp4']);
  });

  it('keeps the engine error code, message and reason when a job fails', async () => {
    engine.failNext('animate', {
      code: 'UNPROCESSABLE',
      message: 'No face was found in the portrait.',
      reason: 'no_face',
    });
    const error = await createLipSyncProvider(env)
      .animate(await request())
      .catch((err: unknown) => err);
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'UNPROCESSABLE',
      status: 422,
      message: 'No face was found in the portrait.',
      details: { engineCode: 'UNPROCESSABLE', reason: 'no_face' },
    });
    expect(await workDirEntries()).toEqual([]);
  });

  it('maps rejected submissions: missing weights, bad token, contract violations', async () => {
    const provider = createLipSyncProvider(env);
    engine.rejectNext(503, {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Animation weights are missing.',
      reason: 'weights_missing',
    });
    await expect(provider.animate(await request())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Animation weights are missing.',
      details: { reason: 'weights_missing', httpStatus: 503 },
    });

    // Our own request being invalid is a provider failure, never a 400 for the end user.
    engine.rejectNext(400, { code: 'VALIDATION_ERROR', message: 'fps: out of range' });
    await expect(provider.animate(await request())).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'Avatar engine: fps: out of range',
    });

    const wrongToken = createLipSyncProvider({ ...env, AVATAR_ENGINE_TOKEN: 'wrong' });
    await expect(wrongToken.animate(await request())).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: expect.stringContaining('AVATAR_ENGINE_TOKEN'),
    });

    const stopped = createLipSyncProvider({ ...env, AVATAR_ENGINE_URL: 'http://127.0.0.1:9' });
    await expect(stopped.animate(await request())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('pnpm avatar-engine'),
    });

    expect(engine.submitted).toHaveLength(0);
    expect(await workDirEntries()).toEqual([]);
  });

  it('fails cleanly when an input file does not exist', async () => {
    const req = await request({ audioPath: path.join(callerDir, 'missing.wav') });
    await expect(createLipSyncProvider(env).animate(req)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(engine.submitted).toHaveLength(0);
    expect(await workDirEntries()).toEqual([]);
  });

  it('cancels the engine job with DELETE when the signal aborts', async () => {
    engine.freeze = true;
    const controller = new AbortController();
    const reason = new Error('render canceled by the user');
    const progress: EngineProgress[] = [];
    const pending = createLipSyncProvider(env).animate(
      await request({
        signal: controller.signal,
        onProgress: (p) => {
          progress.push(p);
          // Abort once the job is visibly running.
          if (p.fraction > 0) controller.abort(reason);
        },
      }),
    );
    await expect(pending).rejects.toBe(reason);
    expect(engine.canceled).toEqual(['job_1']);
    expect(engine.jobs.get('job_1')?.job.status).toBe('canceled');
    expect(progress.at(-1)).toEqual({ fraction: 0.1, etaSec: 99 });
    expect(await workDirEntries()).toEqual([]);
    await expect(fs.readdir(path.join(callerDir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not even submit when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createLipSyncProvider(env).animate(await request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.requests).toEqual([]);
    expect(await workDirEntries()).toEqual([]);
  });

  it('re-attaches to the job of a crashed worker through clientRef', async () => {
    const clientRef = 'rjb_9:scene_2:layer_1';
    const req = await request({ clientRef });

    // "Previous worker process": same clientRef ⇒ same job dir; it submits, sees the job
    // start and dies without cancelling or cleaning up.
    const previous = await createEngineJobDir(env, { clientRef });
    const crashedBody = {
      portraitPath: await previous.importFile(req.portraitPath, 'portrait.jpg'),
      maskPath: await previous.importFile(req.maskPath!, 'mask.png'),
      audioPath: await previous.importFile(req.audioPath, 'audio.wav'),
      fps: 30,
      maxSize: 512,
      outputDir: previous.dir,
      clientRef,
    };
    const headers = engineRequestHeaders(env);
    const submitted = EngineJobSchema.parse(
      await (
        await fetch(`${engine.url}/v1/animations`, {
          method: 'POST',
          headers,
          body: JSON.stringify(crashedBody),
        })
      ).json(),
    );
    const polled = EngineJobSchema.parse(
      await (await fetch(`${engine.url}/v1/jobs/${submitted.jobId}`, { headers })).json(),
    );
    expect(polled).toMatchObject({ jobId: 'job_1', status: 'running' });

    // "Restarted worker": the same request again.
    const progress: EngineProgress[] = [];
    const result = await createLipSyncProvider(env).animate({
      ...req,
      onProgress: (p) => progress.push(p),
    });

    // The engine ran ONE job; the provider picked it up where it was and collected its files.
    expect(engine.jobs.size).toBe(1);
    expect(engine.submitted).toHaveLength(1);
    expect(engine.requests.filter((r) => r === 'POST /v1/animations')).toHaveLength(2);
    expect(progress[0]!.fraction).toBeGreaterThan(0);
    expect(await fs.readFile(result.videoPath, 'utf8')).toBe('CLIP(PORTRAIT)');
    expect(engine.canceled).toEqual([]);
    expect(await workDirEntries()).toEqual([]);
  });

  it('gives up, cancels and says so when a running job stops making progress', async () => {
    engine.freeze = true;
    const stalling = createLipSyncProvider({ ...env, AVATAR_ENGINE_STALL_SEC: 1 });
    const started = Date.now();
    await expect(stalling.animate(await request())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('no progress for 1 seconds'),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(engine.canceled).toEqual(['job_1']);
    expect(await workDirEntries()).toEqual([]);
  });

  it('reports an engine restart (job unknown) as a retryable failure', async () => {
    engine.freeze = true;
    const pending = createLipSyncProvider(env).animate(
      await request({
        onProgress: (p) => {
          if (p.fraction > 0) engine.forgetJobs();
        },
      }),
    );
    await expect(pending).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('restarted'),
    });
    expect(await workDirEntries()).toEqual([]);
  });

  it('rejects a result of the wrong kind (contract violation)', async () => {
    const dir = await createEngineJobDir(env);
    const imagePath = await dir.importFile((await request()).portraitPath, 'source.jpg');
    await expect(
      runEngineJob(env, {
        path: '/v1/portraits/prepare',
        kind: 'animate',
        body: { imagePath, outputDir: dir.dir },
      }),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('animate'),
    });
    await dir.remove();
  });
});
