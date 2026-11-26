import { CompositionSchema } from '@parlante/shared';
import type { Video } from '@parlante/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { defineFeature } from '@/shell';
import { toast } from '@/ui';
import videos from './index';
import {
  apiError,
  createFakeApi,
  json,
  makeBilling,
  makeSession,
  makeShare,
  makeVideo,
  renderFeatures,
  resetApiClient,
  toSummary,
  videoId,
  watchContractWarnings,
} from './testing/harness';
import type { FakeApi } from './testing/harness';

/** Stand-ins for sections owned by other features, so optional links are offered. */
const others = defineFeature({
  id: 'others',
  routes: [
    { path: '/studio/:videoId', layout: 'fullscreen', component: () => <h1>Studio</h1> },
    { path: '/settings/billing', layout: 'app', component: () => <h1>Facturación</h1> },
  ],
});

let contract: ReturnType<typeof watchContractWarnings>;
beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('es');
  contract = watchContractWarnings();
});
afterEach(() => {
  contract.assert();
  contract.restore();
  resetApiClient();
  toast.clear();
});

/** Fake `/api/videos*` backed by an in-memory list (search, status filter, cursor pages). */
function withVideos(api: FakeApi, initial: Video[]): { list: Video[] } {
  const store = { list: [...initial] };
  api.on('GET', '/api/videos', ({ url }) => {
    const q = url.searchParams.get('q')?.toLowerCase();
    const status = url.searchParams.get('status');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const matching = store.list.filter(
      (video) =>
        (!q || video.title.toLowerCase().includes(q)) && (!status || video.status === status),
    );
    return {
      items: matching.slice(start, start + limit).map(toSummary),
      nextCursor: start + limit < matching.length ? String(start + limit) : null,
    };
  });
  api.on('GET', /^\/api\/videos\/(vid_[a-z0-9]+)$/, ({ match }) => {
    const video = store.list.find((item) => item.id === match[1]);
    return video ?? apiError(404, 'NOT_FOUND', 'Video not found');
  });
  api.on('GET', /^\/api\/videos\/(vid_[a-z0-9]+)\/render-jobs$/, () => ({ items: [] }));
  api.on('GET', /^\/api\/videos\/(vid_[a-z0-9]+)\/share$/, () => ({ share: null }));
  api.on('GET', '/api/billing', () => makeBilling());
  return store;
}

const library = () => [
  makeVideo(1, { title: 'Bienvenida al equipo' }),
  makeVideo(2, {
    title: 'Anuncio de otoño',
    status: 'rendering',
    progress: 37,
    renderStage: 'frames',
    renderEtaSec: 48,
  }),
  makeVideo(3, { title: 'Novedades de noviembre', status: 'draft' }),
  makeVideo(4, {
    title: 'Saludo navideño',
    status: 'failed',
    error: { code: 'CONTENT_BLOCKED', message: 'Script blocked' },
  }),
];

