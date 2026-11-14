import { api } from '@parlante/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiQueryKey,
  invalidateApi,
  useApiInfiniteQuery,
  useApiMutation,
  useApiQuery,
} from './hooks';
import { apiRequester } from './instance';

const VIDEO_ID = 'vid_a1b2c3d4e5f6g7h8';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let client: QueryClient;

beforeEach(() => {
  fetchMock = vi.fn();
  apiRequester.configure({ fetch: fetchMock as unknown as typeof fetch, validateResponses: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  apiRequester.configure({ fetch: undefined, validateResponses: undefined });
  client.clear();
});

describe('query keys', () => {
  it('are stable per route + input and prefix-friendly', () => {
    expect(apiQueryKey(api.videos.list)).toEqual(['api', '/api/videos']);
    expect(apiQueryKey(api.videos.get, { params: { videoId: VIDEO_ID } })).toEqual([
      'api',
      '/api/videos/:videoId',
      { params: { videoId: VIDEO_ID }, query: null },
    ]);
  });

  it('invalidateApi matches exact routes and path prefixes only', async () => {
    client.setQueryData(apiQueryKey(api.videos.list), 1);
    client.setQueryData(apiQueryKey(api.videos.get, { params: { videoId: VIDEO_ID } }), 2);
    client.setQueryData(apiQueryKey(api.assets.list), 3);
    client.setQueryData(['session'], 4);

    await invalidateApi(client, api.videos.list);
    const stale = () =>
      client
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.isInvalidated)
        .map((q) => q.queryKey[1] ?? q.queryKey[0]);
    expect(stale()).toEqual(['/api/videos']);

    await invalidateApi(client, '/api/videos');
    expect(stale().sort()).toEqual(['/api/videos', '/api/videos/:videoId']);
  });
});

describe('useApiQuery / useApiMutation', () => {
  it('fetches a route and exposes typed data', async () => {
    fetchMock.mockResolvedValue(json({ id: VIDEO_ID, title: 'Bienvenida' }));
    const { result } = renderHook(
      () => useApiQuery(api.videos.get, { params: { videoId: VIDEO_ID } }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.title).toBe('Bienvenida');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/videos/${VIDEO_ID}`);
  });

  it('surfaces ApiError with its code', async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: 'NOT_FOUND', message: 'Video not found' } }, 404),
    );
    const { result } = renderHook(
      () => useApiQuery(api.videos.get, { params: { videoId: VIDEO_ID } }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.code).toBe('NOT_FOUND');
  });

  it('does not fetch while disabled', () => {
    renderHook(() => useApiQuery(api.videos.get, { params: { videoId: '' } }, { enabled: false }), {
      wrapper: wrapperFor(client),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mutates and invalidates the listed routes on success', async () => {
    client.setQueryData(apiQueryKey(api.videos.list), { items: [], nextCursor: null });
    fetchMock.mockResolvedValue(json({ ok: true }));
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () => useApiMutation(api.videos.remove, { invalidates: [api.videos.list], onSuccess }),
      { wrapper: wrapperFor(client) },
    );
    await act(async () => {
      await result.current.mutateAsync({ params: { videoId: VIDEO_ID } });
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/videos/${VIDEO_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
    expect(client.getQueryState(apiQueryKey(api.videos.list))?.isInvalidated).toBe(true);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('useApiInfiniteQuery', () => {
  it('follows nextCursor and flattens the pages', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('cursor=c2')
        ? json({ items: [{ id: 'c' }], nextCursor: null })
        : json({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c2' }),
    );
    const { result } = renderHook(
      () => useApiInfiniteQuery(api.videos.list, { query: { limit: 2 } }),
      {
        wrapper: wrapperFor(client),
      },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.hasNextPage).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/videos?limit=2');

    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/videos?limit=2&cursor=c2');
    expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.hasNextPage).toBe(false);
  });
});
