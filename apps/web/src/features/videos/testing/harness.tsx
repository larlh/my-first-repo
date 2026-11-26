import {
  BillingOverviewSchema,
  CapabilitiesSchema,
  PLANS,
  SessionInfoSchema,
  ShareLinkSchema,
  VideoSchema,
  VideoSummarySchema,
  createComposition,
} from '@parlante/shared';
import type {
  BillingOverview,
  Capabilities,
  Role,
  SessionInfo,
  ShareLink,
  Video,
  VideoSummary,
} from '@parlante/shared';
import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppProviders } from '@/app/App';
import { RegistryProvider } from '@/app/RegistryContext';
import { collectFeatures } from '@/app/features';
import type { FeatureManifest } from '@/app/features';
import { buildRoutes } from '@/app/router';
import { apiRequester } from '@/lib/api/instance';
import { registerTranslations } from '@/lib/i18n';

/* Test harness shared by the web-core features (auth, dashboard, videos, share): mounts real
 * manifests in the real shell router with a fake `fetch`. Fixtures are parsed with the zod
 * schemas of the contract, so a test can never pass against a body the API would not send. */

export const NOW = '2026-11-20T10:00:00.000Z';
export const WS_A = 'ws_a1b2c3d4e5f6g7h8';
export const WS_B = 'ws_z9y8x7w6v5u4t3s2';
const API_ORIGIN = 'http://localhost:4000';

export function makeSession(
  role: Role = 'owner',
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return SessionInfoSchema.parse({
    user: {
      id: 'usr_a1b2c3d4e5f6g7h8',
      email: 'lucia@ejemplo.com',
      name: 'Lucía Ferrer',
      locale: 'es',
      createdAt: NOW,
    },
    session: { id: 'ses_a1b2c3d4e5f6g7h8', expiresAt: '2026-12-20T10:00:00.000Z', createdAt: NOW },
    workspaces: [
      { id: WS_A, name: 'Estudio Norte', plan: 'creator', credits: 212, createdAt: NOW, role },
      { id: WS_B, name: 'Personal', plan: 'free', credits: 3, createdAt: NOW, role: 'owner' },
    ],
    currentWorkspaceId: WS_A,
    ...overrides,
  });
}

export function videoId(n: number): string {
  return `vid_${String(n).padStart(4, '0')}abcdefgh1234`;
}

export function fileUrl(key: string): string {
  return `${API_ORIGIN}/api/files/${key}?exp=1999999999&sig=test`;
}

/** A completed video by default; pass `status` (and friends) for other states. */
export function makeVideo(n: number, overrides: Partial<Video> = {}): Video {
  const id = videoId(n);
  const status = overrides.status ?? 'completed';
  const done = status === 'completed';
  return VideoSchema.parse({
    id,
    workspaceId: WS_A,
    title: `Vídeo ${n}`,
    status,
    progress: done ? 100 : 0,
    aspect: '16:9',
    resolution: done ? '720p' : null,
    durationMs: done ? 42_000 : null,
    thumbnailUrl: done ? fileUrl(`ws/${WS_A}/videos/${id}/thumb.jpg`) : null,
    source: 'studio',
    batchJobId: null,
    createdBy: { id: 'usr_a1b2c3d4e5f6g7h8', name: 'Lucía Ferrer' },
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    renderedAt: done ? NOW : null,
    renderStage: null,
    renderEtaSec: null,
    usesPhotorealAvatars: false,
    composition: createComposition(),
    revision: 3,
    renderedRevision: done ? 3 : null,
    estimatedDurationMs: 42_000,
    videoUrl: done ? fileUrl(`ws/${WS_A}/videos/${id}/video.mp4`) : null,
    downloadUrl: done ? `${fileUrl(`ws/${WS_A}/videos/${id}/video.mp4`)}&download=video.mp4` : null,
    srtUrl: done ? fileUrl(`ws/${WS_A}/videos/${id}/subtitles.srt`) : null,
    vttUrl: done ? fileUrl(`ws/${WS_A}/videos/${id}/subtitles.vtt`) : null,
    providers: done
      ? {
          tts: { id: 'espeak', name: 'eSpeak NG', quality: 'basic', local: true },
          lipsync: { id: 'canvas2d', name: 'Avatar 2D', quality: 'basic', local: true },
        }
      : null,
    templateId: null,
    ...overrides,
  });
}

