import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  apiError,
  createFakeApi,
  json,
  makeSession,
  renderFeatures,
} from '@/features/videos/testing/harness';
import type { FakeApi } from '@/features/videos/testing/harness';
import avatars from '@/features/avatars';
import {
  ELEVEN_PROVIDER,
  clonedVoice,
  makeAsset,
  makeConsent,
  makeLibraryCapabilities,
  makeSpeech,
} from '@/features/avatars/kit/testing/fixtures';
import { fakeUploads, others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import voiceClone from './index';

const features = [voiceClone, avatars, others];
const sample = () => new File([new Uint8Array(2048)], 'mi-voz.wav', { type: 'audio/wav' });
const sampleAsset = () =>
  makeAsset(2, {
    kind: 'audio',
    purpose: 'voice_sample',
    name: 'mi-voz.wav',
    mimeType: 'audio/wav',
    width: null,
    height: null,
    durationMs: 32_000,
  });

function withVoices(api: FakeApi, cloned = [] as ReturnType<typeof clonedVoice>[]): FakeApi {
  return api
    .on('GET', '/api/capabilities', () => makeLibraryCapabilities())
    .on('GET', '/api/voices', () => ({ items: cloned }));
}

async function pickSample(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: /Muestra de voz/ });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  await user.upload(input, sample());
  await screen.findByText('mi-voz.wav');
}

async function consent(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByRole('textbox', { name: /Nombre completo de quien consiente/ }),
    'Lucía Ferrer',
  );
  await user.click(screen.getByRole('checkbox', { name: /He leído la declaración y la acepto/ }));
}

