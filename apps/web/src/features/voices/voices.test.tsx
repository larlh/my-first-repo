import { CompositionSchema } from '@parlante/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  apiError,
  createFakeApi,
  makeVideo,
  renderFeatures,
} from '@/features/videos/testing/harness';
import avatars from '@/features/avatars';
import {
  ELEVEN_PROVIDER,
  clonedVoice,
  makeSpeech,
  stockVoice,
} from '@/features/avatars/kit/testing/fixtures';
import { others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import voices from './index';

const list = () => ({
  items: [
    stockVoice('es-f1', 'Carmen'),
    stockVoice('es-m1', 'Diego'),
    stockVoice('fr-f1', 'Camille'),
    stockVoice('en-f1', 'Rachel', {
      id: 'elevenlabs:rachel',
      provider: ELEVEN_PROVIDER,
      language: 'en-US',
      multilingual: true,
    }),
    clonedVoice(1, { name: 'Mi voz' }),
  ],
});

describe('voice library', () => {
  const { play } = usePageTestSetup();

  it('groups voices by language with the cloned ones first and labels each provider', async () => {
    const api = createFakeApi().on('GET', '/api/voices', list);
    renderFeatures([voices, avatars, others], '/voices', api);
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(['Tus voces clonadas', 'Español', 'Français', 'Multilingües']);
    const spanish = screen.getByRole('region', { name: 'Español' });
    expect(within(spanish).getAllByRole('listitem')).toHaveLength(2);
    expect(within(spanish).getAllByText('Modo básico')).toHaveLength(2);
    const multi = screen.getByRole('region', { name: 'Multilingües' });
    expect(within(multi).getByText('Alta calidad')).toBeInTheDocument();
  });

  it('filters by language (multilingual voices stay) and by kind', async () => {
    const user = userEvent.setup();
    const api = createFakeApi().on('GET', '/api/voices', list);
    const { router } = renderFeatures([voices, avatars, others], '/voices?lang=fr', api);
    await screen.findByRole('heading', { level: 2, name: 'Français' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Español' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Multilingües' })).toBeVisible();

    await user.click(screen.getByRole('tab', { name: /Clonadas/ }));
    expect(router.state.location.search).toBe('?lang=fr&kind=cloned');
    expect(await screen.findByText('Ninguna voz coincide')).toBeVisible();
  });

  it('previews a voice with its sample sentence and says who made the audio', async () => {
    const user = userEvent.setup();
    const api = createFakeApi()
      .on('GET', '/api/voices', list)
      .on('POST', '/api/tts/synthesize', ({ body }) => makeSpeech((body as { text: string }).text));
    renderFeatures([voices, avatars, others], '/voices', api);

    await user.click(await screen.findByRole('button', { name: 'Escuchar a Camille' }));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(api.requests('POST', '/api/tts/synthesize')[0]?.body).toEqual({
      text: 'Bonjour, je suis l’une des voix de Parlante. Voici comment sonnera votre vidéo.',
      voiceId: 'espeak:fr-f1',
      language: 'fr',
      speed: 1,
      pitch: 0,
    });
    // The row turns into a stop button while it sounds.
    expect(screen.getByRole('button', { name: 'Parar a Camille' })).toBeVisible();
  });

  it('opens the listening desk: own text, provider of the voice and of the audio, basic mode note', async () => {
    const user = userEvent.setup();
    const api = createFakeApi()
      .on('GET', '/api/voices', list)
      .on('POST', '/api/tts/synthesize', ({ body }) => makeSpeech((body as { text: string }).text));
    renderFeatures([voices, avatars, others], '/voices', api);

    // jsdom reports a narrow screen: choosing a voice opens the desk as a sheet.
    await user.click(await screen.findByRole('button', { name: /^Carmen/, pressed: false }));
    const desk = await screen.findByRole('region', { name: 'Preescucha de Carmen' });
    expect(within(desk).getByText(/Modo básico: voz sintética local/)).toBeVisible();

    const text = within(desk).getByRole('textbox', { name: /Texto de prueba/ });
    await user.clear(text);
    await user.type(text, 'Probando mi propio guion.');
    await user.click(
      within(desk).getByRole('button', { name: 'Escuchar a Carmen con este texto' }),
    );
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(api.requests('POST', '/api/tts/synthesize')[0]?.body).toMatchObject({
      text: 'Probando mi propio guion.',
      voiceId: 'espeak:es-f1',
    });
    expect(await within(desk).findByText('Este audio lo generó')).toBeVisible();
    expect(within(desk).getAllByText('Modo básico · eSpeak NG (local)')).toHaveLength(2);
  });

  it('shows a synthesis failure instead of failing silently', async () => {
    const user = userEvent.setup();
    const api = createFakeApi()
      .on('GET', '/api/voices', list)
      .on('POST', '/api/tts/synthesize', () =>
        apiError(422, 'CONTENT_BLOCKED', 'The text was blocked by moderation'),
      );
    renderFeatures([voices, avatars, others], '/voices?voice=espeak:es-m1', api);
    await user.click(await screen.findByRole('button', { name: /^Diego/ }));
    const desk = await screen.findByRole('region', { name: 'Preescucha de Diego' });
    await user.click(within(desk).getByRole('button', { name: 'Escuchar a Diego con este texto' }));
    expect(await within(desk).findByRole('alert')).toHaveTextContent(/moderation/);
    expect(play).not.toHaveBeenCalled();
  });

  it('tells the truth about a voice cloned in basic mode and starts a video with it', async () => {
    const user = userEvent.setup();
    const api = createFakeApi()
      .on('GET', '/api/voices', list)
      .on('POST', '/api/videos', () => makeVideo(9, { status: 'draft' }));
    const { router } = renderFeatures([voices, avatars, others], '/voices', api);
    await user.click(await screen.findByRole('button', { name: /^Mi voz/ }));
    const desk = await screen.findByRole('region', { name: 'Preescucha de Mi voz' });
    expect(within(desk).getByText(/No reproduce tu timbre/)).toBeVisible();
    expect(within(desk).getByText('212 Hz')).toBeVisible();

    await user.click(within(desk).getByRole('button', { name: 'Usar en un vídeo' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/studio\/vid_/));
    const body = api.requests('POST', '/api/videos')[0]?.body as { composition: unknown };
    const script = CompositionSchema.parse(body.composition).scenes[0]?.script;
    expect(script).toMatchObject({ kind: 'tts', voiceId: 'vcl_0001abcdefgh1234', language: 'es' });
  });
});
