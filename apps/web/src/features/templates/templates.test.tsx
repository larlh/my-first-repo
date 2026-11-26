import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  apiError,
  createFakeApi,
  makeSession,
  makeVideo,
  renderFeatures,
} from '@/features/videos/testing/harness';
import avatars from '@/features/avatars';
import { makeTemplate, makeTemplateDetail } from '@/features/avatars/kit/testing/fixtures';
import { others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import type { FakeApi } from '@/features/videos/testing/harness';
import templates from './index';

const builtin = [
  makeTemplate('explainer', { name: 'Vídeo explicativo' }),
  makeTemplate('vertical-ad', { name: 'Anuncio vertical', category: 'ad', aspect: '9:16' }),
];
const custom = makeTemplate('mio', { kind: 'custom', name: 'Mi formación', category: 'training' });

function withGallery(api: FakeApi, items = [...builtin, custom]): FakeApi {
  return api
    .on('GET', '/api/templates', () => ({ items }))
    .on('GET', /^\/api\/templates\/([a-z0-9_-]+)$/, ({ match }) => {
      const template = items.find((item) => item.id === match[1]);
      return template ? makeTemplateDetail(template) : apiError(404, 'NOT_FOUND');
    })
    .on('GET', '/api/stock-assets', () => ({ items: [] }));
}

describe('template gallery', () => {
  usePageTestSetup();

  it('lists built-in and custom templates with poster, format and scene count', async () => {
    renderFeatures([templates, avatars, others], '/templates', withGallery(createFakeApi()));
    expect(await screen.findByRole('img', { name: 'Póster de Vídeo explicativo' })).toHaveAttribute(
      'src',
      '/api/templates/builtin_explainer/thumbnail',
    );
    // Custom templates may have no poster: a labelled placeholder, not a broken image.
    expect(
      screen.getByRole('img', { name: 'La plantilla Mi formación no tiene póster' }),
    ).toBeVisible();
    expect(screen.getAllByText('2 escenas')).toHaveLength(3);
    // Once as the format filter and once on the vertical card.
    expect(screen.getAllByText('9:16')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Propias/ })).toHaveTextContent('Propias1');
  });

  it('filters by format and category', async () => {
    const user = userEvent.setup();
    const { router } = renderFeatures(
      [templates, avatars, others],
      '/templates',
      withGallery(createFakeApi()),
    );
    await screen.findByRole('img', { name: 'Póster de Vídeo explicativo' });
    await user.click(screen.getByRole('radio', { name: 'Vertical 9:16' }));
    expect(router.state.location.search).toBe('?aspect=9%3A16');
    expect(screen.getAllByRole('button', { name: /Vista previa de la plantilla/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Quitar filtros' }));
    expect(screen.getAllByRole('button', { name: /Vista previa de la plantilla/ })).toHaveLength(3);
  });

  it('uses a template straight from its card and opens the draft in the Studio', async () => {
    const user = userEvent.setup();
    const api = withGallery(createFakeApi()).on(
      'POST',
      /^\/api\/templates\/([a-z0-9_-]+)\/use$/,
      () => makeVideo(3, { status: 'draft', source: 'template' }),
    );
    const { router } = renderFeatures([templates, avatars, others], '/templates', api);
    await screen.findByRole('img', { name: 'Póster de Vídeo explicativo' });
    await user.click(screen.getAllByRole('button', { name: 'Usar plantilla' })[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/studio\/vid_/));
    const request = api.requests('POST', /\/use$/)[0];
    expect(request?.url.pathname).toBe('/api/templates/builtin_explainer/use');
    expect(request?.body).toEqual({});
  });

  it('previews a template: scenes, example values of its variables and a custom title', async () => {
    const user = userEvent.setup();
    const api = withGallery(createFakeApi()).on(
      'POST',
      /^\/api\/templates\/([a-z0-9_-]+)\/use$/,
      () => makeVideo(4, { status: 'draft', source: 'template' }),
    );
    renderFeatures([templates, avatars, others], '/templates?template=builtin_explainer', api);
    const dialog = await screen.findByRole('dialog', { name: 'Vídeo explicativo' });
    expect(
      await within(dialog).findByRole('img', { name: 'Vista previa de Vídeo explicativo' }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Vista previa sin sonido y con tiempos estimados/),
    ).toBeVisible();
    // The undeclared {{nombre}} placeholder resolves to nothing in the preview script.
    expect(within(dialog).getByText('Hola, . Esto es una plantilla.')).toBeVisible();
    expect(within(dialog).getByText('Sin narración')).toBeVisible();

    await user.type(
      within(dialog).getByRole('textbox', { name: 'Título del vídeo nuevo' }),
      'Mi vídeo',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Usar plantilla' }));
    await waitFor(() =>
      expect(api.requests('POST', /\/use$/)[0]?.body).toEqual({ title: 'Mi vídeo' }),
    );
  });

  it('edits and deletes only custom templates', async () => {
    const user = userEvent.setup();
    const api = withGallery(createFakeApi())
      .on('PATCH', /^\/api\/templates\/tpl_/, ({ body }) => ({
        ...custom,
        ...(body as object),
      }))
      .on('DELETE', /^\/api\/templates\/tpl_/, () => ({ ok: true }));
    const { router } = renderFeatures(
      [templates, avatars, others],
      `/templates?template=${custom.id}`,
      api,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Mi formación' });
    await user.click(within(dialog).getByRole('button', { name: 'Editar datos' }));
    const name = within(dialog).getByRole('textbox', { name: /Nombre/ });
    await user.clear(name);
    await user.type(name, 'Formación interna');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() =>
      expect(api.requests('PATCH', /^\/api\/templates\/tpl_/)[0]?.body).toMatchObject({
        name: 'Formación interna',
        category: 'training',
      }),
    );

    await user.click(await within(dialog).findByRole('button', { name: 'Eliminar plantilla' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Eliminar plantilla' }));
    await waitFor(() => expect(api.requests('DELETE', /^\/api\/templates\/tpl_/)).toHaveLength(1));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('keeps built-in templates read-only and viewers from using any', async () => {
    renderFeatures(
      [templates, avatars, others],
      '/templates?template=builtin_explainer',
      withGallery(createFakeApi(makeSession('viewer'))),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Vídeo explicativo' });
    expect(within(dialog).queryByRole('button', { name: 'Editar datos' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Usar plantilla' })).toBeDisabled();
  });
});