describe('clone a voice', () => {
  const { play } = usePageTestSetup();

  it('is honest about the local basic mode: what it does and what it does not', async () => {
    renderFeatures(features, '/voices/clone', withVoices(createFakeApi()));
    const panel = await screen.findByRole('region', { name: 'Cómo se clona aquí' });
    expect(await within(panel).findByText('Modo básico local')).toBeVisible();
    expect(within(panel).getByText('Modo básico · Voice profile (local)')).toBeVisible();
    expect(
      within(panel).getByText(/No reproduce tu timbre: sonará a voz sintética, no a ti/),
    ).toBeVisible();
    expect(within(panel).getByText(/la muestra no sale de este servidor/)).toBeVisible();
  });

  it('says so when an external provider does the cloning and the sample leaves the server', async () => {
    const api = createFakeApi()
      .on('GET', '/api/capabilities', () =>
        makeLibraryCapabilities({ voiceClone: ELEVEN_PROVIDER }),
      )
      .on('GET', '/api/voices', () => ({ items: [] }));
    renderFeatures(features, '/voices/clone', api);
    const panel = await screen.findByRole('region', { name: 'Cómo se clona aquí' });
    expect(await within(panel).findByText('Clonado externo')).toBeVisible();
    expect(within(panel).getByText(/El clonado lo hace ElevenLabs/)).toBeVisible();
    expect(
      within(panel).getByText('La muestra se envía a ese servicio para crear la voz.'),
    ).toBeVisible();
    expect(within(panel).queryByText(/No reproduce tu timbre/)).toBeNull();
  });

  it('names the local voice engine, never "modo básico", when it does the cloning', async () => {
    const chatterbox = {
      id: 'chatterbox',
      name: 'Chatterbox es-ES (local)',
      quality: 'premium' as const,
      local: true,
    };
    const api = createFakeApi()
      .on('GET', '/api/capabilities', () => makeLibraryCapabilities({ voiceClone: chatterbox }))
      .on('GET', '/api/voices', () => ({ items: [] }));
    renderFeatures(features, '/voices/clone', api);
    const panel = await screen.findByRole('region', { name: 'Cómo se clona aquí' });
    expect(await within(panel).findByText('Clonado neuronal local')).toBeVisible();
    expect(
      within(panel).getByText(/El clonado lo hace Chatterbox es-ES \(local\) en este equipo/),
    ).toBeVisible();
    expect(within(panel).getByText(/acento de España/)).toBeVisible();
    expect(within(panel).getByText(/marca de agua inaudible \(Perth\)/)).toBeVisible();
    expect(within(panel).queryByText(/[Mm]odo básico local/)).toBeNull();
    expect(within(panel).queryByText(/La muestra se envía/)).toBeNull();
  });

  it('refuses to upload the sample without the consent declaration', async () => {
    const user = userEvent.setup();
    const uploads = fakeUploads(() => ({ status: 201, body: sampleAsset() }));
    const api = withVoices(createFakeApi());
    renderFeatures(features, '/voices/clone', api);
    await pickSample(user);
    await user.type(screen.getByRole('textbox', { name: /^Nombre\s*\*?$/ }), 'Mi voz');
    await user.click(screen.getByRole('button', { name: 'Clonar voz' }));
    expect(
      await screen.findByText('Tienes que aceptar la declaración para continuar.'),
    ).toBeVisible();
    expect(uploads).toHaveLength(0);
    expect(api.requests('POST', '/api/consents')).toHaveLength(0);
    expect(api.requests('POST', '/api/voice-clones')).toHaveLength(0);
  });

  it('uploads the sample, records the consent, queues the clone and shows the measured profile', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const uploads = fakeUploads(() => {
      order.push('upload');
      return { status: 201, body: sampleAsset() };
    });
    const processing = clonedVoice(3, { status: 'processing', name: 'Mi voz' });
    let polls = 0;
    const api = withVoices(createFakeApi())
      .on('POST', '/api/consents', () => {
        order.push('consent');
        return json(makeConsent('voice_clone'), 201);
      })
      .on('POST', '/api/voice-clones', () => {
        order.push('create');
        return json(processing, 202);
      })
      .on('GET', `/api/voices/${processing.id}`, () => {
        polls += 1;
        return polls < 2 ? processing : clonedVoice(3, { name: 'Mi voz' });
      })
      .on('POST', '/api/tts/synthesize', ({ body }) => makeSpeech((body as { text: string }).text));
    const { router } = renderFeatures(features, '/voices/clone', api);
    await pickSample(user);
    await user.type(screen.getByRole('textbox', { name: /^Nombre\s*\*?$/ }), 'Mi voz');
    expect(
      screen.getByText(/consiento que Parlante la analice para crear una voz sintética/),
    ).toBeVisible();
    await consent(user);
    await user.click(screen.getByRole('button', { name: 'Clonar voz' }));

    await waitFor(() => expect(router.state.location.search).toBe(`?job=${processing.id}`));
    expect(order).toEqual(['upload', 'consent', 'create']);
    expect(uploads[0]?.fields).toEqual({ name: 'mi-voz.wav', purpose: 'voice_sample' });
    expect(api.requests('POST', '/api/consents')[0]?.body).toMatchObject({
      kind: 'voice_clone',
      subjectName: 'Lucía Ferrer',
      accepted: true,
    });
    expect(api.requests('POST', '/api/voice-clones')[0]?.body).toEqual({
      name: 'Mi voz',
      sampleAssetId: 'ast_0002abcdefgh1234',
      consentId: 'cns_a1b2c3d4e5f6g7h8',
      language: 'es',
      gender: 'neutral',
    });

    // The API gives no progress for this job: no percentage is invented.
    expect(await screen.findByText('Analizando la muestra')).toBeVisible();
    expect(screen.getByText(/no informa de porcentaje ni de tiempo restante/)).toBeVisible();

    expect(await screen.findByText('Voz lista', undefined, { timeout: 4000 })).toBeVisible();
    expect(screen.getByText('Clonada en modo básico')).toBeVisible();
    expect(screen.getByText('212 Hz')).toBeVisible();
    expect(screen.getByText('+1,5 st')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Escuchar la voz' }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(api.requests('POST', '/api/tts/synthesize')[0]?.body).toMatchObject({
      voiceId: processing.id,
      language: 'es',
    });
  });

  it('explains a sample the API rejects', async () => {
    const user = userEvent.setup();
    fakeUploads(() => ({ status: 201, body: sampleAsset() }));
    const api = withVoices(createFakeApi())
      .on('POST', '/api/consents', () => json(makeConsent('voice_clone'), 201))
      .on('POST', '/api/voice-clones', () =>
        apiError(
          400,
          'VALIDATION_ERROR',
          'The voice sample must last between 10 seconds and 5 minutes',
        ),
      );
    renderFeatures(features, '/voices/clone', api);
    await pickSample(user);
    await user.type(screen.getByRole('textbox', { name: /^Nombre\s*\*?$/ }), 'Mi voz');
    await consent(user);
    await user.click(screen.getByRole('button', { name: 'Clonar voz' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Hay datos que no son válidos');
    // The sentence of the API is shown in the language of the interface.
    expect(alert).toHaveTextContent('La muestra de voz debe durar entre 10 segundos y 5 minutos.');
  });

  it('respects the plan allowance of cloned voices', async () => {
    const session = makeSession('owner', { currentWorkspaceId: 'ws_z9y8x7w6v5u4t3s2' });
    renderFeatures(features, '/voices/clone', withVoices(createFakeApi(session), [clonedVoice(1)]));
    // Free plan: one cloned voice, already used; and 3 credits do not pay for a clone.
    expect(await screen.findByText('Voces clonadas: 1 de 1 (plan Free)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clonar voz' })).toBeDisabled();
  });

  it('shows why a clone failed and that the credits came back', async () => {
    const failed = clonedVoice(4, { status: 'failed', name: 'Ruido' });
    const api = withVoices(createFakeApi()).on('GET', `/api/voices/${failed.id}`, () => failed);
    renderFeatures(features, `/voices/clone?job=${failed.id}`, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sample too noisy');
    expect(alert).toHaveTextContent('Los créditos se han devuelto.');
  });
});
