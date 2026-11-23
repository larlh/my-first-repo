import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { defineFeature } from '@/shell';
import { toast } from '@/ui';
import {
  WS_B,
  apiError,
  createFakeApi,
  makeSession,
  renderFeatures,
  resetApiClient,
  watchContractWarnings,
} from '../videos/testing/harness';
import auth from './index';

/** Stand-in for the rest of the app: somewhere to land after signing in. */
function Landing() {
  const { workspace } = useSession();
  return <h1>Vídeos de {workspace.name}</h1>;
}
const app = defineFeature({
  id: 'landing',
  routes: [
    { path: '/', layout: 'app', component: Landing },
    { path: '/videos', layout: 'app', component: Landing },
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

const email = () => screen.findByRole('textbox', { name: /Correo electrónico/ });
const password = () =>
  document.querySelector<HTMLInputElement>('input[name="password"]') as HTMLInputElement;

describe('login', () => {
  it('explains what is missing before calling the API', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(null);
    renderFeatures([auth, app], '/login', api);
    await email();
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('Escribe tu correo.')).toBeInTheDocument();
    expect(screen.getByText('Escribe tu contraseña.')).toBeInTheDocument();
    expect(api.requests('POST', '/api/auth/login')).toHaveLength(0);

    // Once submitted, the messages follow the typing.
    await user.type(await email(), 'lucia@');
    expect(await screen.findByText(/no parece válido/)).toBeInTheDocument();
    await user.type(await email(), 'ejemplo.com');
    await waitFor(() => expect(screen.queryByText(/no parece válido/)).not.toBeInTheDocument());
  });

  it('shows wrong credentials in plain words and lets the user retry', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(null).on('POST', '/api/auth/login', () =>
      apiError(401, 'INVALID_CREDENTIALS', 'Invalid e-mail or password'),
    );
    renderFeatures([auth, app], '/login', api);
    await user.type(await email(), 'lucia@ejemplo.com');
    await user.type(password(), 'equivocada');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El correo o la contraseña no son correctos');
    // Still on the form, password ready to be retyped.
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
    await waitFor(() => expect(password()).toHaveFocus());
  });

  it('signs in and returns to the page the guard interrupted', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const api = createFakeApi(null);
    api.on('POST', '/api/auth/login', () => {
      api.setSession(session);
      return session;
    });
    // An anonymous visit to a guarded page is sent to the login form with ?next=.
    const { router } = renderFeatures([auth, app], '/videos?status=failed', api);
    await email();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2Fvideos%3Fstatus%3Dfailed');
    expect(screen.getByText(/te llevamos a la página que querías abrir/)).toBeInTheDocument();

    await user.type(await email(), '  Lucia@Ejemplo.com ');
    await user.type(password(), 'correcta-1234');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('heading', { name: 'Vídeos de Estudio Norte' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/videos?status=failed',
    );
    expect(api.requests('POST', '/api/auth/login')[0]?.body).toEqual({
      email: 'Lucia@Ejemplo.com',
      password: 'correcta-1234',
    });
  });

  it('keeps ?next= when moving between login and register', async () => {
    const user = userEvent.setup();
    const { router } = renderFeatures([auth, app], '/login?next=%2Fvideos', createFakeApi(null));
    const link = await screen.findByRole('link', { name: 'Crea una gratis' });
    expect(link).toHaveAttribute('href', '/register?next=%2Fvideos');
    // Leaving the (auto-focused, empty) form must not raise validation errors on the way out.
    await user.click(link);
    expect(await screen.findByRole('heading', { name: 'Crea tu cuenta' })).toBeInTheDocument();
    expect(screen.queryByText('Escribe tu correo.')).not.toBeInTheDocument();
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/register?next=%2Fvideos',
    );
  });

  it('sends a signed-in visitor straight into the app', async () => {
    const { router } = renderFeatures([auth, app], '/login?next=%2Fvideos', createFakeApi());
    expect(
      await screen.findByRole('heading', { name: 'Vídeos de Estudio Norte' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/videos');
  });

  it('toggles password visibility without losing the value', async () => {
    const user = userEvent.setup();
    renderFeatures([auth, app], '/login', createFakeApi(null));
    await email();
    await user.type(password(), 'secreta-123');
    expect(password()).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Mostrar contraseña' }));
    expect(password()).toHaveAttribute('type', 'text');
    expect(password()).toHaveValue('secreta-123');
    expect(screen.getByRole('button', { name: 'Ocultar contraseña' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('register', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, pass = 'Cabina-2026!') {
    await user.type(await screen.findByRole('textbox', { name: /Nombre/ }), 'Lucía Ferrer');
    await user.type(await email(), 'lucia@ejemplo.com');
    await user.type(password(), pass);
  }

  it('requires a password of at least 8 characters', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(null);
    renderFeatures([auth, app], '/register', api);
    await fill(user, 'corta');
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(
      await screen.findByText('La contraseña necesita al menos 8 caracteres.'),
    ).toBeInTheDocument();
    expect(api.requests('POST', '/api/auth/register')).toHaveLength(0);
  });

  it('puts "e-mail taken" on the e-mail field with a way to sign in', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(null).on('POST', '/api/auth/register', () =>
      apiError(409, 'EMAIL_TAKEN', 'E-mail already registered'),
    );
    renderFeatures([auth, app], '/register?next=%2Fvideos', api);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    const message = await screen.findByText(/Ya hay una cuenta con ese correo\./);
    expect(within(message).getByRole('link', { name: 'Inicia sesión' })).toHaveAttribute(
      'href',
      '/login?next=%2Fvideos',
    );
    expect(await email()).toHaveAttribute('aria-invalid', 'true');
  });

  it('creates the account in the UI language and enters the app', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const api = createFakeApi(null);
    api.on('POST', '/api/auth/register', () => {
      api.setSession(session);
      return new Response(JSON.stringify(session), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const { router } = renderFeatures([auth, app], '/register?invite=tok_abcdefghij', api);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));

    expect(
      await screen.findByRole('heading', { name: 'Vídeos de Estudio Norte' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(api.requests('POST', '/api/auth/register')[0]?.body).toEqual({
      name: 'Lucía Ferrer',
      email: 'lucia@ejemplo.com',
      password: 'Cabina-2026!',
      locale: 'es',
      inviteToken: 'tok_abcdefghij',
    });
  });

  it('maps server-side validation onto the fields', async () => {
    const user = userEvent.setup();
    const api = createFakeApi(null).on('POST', '/api/auth/register', () =>
      apiError(400, 'VALIDATION_ERROR', 'Invalid request body', {
        issues: [{ path: 'name', message: 'Name is not allowed' }],
      }),
    );
    renderFeatures([auth, app], '/register', api);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Crear cuenta' }));
    expect(await screen.findByText('Name is not allowed')).toBeInTheDocument();
  });
});

describe('logout', () => {
  it('ends the session and confirms it on the login page', async () => {
    const api = createFakeApi();
    const { router } = renderFeatures([auth, app], '/logout', api);
    expect(await screen.findByText('Has cerrado sesión. Hasta la próxima.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(api.requests('POST', '/api/auth/logout')).toHaveLength(1);
  });
});

describe('workspaces', () => {
  it('lists the workspaces and switches to another one', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const api = createFakeApi(session);
    api.on('GET', '/api/workspaces', () => ({ items: session.workspaces }));
    api.on('POST', '/api/auth/switch-workspace', () => {
      const next = { ...session, currentWorkspaceId: WS_B };
      api.setSession(next);
      return next;
    });
    const { router } = renderFeatures([auth, app], '/workspaces', api);

    const cards = await screen.findAllByRole('listitem');
    const current = cards.find((card) => within(card).queryByText('Estudio Norte'));
    const other = cards.find((card) => within(card).queryByText('Personal'));
    if (!current || !other) throw new Error('workspace cards not found');
    expect(within(current).getByText('Actual')).toBeInTheDocument();
    expect(within(current).getByText('Plan Creator · Propietario')).toBeInTheDocument();
    expect(within(other).getByText('3 créditos')).toBeInTheDocument();

    await user.click(within(other).getByRole('button', { name: 'Trabajar aquí' }));
    expect(await screen.findByRole('heading', { name: 'Vídeos de Personal' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(api.requests('POST', '/api/auth/switch-workspace')[0]?.body).toEqual({
      workspaceId: WS_B,
    });
  });

  it('creates a workspace and makes it the active one', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const created = {
      id: 'ws_n3wn3wn3wn3wn3wn',
      name: 'Equipo de marketing',
      plan: 'free' as const,
      credits: 30,
      createdAt: '2026-11-20T10:00:00.000Z',
      role: 'owner' as const,
    };
    const api = createFakeApi(session);
    api.on('GET', '/api/workspaces', () => ({ items: session.workspaces }));
    api.on(
      'POST',
      '/api/workspaces',
      () =>
        new Response(JSON.stringify(created), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    api.on('POST', '/api/auth/switch-workspace', () => {
      const next = {
        ...session,
        workspaces: [...session.workspaces, created],
        currentWorkspaceId: created.id,
      };
      api.setSession(next);
      return next;
    });
    renderFeatures([auth, app], '/workspaces', api);

    await user.click(await screen.findByRole('button', { name: 'Nuevo workspace' }));
    const dialog = await screen.findByRole('dialog');
    // Empty name is caught on the client.
    await user.click(within(dialog).getByRole('button', { name: 'Crear y cambiar' }));
    expect(await within(dialog).findByText('Ponle un nombre al workspace.')).toBeInTheDocument();
    expect(api.requests('POST', '/api/workspaces')).toHaveLength(0);

    await user.type(
      within(dialog).getByRole('textbox', { name: /Nombre/ }),
      '  Equipo de marketing ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Crear y cambiar' }));

    expect(
      await screen.findByRole('heading', { name: 'Vídeos de Equipo de marketing' }),
    ).toBeInTheDocument();
    expect(api.requests('POST', '/api/workspaces')[0]?.body).toEqual({
      name: 'Equipo de marketing',
    });
    expect(api.requests('POST', '/api/auth/switch-workspace')[0]?.body).toEqual({
      workspaceId: created.id,
    });
  });
});
