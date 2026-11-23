import fs from 'node:fs/promises';
import path from 'node:path';
import { createComposition, creditsForRender, estimateSpeechTimeline } from '@parlante/shared';
import type {
  Composition,
  EngineStatus,
  ModerationRequest,
  ProviderRef,
  Provenance,
  Resolution,
  TTSProvider,
} from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, eq, renderJobs, settleCredits, videos } from '@parlante/db';
import type { VideoRow } from '@parlante/db';
import { canvasToRgba, createNodeCanvas, loadNodeImage } from '@parlante/renderer/node';
import type { TestApp } from '../../testing/index';

/* -------------------------------------------------------------------------------------------
 * Test doubles shared by the tests of videos, templates, share and public-v1.
 *
 * The AI providers a render needs BEFORE it is queued (moderation, the TTS registry that
 * resolves voice ids, the status of the avatar engine) are replaced by deterministic doubles
 * that honour their contracts, so these tests do not depend on eSpeak or the neural engine
 * being installed. Everything else is the real app: routes, `startRender`, credits, storage,
 * signed URLs and the test database.
 * ----------------------------------------------------------------------------------------- */

export const TEST_VOICE = 'espeak:es-f1';
export const TEST_AVATAR = 'stock_lucia';
export const TEST_PHOTOREAL_AVATAR = 'real_lucia';
/** Any text containing this word is rejected by the moderation double. */
export const BLOCKED_WORD = 'PROHIBIDO';

const LOCAL_TTS: ProviderRef = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic',
  local: true,
};

export interface FakeProviders {
  moderated: ModerationRequest[];
  /** State reported by the avatar engine double (change it to simulate the engine going up). */
  engine: EngineStatus;
}

export function installFakeProviders(t: TestApp): FakeProviders {
  const state: FakeProviders = {
    moderated: [],
    engine: {
      available: false,
      reason: 'The avatar engine is not running',
      device: null,
      secondsPerVideoSecond: null,
    },
  };
  const tts: TTSProvider = {
    info: LOCAL_TTS,
    listVoices: () =>
      Promise.resolve([
        {
          providerVoiceId: 'es-f1',
          name: 'Carmen',
          language: 'es',
          gender: 'female',
          description: 'Voz local',
          tags: [],
        },
        {
          providerVoiceId: 'en-f1',
          name: 'Emma',
          language: 'en',
          gender: 'female',
          description: 'Local voice',
          tags: [],
        },
      ]),
    synthesize: (request) => {
      const durationMs = request.text.length * 60;
      return Promise.resolve({
        audio: new Uint8Array([82, 73, 70, 70]),
        format: 'wav',
        sampleRate: 22050,
        durationMs,
        ...estimateSpeechTimeline(request.text, durationMs, request.language),
        provider: LOCAL_TTS,
      });
    },
  };
  const moderationInfo: ProviderRef = {
    id: 'local',
    name: 'Blocklist',
    quality: 'basic',
    local: true,
  };
  t.app.providers.tts = {
    default: tts,
    get: (id) => (id === 'espeak' ? tts : null),
    all: () => [tts],
  };
  t.app.providers.moderation = {
    info: moderationInfo,
    check: (request) => {
      state.moderated.push(request);
      const blocked = request.text.includes(BLOCKED_WORD);
      return Promise.resolve({
        allowed: !blocked,
        flags: blocked ? [{ category: 'blocklist', reason: 'Blocked term' }] : [],
        provider: moderationInfo,
      });
    },
  };
  t.app.providers.lipsync = {
    info: { id: 'local-neural', name: 'Motor neuronal local', quality: 'premium', local: true },
    status: () => Promise.resolve(state.engine),
    animate: () => Promise.reject(new Error('not used by API tests')),
  };
  return state;
}

export interface TalkingOptions {
  text?: string;
  avatarId?: string;
  scenes?: number;
  backgroundColor?: string;
  title?: string;
}

/** A renderable document: avatar + narration (+ an on-screen text) on a plain background. */
export function talkingComposition(options: TalkingOptions = {}): Composition {
  const count = options.scenes ?? 1;
  return createComposition({
    scenes: Array.from({ length: count }, (_, index) => ({
      name: `Escena ${index + 1}`,
      script: {
        kind: 'tts' as const,
        text: options.text ?? 'Hola, bienvenida a Parlante.',
        voiceId: TEST_VOICE,
        language: 'es',
      },
      background: { type: 'color' as const, color: options.backgroundColor ?? '#1d4ed8' },
      layers: [
        {
          type: 'avatar' as const,
          avatarId: options.avatarId ?? TEST_AVATAR,
          box: { x: 0.3, y: 0.1, w: 0.4, h: 0.9 },
        },
        ...(options.title
          ? [
              {
                type: 'text' as const,
                text: options.title,
                box: { x: 0.1, y: 0.05, w: 0.8, h: 0.15 },
              },
            ]
          : []),
      ],
    })),
  });
}

