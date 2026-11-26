import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineProgress } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import type { ProviderEnv } from '../env';
import { startFakeEngine } from '../lipsync/testing/fake-engine';
import type { FakeEngine } from '../lipsync/testing/fake-engine';
import { createPortraitProvider } from './index';

let root: string;
let workDir: string;
let callerDir: string;
let engine: FakeEngine;
let env: ProviderEnv;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-portrait-'));
  workDir = path.join(root, 'engine-work');
  callerDir = path.join(root, 'worker-tmp');
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(callerDir, { recursive: true });
  engine = await startFakeEngine({ workDir, steps: 2 });
  env = providerEnvSchema.parse({
    AVATAR_ENGINE_URL: engine.url,
    AVATAR_ENGINE_WORK_DIR: workDir,
    AVATAR_ENGINE_POLL_MS: '20',
    AVATAR_PORTRAIT_SIZE: '512',
  });
});

afterEach(async () => {
  await engine.close();
  await fs.rm(root, { recursive: true, force: true });
});

const PROVIDER = {
  id: 'local-neural',
  name: 'Motor neuronal local',
  quality: 'premium',
  local: true,
};

describe('local-neural portraits', () => {
  it('status: available when the engine can prepare; generation is reported per operation', async () => {
    engine.health = {
      ...engine.health,
      capabilities: { generate: false, prepare: true, animate: true },
    };
    const status = await createPortraitProvider(env).status();
    expect(status).toMatchObject({
      available: true,
      operations: { generate: false, prepare: true, animate: true },
      secondsPerPortrait: 66,
    });
    expect(status.reason).toMatch(/generate/);

    const stopped = await createPortraitProvider({
      ...env,
      AVATAR_ENGINE_URL: 'http://127.0.0.1:9',
    }).status();
    expect(stopped.available).toBe(false);
    expect(stopped.reason).toMatch(/pnpm avatar-engine/);
  });

  it('status: the reason also arrives as a translatable code', async () => {
    // Everything usable: nothing to explain.
    expect(await createPortraitProvider(env).status()).toMatchObject({
      available: true,
      reason: null,
      reasonCode: null,
    });
    // Not running at all.
    const stopped = await createPortraitProvider({
      ...env,
      AVATAR_ENGINE_URL: 'http://127.0.0.1:9',
    }).status();
    expect(stopped).toMatchObject({ available: false, reasonCode: 'engine_unreachable' });
  });

  it('status: missing weights of one operation are reported as `weights_missing`', async () => {
    // Running, but the generator weights are not downloaded.
    engine.health = {
      ...engine.health,
      capabilities: { generate: false, prepare: true, animate: true },
    };
    expect(await createPortraitProvider(env).status()).toMatchObject({
      available: true,
      reasonCode: 'weights_missing',
    });
  });

  it('status: a missing matting model (ORMBG) does not make prepare unavailable', async () => {
    // The engine degrades to its fallback segmenter: `capabilities.prepare` stays true and
    // /health lists the model as not downloaded (the UI shows it; nothing is refused).
    engine.health = {
      ...engine.health,
      models: engine.health.models.map((model) =>
        model.id === 'ormbg-onnx' ? { ...model, downloaded: false } : model,
      ),
    };
    const status = await createPortraitProvider(env).status();
    expect(status).toMatchObject({ available: true, reason: null, reasonCode: null });
    expect(status.models?.find((model) => model.id === 'ormbg-onnx')).toMatchObject({
      role: 'matting',
      downloaded: false,
    });
  });

  it('generate: sends prompt, seed, size and gender; returns the image, model and kept seed', async () => {
    const progress: EngineProgress[] = [];
    const outputDir = path.join(callerDir, 'generated');
    const result = await createPortraitProvider(env).generate({
      prompt: '  mujer de 40 años, pelo corto oscuro, chaqueta gris  ',
      seed: 7,
      gender: 'female',
      outputDir,
      clientRef: 'avt_1:generate',
      onProgress: (p) => progress.push(p),
    });
    expect(engine.submitted).toEqual([
      {
        kind: 'generate',
        body: {
          prompt: 'mujer de 40 años, pelo corto oscuro, chaqueta gris',
          seed: 7,
          width: 512,
          height: 512,
          gender: 'female',
          clientRef: 'avt_1:generate',
          outputDir: expect.stringContaining(workDir + path.sep),
        },
      },
    ]);
    expect(result).toEqual({
      imagePath: path.join(outputDir, 'generated.png'),
      provider: PROVIDER,
      model: 'realistic-vision-v6',
      seed: 1_000_010,
      quality: { passed: true, issues: [], attempts: 2 },
    });
    expect(await fs.readFile(result.imagePath, 'utf8')).toBe(
      'GENERATED(mujer de 40 años, pelo corto oscuro, chaqueta gris)',
    );
    expect(progress.at(-1)).toEqual({ fraction: 1, etaSec: 0 });
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('generate: a portrait that failed the quality control comes back flagged, with its issues', async () => {
    engine.patchNextResult('generate', {
      attempts: 4,
      qcPassed: false,
      qcIssues: ['head_tilted', 'not_frontal'],
    });
    const result = await createPortraitProvider(env).generate({
      prompt: 'hombre de 50 años con barba',
      seed: 3,
      outputDir: path.join(callerDir, 'flagged'),
    });
    expect(result.quality).toEqual({
      passed: false,
      issues: ['head_tilted', 'not_frontal'],
      attempts: 4,
    });
    // No `gender` was given: the field is not sent (the engine guesses it from the prompt).
    expect(engine.submitted[0]!.body).not.toHaveProperty('gender');
  });

  it('generate: an engine without quality control reports no verdict', async () => {
    engine.patchNextResult('generate', {
      qcPassed: undefined,
      qcIssues: undefined,
      attempts: undefined,
    });
    const result = await createPortraitProvider(env).generate({
      prompt: 'mujer de 30 años',
      seed: 3,
      outputDir: path.join(callerDir, 'plain'),
    });
    expect(result).not.toHaveProperty('quality');
  });

  it('generate: a description the engine refuses (minor) is CONTENT_BLOCKED, not a crash', async () => {
    engine.rejectNext(400, {
      code: 'VALIDATION_ERROR',
      message: 'Descriptions of minors are not allowed.',
      reason: 'minor_not_allowed',
    });
    await expect(
      createPortraitProvider(env).generate({ prompt: 'x', seed: 1, outputDir: callerDir }),
    ).rejects.toMatchObject({
      code: 'CONTENT_BLOCKED',
      message: 'Descriptions of minors are not allowed.',
      details: { reason: 'minor_not_allowed' },
    });
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('prepare: uploads the photo, forwards user landmarks and returns portrait + matte', async () => {
    const imagePath = path.join(callerDir, 'upload.webp');
    await fs.writeFile(imagePath, 'PHOTO');
    const landmarks = {
      leftEye: { x: 0.3, y: 0.3 },
      rightEye: { x: 0.7, y: 0.3 },
      mouthLeft: { x: 0.4, y: 0.6 },
      mouthRight: { x: 0.6, y: 0.6 },
      chin: { x: 0.5, y: 0.8 },
    };
    const outputDir = path.join(callerDir, 'prepared');
    const result = await createPortraitProvider(env).prepare({ imagePath, landmarks, outputDir });

    const body = engine.submitted[0]!.body;
    expect(body.imagePath).toBe(path.join(body.outputDir as string, 'source.webp'));
    expect(body.landmarks).toEqual(landmarks);
    expect(result).toMatchObject({
      portraitPath: path.join(outputDir, 'portrait.png'),
      maskPath: path.join(outputDir, 'mask.png'),
      width: 768,
      height: 768,
      landmarksSource: 'user',
      matteModel: 'matting',
      provider: PROVIDER,
    });
    expect(result.landmarks.chin).toEqual({ x: 0.5, y: 0.78 });
    expect(await fs.readFile(result.portraitPath, 'utf8')).toBe('PREPARED');
    expect(await fs.readFile(result.maskPath!, 'utf8')).toBe('MASK');
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('prepare: says so when the matte came from the fallback segmenter or is missing', async () => {
    const imagePath = path.join(callerDir, 'photo.jpg');
    await fs.writeFile(imagePath, 'PHOTO');
    engine.patchNextResult('prepare', { matteModel: 'mediapipe-selfie-multiclass' });
    const fallback = await createPortraitProvider(env).prepare({
      imagePath,
      outputDir: path.join(callerDir, 'fallback'),
    });
    expect(fallback.matteModel).toBe('mediapipe-selfie-multiclass');
    expect(fallback.maskPath).not.toBeNull();

    engine.patchNextResult('prepare', { matteModel: null, maskPath: null });
    const none = await createPortraitProvider(env).prepare({
      imagePath,
      outputDir: path.join(callerDir, 'none'),
    });
    expect(none).toMatchObject({ matteModel: null, maskPath: null });
  });

  it('prepare: no usable face is UNPROCESSABLE with the reason key for the UI', async () => {
    const imagePath = path.join(callerDir, 'landscape.jpg');
    await fs.writeFile(imagePath, 'PHOTO');
    engine.failNext('prepare', {
      code: 'UNPROCESSABLE',
      message: 'More than one face was found. Use a photo of a single person.',
      reason: 'multiple_faces',
    });
    await expect(
      createPortraitProvider(env).prepare({ imagePath, outputDir: callerDir }),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      message: 'More than one face was found. Use a photo of a single person.',
      details: { reason: 'multiple_faces' },
    });
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it('forget: drops the features the engine cached for a portrait, and nothing else', async () => {
    const sha = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const cacheDir = path.join(workDir, '.cache', 'avatars');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, `${sha}.npz`), 'FEATURES');
    await fs.writeFile(path.join(cacheDir, `${other}.npz`), 'OTHER PERSON');
    const provider = createPortraitProvider(env);

    await provider.forget?.({ portraitSha256: sha });
    expect(await fs.readdir(cacheDir)).toEqual([`${other}.npz`]);
    // Idempotent: an entry that is not there is not an error.
    await provider.forget?.({ portraitSha256: sha });
    // Only a content hash addresses an entry — never a path.
    for (const bad of ['../../etc/passwd', `${other}/../${other}`, 'B'.repeat(64), '']) {
      await expect(provider.forget?.({ portraitSha256: bad })).rejects.toThrow(/sha256/);
    }
    expect(await fs.readFile(path.join(cacheDir, `${other}.npz`), 'utf8')).toBe('OTHER PERSON');
    expect(engine.requests).toEqual([]); // files only: works while the engine is stopped
  });

  it('prepare: aborting cancels the engine job', async () => {
    const imagePath = path.join(callerDir, 'photo.png');
    await fs.writeFile(imagePath, 'PHOTO');
    engine.freeze = true;
    const controller = new AbortController();
    const pending = createPortraitProvider(env).prepare({
      imagePath,
      outputDir: callerDir,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.fraction > 0) controller.abort();
      },
    });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.canceled).toEqual(['job_1']);
    expect(await fs.readdir(workDir)).toEqual([]);
  });
});
