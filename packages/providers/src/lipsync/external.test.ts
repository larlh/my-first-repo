import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineProgress, LipSyncRequest } from '@parlante/shared';
import { runFfmpeg } from '@parlante/shared/node';
import { providerEnvSchema } from '../env';
import { createExternalLipSyncProvider } from './external';
import { createLipSyncProvider } from './index';

/*
 * No external lip-sync service (or key) exists in this environment: the adapter is tested
 * against a stub `fetch` that plays the service side of the contract documented in
 * ./external.ts.
 */

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  form: FormData | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

function stubFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      form: init?.body instanceof FormData ? init.body : null,
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetch: fetchStub as unknown as typeof fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ENDPOINT = 'https://lipsync.example.com/v1/jobs';
const env = providerEnvSchema.parse({
  LIPSYNC_PROVIDER: 'external',
  LIPSYNC_ENDPOINT_URL: ENDPOINT,
  LIPSYNC_API_KEY: 'ls-secret',
  LIPSYNC_STATUS_URL: 'https://lipsync.example.com/health',
});

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-extlip-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function request(overrides: Partial<LipSyncRequest> = {}): Promise<LipSyncRequest> {
  const portraitPath = path.join(dir, 'portrait.jpg');
  const maskPath = path.join(dir, 'mask.png');
  const audioPath = path.join(dir, 'speech.wav');
  await fs.writeFile(portraitPath, 'JPEGDATA');
  await fs.writeFile(maskPath, 'PNGDATA');
  await fs.writeFile(audioPath, 'RIFFDATA');
  return {
    portraitPath,
    maskPath,
    audioPath,
    visemes: [{ tMs: 0, viseme: 'rest' }],
    fps: 30,
    maxSize: 512,
    outputDir: path.join(dir, 'out'),
    clientRef: 'rjb_1:scene_1:layer_1',
    ...overrides,
  };
}

describe('external lip-sync: configuration and status', () => {
  it('is selected by LIPSYNC_PROVIDER=external and needs its endpoint', () => {
    expect(createLipSyncProvider(env).info).toEqual({
      id: 'external',
      name: 'External lip-sync',
      quality: 'premium',
      local: false,
    });
    expect(() =>
      createLipSyncProvider(providerEnvSchema.parse({ LIPSYNC_PROVIDER: 'external' })),
    ).toThrow(/LIPSYNC_ENDPOINT_URL/);
  });

  it('reports availability from the optional health URL', async () => {
    const up = stubFetch(() => json({ device: 'gpu', secondsPerVideoSecond: 0.4 }));
    expect(await createExternalLipSyncProvider(env, { fetch: up.fetch }).status()).toEqual({
      available: true,
      reason: null,
      device: 'gpu',
      secondsPerVideoSecond: 0.4,
    });
    expect(up.calls[0]).toMatchObject({
      url: 'https://lipsync.example.com/health',
      authorization: 'Bearer ls-secret',
    });

    const down = stubFetch(() => json({}, 503));
    const status = await createExternalLipSyncProvider(env, { fetch: down.fetch }).status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/HTTP 503/);

    const unreachable = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(
      (await createExternalLipSyncProvider(env, { fetch: unreachable.fetch }).status()).reason,
    ).toMatch(/not reachable \(fetch failed\)/);

    // Without a health URL the adapter can only say it is configured.
    const silent = stubFetch(() => json({}));
    const configured = await createExternalLipSyncProvider(
      { ...env, LIPSYNC_STATUS_URL: undefined },
      { fetch: silent.fetch },
    ).status();
    expect(configured).toMatchObject({ available: true, secondsPerVideoSecond: null });
    expect(silent.calls).toHaveLength(0);
  });
});

