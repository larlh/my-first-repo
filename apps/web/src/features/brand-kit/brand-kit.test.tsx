import { CreateBrandKitBodySchema } from '@parlante/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeApi, makeSession, renderFeatures } from '@/features/videos/testing/harness';
import type { FakeApi } from '@/features/videos/testing/harness';
import assets from '@/features/assets';
import avatars from '@/features/avatars';
import { makeBrandKit } from '@/features/avatars/kit/testing/fixtures';
import { others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import brandKit from './index';

function withKits(api: FakeApi, items = [makeBrandKit(1), makeBrandKit(2)]): FakeApi {
  const store = [...items];
  return api
    .on('GET', '/api/brand-kits', () => ({ items: store }))
    .on('GET', '/api/stock-assets', () => ({ items: [] }))
    .on('POST', '/api/brand-kits', ({ body }) => {
      const kit = makeBrandKit(9, CreateBrandKitBodySchema.parse(body));
      store.push(kit);
      return new Response(JSON.stringify(kit), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    })
    .on('PATCH', /^\/api\/brand-kits\/(bk_[a-z0-9]+)$/, ({ body, match }) => {
      const index = store.findIndex((kit) => kit.id === match[1]);
      const next = makeBrandKit(index + 1, { ...store[index], ...(body as object) });
      store[index] = next;
      return next;
    })
    .on('DELETE', /^\/api\/brand-kits\/(bk_[a-z0-9]+)$/, ({ match }) => {
      store.splice(
        store.findIndex((kit) => kit.id === match[1]),
        1,
      );
      return { ok: true };
    });
}

const features = [brandKit, assets, avatars, others];

describe('brand kit', () => {
  usePageTestSetup();

  it('starts a first kit from the defaults and creates it', async () => {
    const user = userEvent.setup();
    const api = withKits(createFakeApi(), []);
    const { router } = renderFeatures(features, '/brand-kit', api);
    expect(await screen.findByText('Todavía no hay ningún kit')).toBeVisible();
    expect(
      screen.getByRole('img', { name: 'Escena de ejemplo con el kit Mi marca' }),
    ).toBeInTheDocument();

    const name = screen.getByRole('textbox', { name: /Nombre del kit/ });
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Crear kit' }));
    expect(await screen.findByText('Ponle un nombre al kit.')).toBeVisible();
    expect(api.requests('POST', '/api/brand-kits')).toHaveLength(0);

    await user.type(name, 'Zumos Sol');
    await user.click(screen.getByRole('button', { name: 'Crear kit' }));
    await waitFor(() => expect(api.requests('POST', '/api/brand-kits')).toHaveLength(1));
    expect(api.requests('POST', '/api/brand-kits')[0]?.body).toEqual({
      name: 'Zumos Sol',
      logoAssetId: null,
      colors: {
        primary: '#6d5efc',
        secondary: '#1b1f3b',
        accent: '#ffb547',
        background: '#0f1224',
        text: '#ffffff',
      },
      fonts: { heading: 'Poppins', body: 'Inter' },
      // The first kit of a workspace is proposed as the default one.
      isDefault: true,
    });
    await waitFor(() => expect(router.state.location.search).toMatch(/^\?kit=bk_/));
    expect(await screen.findByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
  });

  it('edits a kit: unsaved changes are flagged, saved with PATCH and can be reverted', async () => {
    const user = userEvent.setup();
    const api = withKits(createFakeApi());
    renderFeatures(features, '/brand-kit', api);
    const save = await screen.findByRole('button', { name: 'Guardar cambios' });
    expect(save).toBeDisabled();
    // The default kit is the one selected.
    expect(screen.getByRole('button', { name: /Marca 1/, pressed: true })).toBeVisible();

    await user.click(screen.getByRole('switch', { name: /Kit predeterminado/ }));
    expect(screen.getByText(/Hay cambios sin guardar/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Descartar cambios' }));
    expect(save).toBeDisabled();

    const name = screen.getByRole('textbox', { name: /Nombre del kit/ });
    await user.clear(name);
    await user.type(name, 'Marca renovada');
    await user.click(save);
    await waitFor(() => expect(api.requests('PATCH', /^\/api\/brand-kits\//)).toHaveLength(1));
    expect(api.requests('PATCH', /^\/api\/brand-kits\//)[0]?.body).toMatchObject({
      name: 'Marca renovada',
      isDefault: true,
      fonts: { heading: 'Poppins', body: 'Inter' },
    });
    expect(
      await screen.findByRole('button', { name: /Marca renovada/, pressed: true }),
    ).toBeVisible();
  });

  it('asks before throwing away unsaved changes when switching kit', async () => {
    const user = userEvent.setup();
    const { router } = renderFeatures(features, '/brand-kit', withKits(createFakeApi()));
    const name = await screen.findByRole('textbox', { name: /Nombre del kit/ });
    await user.type(name, ' X');
    await user.click(screen.getByRole('button', { name: /Marca 2/ }));
    const prompt = await screen.findByRole('alertdialog');
    expect(prompt).toHaveTextContent('¿Descartar los cambios?');
    await user.click(within(prompt).getByRole('button', { name: 'Cancelar' }));
    expect(name).toHaveValue('Marca 1 X');
    expect(router.state.location.search).toBe('');

    await user.click(screen.getByRole('button', { name: /Marca 2/ }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Descartar' }),
    );
    await waitFor(() => expect(name).toHaveValue('Marca 2'));
  });

  it('warns when the text colour will not be readable on the brand surfaces', async () => {
    const pale = makeBrandKit(1, {
      colors: {
        primary: '#fff3a0',
        secondary: '#1b1f3b',
        accent: '#ffb547',
        background: '#f4f4f4',
        text: '#ffffff',
      },
    });
    renderFeatures(features, '/brand-kit', withKits(createFakeApi(), [pale]));
    const title = await screen.findByText('Poco contraste');
    const warning = title.closest('[role="status"]');
    expect(warning).not.toBeNull();
    const items = within(warning as HTMLElement).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/El texto sobre el fondo tiene un contraste de 1,1:1/);
  });

  it('deletes a kit after confirming', async () => {
    const user = userEvent.setup();
    const api = withKits(createFakeApi());
    renderFeatures(features, '/brand-kit', api);
    await user.click(await screen.findByRole('button', { name: 'Eliminar kit' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Eliminar' }),
    );
    await waitFor(() => expect(api.requests('DELETE', /^\/api\/brand-kits\//)).toHaveLength(1));
    expect(await screen.findByRole('textbox', { name: /Nombre del kit/ })).toHaveValue('Marca 2');
  });

  it('is read-only for viewers', async () => {
    renderFeatures(features, '/brand-kit', withKits(createFakeApi(makeSession('viewer'))));
    expect(await screen.findByText(/necesitas el rol de editor/)).toBeVisible();
    expect(screen.getByRole('textbox', { name: /Nombre del kit/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Guardar cambios' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nuevo kit' })).toBeNull();
  });
});
