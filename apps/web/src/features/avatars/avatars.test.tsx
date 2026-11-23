import { CompositionSchema, collectAvatarIds } from '@parlante/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  createFakeApi,
  makeSession,
  makeVideo,
  renderFeatures,
} from '@/features/videos/testing/harness';
import photoAvatar from '@/features/photo-avatar';
import avatars from './index';
import {
  engineOff,
  engineReady,
  makeSpeech,
  ownAvatar,
  photorealStock,
  stockAvatars,
} from './kit/testing/fixtures';
import { others, usePageTestSetup } from './kit/testing/page';

function catalogue(engine = engineOff()) {
  return {
    items: [
      ...stockAvatars(),
      photorealStock('lucia', 'Lucía Real'),
      ownAvatar(1, { status: 'processing', name: 'Mi doble' }),
    ],
    engine,
  };
}

describe('avatar library', () => {
  const { play } = usePageTestSetup();

  it('shows the three shelves, labels how each avatar is animated and the engine state', async () => {
    const api = createFakeApi().on('GET', '/api/avatars', () => catalogue());
    renderFeatures([avatars, photoAvatar, others], '/avatars', api);

    expect(await screen.findByRole('heading', { level: 2, name: 'Tus avatares' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Instantáneos 2D' })).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Fotorrealistas de stock' }),
    ).toBeVisible();

    // Stock: at least 8 diverse instant avatars, each with a live canvas preview.
    const instant = screen.getByRole('region', { name: 'Instantáneos 2D' });
    expect(within(instant).getAllByRole('listitem').length).toBeGreaterThanOrEqual(8);
    expect(
      within(instant).getByRole('img', { name: 'Vista previa animada de Mateo' }),
    ).toBeInTheDocument();

    // An avatar being prepared shows the progress and ETA the API reports.
    const mine = screen.getByRole('region', { name: 'Tus avatares' });
    expect(within(mine).getByText(/40 %/)).toHaveTextContent('40 % · quedan 1 min 15 s');

    // The engine is off: said in words, never hidden.
    expect(
      screen.getByText(/apagado — los fotorrealistas no se pueden crear ni exportar/),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Crear avatar fotorrealista' })).toHaveAttribute(
      'href',
      '/avatars/new',
    );
  });

  it('filters by shelf and by search, and keeps the filters in the URL', async () => {
    const user = userEvent.setup();
    const api = createFakeApi().on('GET', '/api/avatars', () => catalogue());
    const { router } = renderFeatures([avatars, others], '/avatars', api);
    await screen.findByRole('heading', { level: 2, name: 'Instantáneos 2D' });

    await user.click(screen.getByRole('tab', { name: /Fotorrealistas/ }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Instantáneos 2D' })).toBeNull();
    expect(router.state.location.search).toBe('?view=photoreal');

    await user.click(screen.getByRole('tab', { name: /Todos/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar avatares' }), 'mateo');
    await waitFor(() => expect(router.state.location.search).toBe('?q=mateo'));
    const cards = screen.getAllByRole('button', { name: /Abrir la ficha de/ });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAccessibleName('Abrir la ficha de Mateo');

    await user.clear(screen.getByRole('searchbox', { name: 'Buscar avatares' }));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar avatares' }), 'zzzz');
    expect(await screen.findByText('Ningún avatar coincide')).toBeVisible();
    await user.click(screen.getAllByRole('button', { name: 'Quitar filtros' })[0]!);
    expect(await screen.findByRole('heading', { level: 2, name: 'Instantáneos 2D' })).toBeVisible();
  });

  it('opens the card of an avatar, lets it introduce itself and names the TTS provider', async () => {
    const user = userEvent.setup();
    const api = createFakeApi()
      .on('GET', '/api/avatars', () => catalogue())
      .on('POST', '/api/tts/synthesize', ({ body }) => makeSpeech((body as { text: string }).text));
    renderFeatures([avatars, others], '/avatars?avatar=stock_mateo', api);

    const dialog = await screen.findByRole('dialog', { name: 'Mateo' });
    expect(
      within(dialog).getByText(/Avatar instantáneo: un personaje 2D paramétrico/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Escuchar presentación' }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(api.requests('POST', '/api/tts/synthesize')[0]?.body).toMatchObject({
      text: 'Hola, soy Mateo. Puedo presentar tu próximo vídeo.',
      voiceId: 'espeak:es-m1',
      language: 'es',
    });
    // Honesty rule: the audio is labelled with the provider that produced it.
    expect(await within(dialog).findByText('Modo básico · eSpeak NG (local)')).toBeVisible();
  });

  it('creates a draft with the avatar and opens it in the Studio', async () => {
    const user = userEvent.setup();
    const api = createFakeApi()
      .on('GET', '/api/avatars', () => catalogue())
      .on('POST', '/api/videos', () => makeVideo(7, { status: 'draft' }));
    const { router } = renderFeatures([avatars, others], '/avatars?avatar=stock_mateo', api);

    const dialog = await screen.findByRole('dialog', { name: 'Mateo' });
    await user.click(within(dialog).getByRole('button', { name: 'Usar en un vídeo' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/studio\/vid_/));
    const body = api.requests('POST', '/api/videos')[0]?.body as {
      title: string;
      composition: unknown;
    };
    expect(body.title).toBe('Vídeo con Mateo');
    const composition = CompositionSchema.parse(body.composition);
    expect(collectAvatarIds(composition)).toEqual(['stock_mateo']);
  });

  it('explains what a photorealistic avatar costs to render with the measured speed', async () => {
    const api = createFakeApi().on('GET', '/api/avatars', () => catalogue(engineReady()));
    renderFeatures([avatars, others], '/avatars?avatar=real_lucia', api);
    const dialog = await screen.findByRole('dialog', { name: 'Lucía Real' });
    expect(
      within(dialog).getByText(/Persona sintética: este rostro no pertenece a nadie/),
    ).toBeVisible();
    // 14.2 s per video second (fixture) × 10 s = 142 s.
    expect(
      within(dialog).getByText(/Animar 10 s de vídeo con este avatar tarda unos 2 min 22 s/),
    ).toBeVisible();
    expect(within(dialog).getByText(/cuestan 2× créditos/)).toBeVisible();
    expect(within(dialog).getByText(/Vista previa aproximada/)).toBeVisible();
  });

  it('does not let a viewer create avatars or start videos', async () => {
    const api = createFakeApi(makeSession('viewer')).on('GET', '/api/avatars', () => catalogue());
    renderFeatures([avatars, photoAvatar, others], '/avatars?avatar=stock_mateo', api);
    const dialog = await screen.findByRole('dialog', { name: 'Mateo' });
    expect(within(dialog).getByRole('button', { name: 'Usar en un vídeo' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: 'Crear avatar fotorrealista' })).toBeNull();
  });
});
