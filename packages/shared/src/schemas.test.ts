import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  ApiErrorBodySchema,
  AvatarIdSchema,
  avatarRenderingOf,
  ERROR_CODES,
  PLANS,
  PhotoLandmarksSchema,
  QUEUES,
  QUEUE_KEYS,
  SceneRuntimeSchema,
  VISEMES,
  VISEME_MOUTH_SHAPES,
  VoiceIdSchema,
  WebhookEventSchema,
  allRoutes,
  api,
  buildPage,
  buildPath,
  creditsForRender,
  creditsForTranslation,
  decodeCursor,
  encodeCursor,
  formatSrt,
  formatVtt,
  idOf,
  isAppError,
  newId,
  parseStockVoiceId,
  parseSubtitles,
  parseTranscript,
  phonemeToViseme,
  resolutionAllowed,
  roleAtLeast,
  toStoredError,
} from './index';
import type { RouteDef } from './index';

describe('ids', () => {
  it('generates prefixed ids accepted by the matching schema only', () => {
    const id = newId('video');
    expect(id).toMatch(/^vid_[a-z0-9]{16}$/);
    expect(idOf('video').safeParse(id).success).toBe(true);
    expect(idOf('asset').safeParse(id).success).toBe(false);
  });

  it('validates avatar and voice id forms', () => {
    expect(AvatarIdSchema.safeParse('stock_lucia').success).toBe(true);
    expect(AvatarIdSchema.safeParse('real_ana-garcia').success).toBe(true);
    expect(avatarRenderingOf('stock_lucia')).toBe('instant');
    expect(avatarRenderingOf('real_ana')).toBe('photoreal');
    expect(avatarRenderingOf(newId('avatar'))).toBe('photoreal');
    expect(AvatarIdSchema.safeParse(newId('avatar')).success).toBe(true);
    expect(AvatarIdSchema.safeParse('../etc/passwd').success).toBe(false);
    expect(VoiceIdSchema.safeParse('espeak:es-f1').success).toBe(true);
    expect(VoiceIdSchema.safeParse(newId('voice')).success).toBe(true);
    expect(VoiceIdSchema.safeParse('es f1').success).toBe(false);
    expect(parseStockVoiceId('elevenlabs:abc:def')).toEqual({
      provider: 'elevenlabs',
      providerVoiceId: 'abc:def',
    });
    expect(parseStockVoiceId(newId('voice'))).toBeNull();
  });
});

