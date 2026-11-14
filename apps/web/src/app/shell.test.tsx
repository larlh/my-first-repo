import type { SessionInfo } from '@parlante/shared';
import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Film, KeyRound, Plus, UserRound } from 'lucide-react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient, apiRequester } from '@/lib/api/instance';
import { i18n, registerTranslations } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { AppProviders } from './App';
import { RegistryProvider } from './RegistryContext';
import { collectFeatures, defineFeature } from './features';
import { loginPathFor, safeNextPath } from './paths';
import { buildRoutes } from './router';

const NOW = '2026-11-01T10:00:00.000Z';
const WS_A = 'ws_a1b2c3d4e5f6g7h8';
const WS_B = 'ws_z9y8x7w6v5u4t3s2';

function sessionFor(role: 'owner' | 'viewer', currentWorkspaceId = WS_A): SessionInfo {
  return {
    user: {
      id: 'usr_a1b2c3d4e5f6g7h8',
      email: 'lucia@ejemplo.com',
      name: 'Lucía Ferrer',
      locale: 'es',
      createdAt: NOW,
    },
    session: { id: 'ses_a1b2c3d4e5f6g7h8', expiresAt: '2026-12-01T10:00:00.000Z', createdAt: NOW },
    workspaces: [
      { id: WS_A, name: 'Estudio Norte', plan: 'creator', credits: 212, createdAt: NOW, role },
      { id: WS_B, name: 'Personal', plan: 'free', credits: 3, createdAt: NOW, role: 'owner' },
    ],
    currentWorkspaceId,
  };
}

function Videos() {
  const { workspace, credits, plan } = useSession();
  return (
    <h1>
      Vídeos de {workspace.name} ({credits} créditos, plan {plan.name})
    </h1>
  );
}

const videos = defineFeature({
  id: 'videos',
  routes: [
    { path: '/videos', layout: 'app', component: Videos, titleKey: 'title' },
    { path: '/videos/new', layout: 'fullscreen', component: () => <h1>Studio</h1> },
    { path: '/keys', layout: 'app', component: () => <h1>Claves de API</h1>, minRole: 'admin' },
    { path: '/account', layout: 'app', component: () => <h1>Mi cuenta</h1> },
  ],
  nav: [
    { to: '/videos', labelKey: 'nav.videos', icon: Film, section: 'library', order: 10 },
    { to: '/videos/new', labelKey: 'nav.create', icon: Plus, section: 'main', cta: true },
    { to: '/keys', labelKey: 'nav.keys', icon: KeyRound, section: 'workspace', minRole: 'admin' },
    { to: '/account', labelKey: 'nav.account', icon: UserRound, section: 'account' },
  ],
  i18n: {
    es: {
      title: 'Vídeos',
      nav: { videos: 'Vídeos', create: 'Crear vídeo', keys: 'Claves de API', account: 'Mi cuenta' },
    },
    en: {
      title: 'Videos',
      nav: { videos: 'Videos', create: 'Create video', keys: 'API keys', account: 'My account' },
    },
  },
});

const auth = defineFeature({
  id: 'auth',
  routes: [
    { path: '/login', layout: 'public', guestOnly: true, component: () => <h1>Iniciar sesión</h1> },
    { path: '/share/:token', layout: 'public', component: () => <h1>Vídeo compartido</h1> },
  ],
});

const registry = collectFeatures(
  {
    '../features/videos/index.tsx': { default: videos },
    '../features/auth/index.tsx': { default: auth },
  },
  { dev: false },
);
for (const feature of registry.features) {
  if (feature.i18n) registerTranslations(feature.id, feature.i18n);
}

interface Handlers {
  me: () => Response;
  [path: string]: (init: RequestInit) => Response;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
const unauthenticated = () =>
  json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, 401);

