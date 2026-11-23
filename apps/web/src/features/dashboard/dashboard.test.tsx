import { PLANS } from '@parlante/shared';
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { defineFeature } from '@/shell';
import { toast } from '@/ui';
import {
  apiError,
  createFakeApi,
  makeBilling,
  makeSession,
  makeVideo,
  renderFeatures,
  resetApiClient,
  toSummary,
  watchContractWarnings,
} from '../videos/testing/harness';
import videos from '../videos/index';
import dashboard from './index';

const others = defineFeature({
  id: 'others',
  routes: [
    { path: '/templates', layout: 'app', component: () => <h1>Plantillas</h1> },
    { path: '/script-writer', layout: 'app', component: () => <h1>Guionista</h1> },
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

const recent = () => [
  makeVideo(1, { title: 'Bienvenida al equipo' }),
  makeVideo(2, {
    title: 'Anuncio de otoño',
    status: 'rendering',
    progress: 60,
    renderStage: 'encode',
  }),
];

describe('home', () => {
  it('greets, offers the three ways to start and shows recent videos with their state', async () => {
    const api = createFakeApi();
    api.on('GET', '/api/videos', () => ({ items: recent().map(toSummary), nextCursor: null }));
    api.on('GET', '/api/billing', () => makeBilling());
    renderFeatures([dashboard, videos, others], '/', api);

    expect(await screen.findByRole('heading', { level: 1, name: /Lucía$/ })).toBeInTheDocument();
    expect(await screen.findByText('En el aire · 1 render en curso')).toBeInTheDocument();

    const create = screen.getByRole('region', { name: 'Empezar un vídeo' });
    expect(within(create).getByRole('link', { name: 'En blanco' })).toHaveAttribute(
      'href',
      '/videos/new',
    );
    expect(within(create).getByRole('link', { name: 'Desde una plantilla' })).toHaveAttribute(
      'href',
      '/templates',
    );
    expect(within(create).getByRole('link', { name: 'Con el guionista IA' })).toHaveAttribute(
      'href',
      '/script-writer',
    );
    // The script writer runs on the local heuristic here: it must say "modo básico".
    expect(await within(create).findByText('Modo básico · Heurística local')).toBeInTheDocument();

    const list = screen.getByRole('region', { name: 'Vídeos recientes' });
    expect(within(list).getByRole('link', { name: 'Bienvenida al equipo' })).toBeInTheDocument();
    expect(within(list).getByText('Codificando el vídeo')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Ver todos' })).toHaveAttribute(
      'href',
      '/videos',
    );
    expect(api.calls).toContain('GET /api/videos?limit=6');
  });

  it('shows credits, the last 30 days and how much of the plan is used', async () => {
    const api = createFakeApi();
    api.on('GET', '/api/videos', () => ({ items: [], nextCursor: null }));
    api.on('GET', '/api/billing', () => makeBilling());
    renderFeatures([dashboard, videos, others], '/', api);

    const plan = await screen.findByRole('region', { name: 'Créditos y plan' });
    expect(within(plan).getByText('212')).toBeInTheDocument();
    expect(within(plan).getByText('de 300 al mes')).toBeInTheDocument();
    expect(within(plan).getByText('Plan Creator')).toBeInTheDocument();
    expect(within(plan).getByText('31')).toBeInTheDocument();
    expect(within(plan).getByText('vídeos renderizados')).toBeInTheDocument();
    expect(within(plan).getByText('88')).toBeInTheDocument();

    const storage = within(plan).getByRole('meter', { name: 'Almacenamiento' });
    expect(storage).toHaveAttribute('aria-valuetext', '5 GB de 20 GB');
    expect(within(plan).getByRole('meter', { name: 'Voces clonadas' })).toHaveAttribute(
      'aria-valuetext',
      '5 de 5',
    );
    expect(within(plan).getByText('Hasta 1080p')).toBeInTheDocument();
    expect(within(plan).getByText('Sin marca de agua')).toBeInTheDocument();
    expect(within(plan).getByRole('link', { name: 'Ver plan y créditos' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
    expect(
      within(plan).getByText('Los pagos de esta instalación son simulados.'),
    ).toBeInTheDocument();
  });

  it('guides an empty workspace to its first video', async () => {
    const session = makeSession();
    const first = session.workspaces[0];
    if (!first) throw new Error('fixture');
    Object.assign(first, { plan: 'free', credits: 30 });
    const api = createFakeApi(session);
    api.on('GET', '/api/videos', () => ({ items: [], nextCursor: null }));
    api.on('GET', '/api/billing', () =>
      makeBilling({ plan: PLANS.free, limits: PLANS.free.limits, credits: 30 }),
    );
    renderFeatures([dashboard, videos, others], '/', api);

    expect(await screen.findByText('De un guion a un MP4 en tres pasos')).toBeInTheDocument();
    expect(screen.getByText('Cabina libre')).toBeInTheDocument();
    expect(screen.getByText('Escribe el guion')).toBeInTheDocument();
    expect(screen.getByText('Elige avatar y voz')).toBeInTheDocument();
    expect(screen.getByText('Renderiza y comparte')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Crear mi primer vídeo' })).toHaveAttribute(
      'href',
      '/videos/new',
    );
    expect(screen.queryByRole('link', { name: 'Ver todos' })).not.toBeInTheDocument();
    expect(await screen.findByText('Con marca de agua')).toBeInTheDocument();
  });

  it('does not offer creation to viewers', async () => {
    const api = createFakeApi(makeSession('viewer'));
    api.on('GET', '/api/videos', () => ({ items: [], nextCursor: null }));
    api.on('GET', '/api/billing', () => makeBilling());
    renderFeatures([dashboard, videos, others], '/', api);
    expect(await screen.findByText(/Con rol de lector podrás verlos/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Empezar un vídeo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Crear mi primer vídeo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Crear vídeo' })).not.toBeInTheDocument();
  });

  it('keeps working when one of its sources fails', async () => {
    const api = createFakeApi();
    api.on('GET', '/api/videos', () => apiError(400, 'BAD_REQUEST', 'nope'));
    api.on('GET', '/api/billing', () => apiError(403, 'FORBIDDEN', 'nope'));
    renderFeatures([dashboard, videos, others], '/', api);
    expect(await screen.findByText('La petición no es válida')).toBeInTheDocument();
    expect(await screen.findByText('No se ha podido cargar el uso del plan')).toBeInTheDocument();
    // The balance still comes from the session.
    expect(
      screen.getByText('Saldo según tu sesión: 212 créditos · plan Creator.'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Reintentar' })).toHaveLength(2);
  });
});