describe('errors', () => {
  it('serialises AppError to the single error shape', () => {
    const err = AppError.validation('Bad input', [{ path: 'email', message: 'Required' }]);
    expect(err.status).toBe(400);
    const body = err.toBody();
    expect(ApiErrorBodySchema.parse(body)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Bad input',
        details: { issues: [{ path: 'email', message: 'Required' }] },
      },
    });
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('maps every code to a 4xx/5xx status', () => {
    for (const status of Object.values(ERROR_CODES)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('toStoredError hides nothing for AppError and normalises unknown errors', () => {
    expect(toStoredError(new AppError('CONTENT_BLOCKED', 'no'))).toEqual({
      code: 'CONTENT_BLOCKED',
      message: 'no',
    });
    expect(toStoredError(new Error('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
  });
});

describe('pagination', () => {
  it('round-trips cursors and rejects garbage', () => {
    const pos = { createdAt: '2026-01-02T03:04:05.678Z', id: 'vid_abc' };
    expect(decodeCursor(encodeCursor(pos))).toEqual(pos);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(encodeCursor({ createdAt: 'nope', id: 'x' }))).toBeNull();
  });

  it('buildPage trims the extra row and emits nextCursor only when there is more', () => {
    const rows = [1, 2, 3].map((n) => ({ id: `r${n}`, createdAt: new Date(2026, 0, n) }));
    const page = buildPage(rows, 2);
    expect(page.items.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(decodeCursor(page.nextCursor ?? '')?.id).toBe('r2');
    expect(buildPage(rows, 3).nextCursor).toBeNull();
    expect(buildPage([], 3)).toEqual({ items: [], nextCursor: null });
  });
});

describe('visemes', () => {
  it('has a mouth shape for each of the 15 visemes', () => {
    expect(VISEMES).toHaveLength(15);
    for (const v of VISEMES) {
      const shape = VISEME_MOUTH_SHAPES[v];
      expect(shape.open).toBeGreaterThanOrEqual(0);
      expect(shape.open).toBeLessThanOrEqual(1);
      expect(Math.abs(shape.width)).toBeLessThanOrEqual(1);
    }
    expect(VISEME_MOUTH_SHAPES.rest.open).toBe(0);
    expect(VISEME_MOUTH_SHAPES.A.open).toBe(1);
  });

  it('maps IPA and eSpeak phonemes, ignoring stress and length marks', () => {
    expect(phonemeToViseme('m')).toBe('MBP');
    expect(phonemeToViseme('ˈa')).toBe('A');
    expect(phonemeToViseme('iː')).toBe('I');
    expect(phonemeToViseme('tʃ')).toBe('CHJ');
    expect(phonemeToViseme('tS')).toBe('CHJ');
    expect(phonemeToViseme('ɲ')).toBe('NL');
    expect(phonemeToViseme('u:')).toBe('U');
    expect(phonemeToViseme('θ')).toBe('TH');
    expect(phonemeToViseme('_')).toBe('rest');
    expect(phonemeToViseme('§§')).toBe('rest');
  });

  it('validates scene runtimes', () => {
    expect(
      SceneRuntimeSchema.safeParse({
        audioDurationMs: 1200,
        visemes: [
          { tMs: 0, viseme: 'rest' },
          { tMs: 80, viseme: 'O' },
        ],
        words: [{ tMs: 80, durMs: 300, text: 'Hola' }],
      }).success,
    ).toBe(true);
    expect(
      SceneRuntimeSchema.safeParse({
        audioDurationMs: 1200,
        visemes: [{ tMs: 0, viseme: 'XX' }],
        words: [],
      }).success,
    ).toBe(false);
  });
});

describe('subtitles', () => {
  const cues = [
    { startMs: 0, endMs: 1500, text: 'Hola mundo' },
    { startMs: 1500, endMs: 3_723_456, text: 'Segunda línea' },
  ];

  it('formats SRT and VTT timestamps', () => {
    const srt = formatSrt(cues);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nHola mundo\n');
    expect(srt).toContain('2\n00:00:01,500 --> 01:02:03,456\nSegunda línea\n');
    const vtt = formatVtt(cues);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:01.500 --> 01:02:03.456');
  });

  it('parses what it formats (SRT and VTT)', () => {
    expect(parseSubtitles(formatSrt(cues))).toEqual(cues);
    expect(parseSubtitles(formatVtt(cues))).toEqual(cues);
  });

  it('parses messy input: BOM, CRLF, tags, short VTT timestamps, multi-line cues', () => {
    const input =
      '\uFEFFWEBVTT\r\n\r\nNOTE hi\r\n\r\n00:01.000 --> 00:02.500 align:start\r\n<i>Uno</i>\r\ndos\r\n\r\n00:03.000 --> 00:02.000\r\ninvalid\r\n';
    expect(parseSubtitles(input)).toEqual([{ startMs: 1000, endMs: 2500, text: 'Uno dos' }]);
  });

  it('times plain text proportionally to sentence length', () => {
    const segs = parseTranscript('text', 'Hola. Esto es una frase más larga. ¿Vale?', 10_000);
    expect(segs).toHaveLength(3);
    expect(segs[0]?.startMs).toBe(0);
    expect(segs[2]?.endMs).toBe(10_000);
    expect((segs[1]?.endMs ?? 0) - (segs[1]?.startMs ?? 0)).toBeGreaterThan(
      (segs[0]?.endMs ?? 0) - (segs[0]?.startMs ?? 0),
    );
    expect(parseTranscript('text', '   ', 10_000)).toEqual([]);
  });
});

describe('plans and credits', () => {
  it('orders roles', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('editor', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
  });

  it('prices renders per started 30 s, doubled at 1080p', () => {
    expect(creditsForRender(1, '720p')).toBe(1);
    expect(creditsForRender(30_000, '720p')).toBe(1);
    expect(creditsForRender(30_001, '720p')).toBe(2);
    expect(creditsForRender(61_000, '1080p')).toBe(6);
    expect(creditsForRender(61_000, '720p', { photoreal: true })).toBe(6);
    expect(creditsForTranslation(90_000, 3)).toBe(12);
  });

  it('gates 1080p by plan and keeps limits monotonic', () => {
    expect(resolutionAllowed('free', '1080p')).toBe(false);
    expect(resolutionAllowed('creator', '1080p')).toBe(true);
    expect(PLANS.free.limits.maxMembers).toBeLessThan(PLANS.creator.limits.maxMembers);
    expect(PLANS.creator.monthlyCredits).toBeLessThan(PLANS.team.monthlyCredits);
  });
});

describe('entities', () => {
  it('rejects landmarks outside the image', () => {
    const ok = { x: 0.5, y: 0.5 };
    expect(
      PhotoLandmarksSchema.safeParse({
        leftEye: ok,
        rightEye: ok,
        mouthLeft: ok,
        mouthRight: ok,
        chin: { x: 1.2, y: 0.5 },
      }).success,
    ).toBe(false);
  });

  it('validates webhook events', () => {
    expect(
      WebhookEventSchema.safeParse({
        id: newId('event'),
        type: 'ping',
        createdAt: new Date().toISOString(),
        workspaceId: newId('workspace'),
        data: {},
      }).success,
    ).toBe(true);
    expect(
      WebhookEventSchema.safeParse({
        id: newId('event'),
        type: 'video.deleted',
        createdAt: new Date().toISOString(),
        workspaceId: newId('workspace'),
        data: {},
      }).success,
    ).toBe(false);
  });
});

describe('queues', () => {
  it('defines payload, progress and result schemas for every queue with unique names', () => {
    const names = QUEUE_KEYS.map((k) => QUEUES[k].name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'render',
        'translation',
        'batch',
        'photo-avatar',
        'voice-clone',
        'webhook-delivery',
      ]),
    );
    for (const key of QUEUE_KEYS) {
      const q = QUEUES[key];
      expect(q.name).not.toContain(':');
      expect(q.attempts).toBeGreaterThanOrEqual(1);
      expect(q.payload).toBeInstanceOf(z.ZodType);
      expect(q.progress).toBeInstanceOf(z.ZodType);
      expect(q.result).toBeInstanceOf(z.ZodType);
    }
  });

  it('validates payloads', () => {
    const ok = {
      renderJobId: newId('renderJob'),
      videoId: newId('video'),
      workspaceId: newId('workspace'),
    };
    expect(QUEUES.render.payload.safeParse(ok).success).toBe(true);
    expect(QUEUES.render.payload.safeParse({ ...ok, videoId: 'x' }).success).toBe(false);
    expect(QUEUES.system.payload.parse({ kind: 'ping' })).toEqual({ kind: 'ping', echo: '' });
  });
});

describe('API contract', () => {
  const routes = allRoutes();

  it('has unique method + path pairs', () => {
    const keys = routes.map((r) => `${r.route.method} ${r.route.path}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  it('covers every product feature 1–16', () => {
    const features = new Set(routes.map((r) => r.route.feature));
    for (let f = 1; f <= 16; f += 1) expect(features.has(f), `feature ${f}`).toBe(true);
  });

  it('declares a params schema exactly for the :params in each path', () => {
    for (const { group, name, route } of routes) {
      const inPath = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort();
      const params = route.params as z.ZodObject | undefined;
      const declared = params ? Object.keys(params.shape).sort() : [];
      expect(declared, `${group}.${name}`).toEqual(inPath);
    }
  });

  it('uses /v1 only with API-key auth and /api never with API-key auth', () => {
    for (const { group, name, route } of routes) {
      if (route.path.startsWith('/v1/')) expect(route.auth, `${group}.${name}`).toBe('apiKey');
      if (route.path.startsWith('/api/')) {
        expect(route.auth, `${group}.${name}`).not.toBe('apiKey');
      }
      expect(route.summary.length, `${group}.${name}`).toBeGreaterThan(5);
    }
  });

  it('never has a body on GET/DELETE and never both body and multipart', () => {
    for (const { group, name, route } of routes) {
      if (route.method === 'GET' || route.method === 'DELETE') {
        expect(route.body, `${group}.${name}`).toBeUndefined();
      }
      expect(Boolean(route.body && route.multipart), `${group}.${name}`).toBe(false);
    }
  });

  it('can turn every schema into JSON Schema (OpenAPI generation)', () => {
    for (const { group, name, route } of routes) {
      const def = route as RouteDef;
      for (const [part, schema] of [
        ['params', def.params],
        ['query', def.query],
        ['body', def.body],
        ['response', def.binary ? undefined : def.response],
      ] as const) {
        if (!schema) continue;
        expect(
          () => z.toJSONSchema(schema, { io: part === 'response' ? 'output' : 'input' }),
          `${group}.${name}.${part}`,
        ).not.toThrow();
      }
    }
  });

  it('builds paths with params and query', () => {
    expect(buildPath(api.videos.get.path, { videoId: 'vid_1' })).toBe('/api/videos/vid_1');
    expect(
      buildPath(api.videos.list.path, undefined, { limit: 5, q: 'a b', status: undefined }),
    ).toBe('/api/videos?limit=5&q=a+b');
    expect(() => buildPath(api.videos.get.path, {})).toThrow(/Missing path param/);
  });

  it('validates representative request bodies', () => {
    expect(
      api.auth.register.body.safeParse({
        email: ' Ana@Example.com ',
        password: 'supersecreta',
        name: 'Ana',
      }).success,
    ).toBe(false); // surrounding spaces are not a valid e-mail
    const reg = api.auth.register.body.parse({
      email: 'Ana@Example.com',
      password: 'supersecreta',
      name: 'Ana',
    });
    expect(reg.email).toBe('ana@example.com');
    expect(reg.locale).toBe('es');
    expect(
      api.auth.register.body.safeParse({ email: 'a@b.co', password: 'short', name: 'A' }).success,
    ).toBe(false);

    expect(
      api.consents.create.body.safeParse({
        kind: 'voice_clone',
        subjectName: 'Ana Pérez',
        relationship: 'self',
        statementVersion: '2026-01',
        accepted: false,
      }).success,
    ).toBe(false);

    expect(
      api.batches.create.body.safeParse({ name: 'x', sourceVideoId: newId('video') }).success,
    ).toBe(false);
    expect(
      api.batches.create.body.safeParse({
        name: 'x',
        sourceVideoId: newId('video'),
        rows: [{ nombre: 'Ana' }],
      }).success,
    ).toBe(true);

    expect(
      api.v1.createVideo.body.parse({
        input: { type: 'script', text: 'Hola', avatarId: 'stock_lucia', voiceId: 'espeak:es-f1' },
      }),
    ).toMatchObject({ resolution: '720p', render: true, input: { aspect: '16:9' } });

    expect(api.webhooks.create.body.safeParse({ url: 'ftp://example.com/hook' }).success).toBe(
      false,
    );
    expect(api.webhooks.create.body.parse({ url: 'https://example.com/hook' }).events).toEqual([
      'video.completed',
      'video.failed',
    ]);

    // Partial updates must not re-introduce defaults for absent keys.
    expect(api.brandKits.update.body.parse({ colors: { accent: '#00ff00' } })).toEqual({
      colors: { accent: '#00ff00' },
    });
    expect(api.videos.update.body.parse({})).toEqual({});

    expect(
      api.translations.create.body.safeParse({
        sourceAssetId: newId('asset'),
        sourceLanguage: 'es',
        targetLanguages: [],
      }).success,
    ).toBe(false);
  });
});
