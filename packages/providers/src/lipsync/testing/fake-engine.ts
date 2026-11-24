import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  EngineAnimateRequestSchema,
  EngineGenerateRequestSchema,
  EngineHealthSchema,
  EnginePrepareRequestSchema,
} from '@parlante/shared';
import type { EngineHealth, EngineJob, EngineJobResult } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * In-process fake of services/avatar-engine for tests: a real HTTP server that follows the
 * contract of packages/shared/src/avatar-engine.ts (bearer token, paths confined to the work
 * dir, jobs with progress, `clientRef` de-duplication, DELETE = cancel). It writes small
 * placeholder files instead of running models.
 * ----------------------------------------------------------------------------------------- */

type Kind = EngineJobResult['kind'];

interface FakeJob {
  job: EngineJob;
  kind: Kind;
  clientRef: string | undefined;
  body: Record<string, unknown>;
  polls: number;
}

export interface FakeEngineOptions {
  workDir: string;
  token?: string;
  /** Polls needed to finish a job (progress = polls / steps). Default 3. */
  steps?: number;
}

export interface FakeEngine {
  url: string;
  /** Every request received: `METHOD path`. */
  requests: string[];
  /** Bodies of the accepted POSTs, in order. */
  submitted: { kind: Kind; body: Record<string, unknown> }[];
  /** Job ids that received a DELETE. */
  canceled: string[];
  jobs: Map<string, FakeJob>;
  health: EngineHealth;
  /** Make the next job of this kind fail when it finishes. */
  failNext(kind: Kind, error: { code: string; message: string; reason?: string }): void;
  /**
   * Merge these fields into the result of the next job of this kind (e.g. a portrait whose
   * quality control failed: `{ qcPassed: false, qcIssues: ['head_tilted'] }`, or a prepared
   * portrait without the dedicated matte: `{ matteModel: 'mediapipe-selfie-multiclass' }`).
   */
  patchNextResult(kind: Kind, patch: Record<string, unknown>): void;
  /** Answer the next POST with this HTTP error instead of creating a job. */
  rejectNext(status: number, error: { code: string; message: string; reason?: string }): void;
  /** Jobs never progress past `running` (stall / cancel tests). */
  freeze: boolean;
  /** Forget every job (an engine restart). */
  forgetJobs(): void;
  close(): Promise<void>;
}

const DEFAULT_HEALTH: EngineHealth = EngineHealthSchema.parse({
  status: 'ok',
  version: '0.0.0-fake',
  device: 'cpu',
  capabilities: { generate: true, prepare: true, animate: true },
  models: [
    {
      id: 'liveportrait',
      role: 'animation',
      downloaded: true,
      license: 'MIT',
      commercialUse: true,
    },
    {
      id: 'realistic-vision',
      role: 'portrait-generation',
      downloaded: true,
      license: 'CreativeML OpenRAIL-M',
      commercialUse: true,
    },
    // Person matting used by `prepare` (part of the engine's default download).
    {
      id: 'ormbg-onnx',
      role: 'matting',
      downloaded: true,
      license: 'Apache-2.0',
      commercialUse: true,
    },
  ],
  secondsPerVideoSecond: 46.5,
  secondsPerPortrait: 66,
});

const LANDMARKS = {
  leftEye: { x: 0.4, y: 0.42 },
  rightEye: { x: 0.6, y: 0.42 },
  mouthLeft: { x: 0.43, y: 0.62 },
  mouthRight: { x: 0.57, y: 0.62 },
  chin: { x: 0.5, y: 0.78 },
};