function renderApp(path: string, handlers: Handlers) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me' && (init?.method ?? 'GET') === 'GET') return handlers.me();
    const handler = handlers[`${init?.method ?? 'GET'} ${url}`];
    return handler
      ? handler(init ?? {})
      : json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
  });
  apiRequester.configure({ fetch: fetchMock as unknown as typeof fetch, validateResponses: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(buildRoutes(registry, { dev: false }), {
    initialEntries: [path],
  });
  render(
    <AppProviders client={client}>
      <RegistryProvider registry={registry}>
        <RouterProvider router={router} />
      </RegistryProvider>
    </AppProviders>,
  );
  return { router, fetchMock };
}

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('es');
});
afterEach(() => {
  apiRequester.configure({ fetch: undefined, validateResponses: undefined });
});

describe('collectFeatures', () => {
  it('collects routes and navigation from every manifest', () => {
    expect(registry.problems).toEqual([]);
    expect(registry.features.map((f) => f.id)).toEqual(['auth', 'videos']);
    expect(registry.routes.map((r) => r.path)).toContain('/videos/new');
    expect(registry.nav.find((n) => n.to === '/videos')?.featureId).toBe('videos');
  });

  it('reports broken manifests instead of crashing, and skips devOnly outside dev', () => {
    const page = () => null;
    const result = collectFeatures(
      {
        'a/index.ts': {
          default: defineFeature({
            id: 'one',
            routes: [{ path: '/x', layout: 'app', component: page }],
          }),
        },
        'b/index.ts': { default: defineFeature({ id: 'one', routes: [] }) },
        'c/index.ts': { default: { nope: true } },
        'd/index.ts': { default: defineFeature({ id: 'Bad_Id', routes: [] }) },
        'e/index.ts': {
          default: defineFeature({
            id: 'two',
            routes: [
              { path: '/x', layout: 'app', component: page },
              { path: 'relative', layout: 'app', component: page },
              { path: '/no-page', layout: 'app' },
            ],
          }),
        },
        'f/index.ts': {
          default: defineFeature({
            id: 'playground',
            devOnly: true,
            routes: [{ path: '/dev/p', layout: 'app', component: page }],
          }),
        },
      },
      { dev: false },
    );
    expect(result.features.map((f) => f.id)).toEqual(['one', 'two']);
    expect(result.routes.map((r) => `${r.featureId}:${r.path}`)).toEqual(['one:/x']);
    expect(result.problems).toHaveLength(6);
    expect(result.problems.join('\n')).toMatch(/duplicate feature id "one"/);
    expect(result.problems.join('\n')).toMatch(/already registered by "one"/);

    const dev = collectFeatures(
      {
        'f/index.ts': {
          default: defineFeature({
            id: 'playground',
            devOnly: true,
            routes: [{ path: '/dev/p', layout: 'app', component: page }],
          }),
        },
      },
      { dev: true },
    );
    expect(dev.features).toHaveLength(1);
  });
});

describe('redirect helpers', () => {
  it('only accept same-site paths', () => {
    expect(safeNextPath('/videos?tab=1')).toBe('/videos?tab=1');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil')).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('/login')).toBe('/');
    expect(loginPathFor('/videos/new')).toBe('/login?next=%2Fvideos%2Fnew');
    expect(loginPathFor('/')).toBe('/login');
  });
});