export function toSummary(video: Video): VideoSummary {
  return VideoSummarySchema.parse(video);
}

export function makeShare(video: Video, overrides: Partial<ShareLink> = {}): ShareLink {
  return ShareLinkSchema.parse({
    id: 'shr_a1b2c3d4e5f6g7h8',
    videoId: video.id,
    token: 'kq7mx2plw9zt4rbn',
    url: 'http://localhost:5173/s/kq7mx2plw9zt4rbn',
    enabled: true,
    allowDownload: true,
    viewCount: 7,
    expiresAt: null,
    createdAt: NOW,
    ...overrides,
  });
}

export function makeBilling(overrides: Partial<BillingOverview> = {}): BillingOverview {
  return BillingOverviewSchema.parse({
    plan: PLANS.creator,
    plans: Object.values(PLANS),
    credits: 212,
    limits: PLANS.creator.limits,
    usage: {
      storageBytes: 5 * 1024 ** 3,
      members: 4,
      photoAvatars: 3,
      clonedVoices: 5,
      apiKeys: 1,
      webhookEndpoints: 0,
      creditsSpent30d: 88,
      renders30d: 31,
    },
    simulated: true,
    ...overrides,
  });
}

export function makeCapabilities(): Capabilities {
  const local = (id: string, name: string) => ({
    id,
    name,
    quality: 'basic' as const,
    local: true,
  });
  return CapabilitiesSchema.parse({
    active: {
      tts: local('espeak', 'eSpeak NG'),
      stt: local('user', 'Transcripción aportada'),
      llm: local('heuristic', 'Heurística local'),
      translation: local('heuristic', 'Heurística local'),
      voiceClone: local('profile', 'Perfil de voz'),
      lipsync: local('canvas2d', 'Avatar 2D'),
      portrait: local('local-neural', 'Motor neuronal local'),
      moderation: local('blocklist', 'Lista de bloqueo'),
      storage: local('disk', 'Disco local'),
    },
    ttsProviders: [local('espeak', 'eSpeak NG')],
    sttRequiresTranscript: true,
    avatarEngine: {
      available: false,
      reason: 'not running',
      device: null,
      secondsPerVideoSecond: null,
    },
  });
}

export const SAMPLE_VTT = `WEBVTT

00:00:00.000 --> 00:00:01.500
Hola, soy Marta.

00:00:01.500 --> 00:00:04.000
Te doy la bienvenida al equipo.
`;

/* ---------- fake API ---------- */

export interface FakeRequest {
  method: string;
  url: URL;
  /** Parsed JSON body (undefined when there is none). */
  body: unknown;
  /** Named groups / positional captures of the path pattern. */
  match: RegExpExecArray;
}

type Handler = (request: FakeRequest) => unknown;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function apiError(
  status: number,
  code: string,
  message = code,
  details?: unknown,
): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

export interface FakeApi {
  /** Register a handler: `on('GET', '/api/videos', …)` or with a RegExp path. */
  on: (method: string, path: string | RegExp, handler: Handler) => FakeApi;
  /** Change what `GET /api/auth/me` answers (null = anonymous). */
  setSession: (session: SessionInfo | null) => void;
  /** Every request seen, as `METHOD /path?query`. */
  calls: string[];
  /** Requests matching a method + path (to assert on bodies). */
  requests: (method: string, path: string | RegExp) => FakeRequest[];
  fetch: typeof fetch;
}

