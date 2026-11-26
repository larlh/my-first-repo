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
  engineOff,
  engineReady,
  makeAsset,
  makeConsent,
  ownAvatar,
  stockAvatars,
} from '@/features/avatars/kit/testing/fixtures';
import type { Engine } from '@/features/avatars/kit/testing/fixtures';
import { fakeUploads, others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import photoAvatar from './index';

const features = [photoAvatar, avatars, others];
const photo = () =>
  new File([new Uint8Array([0xff, 0xd8, 0xff])], 'lucia-ferrer.jpg', { type: 'image/jpeg' });

function withEngine(
  api: FakeApi,
  engine: Engine,
  own = [] as ReturnType<typeof ownAvatar>[],
): FakeApi {
  return api.on('GET', '/api/avatars', () => ({ items: [...stockAvatars(), ...own], engine }));
}

async function pickPhoto(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { level: 2, name: /Elige la foto/ });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not found');
  await user.upload(input, photo());
  await screen.findByRole('img', { name: 'Foto elegida para el avatar' });
}

describe('create a photorealistic avatar', () => {
  usePageTestSetup();

  it('says the engine is off, why, and what to run — and blocks sending', async () => {
    const api = withEngine(
      createFakeApi(),
      engineOff('The local avatar engine is not reachable at http://127.0.0.1:8090'),
    );
    renderFeatures(features, '/avatars/new', api);
    const panel = await screen.findByRole('region', { name: 'Motor neuronal local' });
    expect(await within(panel).findByText('Apagado')).toBeVisible();
    expect(within(panel).getByText(/not reachable at http:\/\/127\.0\.0\.1:8090/)).toBeVisible();
    expect(within(panel).getByText('pnpm avatar-engine')).toBeVisible();
    expect(within(panel).getByText(/No disponible · necesario aquí/)).toBeVisible();
    expect(screen.getByText('El motor no puede preparar fotos ahora')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crear avatar' })).toBeDisabled();
  });

  it('shows measured speeds and the licence notice of a non-commercial model', async () => {
    const engine = engineReady({
      nonCommercial: true,
      models: [
        {
          id: 'face-animator-nc',
          role: 'animation',
          downloaded: true,
          license: 'CC BY-NC 4.0',
          commercialUse: false,
        },
      ],
    });
    renderFeatures(features, '/avatars/new', withEngine(createFakeApi(), engine));
    const panel = await screen.findByRole('region', { name: 'Motor neuronal local' });
    expect(await within(panel).findByText('En marcha')).toBeVisible();
    expect(within(panel).getByText('≈ 1 min 35 s')).toBeVisible();
    expect(within(panel).getByText('≈ 14 s por segundo de vídeo')).toBeVisible();
    expect(within(panel).getByText('Un vídeo de 10 s ≈ 2 min 22 s de cálculo')).toBeVisible();
    expect(within(panel).getByText('Modelo de uso no comercial cargado')).toBeVisible();
    expect(
      within(panel).getByText(/La licencia de face-animator-nc no permite uso comercial/),
    ).toBeVisible();
  });

  it('refuses to upload anything without the consent declaration', async () => {
    const user = userEvent.setup();
    const uploads = fakeUploads(() => ({ status: 201, body: makeAsset(1) }));
    const api = withEngine(createFakeApi(), engineReady());
    renderFeatures(features, '/avatars/new', api);
    await pickPhoto(user);
    // The avatar name is proposed from the file name.
    expect(screen.getByRole('textbox', { name: /^Nombre\s*\*?$/ })).toHaveValue('Lucia ferrer');

    await user.click(screen.getByRole('button', { name: 'Crear avatar' }));
    expect(await screen.findByText('Escribe el nombre de quien consiente.')).toBeVisible();
    expect(screen.getByText('Tienes que aceptar la declaración para continuar.')).toBeVisible();
    expect(uploads).toHaveLength(0);
    expect(api.requests('POST', '/api/consents')).toHaveLength(0);
    expect(api.requests('POST', '/api/photo-avatars')).toHaveLength(0);
  });

  it('uploads the photo, records the consent, queues the avatar and follows its progress', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const uploads = fakeUploads(() => {
      order.push('upload');
      return { status: 201, body: makeAsset(1) };
    });
    let polls = 0;
    const created = ownAvatar(5, {
      status: 'processing',
      name: 'Lucia ferrer',
      progress: 0,
      etaSec: null,
    });
    const api = withEngine(createFakeApi(), engineReady())
      .on('POST', '/api/consents', () => {
        order.push('consent');
        return json(makeConsent('photo_avatar'), 201);
      })
      .on('POST', '/api/photo-avatars', () => {
        order.push('create');
        return json(created, 202);
      })
      .on('GET', `/api/avatars/${created.id}`, () => {
        polls += 1;
        return polls < 2
          ? { ...created, progress: 35, etaSec: 48 }
          : ownAvatar(5, { name: 'Lucia ferrer' });
      });
    const { router } = renderFeatures(features, '/avatars/new', api);
    await pickPhoto(user);

    expect(
      screen.getByText(/consiento que Parlante la utilice para generar un avatar animado/),
    ).toBeVisible();
    await user.type(
      screen.getByRole('textbox', { name: /Nombre completo de quien consiente/ }),
      'Lucía Ferrer',
    );
    await user.click(screen.getByRole('checkbox', { name: /He leído la declaración y la acepto/ }));
    await user.click(screen.getByRole('button', { name: 'Crear avatar' }));

    await waitFor(() => expect(router.state.location.search).toBe(`?job=${created.id}`));
    expect(order).toEqual(['upload', 'consent', 'create']);
    expect(uploads[0]).toMatchObject({
      url: '/api/assets',
      fields: { name: 'lucia-ferrer.jpg', purpose: 'avatar_source' },
    });
    expect(uploads[0]?.file?.name).toBe('lucia-ferrer.jpg');
    expect(api.requests('POST', '/api/consents')[0]?.body).toEqual({
      kind: 'photo_avatar',
      subjectName: 'Lucía Ferrer',
      relationship: 'self',
      statementVersion: '2026-01',
      locale: 'es',
      accepted: true,
    });
    expect(api.requests('POST', '/api/photo-avatars')[0]?.body).toEqual({
      name: 'Lucia ferrer',
      imageAssetId: 'ast_0001abcdefgh1234',
      consentId: 'cns_a1b2c3d4e5f6g7h8',
      gender: 'neutral',
    });

    // Progress and ETA are the API's figures.
    expect(await screen.findByText(/35 % · quedan 48 s/)).toBeVisible();
    // …and the page keeps polling until the avatar is ready.
    expect(await screen.findByText('Avatar listo', undefined, { timeout: 4000 })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver en la biblioteca' })).toHaveAttribute(
      'href',
      `/avatars?avatar=${created.id}`,
    );
  });

  it('explains a refusal of the API and keeps the uploaded photo for the retry', async () => {
    const user = userEvent.setup();
    const uploads = fakeUploads(() => ({ status: 201, body: makeAsset(1) }));
    let attempts = 0;
    const api = withEngine(createFakeApi(), engineReady())
      .on('POST', '/api/consents', () => json(makeConsent('photo_avatar'), 201))
      .on('POST', '/api/photo-avatars', () => {
        attempts += 1;
        return attempts === 1
          ? apiError(503, 'SERVICE_UNAVAILABLE', 'The avatar engine is busy downloading weights')
          : json(ownAvatar(6, { status: 'processing' }), 202);
      })
      .on('GET', /^\/api\/avatars\/avt_/, () => ownAvatar(6, { status: 'processing' }));
    const { router } = renderFeatures(features, '/avatars/new', api);
    await pickPhoto(user);
    await user.type(
      screen.getByRole('textbox', { name: /Nombre completo de quien consiente/ }),
      'Lucía Ferrer',
    );
    await user.click(screen.getByRole('checkbox', { name: /He leído la declaración/ }));
    await user.click(screen.getByRole('button', { name: 'Crear avatar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El motor local no puede hacerlo ahora');
    // The engine's own reason is passed through.
    expect(alert).toHaveTextContent('The avatar engine is busy downloading weights');

    await user.click(screen.getByRole('button', { name: 'Crear avatar' }));
    await waitFor(() => expect(router.state.location.search).toMatch(/^\?job=avt_/));
    // One upload and one consent record serve both attempts.
    expect(uploads).toHaveLength(1);
    expect(api.requests('POST', '/api/consents')).toHaveLength(1);
  });

  it('generates a synthetic person from a description, with an optional seed', async () => {
    const user = userEvent.setup();
    const created = ownAvatar(8, { kind: 'generated', status: 'processing', name: 'Marta' });
    const api = withEngine(createFakeApi(), engineReady())
      .on('POST', '/api/photo-avatars/generate', () => json(created, 202))
      .on('GET', `/api/avatars/${created.id}`, () => created);
    const { router } = renderFeatures(features, '/avatars/new?mode=generate', api);
    await screen.findByRole('heading', { level: 2, name: /Describe a la persona/ });
    // No consent form in this mode: nobody real is depicted.
    expect(screen.queryByText('Declaración de consentimiento')).toBeNull();
    expect(
      await screen.findByText(/Generar un retrato tarda unos 1 min 35 s en este equipo/),
    ).toBeVisible();

    const submit = screen.getByRole('button', { name: 'Generar avatar' });
    await user.type(screen.getByRole('textbox', { name: /Descripción/ }), 'mujer');
    await user.type(screen.getByRole('textbox', { name: /^Nombre\s*\*?$/ }), 'Marta');
    await user.type(screen.getByRole('textbox', { name: /Semilla/ }), 'abc');
    await user.click(submit);
    expect(await screen.findByText(/La descripción es demasiado corta/)).toBeVisible();
    expect(screen.getByText(/La semilla es un número entero/)).toBeVisible();
    expect(api.requests('POST', '/api/photo-avatars/generate')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Presentadora' }));
    await user.clear(screen.getByRole('textbox', { name: /Semilla/ }));
    await user.type(screen.getByRole('textbox', { name: /Semilla/ }), '42');
    await user.click(submit);
    await waitFor(() =>
      expect(router.state.location.search).toBe(`?mode=generate&job=${created.id}`),
    );
    expect(api.requests('POST', '/api/photo-avatars/generate')[0]?.body).toEqual({
      name: 'Marta',
      prompt:
        'Mujer de unos 35 años, melena castaña por los hombros, chaqueta azul marino, sonrisa suave, fondo gris neutro de estudio',
      gender: 'neutral',
      seed: 42,
    });
    expect(await screen.findByText('Generando y preparando el retrato')).toBeVisible();
  });

  it('shows the stored reason when the job fails and that credits were refunded', async () => {
    const failed = ownAvatar(4, { status: 'failed', name: 'Foto borrosa' });
    const api = withEngine(createFakeApi(), engineReady()).on(
      'GET',
      `/api/avatars/${failed.id}`,
      () => failed,
    );
    renderFeatures(features, `/avatars/new?job=${failed.id}`, api);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No face was found');
    expect(alert).toHaveTextContent('Los créditos se han devuelto.');
    expect(screen.getByRole('button', { name: 'Intentar de nuevo' })).toBeVisible();
  });

  it('explains in Spanish why the engine is off, from its stable reason code', async () => {
    const off = {
      ...engineOff('connect ECONNREFUSED 127.0.0.1:8090'),
      reasonCode: 'engine_unreachable' as const,
    };
    renderFeatures(features, '/avatars/new', withEngine(createFakeApi(), off));
    const panel = await screen.findByRole('region', { name: 'Motor neuronal local' });
    expect(
      await within(panel).findByText(/no hay nada escuchando en la dirección del motor/),
    ).toBeVisible();
    // The engine's own sentence stays as the technical detail.
    expect(within(panel).getByText(/ECONNREFUSED 127\.0\.0\.1:8090/)).toBeVisible();
  });

  it('translates the stored cause of a failed job without repeating it in English', async () => {
    const noFace = ownAvatar(5, {
      status: 'failed',
      name: 'Paisaje',
      error: {
        code: 'UNPROCESSABLE',
        message: 'No face was found in the image.',
        reason: 'no_face',
      },
    });
    const api = withEngine(createFakeApi(), engineReady(), [noFace]).on(
      'GET',
      `/api/avatars/${noFace.id}`,
      () => noFace,
    );
    renderFeatures(features, `/avatars/new?job=${noFace.id}`, api);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/No se detecta ninguna cara en la foto/)).toBeVisible();
    // The cause is explained in the language of the interface; the worker's English sentence
    // says the same and is not shown next to it in a Spanish screen.
    expect(within(alert).queryByText(/No face was found/)).not.toBeInTheDocument();
  });

  it('says next to a ready avatar that its portrait did not pass quality control, issue by issue', async () => {
    const flawed = ownAvatar(6, {
      kind: 'generated',
      name: 'Retrato torcido',
      quality: { passed: false, issues: ['head_tilted', 'brand_new_code'], attempts: 3 },
    });
    const api = withEngine(createFakeApi(), engineReady(), [flawed]).on(
      'GET',
      `/api/avatars/${flawed.id}`,
      () => flawed,
    );
    renderFeatures(features, `/avatars/new?job=${flawed.id}`, api);
    expect(await screen.findByText('El retrato no pasó el control de calidad')).toBeVisible();
    expect(screen.getByText(/El motor lo intentó 3 veces/)).toBeVisible();
    expect(screen.getByText('La cabeza está inclinada.')).toBeVisible();
    // A code this build does not know is shown as it comes, never hidden.
    expect(screen.getByText('brand_new_code')).toBeVisible();
    expect(screen.getByText('Avatar listo')).toBeVisible();
  });

  it('respects the plan allowance and is closed to viewers', async () => {
    const full = withEngine(
      createFakeApi(
        makeSession('owner', {
          currentWorkspaceId: 'ws_z9y8x7w6v5u4t3s2',
        }),
      ),
      engineReady(),
      [ownAvatar(1)],
    );
    renderFeatures(features, '/avatars/new', full);
    // The free plan allows one own avatar and this workspace already has it.
    expect(await screen.findByText('Avatares propios: 1 de 1 (plan Free)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crear avatar' })).toBeDisabled();
  });
});
