import { allRoutes, api, route } from '@parlante/shared';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { createApiClient, createApiRequester } from './client';
import type { RouteInput, RouteResult } from './client';
import { ApiError } from './errors';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  const onUnauthenticated = vi.fn();
  const requester = createApiRequester({
    fetch: fetchMock as unknown as typeof fetch,
    onUnauthenticated,
    validateResponses: false,
  });
  return { fetchMock, onUnauthenticated, requester, client: createApiClient(api, requester) };
}

const VIDEO_ID = 'vid_a1b2c3d4e5f6g7h8';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('typed API client', () => {
  it('exposes one caller per route of the shared contract, without listing any', () => {
    const { client } = setup(() => jsonResponse(200, {}));
    const groups = client as unknown as Record<string, Record<string, unknown>>;
    for (const { group, name } of allRoutes()) {
      expect(typeof groups[group]?.[name], `${group}.${name}`).toBe('function');
    }
    expect(allRoutes().length).toBeGreaterThan(60);
  });

  it('sees routes of any contract object (new routes need no client change)', async () => {
    const contract = {
      things: {
        rename: route({
          method: 'PATCH',
          path: '/api/things/:thingId',
          auth: 'session',
          feature: 0,
          tag: 'Things',
          summary: 'Rename',
          params: z.object({ thingId: z.string() }),
          body: z.object({ name: z.string() }),
          response: z.object({ id: z.string(), name: z.string() }),
        }),
      },
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 't1', name: 'Nuevo' }));
    const client = createApiClient(
      contract,
      createApiRequester({ fetch: fetchMock as unknown as typeof fetch, validateResponses: false }),
    );
    const result = await client.things.rename({
      params: { thingId: 't 1' },
      body: { name: 'Nuevo' },
    });
    expect(result.name).toBe('Nuevo');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/things/t%201');
    expect(init.method).toBe('PATCH');
    expectTypeOf(result).toEqualTypeOf<{ id: string; name: string }>();
  });

  it('fills path params and query, sends cookies and no body on GET', async () => {
    const { client, fetchMock } = setup(() => jsonResponse(200, { items: [], nextCursor: null }));
    await client.videos.list({ query: { limit: 5, q: 'hola mundo' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/videos?limit=5&q=hola+mundo');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('prefixes the configured base URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    const requester = createApiRequester({
      baseUrl: 'https://api.example.com/',
      fetch: fetchMock as unknown as typeof fetch,
      validateResponses: false,
    });
    await requester.request(api.videos.get, { params: { videoId: VIDEO_ID } });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      `https://api.example.com/api/videos/${VIDEO_ID}`,
    );
    expect(requester.url(api.videos.get, { params: { videoId: VIDEO_ID } })).toBe(
      `https://api.example.com/api/videos/${VIDEO_ID}`,
    );
  });

  it('sends JSON bodies and returns the parsed answer', async () => {
    const answer = { user: { id: 'usr_1' } };
    const { client, fetchMock } = setup(() => jsonResponse(200, answer));
    const result = await client.auth.login({ body: { email: 'a@b.co', password: 'secreto123' } });
    expect(result).toEqual(answer);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.co', password: 'secreto123' });
  });

  it('sends {} when a route has a body schema but the caller passes nothing', async () => {
    const { client, fetchMock } = setup(() =>
      jsonResponse(202, { jobId: 'j1', state: 'waiting', result: null }),
    );
    await client.system.pingWorker();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{}');
  });

  it('sends no body and no content type for body-less POST routes', async () => {
    const { client, fetchMock } = setup(() => jsonResponse(200, { ok: true }));
    await client.auth.logout();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('maps the single error shape to ApiError (code, status, details, field issues)', async () => {
    const { client } = setup(() =>
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid body',
          details: {
            issues: [
              { path: 'email', message: 'Invalid email' },
              { path: 'email', message: 'Second message' },
              { path: 'password', message: 'Too short' },
            ],
          },
        },
      }),
    );
    const error = await client.auth
      .login({ body: { email: 'x', password: 'y' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('VALIDATION_ERROR');
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe('Invalid body');
    expect(apiError.issues).toHaveLength(3);
    expect(apiError.fieldErrors).toEqual({ email: 'Invalid email', password: 'Too short' });
    expect(apiError.is('VALIDATION_ERROR', 'CONFLICT')).toBe(true);
  });

  it('derives a code from the status when the body is not the contract (proxy error page)', async () => {
    const { client } = setup(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const error = (await client.videos.list().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.status).toBe(502);
  });

  it('reports a non-JSON success body as INVALID_RESPONSE', async () => {
    const { client } = setup(() => new Response('<html></html>', { status: 200 }));
    const error = (await client.videos.list().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('INVALID_RESPONSE');
  });

  it('turns network failures and aborts into ApiError', async () => {
    const offline = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    const networkError = (await offline.client.videos.list().catch((e: unknown) => e)) as ApiError;
    expect(networkError).toBeInstanceOf(ApiError);
    expect(networkError.code).toBe('NETWORK_ERROR');
    expect(networkError.status).toBe(0);

    const aborted = setup(() => {
      throw new DOMException('Aborted', 'AbortError');
    });
    const abortError = (await aborted.client.videos.list().catch((e: unknown) => e)) as ApiError;
    expect(abortError.code).toBe('ABORTED');
  });

  it('notifies onUnauthenticated for a 401 on a session route', async () => {
    const { client, onUnauthenticated } = setup(() =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }),
    );
    const error = (await client.videos.list().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(onUnauthenticated.mock.calls[0]?.[0].route).toBe(api.videos.list);
  });

  it('does not notify for skipAuthRedirect, for public routes or for wrong credentials', async () => {
    const unauth = setup(() =>
      jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }),
    );
    await unauth.client.auth.me(undefined, { skipAuthRedirect: true }).catch(() => undefined);
    expect(unauth.onUnauthenticated).not.toHaveBeenCalled();

    const wrong = setup(() =>
      jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Wrong password' } }),
    );
    const error = (await wrong.client.auth
      .login({ body: { email: 'a@b.co', password: 'nope' } })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.onUnauthenticated).not.toHaveBeenCalled();
  });

  it('uploads multipart with text fields before the file and lets the browser set the boundary', async () => {
    const { client, fetchMock } = setup(() => jsonResponse(201, { id: 'ast_1' }));
    const file = new File(['hola'], 'fondo.png', { type: 'image/png' });
    await client.assets.upload({ file, fields: { name: 'Fondo' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/assets');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['name', 'file']);
    expect(form.get('name')).toBe('Fondo');
    expect((form.get('file') as File).name).toBe('fondo.png');
  });

  it('reports upload progress through XMLHttpRequest and parses the answer', async () => {
    const instances: FakeXhr[] = [];
    class FakeXhr {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      withCredentials = false;
      status = 0;
      responseText = '';
      method = '';
      url = '';
      body: unknown = null;
      headers: Record<string, string> = {};
      constructor() {
        instances.push(this);
      }
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(key: string, value: string) {
        this.headers[key] = value;
      }
      send(body: unknown) {
        this.body = body;
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const { client, fetchMock } = setup(() => jsonResponse(500, {}));
    const progress: number[] = [];
    const pending = client.assets.upload(
      { file: new File(['12345678'], 'clip.mp4', { type: 'video/mp4' }) },
      { onUploadProgress: (p) => progress.push(p.fraction) },
    );
    const xhr = instances[0];
    if (!xhr) throw new Error('XMLHttpRequest was not used');
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/assets');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.body).toBeInstanceOf(FormData);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 8 } as ProgressEvent);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 8, total: 8 } as ProgressEvent);
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ id: 'ast_9' });
    xhr.onload?.();
    await expect(pending).resolves.toEqual({ id: 'ast_9' });
    expect(progress).toEqual([0.25, 1]);
    expect(fetchMock).not.toHaveBeenCalled();

    // Error answers keep the single error shape on this transport too.
    const failing = client.assets.upload(
      { file: new File(['x'], 'big.mp4', { type: 'video/mp4' }) },
      { onUploadProgress: () => undefined },
    );
    const second = instances[1];
    if (!second) throw new Error('XMLHttpRequest was not used');
    second.status = 413;
    second.responseText = JSON.stringify({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'File too large' },
    });
    second.onload?.();
    const error = (await failing.catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.status).toBe(413);
  });

  it('returns a Blob for binary routes', async () => {
    const binary = {
      files: {
        download: route({
          method: 'GET',
          path: '/api/exports/:id',
          auth: 'session',
          feature: 0,
          tag: 'Files',
          summary: 'Download',
          params: z.object({ id: z.string() }),
          response: z.unknown(),
          binary: true,
        }),
      },
    };
    const client = createApiClient(
      binary,
      createApiRequester({
        fetch: (async () => new Response('bytes', { status: 200 })) as unknown as typeof fetch,
      }),
    );
    const blob = await client.files.download({ params: { id: 'x' } });
    // (Node's Response and jsdom each have their own Blob class: assert the behaviour.)
    expect(blob.size).toBe(5);
    expect(await blob.text()).toBe('bytes');
    expectTypeOf(blob).toEqualTypeOf<Blob>();
  });

  it('infers inputs and results from the zod schemas of the contract', () => {
    // params are required when the route declares them
    expectTypeOf<RouteInput<typeof api.videos.get>>().toEqualTypeOf<{
      params: { videoId: string };
    }>();
    // a query made only of optional/defaulted fields is optional
    expectTypeOf<RouteInput<typeof api.billing.ledger>>().toEqualTypeOf<{
      query?: { limit?: unknown; cursor?: string | undefined };
    }>();
    // bodies use the zod INPUT type (defaults optional)…
    expectTypeOf<RouteInput<typeof api.auth.register>['body']>().toMatchTypeOf<{
      email: string;
      password: string;
      name: string;
    }>();
    expectTypeOf<RouteInput<typeof api.auth.register>['body']['locale']>().toEqualTypeOf<
      'es' | 'en' | undefined
    >();
    // …and results use the zod OUTPUT type
    expectTypeOf<RouteResult<typeof api.auth.me>['user']['locale']>().toEqualTypeOf<'es' | 'en'>();
    expectTypeOf<RouteResult<typeof api.workspaces.list>['items'][number]['role']>().toEqualTypeOf<
      'owner' | 'admin' | 'editor' | 'viewer'
    >();
    // multipart routes take a file
    expectTypeOf<RouteInput<typeof api.assets.upload>['file']>().toEqualTypeOf<Blob>();
  });
});
