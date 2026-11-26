import { api } from '@parlante/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequester } from '../api/instance';
import { useJobPolling } from './useJobPolling';

const VIDEO_ID = 'vid_a1b2c3d4e5f6g7h8';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => apiRequester.configure({ fetch: undefined, validateResponses: undefined }));

describe('useJobPolling', () => {
  it('polls while the job is active, reports progress and ETA, and fires onSettled once', async () => {
    const answers = [
      { status: 'queued', progress: 0, renderEtaSec: null },
      { status: 'rendering', progress: 35, renderEtaSec: 20 },
      { status: 'rendering', progress: 80, renderEtaSec: 4 },
      { status: 'completed', progress: 100, renderEtaSec: null },
    ];
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      const body = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    apiRequester.configure({
      fetch: fetchMock as unknown as typeof fetch,
      validateResponses: false,
    });

    const onSettled = vi.fn();
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        const job = useJobPolling(
          api.videos.get,
          { params: { videoId: VIDEO_ID } },
          {
            intervalMs: 15,
            select: (video) => ({
              status: video.status,
              progress: video.progress,
              etaSec: video.renderEtaSec,
            }),
            onSettled,
          },
        );
        seen.push(`${job.phase}:${job.progress}:${job.etaSec}`);
        return job;
      },
      { wrapper },
    );

    await waitFor(() => expect(result.current.phase).toBe('completed'));
    expect(result.current.progress).toBe(100);
    expect(result.current.isActive).toBe(false);
    expect(result.current.etaSec).toBeNull();
    expect(seen).toContain('queued:0:null');
    expect(seen).toContain('running:35:20');
    expect(seen).toContain('running:80:4');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[1]).toBe('completed');

    // Settled jobs are not polled any more.
    const settledCalls = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetchMock.mock.calls.length).toBe(settledCalls);
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  it('does not fetch while disabled', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    apiRequester.configure({
      fetch: fetchMock as unknown as typeof fetch,
      validateResponses: false,
    });
    const { result } = renderHook(
      () =>
        useJobPolling(
          api.videos.get,
          { params: { videoId: '' } },
          { enabled: false, select: (video) => ({ status: video.status }) },
        ),
      { wrapper },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });
});
