import { describe, expect, it } from 'vitest';
import { isAppError } from '@parlante/shared';
import { readJson, speechFetch, upstreamError } from './http';
import type { SpeechFetch } from './http';
import { fakeService, jsonReply } from './testing/fake-fetch';

const get = (url = 'https://speech.example.com/v1/thing', timeoutMs = 5000) => ({
  service: 'Example',
  url,
  init: () => ({ method: 'GET' }),
  timeoutMs,
});

describe('speechFetch', () => {
  it('returns successful responses untouched', async () => {
    const service = fakeService([jsonReply({ ok: true })]);
    const response = await speechFetch(service.http, get());
    expect(await readJson('Example', response)).toEqual({ ok: true });
    expect(service.calls).toHaveLength(1);
    expect(service.sleeps).toEqual([]);
  });

  it('really aborts a request that does not answer in time, and retries it', async () => {
    let attempts = 0;
    // A server that never answers: the only way out is the AbortSignal of the time limit.
    const hanging = ((_url: unknown, init?: RequestInit) => {
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }) as SpeechFetch;
    const started = performance.now();
    const error = await speechFetch(
      { fetch: hanging, sleep: async () => undefined },
      get(undefined, 40),
    ).catch((err: unknown) => err);
    const elapsed = performance.now() - started;
    expect(isAppError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 502,
      details: { service: 'Example', attempts: 3, timeout: true },
    });
    expect((error as Error).message).toMatch(/Example did not answer within/);
    expect(attempts).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(100); // three limits of 40 ms
    expect(elapsed).toBeLessThan(2000);
  });

  it('builds the request anew for every attempt and honours maxAttempts', async () => {
    let built = 0;
    const service = fakeService([jsonReply({}, 500)]);
    await expect(
      speechFetch(
        { ...service.http, maxAttempts: 5 },
        {
          ...get(),
          init: () => {
            built += 1;
            return { method: 'POST', body: JSON.stringify({ attempt: built }) };
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { attempts: 5, status: 500 } });
    expect(built).toBe(5);
    expect(service.calls.map((call) => call.json)).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({ attempt })),
    );
    // Exponential backoff between attempts.
    expect(service.sleeps).toEqual([500, 1000, 2000, 4000]);

    const once = fakeService([jsonReply({}, 503)]);
    await expect(speechFetch({ ...once.http, maxAttempts: 1 }, get())).rejects.toMatchObject({
      details: { attempts: 1 },
    });
    expect(once.calls).toHaveLength(1);
  });

  it('retries only what can succeed on a second try', async () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      const service = fakeService([jsonReply({}, status)]);
      await expect(speechFetch(service.http, get())).rejects.toMatchObject({
        details: { status, attempts: 1 },
      });
      expect(service.calls).toHaveLength(1);
    }
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const service = fakeService([jsonReply({}, status), jsonReply({ ok: true })]);
      expect((await speechFetch(service.http, get())).status).toBe(200);
      expect(service.calls).toHaveLength(2);
    }
  });

  it('hands back statuses the caller declared acceptable', async () => {
    const service = fakeService([jsonReply({ detail: 'gone' }, 404)]);
    const response = await speechFetch(service.http, { ...get(), acceptStatus: [404] });
    expect(response.status).toBe(404);
    expect(service.calls).toHaveLength(1);
  });
});

describe('upstreamError', () => {
  it('reads OpenAI and ElevenLabs error bodies, plain text and nothing at all', async () => {
    const openai = await upstreamError(
      'OpenAI',
      jsonReply(
        {
          error: {
            message: 'Model not found',
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        404,
      ),
    );
    expect(openai).toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'OpenAI rejected the request (HTTP 404): Model not found',
      details: { status: 404, upstreamCode: 'model_not_found' },
    });
    const eleven = await upstreamError(
      'ElevenLabs',
      jsonReply({ detail: { status: 'quota_exceeded', message: 'No credits' } }, 429),
    );
    expect(eleven.message).toBe('ElevenLabs rate limit or quota exceeded (HTTP 429): No credits');
    const text = await upstreamError('Example', new Response('Bad Gateway', { status: 502 }));
    expect(text.message).toBe('Example is failing (HTTP 502): Bad Gateway');
    const empty = await upstreamError('Example', new Response(null, { status: 500 }));
    expect(empty.message).toBe('Example is failing (HTTP 500)');
    // A page of HTML is not a message worth showing.
    const html = await upstreamError(
      'Example',
      new Response(`<html>${'x'.repeat(500)}</html>`, { status: 503 }),
    );
    expect(html.message).toBe('Example is failing (HTTP 503)');
    // Long upstream messages are cut.
    const long = await upstreamError(
      'Example',
      jsonReply({ error: { message: 'm'.repeat(2000) } }, 400),
    );
    expect(long.message.length).toBeLessThan(360);
  });
});