/** Minimal router over `fetch`. Unknown routes answer 404 in the API error shape. */
export function createFakeApi(session: SessionInfo | null = makeSession()): FakeApi {
  const routes: { method: string; path: string | RegExp; handler: Handler }[] = [];
  const seen: FakeRequest[] = [];
  const calls: string[] = [];
  let current = session;

  const fake: FakeApi = {
    calls,
    setSession(next) {
      current = next;
    },
    on(method, path, handler) {
      routes.unshift({ method, path, handler });
      return fake;
    },
    requests(method, path) {
      return seen.filter(
        (request) =>
          request.method === method &&
          (typeof path === 'string'
            ? request.url.pathname === path
            : path.test(request.url.pathname)),
      );
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url.pathname}${url.search}`);
      let body: unknown;
      if (typeof init?.body === 'string' && init.body !== '') body = JSON.parse(init.body);
      for (const route of routes) {
        if (route.method !== method) continue;
        const match =
          typeof route.path === 'string'
            ? route.path === url.pathname
              ? (/^.*$/.exec(url.pathname) as RegExpExecArray)
              : null
            : route.path.exec(url.pathname);
        if (!match) continue;
        const request: FakeRequest = { method, url, body, match };
        seen.push(request);
        const result = await route.handler(request);
        return result instanceof Response ? result : json(result);
      }
      return apiError(404, 'NOT_FOUND', `No fake route for ${method} ${url.pathname}`);
    }) as typeof fetch,
  };

  // Session endpoints every page relies on.
  fake.on('GET', '/api/auth/me', () =>
    current ? current : apiError(401, 'UNAUTHENTICATED', 'Authentication required'),
  );
  fake.on('POST', '/api/auth/logout', () => {
    current = null;
    return { ok: true };
  });
  fake.on('GET', '/api/capabilities', () => makeCapabilities());
  // Signed files: every subtitle file is the same short WebVTT; anything else is missing.
  fake.on('GET', /^\/api\/files\/.+\.(vtt|srt)$/, () => new Response(SAMPLE_VTT, { status: 200 }));
  return fake;
}

/* ---------- mounting ---------- */

let originalFetch: typeof fetch | null = null;

export interface RenderedApp {
  router: ReturnType<typeof createMemoryRouter>;
  api: FakeApi;
  client: QueryClient;
}

/**
 * Mount feature manifests in the real shell (router, guards, layouts, providers) at `path`.
 * `validateResponses` stays on: a body that breaks the contract prints a console warning,
 * which the suites turn into a failure (see `failOnContractWarnings`).
 */
export function renderFeatures(
  manifests: FeatureManifest[],
  path: string,
  api: FakeApi = createFakeApi(),
): RenderedApp {
  const registry = collectFeatures(
    Object.fromEntries(
      manifests.map((manifest) => [`../features/${manifest.id}/index.tsx`, { default: manifest }]),
    ),
    { dev: false },
  );
  if (registry.problems.length > 0) throw new Error(registry.problems.join('\n'));
  for (const feature of registry.features) {
    if (feature.i18n) registerTranslations(feature.id, feature.i18n);
  }
  apiRequester.configure({ fetch: api.fetch, validateResponses: true });
  // Media helpers (subtitles of the player and the transcript) use the global fetch.
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = api.fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(buildRoutes(registry, { dev: false }), {
    initialEntries: [path],
  });
  render(
    <AppProviders client={client}>
      <RegistryProvider registry={registry}>
        <RouterProvider router={router} />
      </RegistryProvider>
    </AppProviders>,
  );
  return { router, api, client };
}

/** Undo `renderFeatures` side effects on the shared API client. Call in `afterEach`. */
export function resetApiClient(): void {
  apiRequester.configure({ fetch: undefined, validateResponses: undefined });
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
}

/**
 * Fails the test when the API client reports a body that does not match its route schema.
 * Returns the spy; call `assert()` at the end of each test (or in `afterEach`).
 */
export function watchContractWarnings(): { assert: () => void; restore: () => void } {
  const original = console.warn;
  const warnings: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.includes('does not match the contract')) warnings.push(text);
    else original(...(args as Parameters<typeof console.warn>));
  });
  return {
    assert: () => {
      if (warnings.length > 0)
        throw new Error(`Contract drift in test fixtures:\n${warnings.join('\n')}`);
    },
    restore: () => spy.mockRestore(),
  };
}