const PROVENANCE: Provenance = { tts: LOCAL_TTS };

/**
 * What the render job does when it finishes: writes the outputs to storage and moves job and
 * video to `completed`, settling the credits to the real cost (`markRenderCompleted` in the
 * worker — which the API cannot import). Returns the updated video row.
 */
export async function completeRender(
  t: TestApp,
  video: Pick<VideoRow, 'id' | 'workspaceId'>,
  options: { durationMs?: number; resolution?: Resolution } = {},
): Promise<VideoRow> {
  const [current] = await t.db.select().from(videos).where(eq(videos.id, video.id));
  const jobId = current?.currentRenderJobId;
  if (!current || !jobId) throw new Error('The video has no render job');
  const [job] = await t.db.select().from(renderJobs).where(eq(renderJobs.id, jobId));
  if (!job) throw new Error('Render job not found');
  const durationMs = options.durationMs ?? 4000;
  const resolution = options.resolution ?? job.resolution;
  const key = (file: 'video.mp4' | 'thumb.jpg' | 'subtitles.srt' | 'subtitles.vtt') =>
    storageKeys.videoOutput(video.workspaceId, video.id, jobId, file);
  const storage = t.app.providers.storage;
  await storage.put(key('video.mp4'), Buffer.from('fake mp4 bytes'), { contentType: 'video/mp4' });
  await storage.put(key('thumb.jpg'), Buffer.from('fake jpeg'), { contentType: 'image/jpeg' });
  await storage.put(key('subtitles.srt'), Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHola\n'), {
    contentType: 'application/x-subrip',
  });
  await storage.put(
    key('subtitles.vtt'),
    Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHola\n'),
    {
      contentType: 'text/vtt',
    },
  );
  const now = new Date();
  return t.db.transaction(async (tx) => {
    const charged = await settleCredits(tx, {
      workspaceId: video.workspaceId,
      refType: 'renderJob',
      refId: jobId,
      actualCost: creditsForRender(durationMs, resolution),
    });
    await tx
      .update(renderJobs)
      .set({
        status: 'completed',
        stage: 'finalize',
        progress: 100,
        etaSec: null,
        startedAt: now,
        finishedAt: now,
        creditsCharged: charged,
      })
      .where(eq(renderJobs.id, jobId));
    const [row] = await tx
      .update(videos)
      .set({
        status: 'completed',
        progress: 100,
        durationMs,
        resolution,
        videoKey: key('video.mp4'),
        thumbnailKey: key('thumb.jpg'),
        srtKey: key('subtitles.srt'),
        vttKey: key('subtitles.vtt'),
        providers: PROVENANCE,
        renderedRevision: job.revision,
        renderedAt: now,
        error: null,
        updatedAt: now,
      })
      .where(and(eq(videos.id, video.id), eq(videos.workspaceId, video.workspaceId)))
      .returning();
    if (!row) throw new Error('Video not found');
    return row;
  });
}

/** What the worker does when it picks a job up: job `running`, video `rendering`. */
export async function startRendering(
  t: TestApp,
  video: Pick<VideoRow, 'id'>,
  progress: { stage: 'audio' | 'avatars' | 'frames'; percent: number; etaSec: number | null },
): Promise<void> {
  const [current] = await t.db.select().from(videos).where(eq(videos.id, video.id));
  const jobId = current?.currentRenderJobId;
  if (!jobId) throw new Error('The video has no render job');
  await t.db
    .update(renderJobs)
    .set({
      status: 'running',
      stage: progress.stage,
      progress: progress.percent,
      etaSec: progress.etaSec,
      startedAt: new Date(),
    })
    .where(eq(renderJobs.id, jobId));
  await t.db
    .update(videos)
    .set({ status: 'rendering', progress: progress.percent })
    .where(eq(videos.id, video.id));
}

/** Fetch a URL produced by the API (signed file URL or public route) through the app. */
export async function fetchUrl(t: TestApp, url: string) {
  const parsed = new URL(url, t.config.PUBLIC_API_URL);
  return t.inject({ method: 'GET', url: `${parsed.pathname}${parsed.search}` });
}

/** Decode a JPEG and read pixels (to check that a poster really shows the document). */
export async function decodeJpeg(jpeg: Buffer) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG');
  const image = await loadNodeImage(jpeg);
  const { canvas, ctx } = createNodeCanvas(image.width, image.height);
  ctx.drawImage(image.source, 0, 0);
  const data = canvasToRgba(canvas);
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number): [number, number, number] => {
      const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
      return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
    },
  };
}

/** Keys of the objects stored under a prefix (local test storage; metadata sidecars skipped). */
export async function storedKeys(t: TestApp, prefix: string): Promise<string[]> {
  const root = path.join(t.storageDir, prefix);
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.meta.json'))
    .map((entry) =>
      path
        .relative(t.storageDir, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/'),
    )
    .sort();
}
