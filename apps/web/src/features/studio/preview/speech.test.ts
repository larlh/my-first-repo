import type { SynthesizedSpeech } from '@parlante/shared';
import { describe, expect, it, vi } from 'vitest';
import { SpeechCache, speechKey } from './speech';
import type { SpeechRequest } from './speech';

const request = (text: string): SpeechRequest => ({
  text,
  voiceId: 'espeak:es-f1',
  speed: 1,
  pitch: 0,
  language: 'es',
});

const speech = (text: string): SynthesizedSpeech => ({
  audioUrl: `http://localhost:4000/api/files/cache/tts/${encodeURIComponent(text)}.wav`,
  mimeType: 'audio/wav',
  runtime: { audioDurationMs: 1000, visemes: [], words: [{ tMs: 0, durMs: 400, text }] },
  provider: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic', local: true },
});

describe('SpeechCache', () => {
  it('synthesises each distinct script once and notifies subscribers', async () => {
    const synthesize = vi.fn(async (r: SpeechRequest) => speech(r.text));
    const decode = vi.fn(async () => null);
    const cache = new SpeechCache({ synthesize, decode });
    const seen: string[] = [];
    cache.subscribe(() => seen.push(cache.get(speechKey(request('hola')))?.status ?? '-'));

    const [a, b] = await Promise.all([
      cache.ensure(request('hola')),
      cache.ensure(request('hola')),
    ]);
    expect(a).toBe(b);
    expect(a).toMatchObject({ status: 'ready', provider: { id: 'espeak' }, buffer: null });
    expect(a.runtime?.audioDurationMs).toBe(1000);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['loading', 'ready']);

    await cache.ensure(request('hola'));
    expect(synthesize).toHaveBeenCalledTimes(1);
    // Any change of text, voice, speed, pitch or language is a different entry.
    await cache.ensure({ ...request('hola'), speed: 1.25 });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('keeps a failure until asked to retry, and survives a broken decoder', async () => {
    const synthesize = vi
      .fn<(r: SpeechRequest) => Promise<SynthesizedSpeech>>()
      .mockRejectedValueOnce(new Error('PROVIDER_ERROR'))
      .mockImplementation(async (r) => speech(r.text));
    const cache = new SpeechCache({
      synthesize,
      decode: async () => {
        throw new Error('cannot decode');
      },
    });
    const failed = await cache.ensure(request('hola'));
    expect(failed.status).toBe('error');
    expect((await cache.ensure(request('hola'))).status).toBe('error');
    expect(synthesize).toHaveBeenCalledTimes(1);
    const retried = await cache.ensure(request('hola'), { retry: true });
    expect(retried).toMatchObject({ status: 'ready', buffer: null });
  });

  it('never runs more requests at once than the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const cache = new SpeechCache({
      concurrency: 2,
      decode: async () => null,
      synthesize: async (r) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return speech(r.text);
      },
    });
    const entries = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((text) => cache.ensure(request(text))),
    );
    expect(entries.every((entry) => entry.status === 'ready')).toBe(true);
    expect(peak).toBe(2);
  });
});