describe('app shell', () => {
  it('sends anonymous visitors to the login page and remembers where they were going', async () => {
    const { router } = renderApp('/videos', { me: unauthenticated });
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/login?next=%2Fvideos',
    );
  });

  it('serves public routes without a session', async () => {
    renderApp('/share/abc', { me: unauthenticated });
    expect(await screen.findByRole('heading', { name: 'Vídeo compartido' })).toBeInTheDocument();
  });

  it('redirects signed-in users away from guest-only pages to ?next', async () => {
    const { router } = renderApp('/login?next=%2Fvideos', { me: () => json(sessionFor('owner')) });
    expect(
      await screen.findByRole('heading', { name: /Vídeos de Estudio Norte/ }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/videos');
  });

  it('renders the layout with navigation from the manifests, workspace, credits and user', async () => {
    renderApp('/videos', { me: () => json(sessionFor('owner')) });
    expect(
      await screen.findByRole('heading', {
        name: 'Vídeos de Estudio Norte (212 créditos, plan Creator)',
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Vídeos · Parlante'));

    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    const current = within(nav).getByRole('link', { name: 'Vídeos' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('Biblioteca')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Claves de API' })).toBeInTheDocument();
    // the CTA is a prominent link outside the list; account entries live in the user menu
    expect(screen.getByRole('link', { name: 'Crear vídeo' })).toHaveAttribute(
      'href',
      '/videos/new',
    );
    expect(within(nav).queryByRole('link', { name: 'Mi cuenta' })).toBeNull();

    expect(
      screen.getByRole('button', { name: /Workspace actual: Estudio Norte/ }),
    ).toHaveTextContent('Plan Creator · Propietario');
    expect(screen.getByRole('meter', { name: 'Créditos disponibles' })).toHaveAttribute(
      'aria-valuenow',
      '212',
    );
    expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveAttribute(
      'href',
      '#main',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Menú de Lucía Ferrer' }));
    expect(await screen.findByRole('menuitem', { name: 'Mi cuenta' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Idioma' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Tema' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Cerrar sesión' })).toBeInTheDocument();
  });

  it('hides navigation and blocks pages above the caller role', async () => {
    renderApp('/keys', { me: () => json(sessionFor('viewer')) });
    expect(await screen.findByText('No tienes acceso a esta sección')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Claves de API' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    expect(within(nav).queryByRole('link', { name: 'Claves de API' })).toBeNull();
  });

  it('renders fullscreen routes without the sidebar', async () => {
    renderApp('/videos/new', { me: () => json(sessionFor('owner')) });
    expect(await screen.findByRole('heading', { name: 'Studio' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Navegación principal' })).toBeNull();
  });

  it('redirects / to the first navigation entry when no feature owns it, and shows 404 otherwise', async () => {
    const home = renderApp('/', { me: () => json(sessionFor('owner')) });
    expect(
      await screen.findByRole('heading', { name: /Vídeos de Estudio Norte/ }),
    ).toBeInTheDocument();
    expect(home.router.state.location.pathname).toBe('/videos');
  });

  it('shows the not-found page for unknown paths', async () => {
    renderApp('/nada', { me: unauthenticated });
    expect(await screen.findByRole('heading', { name: 'Aquí no hay nada' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir al inicio' })).toHaveAttribute('href', '/');
  });

  it('switches workspace through the API and refreshes the session data', async () => {
    const { fetchMock } = renderApp('/videos', {
      me: () => json(sessionFor('owner')),
      'POST /api/auth/switch-workspace': () => json(sessionFor('owner', WS_B)),
    });
    await screen.findByRole('heading', { name: /Vídeos de Estudio Norte/ });
    await userEvent.click(screen.getByRole('button', { name: /Workspace actual: Estudio Norte/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Personal/ }));
    expect(
      await screen.findByRole('heading', { name: 'Vídeos de Personal (3 créditos, plan Free)' }),
    ).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth/switch-workspace');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ workspaceId: WS_B });
  });

  it('drops the session and goes to login when any session route answers 401', async () => {
    const { router } = renderApp('/videos', {
      me: () => json(sessionFor('owner')),
      'GET /api/videos': unauthenticated,
    });
    await screen.findByRole('heading', { name: /Vídeos de Estudio Norte/ });
    // Any later API call that finds the session expired:
    await apiClient.videos.list().catch(() => undefined);
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Fvideos');
  });

  it('logs out and changes language from the user menu', async () => {
    const { router, fetchMock } = renderApp('/videos', {
      me: () => json(sessionFor('owner')),
      'POST /api/auth/logout': () => json({ ok: true }),
      'PATCH /api/auth/me': () => json({ ...sessionFor('owner').user, locale: 'en' }),
    });
    await screen.findByRole('heading', { name: /Vídeos de Estudio Norte/ });

    await userEvent.click(screen.getByRole('button', { name: 'Menú de Lucía Ferrer' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Idioma' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'English' }));
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create video' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === '/api/auth/me' && init?.method === 'PATCH',
        ),
      ).toBe(true),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Lucía Ferrer’s menu' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/auth/logout')).toBe(true);
  });
});