describe('video list', () => {
  it('shows every video with its status, duration and live render progress', async () => {
    const api = createFakeApi();
    withVideos(api, library());
    renderFeatures([videos, others], '/videos', api);

    const done = (await screen.findByRole('link', { name: 'Bienvenida al equipo' })).closest(
      'article',
    );
    if (!done) throw new Error('card not found');
    expect(within(done).getByText('Listo')).toBeInTheDocument();
    expect(within(done).getByText('0:42')).toBeInTheDocument();

    const rendering = screen.getByRole('link', { name: 'Anuncio de otoño' }).closest('article');
    if (!rendering) throw new Error('card not found');
    expect(within(rendering).getByText('Renderizando')).toBeInTheDocument();
    expect(within(rendering).getByText('Dibujando los fotogramas')).toBeInTheDocument();
    const bar = within(rendering).getByRole('progressbar', {
      name: 'Render de «Anuncio de otoño»',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '37');
    expect(within(rendering).getByText(/quedan 48 s/)).toBeInTheDocument();

    const failed = screen.getByRole('link', { name: 'Saludo navideño' }).closest('article');
    if (!failed) throw new Error('card not found');
    expect(
      within(failed).getByText('El contenido no cumple las normas de uso'),
    ).toBeInTheDocument();
  });

  it('keeps polling while something is rendering and shows the result when it settles', async () => {
    const api = createFakeApi();
    const store = withVideos(api, library());
    renderFeatures([videos, others], '/videos', api);
    await screen.findByText('Dibujando los fotogramas');

    store.list[1] = makeVideo(2, { title: 'Anuncio de otoño' });
    await waitFor(
      () => expect(screen.queryByText('Dibujando los fotogramas')).not.toBeInTheDocument(),
      { timeout: 6000 },
    );
    const card = screen.getByRole('link', { name: 'Anuncio de otoño' }).closest('article');
    expect(within(card as HTMLElement).getByText('Listo')).toBeInTheDocument();
    // The session is re-read once the render settles (credits were settled).
    await waitFor(() =>
      expect(api.calls.filter((call) => call === 'GET /api/auth/me').length).toBeGreaterThan(1),
    );
  }, 12_000);

  it('filters by status and by title through the URL', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    withVideos(api, library());
    const { router } = renderFeatures([videos, others], '/videos', api);
    await screen.findByRole('link', { name: 'Bienvenida al equipo' });

    await user.click(screen.getByRole('button', { name: 'Borradores' }));
    expect(await screen.findByRole('link', { name: 'Novedades de noviembre' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bienvenida al equipo' })).not.toBeInTheDocument();
    expect(router.state.location.search).toBe('?status=draft');
    expect(screen.getByRole('button', { name: 'Borradores' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(api.calls).toContain('GET /api/videos?limit=12&status=draft');

    await user.click(screen.getByRole('button', { name: 'Todos' }));
    await user.type(screen.getByRole('searchbox', { name: 'Buscar vídeos por título' }), 'otoño');
    await waitFor(() => expect(router.state.location.search).toBe('?q=oto%C3%B1o'));
    await waitFor(() => expect(api.calls).toContain('GET /api/videos?limit=12&q=oto%C3%B1o'));
    expect(await screen.findByRole('link', { name: 'Anuncio de otoño' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Bienvenida al equipo' })).not.toBeInTheDocument();
    // Debounced: one request for the whole word, not one per keystroke.
    expect(api.calls.filter((call) => call.includes('q=o')).length).toBe(1);
  });

  it('explains an empty result and offers to clear the filters', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    withVideos(api, library());
    const { router } = renderFeatures([videos, others], '/videos?q=zzz&status=completed', api);
    expect(await screen.findByText('Ningún vídeo coincide')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('zzz');
    await user.click(screen.getByRole('button', { name: 'Quitar filtros' }));
    expect(await screen.findByRole('link', { name: 'Bienvenida al equipo' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
  });

  it('guides an empty workspace to its first video', async () => {
    const api = createFakeApi();
    withVideos(api, []);
    renderFeatures([videos, others], '/videos', api);
    expect(await screen.findByText('La cabina está vacía')).toBeInTheDocument();
    const create = screen.getAllByRole('link', { name: 'Crear vídeo' });
    expect(create.some((link) => link.getAttribute('href') === '/videos/new')).toBe(true);
  });

  it('pages with the cursor of the API', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    withVideos(
      api,
      Array.from({ length: 15 }, (_, index) =>
        makeVideo(index + 1, { title: `Capítulo ${index + 1}` }),
      ),
    );
    renderFeatures([videos, others], '/videos', api);
    await screen.findByRole('link', { name: 'Capítulo 12' });
    expect(screen.queryByRole('link', { name: 'Capítulo 13' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cargar más vídeos' }));
    expect(await screen.findByRole('link', { name: 'Capítulo 15' })).toBeInTheDocument();
    expect(api.calls).toContain('GET /api/videos?limit=12&cursor=12');
    expect(screen.queryByRole('button', { name: 'Cargar más vídeos' })).not.toBeInTheDocument();
  });

  it('shows the error with a retry that works', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    let fail = true;
    const store = withVideos(api, library());
    api.on('GET', '/api/videos', () =>
      fail
        ? apiError(503, 'SERVICE_UNAVAILABLE', 'down')
        : { items: store.list.map(toSummary), nextCursor: null },
    );
    renderFeatures([videos, others], '/videos', api);
    expect(
      await screen.findByText('El servicio no está disponible en este momento'),
    ).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('link', { name: 'Bienvenida al equipo' })).toBeInTheDocument();
  });

  it('renames a video from the card menu', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const store = withVideos(api, library());
    api.on('PATCH', /^\/api\/videos\/(vid_[a-z0-9]+)$/, ({ match, body }) => {
      const index = store.list.findIndex((video) => video.id === match[1]);
      const next = makeVideo(1, { ...store.list[index], ...(body as { title: string }) });
      store.list[index] = next;
      return next;
    });
    renderFeatures([videos, others], '/videos', api);

    await user.click(
      await screen.findByRole('button', { name: 'Acciones de «Bienvenida al equipo»' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Renombrar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renombrar vídeo' });
    const input = within(dialog).getByRole('textbox', { name: /Título/ });
    expect(input).toHaveValue('Bienvenida al equipo');

    await user.clear(input);
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(await within(dialog).findByText('Escribe un título.')).toBeInTheDocument();

    await user.type(input, 'Bienvenida 2027');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByRole('link', { name: 'Bienvenida 2027' })).toBeInTheDocument();
    expect(api.requests('PATCH', /^\/api\/videos\//)[0]?.body).toEqual({
      title: 'Bienvenida 2027',
    });
  });

  it('asks before deleting, and deletes only when confirmed', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const store = withVideos(api, library());
    api.on('DELETE', /^\/api\/videos\/(vid_[a-z0-9]+)$/, ({ match }) => {
      store.list = store.list.filter((video) => video.id !== match[1]);
      return { ok: true };
    });
    renderFeatures([videos, others], '/videos', api);

    await user.click(
      await screen.findByRole('button', { name: 'Acciones de «Novedades de noviembre»' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Eliminar' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('¿Eliminar «Novedades de noviembre»?');
    expect(dialog).toHaveTextContent('No se puede deshacer');
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.requests('DELETE', /^\/api\/videos\//)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Acciones de «Novedades de noviembre»' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Eliminar' }));
    dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar vídeo' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('link', { name: 'Novedades de noviembre' }),
      ).not.toBeInTheDocument(),
    );
    expect(api.requests('DELETE', /^\/api\/videos\//)).toHaveLength(1);
  });

  it('duplicates a video and offers the copy', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const store = withVideos(api, library());
    api.on('POST', /^\/api\/videos\/(vid_[a-z0-9]+)\/duplicate$/, () => {
      const copy = makeVideo(50, { title: 'Bienvenida al equipo (copia)', status: 'draft' });
      store.list.unshift(copy);
      return json(copy, 201);
    });
    renderFeatures([videos, others], '/videos', api);
    await user.click(
      await screen.findByRole('button', { name: 'Acciones de «Bienvenida al equipo»' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicar' }));
    expect(
      await screen.findByRole('link', { name: 'Bienvenida al equipo (copia)' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Copia creada: «Bienvenida al equipo (copia)»'),
    ).toBeInTheDocument();
  });

  it('is read-only for viewers', async () => {
    const api = createFakeApi(makeSession('viewer'));
    withVideos(api, library());
    renderFeatures([videos, others], '/videos', api);
    await screen.findByRole('link', { name: 'Bienvenida al equipo' });
    expect(screen.queryByRole('button', { name: /Acciones de/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Crear vídeo' })).not.toBeInTheDocument();
  });
});

describe('new video', () => {
  it('creates a blank draft in the chosen format and opens the Studio', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    withVideos(api, []);
    api.on('POST', '/api/videos', () =>
      json(makeVideo(9, { status: 'draft', aspect: '9:16' }), 201),
    );
    const { router } = renderFeatures([videos, others], '/videos/new', api);

    await user.click(await screen.findByRole('radio', { name: /Vertical/ }));
    await user.type(screen.getByRole('textbox', { name: /Título/ }), 'Reel de otoño');
    await user.click(screen.getByRole('button', { name: 'Crear y abrir el Studio' }));

    expect(await screen.findByRole('heading', { name: 'Studio' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/studio/${videoId(9)}`);
    // "From scratch" is not an empty black scene: the draft starts with a presenter, a voice in
    // the language of the interface and an example line, in the chosen format.
    const body = api.requests('POST', '/api/videos')[0]?.body as {
      aspect: string;
      title: string;
      composition: unknown;
    };
    expect(body.aspect).toBe('9:16');
    expect(body.title).toBe('Reel de otoño');
    const composition = CompositionSchema.parse(body.composition);
    expect(composition.canvas.aspect).toBe('9:16');
    expect(composition.scenes).toHaveLength(1);
    const scene = composition.scenes[0];
    expect(scene?.script).toMatchObject({
      kind: 'tts',
      language: 'es',
      voiceId: 'espeak:es-f1',
      text: 'Hola, soy Lucía. Escribe aquí tu guion y yo lo cuento en tu vídeo.',
    });
    expect(scene?.layers.map((layer) => layer.type)).toEqual(['avatar']);
    expect(scene?.layers[0]).toMatchObject({ avatarId: 'stock_lucia' });
    expect(composition.subtitles.enabled).toBe(true);
  });

  it('starts the blank draft with the voice the server recommends when there is one', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    withVideos(api, []);
    const voice = (id: string, gender: 'female' | 'male', extra: Record<string, unknown>) => ({
      id,
      kind: 'stock',
      name: id,
      provider: { id: id.split(':')[0], name: id, quality: 'premium', local: true },
      language: 'es',
      multilingual: false,
      gender,
      description: '',
      tags: [],
      status: 'ready',
      workspaceId: null,
      consentId: null,
      profile: null,
      error: null,
      createdAt: null,
      ...extra,
    });
    api.on('GET', '/api/voices', () =>
      json({
        items: [
          voice('kokoro:ef_dora', 'female', { isDefault: true }),
          voice('kokoro:em_alex', 'male', { isDefault: true }),
          voice('espeak:es-f1', 'female', {}),
        ],
      }),
    );
    api.on('POST', '/api/videos', () => json(makeVideo(9, { status: 'draft' }), 201));
    renderFeatures([videos, others], '/videos/new', api);

    await screen.findByRole('button', { name: 'Crear y abrir el Studio' });
    await waitFor(() => expect(api.requests('GET', '/api/voices')).not.toHaveLength(0));
    await user.type(screen.getByRole('textbox', { name: /Título/ }), 'Con voz neuronal');
    await user.click(screen.getByRole('button', { name: 'Crear y abrir el Studio' }));
    await waitFor(() => expect(api.requests('POST', '/api/videos')).toHaveLength(1));
    const body = api.requests('POST', '/api/videos')[0]?.body as { composition: unknown };
    expect(CompositionSchema.parse(body.composition).scenes[0]?.script).toMatchObject({
      kind: 'tts',
      language: 'es',
      voiceId: 'kokoro:ef_dora',
    });
  });

  it('is not offered to viewers', async () => {
    const api = createFakeApi(makeSession('viewer'));
    withVideos(api, []);
    renderFeatures([videos, others], '/videos/new', api);
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
  });
});

describe('video detail', () => {
  it('shows the player, downloads, provenance and details of a finished video', async () => {
    const api = createFakeApi();
    const video = makeVideo(1, { title: 'Bienvenida al equipo' });
    withVideos(api, [video]);
    renderFeatures([videos, others], `/videos/${video.id}`, api);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bienvenida al equipo' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Reproductor de vídeo: Bienvenida al equipo' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Bienvenida al equipo · Parlante'));

    // Downloads: the MP4 uses the attachment URL of the API (never the playback URL).
    const mp4 = screen.getByRole('link', { name: 'Descargar el vídeo en MP4' });
    expect(mp4.getAttribute('href')).toContain('download=video.mp4');
    expect(
      screen.getByRole('button', { name: 'Descargar los subtítulos en SRT' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Descargar los subtítulos en VTT' }),
    ).toBeInTheDocument();

    // The subtitles of the render are shown as a transcript.
    const transcript = await screen.findByRole('list', { name: 'Subtítulos' });
    expect(within(transcript).getByText('Hola, soy Marta.')).toBeInTheDocument();
    expect(within(transcript).getByText('Te doy la bienvenida al equipo.')).toBeInTheDocument();
    expect(within(transcript).getByText('0:01')).toBeInTheDocument();

    // Each line is a button that jumps the player to its instant and plays from there.
    const media = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(media, 'duration', { configurable: true, value: 6 });
    Object.defineProperty(media, 'readyState', { configurable: true, value: 4 });
    fireEvent.loadedMetadata(media);
    const play = vi.spyOn(media, 'play').mockResolvedValue();
    const second = within(transcript).getByRole('button', { name: /Te doy la bienvenida/ });
    await userEvent.setup().click(second);
    expect(media.currentTime).toBeGreaterThan(0);
    expect(play).toHaveBeenCalled();
    await waitFor(() => expect(second.closest('li')).toHaveAttribute('aria-current', 'true'));

    // Provenance: which provider produced each part, and the honest "basic mode" note.
    expect(screen.getByText('Modo básico · eSpeak NG')).toBeInTheDocument();
    expect(screen.getByText('Modo básico · Avatar 2D')).toBeInTheDocument();
    expect(screen.getByText(/se ha generado en modo básico/)).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Editar en el Studio' })).toHaveAttribute(
      'href',
      `/studio/${video.id}`,
    );
  });

  it('says how the lips of a photorealistic avatar were driven', async () => {
    const api = createFakeApi();
    const engine = {
      id: 'local-neural',
      name: 'Motor neuronal local',
      quality: 'premium' as const,
      local: true,
    };
    const voice = {
      id: 'kokoro',
      name: 'Kokoro (neuronal local)',
      quality: 'premium' as const,
      local: true,
    };
    const byAudio = makeVideo(1, {
      title: 'Con labios por audio',
      usesPhotorealAvatars: true,
      providers: { tts: voice, lipsync: { ...engine, mode: 'audio' } },
    });
    const unsaid = makeVideo(2, {
      title: 'Sin modo declarado',
      usesPhotorealAvatars: true,
      providers: { tts: voice, lipsync: engine },
    });
    withVideos(api, [byAudio, unsaid]);
    renderFeatures([videos, others], `/videos/${byAudio.id}`, api);

    await screen.findByRole('heading', { level: 1, name: 'Con labios por audio' });
    expect(screen.getByText('Neuronal local · Kokoro (neuronal local)')).toBeInTheDocument();
    expect(screen.getByTestId('lip-driver')).toHaveTextContent(
      'Labios guiados por el audio: la boca sigue el sonido de la voz.',
    );
    cleanup();

    // A render that does not say which driver worked (an older one, an external provider).
    renderFeatures([videos, others], `/videos/${unsaid.id}`, api);
    await screen.findByRole('heading', { level: 1, name: 'Sin modo declarado' });
    expect(screen.queryByTestId('lip-driver')).not.toBeInTheDocument();
  });

  it('turns the public link on, shows it and copies it', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const video = makeVideo(1);
    withVideos(api, [video]);
    api.on('PUT', /^\/api\/videos\/(vid_[a-z0-9]+)\/share$/, ({ body }) =>
      makeShare(video, body as Partial<ReturnType<typeof makeShare>>),
    );
    const copied: string[] = [];
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });
    renderFeatures([videos, others], `/videos/${video.id}`, api);

    const toggle = await screen.findByRole('switch', { name: /Enlace público/ });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    const link = await screen.findByRole('textbox', { name: 'Enlace' });
    expect(link).toHaveValue('http://localhost:5173/s/kq7mx2plw9zt4rbn');
    expect(api.requests('PUT', /\/share$/)[0]?.body).toEqual({
      enabled: true,
      allowDownload: true,
      expiresAt: null,
    });
    expect(screen.getByText('Activo')).toBeInTheDocument();
    expect(screen.getByText('7 visitas')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copiar' }));
    expect(copied).toEqual(['http://localhost:5173/s/kq7mx2plw9zt4rbn']);
    expect(await screen.findByText('Enlace copiado al portapapeles')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Permitir descargar el MP4' }));
    await waitFor(() => expect(api.requests('PUT', /\/share$/)).toHaveLength(2));
    expect(api.requests('PUT', /\/share$/)[1]?.body).toMatchObject({
      enabled: true,
      allowDownload: false,
    });
  });

  it('cannot share a video that has not been rendered', async () => {
    const api = createFakeApi();
    const video = makeVideo(3, { status: 'draft' });
    withVideos(api, [video]);
    renderFeatures([videos, others], `/videos/${video.id}`, api);
    expect(
      await screen.findByText(/Renderiza el vídeo para poder compartirlo/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /Enlace público/ })).not.toBeInTheDocument();
    expect(screen.getByText('Todavía no hay vídeo')).toBeInTheDocument();
    // Before the first render the panel says what this server WOULD use.
    expect(
      await screen.findByText(/Con la configuración de este servidor se usará/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Modo básico · eSpeak NG')).toBeInTheDocument();
  });

  it('quotes the render, starts it and follows it until it is ready', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const draft = makeVideo(3, {
      title: 'Novedades',
      status: 'draft',
      estimatedDurationMs: 42_000,
    });
    const store = withVideos(api, [draft]);
    api.on('POST', /^\/api\/videos\/(vid_[a-z0-9]+)\/render$/, ({ body }) => {
      const queued = makeVideo(3, { ...draft, status: 'queued' });
      store.list[0] = makeVideo(3, {
        ...draft,
        status: 'rendering',
        progress: 40,
        renderStage: 'audio',
        resolution: '720p',
      });
      return json(
        {
          video: queued,
          renderJob: {
            id: 'rnd_a1b2c3d4e5f6g7h8',
            videoId: draft.id,
            status: 'queued',
            stage: null,
            progress: 0,
            etaSec: null,
            resolution: (body as { resolution: string }).resolution,
            creditsCharged: 2,
            error: null,
            createdAt: '2026-11-20T10:00:00.000Z',
            startedAt: null,
            finishedAt: null,
          },
        },
        202,
      );
    });
    renderFeatures([videos, others], `/videos/${draft.id}`, api);

    await user.click(await screen.findByRole('button', { name: 'Renderizar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renderizar vídeo' });
    // 42 s at 720p = 2 credits; the balance of the workspace is 212.
    expect(within(dialog).getByText('2 créditos')).toBeInTheDocument();
    expect(within(dialog).getByText('212 créditos')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: '1080p' }));
    expect(within(dialog).getByText('4 créditos')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Renderizar' }));

    expect(
      await screen.findByText('Generando la voz', undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(api.requests('POST', /\/render$/)[0]?.body).toEqual({ resolution: '1080p' });
    expect(screen.getByRole('button', { name: 'Cancelar render' })).toBeInTheDocument();

    store.list[0] = makeVideo(3, { title: 'Novedades' });
    expect(
      await screen.findByRole(
        'group',
        { name: 'Reproductor de vídeo: Novedades' },
        { timeout: 6000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('«Novedades» está listo')).toBeInTheDocument();
  }, 20_000);

  it('explains why a render cannot start', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const draft = makeVideo(3, { status: 'draft' });
    withVideos(api, [draft]);
    api.on('POST', /\/render$/, () =>
      apiError(422, 'CONTENT_BLOCKED', 'Scene 2 contains blocked terms'),
    );
    renderFeatures([videos, others], `/videos/${draft.id}`, api);
    await user.click(await screen.findByRole('button', { name: 'Renderizar' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Renderizar' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('El contenido no cumple las normas de uso');
    expect(alert).toHaveTextContent('Scene 2 contains blocked terms');
  });

  it('blocks a render the balance cannot pay and points to the plans', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const first = session.workspaces[0];
    if (!first) throw new Error('fixture');
    first.credits = 1;
    first.plan = 'free';
    const api = createFakeApi(session);
    const draft = makeVideo(3, { status: 'draft', estimatedDurationMs: 95_000 });
    withVideos(api, [draft]);
    renderFeatures([videos, others], `/videos/${draft.id}`, api);
    await user.click(await screen.findByRole('button', { name: 'Renderizar' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('No hay créditos suficientes para este render.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Renderizar' })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: '1080p' })).toBeDisabled();
    expect(within(dialog).getByText(/El plan Free exporta a 720p/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Ver planes y créditos' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });

  it('flags an output that is older than the composition', async () => {
    const api = createFakeApi();
    const video = makeVideo(1, { revision: 9, renderedRevision: 3 });
    withVideos(api, [video]);
    renderFeatures([videos, others], `/videos/${video.id}`, api);
    expect(
      await screen.findByText('Has editado el vídeo después de este render'),
    ).toBeInTheDocument();
    expect(screen.getByText('Desactualizado')).toBeInTheDocument();
  });

  it('lets viewers watch and download but not change anything', async () => {
    const api = createFakeApi(makeSession('viewer'));
    const video = makeVideo(1);
    withVideos(api, [video]);
    renderFeatures([videos, others], `/videos/${video.id}`, api);
    expect(
      await screen.findByRole('link', { name: 'Descargar el vídeo en MP4' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Más acciones' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /renderizar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar en el Studio' })).not.toBeInTheDocument();
    expect(
      await screen.findByText('Este vídeo no tiene un enlace público activo.'),
    ).toBeInTheDocument();
  });

  it('says so when the video does not exist (or belongs to another workspace)', async () => {
    const api = createFakeApi();
    withVideos(api, []);
    renderFeatures([videos, others], `/videos/${videoId(404)}`, api);
    expect(await screen.findByText('Este vídeo no existe')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Volver a los vídeos' })).toHaveAttribute(
      'href',
      '/videos',
    );
  });

  it('deletes from the detail page and goes back to the list', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const video = makeVideo(1, { title: 'Bienvenida al equipo' });
    const store = withVideos(api, [video]);
    api.on('DELETE', /^\/api\/videos\/(vid_[a-z0-9]+)$/, () => {
      store.list = [];
      return { ok: true };
    });
    const { router } = renderFeatures([videos, others], `/videos/${video.id}`, api);
    await user.click(await screen.findByRole('button', { name: 'Más acciones' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Eliminar' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Eliminar vídeo',
      }),
    );
    expect(await screen.findByText('La cabina está vacía')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/videos');
    expect(await screen.findByText('«Bienvenida al equipo» eliminado')).toBeInTheDocument();
    // The deleted video is never fetched again.
    expect(api.calls.filter((call) => call === `GET /api/videos/${video.id}`)).toHaveLength(1);
  });
});
