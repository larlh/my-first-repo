import { PLANS } from '@parlante/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { defineFeature } from '@/shell';
import { toast } from '@/ui';
import {
  NOW,
  WS_A,
  apiError,
  createFakeApi,
  makeBilling,
  makeSession,
  renderFeatures,
  resetApiClient,
  watchContractWarnings,
} from '../videos/testing/harness';
import type { FakeApi } from '../videos/testing/harness';
import settings from './index';
import {
  PLAIN_KEY,
  PLAIN_SECRET,
  makeApiKey,
  makeApiKeyCreated,
  makeConsent,
  makeDelivery,
  makeEndpoint,
  makeEndpointCreated,
  makeInvite,
  makeInviteCreated,
  makeLedgerEntry,
  makeTeam,
} from './testing/fixtures';

const others = defineFeature({
  id: 'others',
  routes: [
    { path: '/', layout: 'app', component: () => <h1>Inicio</h1> },
    { path: '/login', layout: 'public', component: () => <h1>Entrar</h1> },
    { path: '/register', layout: 'public', component: () => <h1>Registro</h1> },
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
  vi.restoreAllMocks();
});

function mount(path: string, api: FakeApi) {
  return renderFeatures([settings, others], path, api);
}

describe('frame', () => {
  it('opens the profile from /settings and links every section and the API docs', async () => {
    const api = createFakeApi();
    const { router } = mount('/settings', api);

    expect(await screen.findByRole('heading', { level: 1, name: 'Tu perfil' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/profile');

    const nav = screen.getAllByRole('navigation', {
      name: 'Secciones de ajustes',
    })[0] as HTMLElement;
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      expect.arrayContaining([
        '/settings/profile',
        '/settings/preferences',
        '/settings/workspace',
        '/settings/members',
        '/settings/billing',
        '/settings/consents',
        '/settings/api-keys',
        '/settings/webhooks',
      ]),
    );
    const docs = within(nav).getAllByRole('link', { name: /Referencia de la API/ })[0];
    expect(docs).toHaveAttribute('href', expect.stringMatching(/\/docs$/));
    expect(docs).toHaveAttribute('target', '_blank');
    expect(within(nav).getAllByRole('link', { name: /^Perfil/ })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('explains admin-only sections to an editor instead of loading their data', async () => {
    const api = createFakeApi(makeSession('editor'));
    mount('/settings/api-keys', api);

    expect(await screen.findByText('Solo para administradores')).toBeInTheDocument();
    expect(screen.getByText(/Tu rol en «Estudio Norte» es Editor/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Crear clave' })).not.toBeInTheDocument();
    // The docs stay reachable, and no admin endpoint was called.
    expect(screen.getByRole('link', { name: /Abrir la documentación/ })).toBeInTheDocument();
    expect(api.calls.filter((call) => call.includes('/api/api-keys'))).toEqual([]);
  });
});

describe('profile and preferences', () => {
  it('saves the name and validates the password form before calling the API', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const api = createFakeApi(session);
    api.on('PATCH', '/api/auth/me', ({ body }) => {
      const next = { ...session.user, name: (body as { name: string }).name };
      api.setSession({ ...session, user: next });
      return next;
    });
    api.on('POST', '/api/auth/change-password', () =>
      apiError(401, 'INVALID_CREDENTIALS', 'Wrong password'),
    );
    mount('/settings/profile', api);

    const name = await screen.findByLabelText(/^Nombre/);
    await user.clear(name);
    await user.type(name, 'Lucía F. Ortega');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(await screen.findByText('Perfil guardado')).toBeInTheDocument();
    expect(api.requests('PATCH', '/api/auth/me')[0]?.body).toEqual({ name: 'Lucía F. Ortega' });

    await user.type(screen.getByLabelText(/^Contraseña actual/), 'vieja-clave');
    await user.type(screen.getByLabelText(/^Contraseña nueva/), 'corta');
    await user.type(screen.getByLabelText(/^Repite la contraseña nueva/), 'otra');
    await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
    expect(
      screen.getByText('La contraseña nueva debe tener entre 8 y 128 caracteres.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Las dos contraseñas no coinciden.')).toBeInTheDocument();
    expect(api.requests('POST', '/api/auth/change-password')).toHaveLength(0);

    await user.clear(screen.getByLabelText(/^Contraseña nueva/));
    await user.type(screen.getByLabelText(/^Contraseña nueva/), 'clave-nueva-larga');
    await user.clear(screen.getByLabelText(/^Repite la contraseña nueva/));
    await user.type(screen.getByLabelText(/^Repite la contraseña nueva/), 'clave-nueva-larga');
    await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
    expect(await screen.findByText('La contraseña actual no es correcta.')).toBeInTheDocument();
    expect(api.requests('POST', '/api/auth/change-password')[0]?.body).toEqual({
      currentPassword: 'vieja-clave',
      newPassword: 'clave-nueva-larga',
    });
  });

  it('switches language (saved on the profile) and theme', async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const api = createFakeApi(session);
    api.on('PATCH', '/api/auth/me', ({ body }) => ({ ...session.user, ...(body as object) }));
    mount('/settings/preferences', api);

    await user.click(await screen.findByRole('radio', { name: /English/ }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Language and theme' }),
    ).toBeInTheDocument();
    expect(api.requests('PATCH', '/api/auth/me')[0]?.body).toEqual({ locale: 'en' });

    await user.click(screen.getByRole('radio', { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('parlante.theme')).toBe('dark');
    await user.click(screen.getByRole('radio', { name: /Light/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('workspace', () => {
  it('lets an admin rename it, shows which engines are in basic mode and reserves deletion to owners', async () => {
    const user = userEvent.setup();
    const session = makeSession('admin');
    const api = createFakeApi(session);
    api.on('PATCH', '/api/workspaces/current', ({ body }) => ({
      id: WS_A,
      name: (body as { name: string }).name,
      plan: 'creator',
      credits: 212,
      createdAt: NOW,
    }));
    mount('/settings/workspace', api);

    const name = await screen.findByLabelText(/^Nombre del workspace/);
    await user.clear(name);
    await user.type(name, 'Estudio Sur');
    await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() =>
      expect(api.requests('PATCH', '/api/workspaces/current')[0]?.body).toEqual({
        name: 'Estudio Sur',
      }),
    );

    const engines = screen.getByRole('region', { name: 'Motores de IA de esta instalación' });
    expect(await within(engines).findByText('9 de 9 en modo básico')).toBeInTheDocument();
    expect(within(engines).getByText('Modo básico · eSpeak NG')).toBeInTheDocument();
    expect(within(engines).getByText(/no está en marcha/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Eliminar workspace' })).toBeDisabled();
    expect(
      screen.getByText('Solo un propietario puede eliminar el workspace.'),
    ).toBeInTheDocument();
  });

  it('deletes the workspace only after its name is typed', async () => {
    const user = userEvent.setup();
    const session = makeSession('owner');
    const api = createFakeApi(session);
    api.on('DELETE', '/api/workspaces/current', () => {
      api.setSession({
        ...session,
        workspaces: session.workspaces.slice(1),
        currentWorkspaceId: session.workspaces[1]?.id ?? '',
      });
      return { ok: true };
    });
    const { router } = mount('/settings/workspace', api);

    await user.click(await screen.findByRole('button', { name: 'Eliminar workspace' }));
    const dialog = await screen.findByRole('dialog', { name: '¿Eliminar «Estudio Norte»?' });
    const confirm = within(dialog).getByRole('button', { name: 'Eliminar para siempre' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Escribe «Estudio Norte»/), 'Estudio Norte');
    await user.click(confirm);

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.requests('DELETE', '/api/workspaces/current')).toHaveLength(1);
  });
});

describe('members', () => {
  function membersApi(role: 'owner' | 'admin' | 'viewer', invites = [makeInvite(1)]) {
    const api = createFakeApi(makeSession(role));
    api.on('GET', '/api/members', () => ({ items: makeTeam(role) }));
    api.on('GET', '/api/invites', () => ({ items: invites }));
    return api;
  }

  it('counts members and pending invitations as seats and blocks inviting when full', async () => {
    const api = membersApi('owner');
    mount('/settings/members', api);

    // 4 members + 1 pending invitation of the 5 seats of Creator: full.
    const seats = await screen.findByRole('meter', { name: 'Plazas del plan Creator' });
    expect(seats).toHaveAttribute('aria-valuetext', '5 de 5');
    expect(screen.getByText('No quedan plazas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invitar' })).toBeDisabled();
  });

  it('creates an invitation and says that no e-mail is sent', async () => {
    const user = userEvent.setup();
    const api = membersApi('owner', []);
    api.on('POST', '/api/invites', () => makeInviteCreated({ email: 'nueva@ejemplo.com' }));
    mount('/settings/members', api);

    await user.click(await screen.findByRole('button', { name: 'Invitar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invitar a una persona' });
    await user.click(within(dialog).getByRole('button', { name: 'Crear invitación' }));
    expect(within(dialog).getByText('Escribe un correo electrónico válido.')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/Correo de la persona/), ' Nueva@Ejemplo.com ');
    await user.click(within(dialog).getByRole('button', { name: 'Crear invitación' }));

    const created = await screen.findByRole('dialog', { name: 'Invitación creada' });
    expect(api.requests('POST', '/api/invites')[0]?.body).toEqual({
      email: 'nueva@ejemplo.com',
      role: 'editor',
    });
    expect(within(created).getByLabelText('Enlace de invitación')).toHaveValue(
      'http://localhost:5173/invite/tok_0123456789abcdefghij',
    );
    expect(within(created).getByText(/Parlante no envía correos/)).toBeInTheDocument();
  });

  it('applies the role rules: an admin manages editors and viewers only', async () => {
    const user = userEvent.setup();
    const api = membersApi('admin', []);
    const patched = vi.fn();
    api.on('PATCH', /^\/api\/members\/(mem_\w+)$/, ({ body, match }) => {
      patched(match[1], body);
      return { ...makeTeam('admin')[3], role: (body as { role: 'editor' }).role };
    });
    mount('/settings/members', api);

    // Editors and viewers get a role selector; owners and admins do not.
    expect(await screen.findByRole('combobox', { name: 'Rol de Pau Roca' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Rol de Irene Sanz' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Rol de Marcos Vidal' })).not.toBeInTheDocument();
    expect(
      screen.getAllByRole('img', {
        name: 'Solo un propietario puede cambiar el rol de administradores y propietarios.',
      }).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole('combobox', { name: 'Rol de Pau Roca' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Editor', 'Lector']);
    await user.click(screen.getByRole('option', { name: 'Editor' }));
    await waitFor(() =>
      expect(patched).toHaveBeenCalledWith('mem_0004abcdefgh1234', { role: 'editor' }),
    );
  });

  it('is read-only for a viewer, who can still leave', async () => {
    const api = membersApi('viewer');
    mount('/settings/members', api);

    expect(await screen.findByText(/Invitar, cambiar roles y quitar miembros/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invitar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Invitaciones pendientes' }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Salir del workspace' })).toBeInTheDocument();
    expect(api.calls).not.toContain('GET /api/invites');
  });
});

describe('billing', () => {
  function billingApi(role: 'owner' | 'admin' = 'owner') {
    const api = createFakeApi(makeSession(role));
    api.on('GET', '/api/billing', () => makeBilling());
    api.on('GET', '/api/billing/ledger', () => ({
      items: [
        makeLedgerEntry(1, { delta: -4, balanceAfter: 212, reason: 'render' }),
        makeLedgerEntry(2, {
          delta: 300,
          balanceAfter: 216,
          reason: 'plan_grant',
          description: 'Creator plan credits (simulated checkout)',
        }),
      ],
      nextCursor: null,
    }));
    return api;
  }

  it('says billing is simulated, shows the balance, the usage, the plans and the ledger', async () => {
    const api = billingApi();
    mount('/settings/billing', api);

    expect(await screen.findByText('En esta instalación no se cobra nada')).toBeInTheDocument();
    expect(screen.getByText('Facturación simulada')).toBeInTheDocument();

    const balance = await screen.findByRole('region', { name: 'Saldo' });
    expect(within(balance).getByText('212')).toBeInTheDocument();
    expect(within(balance).getByText('Plan Creator')).toBeInTheDocument();
    expect(within(balance).getByRole('meter', { name: 'Almacenamiento' })).toHaveAttribute(
      'aria-valuetext',
      '5 GB de 20 GB',
    );

    const plans = screen.getByRole('region', { name: 'Planes' });
    expect(within(plans).getByRole('heading', { name: 'Free' })).toBeInTheDocument();
    expect(within(plans).getByText('Plan actual')).toBeInTheDocument();
    expect(within(plans).getByRole('button', { name: 'Subir a Team' })).toBeEnabled();
    expect(within(plans).getByRole('button', { name: 'Bajar a Free' })).toBeEnabled();
    expect(within(plans).getByText('1500 créditos al mes')).toBeInTheDocument();

    const ledger = screen.getByRole('table', { name: 'Libro de créditos' });
    expect(await within(ledger).findByText('Render de vídeo')).toBeInTheDocument();
    expect(within(ledger).getByText('−4')).toBeInTheDocument();
    expect(within(ledger).getByText('+300')).toBeInTheDocument();
    expect(within(ledger).getByText('Créditos del plan')).toBeInTheDocument();
  });

  it('changes plan after a confirmation that repeats that nothing is charged', async () => {
    const user = userEvent.setup();
    const api = billingApi();
    api.on('POST', '/api/billing/change-plan', () => ({
      workspace: { id: WS_A, name: 'Estudio Norte', plan: 'team', credits: 1712, createdAt: NOW },
      entry: makeLedgerEntry(3, { delta: 1500, balanceAfter: 1712, reason: 'plan_grant' }),
      simulated: true,
    }));
    mount('/settings/billing', api);

    await user.click(await screen.findByRole('button', { name: 'Subir a Team' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cambiar al plan Team' });
    expect(within(dialog).getByText('Pago simulado: no se cobra nada')).toBeInTheDocument();
    expect(within(dialog).getByText(/añade 1500 créditos del plan nuevo/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cambiar a Team' }));

    expect(await screen.findByText('El workspace está ahora en el plan Team')).toBeInTheDocument();
    expect(api.requests('POST', '/api/billing/change-plan')[0]?.body).toEqual({ planId: 'team' });
  });

  it('explains which limits block a downgrade', async () => {
    const user = userEvent.setup();
    const api = billingApi();
    api.on('POST', '/api/billing/change-plan', () =>
      apiError(409, 'INVALID_STATE', 'The workspace uses more than the Free plan allows', {
        exceeded: [
          { limit: 'maxMembers', max: 2, value: 4 },
          { limit: 'maxStorageBytes', max: 1024 ** 3, value: 5 * 1024 ** 3 },
        ],
      }),
    );
    mount('/settings/billing', api);

    await user.click(await screen.findByRole('button', { name: 'Bajar a Free' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cambiar al plan Free' });
    await user.click(within(dialog).getByRole('button', { name: 'Cambiar a Free' }));
    expect(
      await within(dialog).findByText('El workspace usa más de lo que permite el plan Free'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Miembros: usas 4 y el plan admite 2.')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Almacenamiento: usas 5 GB y el plan admite 1 GB.'),
    ).toBeInTheDocument();
  });

  it('shows everything to an admin but keeps plan changes for owners', async () => {
    const api = billingApi('admin');
    mount('/settings/billing', api);

    expect(
      await screen.findByText(/Solo un propietario puede cambiar de plan o añadir créditos/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir a Team' })).toBeDisabled();
    for (const pack of screen.getAllByRole('button', { name: /créditos$/ })) {
      expect(pack).toBeDisabled();
    }
    expect(PLANS.creator.limits.maxMembers).toBe(5);
  });
});

describe('API keys', () => {
  it('shows a new key exactly once, with a copy button, and can revoke keys', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const keys = [makeApiKey(1, { name: 'Servidor', lastUsedAt: NOW })];
    const api = createFakeApi(makeSession('admin'));
    api.on('GET', '/api/api-keys', () => ({ items: keys }));
    api.on('POST', '/api/api-keys', ({ body }) => {
      const created = makeApiKeyCreated({ name: (body as { name: string }).name });
      keys.push(makeApiKey(9, { name: created.name }));
      return new Response(JSON.stringify(created), { status: 201 });
    });
    api.on('DELETE', /^\/api\/api-keys\/key_\w+$/, () => ({ ok: true }));
    mount('/settings/api-keys', api);

    expect(await screen.findByText('Servidor')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Claves activas del plan Creator' })).toHaveAttribute(
      'aria-valuetext',
      '1 de 10',
    );

    await user.click(screen.getByRole('button', { name: 'Crear clave' }));
    const form = await screen.findByRole('dialog', { name: 'Nueva clave de API' });
    await user.type(within(form).getByLabelText(/^Nombre/), 'Integración CRM');
    await user.click(within(form).getByRole('button', { name: 'Crear clave' }));

    const created = await screen.findByRole('dialog', { name: 'Clave «Integración CRM» creada' });
    expect(within(created).getByText('Solo se muestra esta vez')).toBeInTheDocument();
    expect(within(created).getByLabelText('Tu clave')).toHaveValue(PLAIN_KEY);
    await user.click(within(created).getAllByRole('button', { name: 'Copiar' })[0] as HTMLElement);
    expect(writeText).toHaveBeenCalledWith(PLAIN_KEY);
    expect(await within(created).findAllByText('Copiado')).not.toHaveLength(0);

    await user.click(within(created).getByRole('button', { name: 'Ya la he guardado' }));
    await waitFor(() => expect(screen.queryByDisplayValue(PLAIN_KEY)).not.toBeInTheDocument());
    expect(await screen.findByText('Integración CRM')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(PLAIN_KEY);

    await user.click(screen.getAllByRole('button', { name: 'Revocar' })[0] as HTMLElement);
    const confirm = await screen.findByRole('alertdialog', {
      name: '¿Revocar la clave «Servidor»?',
    });
    await user.click(within(confirm).getByRole('button', { name: 'Revocar' }));
    await waitFor(() => expect(api.calls).toContain('DELETE /api/api-keys/key_0001abcdefgh1234'));
  });
});

describe('webhooks', () => {
  it('creates an endpoint, shows its secret once, sends a test and resends a failed delivery', async () => {
    const user = userEvent.setup();
    const endpoints = [makeEndpoint(1, { description: 'CRM de ventas' })];
    const deliveries = [
      makeDelivery(1, {
        status: 'failed',
        attempts: 5,
        responseStatus: 500,
        error: 'HTTP 500',
        deliveredAt: null,
      }),
      makeDelivery(2),
    ];
    const api = createFakeApi(makeSession('admin'));
    api.on('GET', '/api/webhooks', () => ({ items: endpoints }));
    api.on('POST', '/api/webhooks', ({ body }) => {
      const created = makeEndpointCreated({ url: (body as { url: string }).url });
      endpoints.push(makeEndpoint(9, { url: created.url }));
      return new Response(JSON.stringify(created), { status: 201 });
    });
    api.on('GET', /^\/api\/webhooks\/whe_\w+\/deliveries$/, () => ({
      items: deliveries,
      nextCursor: null,
    }));
    api.on('POST', /^\/api\/webhooks\/whe_\w+\/test$/, () => {
      const ping = makeDelivery(3, { eventType: 'ping' });
      deliveries.unshift(ping);
      return new Response(JSON.stringify(ping), { status: 202 });
    });
    api.on('POST', /^\/api\/webhooks\/deliveries\/whd_\w+\/retry$/, () => {
      deliveries[deliveries.length - 2] = makeDelivery(1, { status: 'succeeded' });
      return new Response(JSON.stringify(deliveries[deliveries.length - 2]), { status: 202 });
    });
    mount('/settings/webhooks', api);

    expect(await screen.findByText('https://hooks.ejemplo.com/parlante/1')).toBeInTheDocument();
    expect(screen.getByText('CRM de ventas')).toBeInTheDocument();
    expect(screen.getByText('••••c0de')).toBeInTheDocument();

    // Create: the URL is validated before the request.
    await user.click(screen.getByRole('button', { name: 'Añadir endpoint' }));
    const form = await screen.findByRole('dialog', { name: 'Nuevo endpoint' });
    await user.type(within(form).getByLabelText(/URL del endpoint/), 'no-es-una-url');
    await user.click(within(form).getByRole('button', { name: 'Crear endpoint' }));
    expect(
      within(form).getByText('Escribe una URL completa que empiece por https:// o http://.'),
    ).toBeInTheDocument();
    await user.clear(within(form).getByLabelText(/URL del endpoint/));
    await user.type(
      within(form).getByLabelText(/URL del endpoint/),
      'https://api.cliente.com/hook',
    );
    await user.click(within(form).getByRole('checkbox', { name: /video\.failed/ }));
    await user.click(within(form).getByRole('button', { name: 'Crear endpoint' }));

    const secret = await screen.findByRole('dialog', { name: 'Endpoint creado' });
    expect(api.requests('POST', '/api/webhooks')[0]?.body).toEqual({
      url: 'https://api.cliente.com/hook',
      events: ['video.completed'],
      description: '',
    });
    expect(within(secret).getByLabelText('Secreto de firma')).toHaveValue(PLAIN_SECRET);
    await user.click(within(secret).getByRole('button', { name: 'Ya lo he guardado' }));
    await waitFor(() => expect(screen.queryByDisplayValue(PLAIN_SECRET)).not.toBeInTheDocument());

    // Test delivery opens the history of that endpoint.
    await user.click(screen.getAllByRole('button', { name: 'Enviar prueba' })[0] as HTMLElement);
    expect(await screen.findByText('Prueba en cola')).toBeInTheDocument();
    expect(await screen.findByText('ping')).toBeInTheDocument();
    expect(screen.getByText('Fallida')).toBeInTheDocument();
    expect(screen.getByText('HTTP 500', { selector: 'p.font-mono' })).toBeInTheDocument();
    expect(screen.getByText(/5 intentos · HTTP 500/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reenviar' }));
    expect(await screen.findByText('Entrega puesta en cola de nuevo')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Fallida')).not.toBeInTheDocument());
  });
});

describe('consents', () => {
  it('lists the records and explains what a revocation deletes before doing it', async () => {
    const user = userEvent.setup();
    const records = [
      makeConsent(1, { subjectName: 'Marta Ruiz' }),
      makeConsent(2, {
        subjectName: 'Óscar Peña',
        kind: 'voice_clone',
        relationship: 'authorized',
      }),
    ];
    const api = createFakeApi(makeSession('admin'));
    api.on('GET', '/api/consents', ({ url }) => ({
      items: records.filter(
        (r) => !url.searchParams.get('kind') || r.kind === url.searchParams.get('kind'),
      ),
      nextCursor: null,
    }));
    api.on('POST', /^\/api\/consents\/cns_\w+\/revoke$/, () => {
      records[0] = makeConsent(1, { subjectName: 'Marta Ruiz', revokedAt: NOW, resourceId: null });
      return records[0];
    });
    mount('/settings/consents', api);

    expect(await screen.findByRole('heading', { name: 'Marta Ruiz' })).toBeInTheDocument();
    expect(screen.getByText(/Con autorización de la persona/)).toBeInTheDocument();
    expect(screen.getByText(/Declaro que soy la persona que aparece/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Clonado de voz' }));
    await waitFor(() => expect(api.calls).toContain('GET /api/consents?limit=20&kind=voice_clone'));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Marta Ruiz' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('radio', { name: 'Todos' }));

    const card = (await screen.findByRole('heading', { name: 'Marta Ruiz' })).closest(
      'li',
    ) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Revocar' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: '¿Revocar el consentimiento de Marta Ruiz?',
    });
    expect(within(dialog).getByText('El avatar creado con esta declaración.')).toBeInTheDocument();
    expect(within(dialog).getByText('La fotografía original que se subió.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Los vídeos ya renderizados/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Revocar y borrar' }));

    expect(
      await screen.findByText('Consentimiento de Marta Ruiz revocado y sus datos borrados'),
    ).toBeInTheDocument();
    expect(api.calls).toContain('POST /api/consents/cns_0001abcdefgh1234/revoke');
    expect(await screen.findByText(/^Revocado el/)).toBeInTheDocument();
  });
});

describe('invitation page', () => {
  const lookup = {
    workspaceName: 'Estudio Norte',
    email: 'nueva@ejemplo.com',
    role: 'editor',
    expired: false,
    accepted: false,
  };

  it('sends an anonymous visitor to sign up with the token or to sign in and come back', async () => {
    const api = createFakeApi(null);
    api.on('GET', '/api/invites/lookup/tok_0123456789abcdefghij', () => lookup);
    mount('/invite/tok_0123456789abcdefghij', api);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Te invitan a Estudio Norte' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Crear una cuenta y unirme' })).toHaveAttribute(
      'href',
      '/register?invite=tok_0123456789abcdefghij',
    );
    expect(screen.getByRole('link', { name: 'Ya tengo cuenta' })).toHaveAttribute(
      'href',
      '/login?next=%2Finvite%2Ftok_0123456789abcdefghij',
    );
  });

  it('lets a signed-in visitor accept and lands on the new workspace', async () => {
    const user = userEvent.setup();
    const session = makeSession('owner');
    const api = createFakeApi(session);
    api.on('GET', '/api/invites/lookup/tok_0123456789abcdefghij', () => lookup);
    api.on('POST', '/api/invites/accept', () => session);
    const { router } = mount('/invite/tok_0123456789abcdefghij', api);

    expect(await screen.findByText(/la invitación es para nueva@ejemplo.com/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unirme al workspace' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(api.requests('POST', '/api/invites/accept')[0]?.body).toEqual({
      token: 'tok_0123456789abcdefghij',
    });
  });

  it('says so when the invitation expired or does not exist', async () => {
    const api = createFakeApi(null);
    api.on('GET', '/api/invites/lookup/tok_0123456789abcdefghij', () => ({
      ...lookup,
      expired: true,
    }));
    mount('/invite/tok_0123456789abcdefghij', api);
    expect(await screen.findByText(/Esta invitación ha caducado/)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Crear una cuenta y unirme' }),
    ).not.toBeInTheDocument();
  });
});
