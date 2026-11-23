import { describe, expect, it } from 'vitest';
import type { VoiceCloneRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { fakeService, jsonReply } from '../tts/testing/fake-fetch';
import { decodeWav, encodeWav } from '../tts/wav';
import { createElevenLabsVoiceCloneProvider } from './elevenlabs';

/*
 * Exercised against a scripted fake of the ElevenLabs voices API (shapes from the public
 * documentation). NOT run against the real service: no keys or network access here.
 */

const KEY = 'sk_test_elevenlabs_secret';
const env = (overrides: Record<string, string> = {}) =>
  providerEnvSchema.parse({ ELEVENLABS_API_KEY: KEY, ...overrides });

function sample(seconds: number, sampleRate = 16_000): Int16Array {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(5000 * Math.sin((2 * Math.PI * 150 * i) / sampleRate));
  }
  return samples;
}

const request = (overrides: Partial<VoiceCloneRequest> = {}): VoiceCloneRequest => ({
  name: 'Voz de Ana',
  sample: encodeWav(sample(4), 16_000),
  sampleRate: 16_000,
  language: 'es',
  gender: 'female',
  consentId: 'cns_0123456789abcdef',
  ...overrides,
});

describe('ElevenLabs voice cloning adapter (simulated service)', () => {
  it('requires the API key', () => {
    expect(() => createElevenLabsVoiceCloneProvider(providerEnvSchema.parse({}))).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('creates a voice from the sample and forwards the consent record for audit', async () => {
    const service = fakeService([
      jsonReply({ voice_id: 'newVoice123', requires_verification: false }),
    ]);
    const provider = createElevenLabsVoiceCloneProvider(env(), service.http);
    const result = await provider.createVoice(request());

    expect(result).toEqual({
      ttsProviderId: 'elevenlabs',
      providerVoiceId: 'newVoice123',
      profile: null,
      provider: { id: 'elevenlabs', name: 'ElevenLabs', quality: 'premium', local: false },
    });
    const call = service.calls[0];
    expect(call?.url).toBe('https://api.elevenlabs.io/v1/voices/add');
    expect(call?.method).toBe('POST');
    expect(call?.headers['xi-api-key']).toBe(KEY);
    // multipart: fetch sets the boundary itself.
    expect(call?.headers['content-type']).toBeUndefined();
    expect(call?.form?.get('name')).toEqual(['Voz de Ana']);
    expect(call?.form?.get('remove_background_noise')).toEqual(['false']);
    expect(JSON.parse(String(call?.form?.get('labels')?.[0]))).toEqual({
      language: 'es',
      gender: 'female',
      parlante_consent: 'cns_0123456789abcdef',
    });
    expect(String(call?.form?.get('description')?.[0])).toContain('cns_0123456789abcdef');
    const file = call?.form?.get('files')?.[0];
    expect(file).toBeInstanceOf(Blob);
    const uploaded = decodeWav(new Uint8Array(await (file as Blob).arrayBuffer()));
    expect(uploaded.sampleRate).toBe(16_000);
    expect(uploaded.samples.length).toBe(16_000 * 4);
    expect((file as File).name).toBe('sample.wav');
  });

  it('wraps raw PCM in a WAV and trims recordings over the upload limit', async () => {
    const service = fakeService([jsonReply({ voice_id: 'v' })]);
    const provider = createElevenLabsVoiceCloneProvider(env(), service.http);
    const raw = sample(3, 22_050);
    await provider.createVoice(
      request({
        sample: new Uint8Array(raw.buffer.slice(0)),
        sampleRate: 22_050,
        gender: 'neutral',
      }),
    );
    const first = service.calls[0]?.form?.get('files')?.[0] as Blob;
    const decoded = decodeWav(new Uint8Array(await first.arrayBuffer()));
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.samples.length).toBe(raw.length);
    expect(JSON.parse(String(service.calls[0]?.form?.get('labels')?.[0]))).not.toHaveProperty(
      'gender',
    );

    // 4 minutes at 44.1 kHz is 21 MB: only the first 9.5 MB are sent.
    await provider.createVoice(
      request({ sample: encodeWav(sample(240, 44_100), 44_100), sampleRate: 44_100 }),
    );
    const second = service.calls[1]?.form?.get('files')?.[0] as Blob;
    expect(second.size).toBeLessThanOrEqual(9.5 * 1024 * 1024);
    expect(second.size).toBeGreaterThan(9 * 1024 * 1024);
    expect(decodeWav(new Uint8Array(await second.arrayBuffer())).sampleRate).toBe(44_100);
  });

  it('refuses samples that are too short or not audio, before calling the service', async () => {
    const service = fakeService([jsonReply({ voice_id: 'v' })]);
    const provider = createElevenLabsVoiceCloneProvider(env(), service.http);
    await expect(
      provider.createVoice(request({ sample: encodeWav(sample(0.4), 16_000) })),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
    expect(service.calls).toHaveLength(0);
  });

  it('maps upstream failures to PROVIDER_ERROR', async () => {
    const limit = fakeService([
      jsonReply(
        { detail: { status: 'voice_limit_reached', message: 'You have reached your voice limit' } },
        400,
      ),
    ]);
    await expect(
      createElevenLabsVoiceCloneProvider(env(), limit.http).createVoice(request()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      status: 502,
      details: { status: 400, upstreamCode: 'voice_limit_reached' },
      message: expect.stringMatching(/voice limit/) as unknown,
    });
    expect(limit.calls).toHaveLength(1);

    const noId = fakeService([jsonReply({ ok: true })]);
    await expect(
      createElevenLabsVoiceCloneProvider(env(), noId.http).createVoice(request()),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'ElevenLabs did not return the id of the new voice',
    });

    const flaky = fakeService([
      jsonReply({ detail: 'busy' }, 503),
      jsonReply({ voice_id: 'afterRetry' }),
    ]);
    const result = await createElevenLabsVoiceCloneProvider(env(), flaky.http).createVoice(
      request(),
    );
    expect(result.providerVoiceId).toBe('afterRetry');
    expect(flaky.calls).toHaveLength(2);
  });

  it('deletes a voice, idempotently', async () => {
    const ok = fakeService([jsonReply({ status: 'ok' })]);
    await createElevenLabsVoiceCloneProvider(env(), ok.http).deleteVoice('newVoice123');
    expect(ok.calls[0]).toMatchObject({
      url: 'https://api.elevenlabs.io/v1/voices/newVoice123',
      method: 'DELETE',
      headers: { 'xi-api-key': KEY },
    });

    // Already gone upstream (either way the service says it): nothing to do.
    const notFound = fakeService([jsonReply({ detail: 'Not Found' }, 404)]);
    await expect(
      createElevenLabsVoiceCloneProvider(env(), notFound.http).deleteVoice('gone1'),
    ).resolves.toBeUndefined();
    const unknown = fakeService([
      jsonReply(
        {
          detail: {
            status: 'voice_does_not_exist',
            message: 'A voice with voice_id gone2 does not exist.',
          },
        },
        400,
      ),
    ]);
    await expect(
      createElevenLabsVoiceCloneProvider(env(), unknown.http).deleteVoice('gone2'),
    ).resolves.toBeUndefined();
    expect(unknown.calls).toHaveLength(1);
  });

  it('reports real deletion failures and never calls the service with a foreign id', async () => {
    const forbidden = fakeService([
      jsonReply({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401),
    ]);
    await expect(
      createElevenLabsVoiceCloneProvider(env(), forbidden.http).deleteVoice('voice1'),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { status: 401 },
    });
    const badRequest = fakeService([
      jsonReply({ detail: { status: 'something_else', message: 'Nope' } }, 400),
    ]);
    await expect(
      createElevenLabsVoiceCloneProvider(env(), badRequest.http).deleteVoice('voice1'),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { status: 400, upstreamCode: 'something_else' },
    });
    // A local base voice id (`es-m1`) is harmless; a path-like id never reaches the URL.
    const service = fakeService([jsonReply({ status: 'ok' })]);
    await createElevenLabsVoiceCloneProvider(env(), service.http).deleteVoice('../user');
    await createElevenLabsVoiceCloneProvider(env(), service.http).deleteVoice('');
    expect(service.calls).toHaveLength(0);
  });
});