export async function startFakeEngine(options: FakeEngineOptions): Promise<FakeEngine> {
  const workDir = path.resolve(options.workDir);
  const steps = options.steps ?? 3;
  const jobs = new Map<string, FakeJob>();
  const pendingFailures = new Map<Kind, { code: string; message: string; reason?: string }>();
  const pendingPatches = new Map<Kind, Record<string, unknown>>();
  let pendingRejection: { status: number; error: Record<string, unknown> } | null = null;
  let counter = 0;

  const inside = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    (path.resolve(candidate) === workDir || path.resolve(candidate).startsWith(workDir + path.sep));

  const finish = async (entry: FakeJob): Promise<void> => {
    const failure = pendingFailures.get(entry.kind);
    if (failure) {
      pendingFailures.delete(entry.kind);
      entry.job = { ...entry.job, status: 'failed', error: failure };
      return;
    }
    const outputDir = entry.body.outputDir as string;
    await fs.mkdir(outputDir, { recursive: true });
    let result: EngineJobResult;
    if (entry.kind === 'animate') {
      const portrait = await fs.readFile(entry.body.portraitPath as string, 'utf8');
      const videoPath = path.join(outputDir, 'avatar.mp4');
      await fs.writeFile(videoPath, `CLIP(${portrait})`);
      const hasMask = typeof entry.body.maskPath === 'string';
      const maskPath = hasMask ? path.join(outputDir, 'avatar-matte.mp4') : null;
      if (maskPath) await fs.writeFile(maskPath, 'MATTE');
      result = {
        kind: 'animate',
        videoPath,
        alpha: hasMask ? 'mask-video' : 'none',
        maskPath,
        width: 512,
        height: 512,
        fps: Number(entry.body.fps ?? 30),
        frameCount: 45,
        model: 'liveportrait',
      };
    } else if (entry.kind === 'prepare') {
      const portraitPath = path.join(outputDir, 'portrait.png');
      const maskPath = path.join(outputDir, 'mask.png');
      await fs.writeFile(portraitPath, 'PREPARED');
      await fs.writeFile(maskPath, 'MASK');
      result = {
        kind: 'prepare',
        portraitPath,
        maskPath,
        width: 768,
        height: 768,
        landmarks: LANDMARKS,
        landmarksSource: entry.body.landmarks ? 'user' : 'detected',
        matteModel: 'matting',
      };
    } else {
      const imagePath = path.join(outputDir, 'portrait.png');
      await fs.writeFile(imagePath, `GENERATED(${String(entry.body.prompt)})`);
      result = {
        kind: 'generate',
        imagePath,
        model: 'realistic-vision-v6',
        width: Number(entry.body.width),
        height: Number(entry.body.height),
        seedUsed: Number(entry.body.seed) + 1_000_003,
        attempts: 2,
        qcPassed: true,
        qcIssues: [],
      };
    }
    const patch = pendingPatches.get(entry.kind);
    if (patch) {
      pendingPatches.delete(entry.kind);
      result = { ...result, ...patch } as EngineJobResult;
    }
    entry.job = { ...entry.job, status: 'succeeded', progress: 1, etaSec: 0, result };
  };

  const engine: FakeEngine = {
    url: '',
    requests: [],
    submitted: [],
    canceled: [],
    jobs,
    health: DEFAULT_HEALTH,
    freeze: false,
    failNext: (kind, error) => void pendingFailures.set(kind, error),
    patchNextResult: (kind, patch) => void pendingPatches.set(kind, patch),
    rejectNext: (status, error) => {
      pendingRejection = { status, error };
    },
    forgetJobs: () => jobs.clear(),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  const send = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: http.ServerResponse, status: number, code: string, message: string): void =>
    send(res, status, { error: { code, message } });

  const submit = async (
    res: http.ServerResponse,
    kind: Kind,
    raw: unknown,
    schema:
      | typeof EngineAnimateRequestSchema
      | typeof EnginePrepareRequestSchema
      | typeof EngineGenerateRequestSchema,
    inputPaths: string[],
  ): Promise<void> => {
    if (pendingRejection) {
      const { status, error } = pendingRejection;
      pendingRejection = null;
      send(res, status, { error });
      return;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      fail(res, 400, 'VALIDATION_ERROR', `Invalid ${kind} request`);
      return;
    }
    const body = parsed.data as Record<string, unknown>;
    for (const key of [...inputPaths, 'outputDir']) {
      const value = body[key];
      if (value === null || value === undefined) continue;
      if (!inside(value)) {
        fail(res, 400, 'VALIDATION_ERROR', `${key}: path is outside the engine work directory`);
        return;
      }
      if (key !== 'outputDir' && !(await fs.stat(value).catch(() => null))) {
        fail(res, 400, 'VALIDATION_ERROR', `${key}: file not found`);
        return;
      }
    }
    const clientRef = typeof body.clientRef === 'string' ? body.clientRef : undefined;
    if (clientRef) {
      for (const other of jobs.values()) {
        if (
          other.clientRef === clientRef &&
          other.kind === kind &&
          (other.job.status === 'queued' || other.job.status === 'running')
        ) {
          send(res, 202, other.job);
          return;
        }
      }
    }
    counter += 1;
    const jobId = `job_${counter}`;
    const entry: FakeJob = {
      kind,
      clientRef,
      body,
      polls: 0,
      job: { jobId, status: 'queued', progress: 0, etaSec: steps * 10, result: null, error: null },
    };
    jobs.set(jobId, entry);
    engine.submitted.push({ kind, body });
    send(res, 202, entry.job);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      engine.requests.push(`${req.method} ${url.pathname}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, engine.health);
        return;
      }
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        fail(res, 401, 'UNAUTHENTICATED', 'Missing or invalid bearer token');
        return;
      }
      const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
      if (jobMatch?.[1]) {
        const entry = jobs.get(decodeURIComponent(jobMatch[1]));
        if (!entry) {
          fail(res, 404, 'NOT_FOUND', 'Job not found');
          return;
        }
        if (req.method === 'DELETE') {
          engine.canceled.push(entry.job.jobId);
          if (entry.job.status === 'queued' || entry.job.status === 'running') {
            entry.job = { ...entry.job, status: 'canceled', etaSec: null };
          }
          send(res, 200, entry.job);
          return;
        }
        if (entry.job.status === 'queued' || entry.job.status === 'running') {
          entry.polls += 1;
          if (engine.freeze) {
            entry.job = { ...entry.job, status: 'running', progress: 0.1, etaSec: 99 };
          } else if (entry.polls >= steps) {
            await finish(entry);
          } else {
            entry.job = {
              ...entry.job,
              status: 'running',
              progress: entry.polls / steps,
              etaSec: (steps - entry.polls) * 10,
            };
          }
        }
        send(res, 200, entry.job);
        return;
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let raw: unknown;
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          raw = null;
        }
        if (url.pathname === '/v1/animations') {
          await submit(res, 'animate', raw, EngineAnimateRequestSchema, [
            'portraitPath',
            'maskPath',
            'audioPath',
          ]);
          return;
        }
        if (url.pathname === '/v1/portraits/prepare') {
          await submit(res, 'prepare', raw, EnginePrepareRequestSchema, ['imagePath']);
          return;
        }
        if (url.pathname === '/v1/portraits/generate') {
          await submit(res, 'generate', raw, EngineGenerateRequestSchema, []);
          return;
        }
      }
      fail(res, 404, 'NOT_FOUND', 'No such endpoint');
    })().catch((err: unknown) => {
      fail(res, 500, 'INTERNAL', err instanceof Error ? err.message : 'fake engine error');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  engine.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return engine;
}
