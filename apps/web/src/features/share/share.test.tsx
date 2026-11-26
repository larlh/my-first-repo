import { PublicShareSchema } from '@parlante/shared';
import type { PublicShare } from '@parlante/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiRequester } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import {
  NOW,
  apiError,
  createFakeApi,
  fileUrl,
  renderFeatures,
  resetApiClient,
  watchContractWarnings,
} from '../videos/testing/harness';
import share from './index';
import { loadShare, resetShareCache } from './loadShare';

const TOKEN = 'kq7mx2plw9zt4rbn';

function makePublicShare(overrides: Partial<PublicShare> = {}): PublicShare {
  return PublicShareSchema.parse({
    title: 'Bienvenida al equipo',
    aspect: '16:9',
    durationMs: 42_000,
    videoUrl: fileUrl('ws/a/videos/v/video.mp4'),
    thumbnailUrl: fileUrl('ws/a/videos/v/thumb.jpg'),
    vttUrl: fileUrl('ws/a/videos/v/subtitles.vtt'),
    downloadUrl: `${fileUrl('ws/a/videos/v/video.mp4')}&download=Bienvenida.mp4`,
    workspaceName: 'Estudio Norte',
    providers: {
      tts: { id: 'espeak', name: 'eSpeak NG', quality: 'basic', local: true },
      lipsync: { id: 'canvas2d', name: 'Avatar 2D', quality: 'basic', local: true },
      storage: { id: 'disk', name: 'Disco local', quality: 'basic', local: true },
    },
    aiGenerated: false,
    createdAt: NOW,
    ...overrides,
  });
}

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
  resetShareCache();
  document.head
    .querySelectorAll('meta[property], meta[name="twitter:card"], link[rel="canonical"]')
    .forEach((node) => node.remove());
});

describe('public share page', () => {
  it('plays the shared video without a session and says how it was made', async () => {
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () =>
      makePublicShare(),
    );
    renderFeatures([share], `/s/${TOKEN}`, api);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bienvenida al equipo' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Reproductor de vídeo: Bienvenida al equipo' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Compartido por Estudio Norte')).toBeInTheDocument();
    expect(screen.getByText('42 s')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Descargar MP4' }).getAttribute('href')).toContain(
      'download=Bienvenida.mp4',
    );
    // Honesty rule: the provider of the voice and the avatar, not the storage internals.
    expect(screen.getByText('Modo básico · eSpeak NG')).toBeInTheDocument();
    expect(screen.getByText('Modo básico · Avatar 2D')).toBeInTheDocument();
    expect(screen.queryByText(/Disco local/)).not.toBeInTheDocument();
    // Brand and the way in for an anonymous visitor.
    expect(screen.getByText('Hecho con Parlante')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Crea el tuyo gratis' })).toHaveAttribute(
      'href',
      '/register',
    );
    // One read = one view on the server.
    expect(api.requests('GET', `/api/public/shares/${TOKEN}`)).toHaveLength(1);
  });

  it('writes link-preview metadata for the video', async () => {
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () =>
      makePublicShare(),
    );
    renderFeatures([share], `/s/${TOKEN}`, api);
    await waitFor(() => expect(document.title).toBe('Bienvenida al equipo · Parlante'));
    const content = (selector: string) =>
      document.head.querySelector(selector)?.getAttribute('content');
    expect(content('meta[property="og:title"]')).toBe('Bienvenida al equipo');
    expect(content('meta[property="og:type"]')).toBe('video.other');
    expect(content('meta[property="og:image"]')).toBe(fileUrl('ws/a/videos/v/thumb.jpg'));
    expect(content('meta[property="og:video"]')).toBe(fileUrl('ws/a/videos/v/video.mp4'));
    expect(content('meta[property="og:url"]')).toBe(
      `${window.location.origin}${window.location.pathname}`,
    );
    expect(content('meta[name="description"]')).toBe(
      'Vídeo compartido por Estudio Norte. Hecho con Parlante.',
    );
    expect(content('meta[name="twitter:card"]')).toBe('summary_large_image');
  });

  it('labels AI-generated presenters and hides the download when it is not allowed', async () => {
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () =>
      makePublicShare({ aiGenerated: true, downloadUrl: null, aspect: '9:16' }),
    );
    renderFeatures([share], `/share/${TOKEN}`, api);
    expect(await screen.findByText('Generado por IA')).toBeInTheDocument();
    expect(screen.getByText(/No es una grabación de una persona real/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Descargar MP4' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Descargar' })).not.toBeInTheDocument();
  });

  it('starts the caption overlay off when the subtitles are burnt into the video', async () => {
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () =>
      makePublicShare({ burnedInSubtitles: true }),
    );
    renderFeatures([share], `/s/${TOKEN}`, api);
    expect(await screen.findByRole('button', { name: 'Mostrar subtítulos' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('starts the caption overlay on when it is the only way to read the subtitles', async () => {
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () =>
      makePublicShare({ burnedInSubtitles: false }),
    );
    renderFeatures([share], `/s/${TOKEN}`, api);
    expect(await screen.findByRole('button', { name: 'Ocultar subtítulos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('explains a link that was turned off or expired', async () => {
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () =>
      apiError(404, 'NOT_FOUND', 'Share link not found'),
    );
    renderFeatures([share], `/s/${TOKEN}`, api);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Este enlace ya no está disponible' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Conocer Parlante' })).toHaveAttribute('href', '/');
    expect(api.requests('GET', `/api/public/shares/${TOKEN}`)).toHaveLength(1);
  });

  it('offers a retry that reads again when the server could not be reached', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () => {
      attempts += 1;
      return attempts === 1 ? apiError(503, 'SERVICE_UNAVAILABLE', 'down') : makePublicShare();
    });
    renderFeatures([share], `/s/${TOKEN}`, api);
    expect(
      await screen.findByText('El servicio no está disponible en este momento'),
    ).toBeInTheDocument();
    expect(attempts).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bienvenida al equipo' }),
    ).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('counts one view per visit even when React mounts the page twice (StrictMode)', async () => {
    let reads = 0;
    const api = createFakeApi(null).on('GET', `/api/public/shares/${TOKEN}`, () => {
      reads += 1;
      return makePublicShare();
    });
    apiRequester.configure({ fetch: api.fetch, validateResponses: true });
    const first = loadShare(TOKEN);
    const second = loadShare(TOKEN);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ title: 'Bienvenida al equipo' });
    await loadShare(TOKEN);
    expect(reads).toBe(1);
  });

  it('takes a signed-in visitor back to the app instead of to sign-up', async () => {
    const api = createFakeApi().on('GET', `/api/public/shares/${TOKEN}`, () => makePublicShare());
    renderFeatures([share], `/s/${TOKEN}`, api);
    expect(await screen.findByRole('link', { name: 'Ir a mis vídeos' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
