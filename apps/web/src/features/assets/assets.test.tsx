import type { Asset } from '@parlante/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { defineFeature } from '@/shell';
import { Button, toast } from '@/ui';
import {
  apiError,
  createFakeApi,
  makeBilling,
  makeSession,
  renderFeatures,
  resetApiClient,
  watchContractWarnings,
} from '../videos/testing/harness';
import type { FakeApi } from '../videos/testing/harness';
import assets from './index';
import { AssetPicker } from './picker';
import type { PickedMedia } from './picker';
import { makeAsset, makeStock, pngFile, stubUploads } from './testing/harness';

let contract: ReturnType<typeof watchContractWarnings>;
let uploadsStub: ReturnType<typeof stubUploads> | null = null;
beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('es');
  contract = watchContractWarnings();
});
afterEach(() => {
  contract.assert();
  contract.restore();
  uploadsStub?.restore();
  uploadsStub = null;
  resetApiClient();
  toast.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Fake API with a mutable asset list that honours `kind` and `q`. */
function libraryApi(role: 'owner' | 'editor' | 'viewer', initial: Asset[]) {
  const api = createFakeApi(makeSession(role));
  const store = { items: [...initial] };
  api.on('GET', '/api/billing', () => makeBilling());
  api.on('GET', '/api/assets', ({ url }) => {
    const kind = url.searchParams.get('kind');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return {
      items: store.items.filter(
        (asset) => (!kind || asset.kind === kind) && asset.name.toLowerCase().includes(q),
      ),
      nextCursor: null,
    };
  });
  return { api, store };
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

const LIBRARY = () => [
  makeAsset(1, { name: 'Logo de marca' }),
  makeAsset(2, { name: 'Fondo oficina', kind: 'video' }),
  makeAsset(3, { name: 'Sintonía', kind: 'audio' }),
];

describe('asset library', () => {
  it('lists the files with their facts and the storage in use', async () => {
    const { api } = libraryApi('owner', LIBRARY());
    renderFeatures([assets], '/assets', api);

    const list = await screen.findByRole('list', { name: 'Archivos de la biblioteca' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(within(cards[0] as HTMLElement).getByText('Logo de marca')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText(/2,4 MB · 1920 × 1080/)).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText(/2,4 MB · 1:05/)).toBeInTheDocument();
    // Thumbnails are served from the app origin in development.
    expect((cards[0] as HTMLElement).querySelector('img')?.getAttribute('src')).toMatch(
      /^\/api\/files\/.+thumb\.jpg/,
    );

    const storage = await screen.findByRole('meter', { name: 'Almacenamiento del workspace' });
    await waitFor(() => expect(storage).toHaveAttribute('aria-valuetext', '5 GB de 20 GB'));
    expect(screen.getByText('Hasta 500 MB por archivo en el plan Creator.')).toBeInTheDocument();
    expect(api.calls).toContain('GET /api/assets?limit=30');
  });

  it('filters by kind and by name through the API', async () => {
    const user = userEvent.setup();
    const { api } = libraryApi('owner', LIBRARY());
    renderFeatures([assets], '/assets', api);
    await screen.findByText('Logo de marca');

    await user.click(screen.getByRole('radio', { name: 'Audios' }));
    await waitFor(() => expect(api.calls).toContain('GET /api/assets?limit=30&kind=audio'));
    await waitFor(() => expect(screen.queryByText('Logo de marca')).not.toBeInTheDocument());
    expect(screen.getByText('Sintonía')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Buscar por nombre' }), 'nada');
    await waitFor(() => expect(api.calls).toContain('GET /api/assets?limit=30&kind=audio&q=nada'));
    expect(await screen.findByText('Nada coincide')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Quitar filtros' }));
    expect(await screen.findByText('Fondo oficina')).toBeInTheDocument();
  });

  it('uploads with progress, refuses what the plan does not allow and shows server errors', async () => {
    const { api, store } = libraryApi('editor', []);
    uploadsStub = stubUploads(api);
    renderFeatures([assets], '/assets', api);
    expect(await screen.findByText('La biblioteca está vacía')).toBeInTheDocument();

    const huge = new File([new Uint8Array(8)], 'pelicula.mp4', { type: 'video/mp4' });
    Object.defineProperty(huge, 'size', { value: 600 * 1024 * 1024 });
    const files = [
      pngFile('logo final.png'),
      new File(['x'], 'contrato.pdf', { type: 'application/pdf' }),
      huge,
      pngFile('falso.png'),
    ];
    fireEvent.change(fileInput(), { target: { files } });

    const queue = await screen.findByRole('region', {
      name: 'Arrastra archivos aquí o haz clic para elegirlos',
    });
    expect(
      within(queue).getByText('Formato no admitido. Sube imágenes, vídeo o audio.'),
    ).toBeInTheDocument();
    expect(
      within(queue).getByText('Supera el máximo de 500 MB por archivo de tu plan.'),
    ).toBeInTheDocument();

    // Only the two accepted files were sent, each with its display name.
    await waitFor(() => expect(uploadsStub?.uploads).toHaveLength(2));
    const [first, second] = uploadsStub.uploads;
    expect(first?.fields).toEqual({ name: 'logo final' });
    expect(first?.file.name).toBe('logo final.png');

    act(() => first?.progress(0.4));
    const bar = await within(queue).findByRole('progressbar', {
      name: 'Subida de logo final.png',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    act(() => first?.progress(1));
    expect(await within(queue).findByText('Procesando el archivo…')).toBeInTheDocument();

    const created = makeAsset(7, { name: 'logo final' });
    store.items.unshift(created);
    act(() => first?.respond(201, created));
    act(() =>
      second?.respond(415, {
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The file is not a PNG image' },
      }),
    );

    expect(await within(queue).findByText('Subido')).toBeInTheDocument();
    expect(
      await within(queue).findByText(
        'Ese tipo de archivo no está admitido. Detalle técnico (en inglés): The file is not a PNG image',
      ),
    ).toBeInTheDocument();
    expect(within(queue).getByRole('status')).toHaveTextContent(
      '1 archivo subido · 3 no se han subido',
    );
    // The new file reaches the grid without reloading the page.
    const list = await screen.findByRole('list', { name: 'Archivos de la biblioteca' });
    expect(within(list).getByText('logo final')).toBeInTheDocument();
  });

  it('cancels an upload in flight and can retry it', async () => {
    const user = userEvent.setup();
    const { api } = libraryApi('editor', LIBRARY());
    uploadsStub = stubUploads(api);
    renderFeatures([assets], '/assets', api);
    await screen.findByText('Logo de marca');

    fireEvent.change(fileInput(), { target: { files: [pngFile('lento.png')] } });
    await waitFor(() => expect(uploadsStub?.uploads).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Cancelar la subida de lento.png' }));
    expect(await screen.findByText('Subida cancelada')).toBeInTheDocument();
    expect(uploadsStub.uploads[0]?.aborted).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Reintentar la subida de lento.png' }));
    await waitFor(() => expect(uploadsStub?.uploads).toHaveLength(2));
  });

  it('previews, renames and deletes, explaining why a source file cannot be deleted', async () => {
    const user = userEvent.setup();
    const { api, store } = libraryApi('editor', LIBRARY());
    api.on('PATCH', /^\/api\/assets\/(ast_\w+)$/, ({ body, match }) => {
      const index = store.items.findIndex((asset) => asset.id === match[1]);
      const next = { ...(store.items[index] as Asset), name: (body as { name: string }).name };
      store.items[index] = next;
      return next;
    });
    let blocked = true;
    api.on('DELETE', /^\/api\/assets\/(ast_\w+)$/, ({ match }) => {
      if (blocked) {
        return apiError(409, 'CONFLICT', 'This file is the source of another resource', {
          usedBy: [{ type: 'avatar', id: 'avt_0001abcdefgh1234' }],
        });
      }
      store.items = store.items.filter((asset) => asset.id !== match[1]);
      return { ok: true };
    });
    renderFeatures([assets], '/assets', api);

    await user.click(await screen.findByRole('button', { name: 'Vista previa de Logo de marca' }));
    const preview = await screen.findByRole('dialog', { name: 'Logo de marca' });
    expect(within(preview).getByRole('img', { name: 'Imagen: Logo de marca' })).toHaveAttribute(
      'src',
      expect.stringMatching(/^\/api\/files\/.+file\.png/),
    );
    expect(within(preview).getByText('1920 × 1080 px')).toBeInTheDocument();
    expect(within(preview).getByText('image/png')).toBeInTheDocument();

    await user.click(within(preview).getByRole('button', { name: 'Renombrar' }));
    const rename = await screen.findByRole('dialog', { name: 'Renombrar archivo' });
    const input = within(rename).getByLabelText(/^Nombre/);
    await user.clear(input);
    await user.type(input, 'Logo 2027');
    await user.click(within(rename).getByRole('button', { name: 'Guardar nombre' }));
    expect(await screen.findByRole('dialog', { name: 'Logo 2027' })).toBeInTheDocument();
    expect(api.requests('PATCH', /^\/api\/assets\//)[0]?.body).toEqual({ name: 'Logo 2027' });

    await user.click(
      within(screen.getByRole('dialog', { name: 'Logo 2027' })).getByRole('button', {
        name: 'Borrar',
      }),
    );
    const confirm = await screen.findByRole('alertdialog', { name: '¿Borrar «Logo 2027»?' });
    await user.click(within(confirm).getByRole('button', { name: 'Borrar archivo' }));
    expect(
      await within(confirm).findByText(/No se puede borrar: es el origen de otro recurso/),
    ).toBeInTheDocument();
    expect(within(confirm).getByText('Avatar desde foto')).toBeInTheDocument();
    expect(within(confirm).getByText('avt_0001abcdefgh1234')).toBeInTheDocument();

    blocked = false;
    await user.click(within(confirm).getByRole('button', { name: 'Borrar archivo' }));
    expect(await screen.findByText('«Logo 2027» borrado')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Archivos de la biblioteca' })).queryByText(
          'Logo 2027',
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it('is read-only for a viewer, with the reason', async () => {
    const user = userEvent.setup();
    const { api } = libraryApi('viewer', LIBRARY());
    renderFeatures([assets], '/assets', api);

    expect(await screen.findByText(/Tu rol es Lector/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subir archivos' })).not.toBeInTheDocument();
    expect(fileInput()).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Acciones de Logo de marca' }));
    expect(await screen.findByRole('menuitem', { name: 'Descargar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Borrar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Renombrar' })).not.toBeInTheDocument();
  });

  it('shows the error state with a retry', async () => {
    const user = userEvent.setup();
    const { api } = libraryApi('owner', LIBRARY());
    let fail = true;
    api.on('GET', '/api/assets', () =>
      fail ? apiError(503, 'SERVICE_UNAVAILABLE', 'down') : { items: LIBRARY(), nextCursor: null },
    );
    renderFeatures([assets], '/assets', api);

    expect(
      await screen.findByText('El servicio no está disponible en este momento'),
    ).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Logo de marca')).toBeInTheDocument();
  });
});

describe('asset picker', () => {
  function Host({ onPicked }: { onPicked: (picked: PickedMedia) => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Elegir fondo</Button>
        <AssetPicker open={open} onOpenChange={setOpen} kinds={['image']} onSelect={onPicked} />
      </>
    );
  }
  const host = (onPicked: (picked: PickedMedia) => void) =>
    defineFeature({
      id: 'host',
      routes: [{ path: '/host', layout: 'app', component: () => <Host onPicked={onPicked} /> }],
    });

  function pickerApi(): { api: FakeApi; store: { items: Asset[] } } {
    const { api, store } = libraryApi('editor', LIBRARY());
    api.on('GET', '/api/stock-assets', () => ({
      items: [makeStock('aurora'), makeStock('pulso', { kind: 'audio', category: 'music' })],
    }));
    return { api, store };
  }

  it('offers only the kinds the slot accepts and returns a MediaRef', async () => {
    const user = userEvent.setup();
    const onPicked = vi.fn();
    const { api } = pickerApi();
    renderFeatures([assets, host(onPicked)], '/host', api);

    await user.click(await screen.findByRole('button', { name: 'Elegir fondo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Elegir un archivo' });
    await waitFor(() => expect(api.calls).toContain('GET /api/assets?limit=24&kind=image'));
    const results = await within(dialog).findByRole('list', { name: 'Archivos disponibles' });
    expect(within(results).getAllByRole('button')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Usar este archivo' })).toBeDisabled();

    await user.click(within(results).getByRole('button', { name: /Logo de marca/ }));
    expect(within(dialog).getByText('Seleccionado: Logo de marca')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Usar este archivo' }));

    expect(onPicked).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { source: 'asset', assetId: 'ast_0001abcdefgh1234' },
        source: 'asset',
        kind: 'image',
        name: 'Logo de marca',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('offers the built-in stock media and selects a file uploaded from inside', async () => {
    const user = userEvent.setup();
    const onPicked = vi.fn();
    const { api, store } = pickerApi();
    const uploaded = makeAsset(8, { name: 'recien subido' });
    uploadsStub = stubUploads(api, () => {
      store.items.unshift(uploaded);
      return { status: 201, body: uploaded };
    });
    renderFeatures([assets, host(onPicked)], '/host', api);

    await user.click(await screen.findByRole('button', { name: 'Elegir fondo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Elegir un archivo' });

    // Upload from inside: the new file is selected automatically.
    fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [pngFile('recien subido.png')] },
    });
    expect(await within(dialog).findByText('Seleccionado: recien subido')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('tab', { name: 'Stock incluido' }));
    await waitFor(() => expect(api.calls).toContain('GET /api/stock-assets?kind=image'));
    const stock = await within(dialog).findByRole('button', { name: /Fondo aurora/ });
    await user.dblClick(stock);
    expect(onPicked).toHaveBeenCalledWith(
      expect.objectContaining({ ref: { source: 'stock', stockId: 'aurora' }, source: 'stock' }),
    );
  });
});