describe('external lip-sync: animate', () => {
  it('uploads the inputs, polls with progress and downloads clip and matte', async () => {
    let polls = 0;
    const service = stubFetch((call) => {
      if (call.method === 'POST') return json({ id: 'job 7', status: 'queued', etaSec: 12 }, 202);
      if (call.url === `${ENDPOINT}/job%207`) {
        polls += 1;
        if (polls < 3)
          return json({ id: 'job 7', status: 'running', progress: polls / 3, etaSec: 8 });
        return json({
          id: 'job 7',
          status: 'succeeded',
          result: {
            videoUrl: '/files/job7/clip.mp4',
            maskUrl: 'https://cdn.example.net/job7/matte.mp4',
            width: 512,
            height: 640,
            fps: 30,
            frameCount: 45,
          },
        });
      }
      if (call.url === 'https://lipsync.example.com/files/job7/clip.mp4')
        return new Response('CLIP');
      if (call.url === 'https://cdn.example.net/job7/matte.mp4') return new Response('MATTE');
      return json({ error: { message: 'unexpected' } }, 500);
    });
    const provider = createExternalLipSyncProvider(env, {
      fetch: service.fetch,
      pollIntervalMs: 5,
    });
    const progress: EngineProgress[] = [];
    const req = await request({ onProgress: (p) => progress.push(p) });
    const result = await provider.animate(req);

    expect(result).toEqual({
      videoPath: path.join(req.outputDir, 'avatar.mp4'),
      alpha: 'mask-video',
      maskPath: path.join(req.outputDir, 'avatar-matte.mp4'),
      width: 512,
      height: 640,
      fps: 30,
      frameCount: 45,
      provider: { id: 'external', name: 'External lip-sync', quality: 'premium', local: false },
    });
    expect(await fs.readFile(result.videoPath, 'utf8')).toBe('CLIP');
    expect(await fs.readFile(result.maskPath!, 'utf8')).toBe('MATTE');
    expect(progress).toEqual([
      { fraction: 0, etaSec: 12 },
      { fraction: 1 / 3, etaSec: 8 },
      { fraction: 2 / 3, etaSec: 8 },
      { fraction: 1, etaSec: 0 },
    ]);

    // The upload: multipart with the three files and the options JSON.
    const post = service.calls[0]!;
    expect(post).toMatchObject({
      method: 'POST',
      url: ENDPOINT,
      authorization: 'Bearer ls-secret',
    });
    const form = post.form!;
    const portrait = form.get('portrait') as File;
    expect(portrait.name).toBe('portrait.jpg');
    expect(portrait.type).toBe('image/jpeg');
    expect(await portrait.text()).toBe('JPEGDATA');
    expect(await (form.get('mask') as File).text()).toBe('PNGDATA');
    expect((form.get('audio') as File).type).toBe('audio/wav');
    expect(JSON.parse(form.get('options') as string)).toEqual({
      fps: 30,
      maxSize: 512,
      visemes: [{ tMs: 0, viseme: 'rest' }],
      clientRef: 'rjb_1:scene_1:layer_1',
    });
    // The key goes to the configured origin only — never to the CDN that serves the matte.
    const byUrl = (url: string) => service.calls.find((call) => call.url === url)!;
    expect(byUrl('https://lipsync.example.com/files/job7/clip.mp4').authorization).toBe(
      'Bearer ls-secret',
    );
    expect(byUrl('https://cdn.example.net/job7/matte.mp4').authorization).toBeNull();
  });

  it('accepts a synchronous answer without a matte', async () => {
    const service = stubFetch((call) =>
      call.method === 'POST'
        ? json({
            status: 'succeeded',
            result: {
              videoUrl: 'https://lipsync.example.com/c.mp4',
              width: 256,
              height: 256,
              fps: 25,
              frameCount: 25,
            },
          })
        : new Response('CLIP'),
    );
    const result = await createExternalLipSyncProvider(env, { fetch: service.fetch }).animate(
      await request({ maskPath: null }),
    );
    expect(result).toMatchObject({
      alpha: 'none',
      maskPath: null,
      width: 256,
      fps: 25,
      frameCount: 25,
    });
    expect(service.calls[0]!.form!.has('mask')).toBe(false);
    expect(service.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('measures the clip with ffprobe when the service does not describe it', async () => {
    // A real (tiny) H.264 clip: 0.4 s at 25 fps, 96x64.
    const clip = path.join(dir, 'real.mp4');
    await runFfmpeg([
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=96x64:rate=25:duration=0.4',
      '-pix_fmt',
      'yuv420p',
      '-y',
      clip,
    ]);
    const bytes = await fs.readFile(clip);
    const service = stubFetch((call) =>
      call.method === 'POST'
        ? json({ status: 'succeeded', result: { videoUrl: 'https://lipsync.example.com/c.mp4' } })
        : new Response(bytes),
    );
    const result = await createExternalLipSyncProvider(env, { fetch: service.fetch }).animate(
      await request({ maskPath: null, fps: 25 }),
    );
    expect(result).toMatchObject({ width: 96, height: 64, fps: 25, frameCount: 10, alpha: 'none' });
    expect((await fs.readFile(result.videoPath)).equals(bytes)).toBe(true);
  });

  it('cancels with DELETE when the caller aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('render canceled');
    const service = stubFetch((call) => {
      if (call.method === 'POST') return json({ id: 'j1', status: 'running', progress: 0.2 });
      if (call.method === 'DELETE') return json({ id: 'j1', status: 'canceled' });
      return json({ id: 'j1', status: 'running', progress: 0.3 });
    });
    const pending = createExternalLipSyncProvider(env, {
      fetch: service.fetch,
      pollIntervalMs: 5,
    }).animate(
      await request({
        signal: controller.signal,
        onProgress: (p) => {
          if (p.fraction >= 0.3) controller.abort(reason);
        },
      }),
    );
    await expect(pending).rejects.toBe(reason);
    expect(service.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${ENDPOINT}/j1`,
      authorization: 'Bearer ls-secret',
    });
  });

  it('gives up after LIPSYNC_TIMEOUT_SEC and cancels the job', async () => {
    const service = stubFetch((call) =>
      call.method === 'DELETE' ? json({}) : json({ id: 'slow', status: 'running', progress: 0.1 }),
    );
    const provider = createExternalLipSyncProvider(
      { ...env, LIPSYNC_TIMEOUT_SEC: 0 },
      { fetch: service.fetch, pollIntervalMs: 5 },
    );
    await expect(provider.animate(await request())).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('no result after 0 seconds'),
    });
    expect(service.calls.at(-1)!.method).toBe('DELETE');
  });

  it('maps service failures to AppErrors', async () => {
    const run = async (handler: Handler) =>
      createExternalLipSyncProvider(env, { fetch: stubFetch(handler).fetch, pollIntervalMs: 5 })
        .animate(await request())
        .catch((err: unknown) => err);

    expect(await run(() => json({ error: { message: 'bad key' } }, 401))).toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
      message: expect.stringContaining('LIPSYNC_API_KEY'),
    });
    expect(await run(() => json({ error: { message: 'GPU out of memory' } }, 500))).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'External lip-sync: GPU out of memory',
    });
    expect(
      await run(() =>
        json({
          id: 'j',
          status: 'failed',
          error: { code: 'UNPROCESSABLE', message: 'no face found' },
        }),
      ),
    ).toMatchObject({ code: 'UNPROCESSABLE', message: 'External lip-sync: no face found' });
    expect(await run(() => json({ hello: 'world' }))).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('unexpected answer'),
    });
    expect(await run(() => json({ status: 'running' }))).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('neither id nor statusUrl'),
    });
    // A status URL on another origin would leak the API key: refused.
    expect(
      await run(() =>
        json({ id: 'j', status: 'running', statusUrl: 'https://evil.example.org/jobs/j' }),
      ),
    ).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('same origin') });
    expect(
      await run((call) =>
        call.method === 'POST'
          ? json({ status: 'succeeded', result: { videoUrl: 'file:///etc/passwd' } })
          : new Response('x'),
      ),
    ).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('non-HTTP URL') });
    expect(
      await run(() => {
        throw new TypeError('fetch failed');
      }),
    ).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('not reachable') });
  });
});
