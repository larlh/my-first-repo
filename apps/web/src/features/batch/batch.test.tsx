import { CompositionSchema, api as contract, compositionFromScript } from '@parlante/shared';
import type { Composition } from '@parlante/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeTemplate, makeTemplateDetail } from '@/features/avatars/kit/testing/fixtures';
import { others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import { batchId, makeBatch, makeItem } from '@/features/script-writer/kit/testing/fixtures';
import {
  WS_B,
  apiError,
  createFakeApi,
  makeSession,
  makeVideo,
  renderFeatures,
  toSummary,
} from '@/features/videos/testing/harness';
import type { FakeApi } from '@/features/videos/testing/harness';
import batch from './index';
import { parseCsv } from './lib/csv';

const page = <T,>(items: T[]) => ({ items, nextCursor: null });

/** "Hola, {{nombre}}" from "{{empresa}}"; `ciudad` has a default value. */
function greeting(): Composition {
  const base = compositionFromScript(
    [
      {
        title: 'Saludo',
        text: 'Hola, {{nombre}}. Gracias por confiar en nosotros desde {{ciudad}}.',
        headline: 'Bienvenida, {{empresa}}',
      },
    ],
    { avatarId: 'stock_lucia', voiceId: 'espeak:es-f1', language: 'es' },
  );
  return CompositionSchema.parse({
    ...base,
    variables: [
      { name: 'nombre', label: 'Nombre de pila', defaultValue: '' },
      { name: 'empresa', label: '', defaultValue: '' },
      { name: 'ciudad', label: '', defaultValue: 'tu ciudad' },
    ],
  });
}

const mould = makeVideo(1, {
  title: 'Saludo a clientes',
  status: 'draft',
  composition: greeting(),
});
const plain = makeVideo(2, { title: 'Sin variables', status: 'draft' });

function withVideos(api: FakeApi): FakeApi {
  return api
    .on('GET', '/api/videos', () => page([toSummary(mould), toSummary(plain)]))
    .on('GET', `/api/videos/${mould.id}`, () => mould)
    .on('GET', `/api/videos/${plain.id}`, () => plain);
}

/** Answers the estimate like the API: one credit per row of the CSV it receives. */
function withPreview(api: FakeApi, maxRows = 50): FakeApi {
  return api.on('POST', '/api/batches/preview', ({ body }) => {
    const parsed = parseCsv((body as { csv: string }).csv);
    return {
      variables: ['nombre', 'empresa', 'ciudad'],
      columns: parsed.columns,
      rows: parsed.rows,
      missingColumns: [],
      unknownColumns: [],
      estimatedCredits: parsed.rows.length,
      maxRows,
    };
  });
}

async function chooseMould(user: ReturnType<typeof userEvent.setup>, title = 'Saludo a clientes') {
  await user.click(await screen.findByRole('radio', { name: new RegExp(title) }));
}

async function pasteData(user: ReturnType<typeof userEvent.setup>, csv: string) {
  const box = screen.getByLabelText('O pega aquí los datos');
  await user.clear(box);
  await user.click(box);
  await user.paste(csv);
}

describe('batches list', () => {
  usePageTestSetup();

  it('explains the tool when there is no batch yet', async () => {
    const api = createFakeApi().on('GET', '/api/batches', () => page([]));
    renderFeatures([batch, others], '/batch', api);
    expect(await screen.findByText('Ningún lote todavía')).toBeVisible();
    expect(screen.getByText(/Escribe {{nombre}} en el guion de un vídeo/)).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Nuevo lote' })[0]).toHaveAttribute(
      'href',
      '/batch/new',
    );
  });

  it('lists batches with their progress', async () => {
    const running = makeBatch(1, [
      makeItem(0, { nombre: 'Lucía' }, 'completed'),
      makeItem(1, { nombre: 'Marc' }, 'rendering'),
    ]);
    const api = createFakeApi().on('GET', '/api/batches', () =>
      page([running, makeBatch(2)].map(({ items: _items, variables: _variables, ...job }) => job)),
    );
    renderFeatures([batch, others], '/batch', api);
    const row = await screen.findByRole('link', { name: /Bienvenida 1/ });
    expect(row).toHaveAttribute('href', `/batch/${batchId(1)}`);
    expect(within(row).getByRole('progressbar', { name: 'Lote «Bienvenida 1»' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    expect(
      within(screen.getByRole('link', { name: /Bienvenida 2/ })).getByText(
        /2 de 2 vídeos listos · 720p/,
      ),
    ).toBeVisible();
  });
});

describe('new batch', () => {
  usePageTestSetup();

  it('maps columns by name as soon as the data arrives, whatever is chosen first', async () => {
    const user = userEvent.setup();
    const api = withPreview(withVideos(createFakeApi()));
    renderFeatures([batch, others], '/batch/new', api);

    // The mould first, the data afterwards (regression: the mapping used to stay empty).
    await chooseMould(user);
    const chips = await screen.findByRole('list', { name: 'Variables del vídeo' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['{{nombre}}', '{{ciudad}}', '{{empresa}}']);
    expect(screen.getByText('Añade los datos para asignar las columnas.')).toBeVisible();
    expect(screen.getByLabelText(/Nombre del lote/)).toHaveValue('Lote de Saludo a clientes');

    await pasteData(
      user,
      'Nombre;EMPRESA;telefono\nLucía;Ferrer Asesores;600\nMarc;Taller Riera;601\n',
    );
    expect(
      await screen.findByText('2 filas y 3 columnas leídas (separador: punto y coma).'),
    ).toBeVisible();
    expect(
      screen.getByRole('combobox', { name: 'Columna para la variable nombre' }),
    ).toHaveTextContent('Nombre');
    expect(
      screen.getByRole('combobox', { name: 'Columna para la variable empresa' }),
    ).toHaveTextContent('EMPRESA');
    // `ciudad` has a default value, so no column is fine; `telefono` feeds nothing.
    expect(
      screen.getByRole('combobox', { name: 'Columna para la variable ciudad' }),
    ).toHaveTextContent('Sin columna');
    expect(screen.getByText('Valor por defecto')).toBeVisible();
    expect(
      screen.getByText('La columna telefono no alimenta ninguna variable y se ignora.'),
    ).toBeVisible();

    // Every row as the video will get it, and how the first one reads.
    const rows = within(screen.getByRole('table', { name: 'Filas del lote' })).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Lucía');
    expect(rows[1]).toHaveTextContent('Lista');
    expect(screen.getByText('Así quedará la fila 1')).toBeVisible();
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent === 'Hola, Lucía. Gracias por confiar en nosotros desde tu ciudad.',
      ),
    ).toBeVisible();

    expect(await screen.findByText('Coste estimado: 2 créditos')).toBeVisible();
    const preview = api.requests('POST', '/api/batches/preview').at(-1)?.body as { csv: string };
    expect(contract.batches.preview.body.safeParse(preview).success).toBe(true);
    // The estimate is asked for the rows exactly as they will be sent (variable names).
    expect(preview.csv).toBe('nombre,empresa\nLucía,Ferrer Asesores\nMarc,Taller Riera\n');
  });

  it('blocks rows with missing values and unmapped variables until they are fixed', async () => {
    const user = userEvent.setup();
    const api = withPreview(withVideos(createFakeApi()));
    renderFeatures([batch, others], '/batch/new', api);
    await chooseMould(user);

    await pasteData(user, 'Cliente,empresa\nLucía,Ferrer Asesores\nMarc,\n');
    expect(
      await screen.findByText(
        'Falta asignar una columna a {{nombre}}: no tiene valor por defecto.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Lanzar el lote' })).toBeDisabled();

    // Assign the column by hand.
    await user.click(screen.getByRole('combobox', { name: 'Columna para la variable nombre' }));
    await user.click(await screen.findByRole('option', { name: 'Cliente' }));
    expect(screen.queryByText(/Falta asignar una columna/)).not.toBeInTheDocument();
    // Row 2 still lacks its company.
    expect(screen.getByText('1 fila tiene problemas (fila 2).')).toBeVisible();
    expect(screen.getByText('falta empresa')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Lanzar el lote' })).toBeDisabled();
    expect(api.requests('POST', '/api/batches/preview')).toHaveLength(0);

    // Fixing the CSV keeps the column chosen by hand.
    await pasteData(user, 'Cliente,empresa\nLucía,Ferrer Asesores\nMarc,Taller Riera\n');
    expect(await screen.findByRole('button', { name: 'Lanzar 2 vídeos' })).toBeEnabled();
    expect(
      screen.getByRole('combobox', { name: 'Columna para la variable nombre' }),
    ).toHaveTextContent('Cliente');
  });

  it('explains a CSV it cannot read and a video without variables', async () => {
    const user = userEvent.setup();
    renderFeatures([batch, others], '/batch/new', withVideos(createFakeApi()));
    await chooseMould(user, 'Sin variables');
    expect(await screen.findByText('Este vídeo no tiene variables')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Abrir en el Studio' })).toHaveAttribute(
      'href',
      `/studio/${plain.id}`,
    );
    expect(screen.getByText('Elige primero un vídeo con variables.')).toBeVisible();

    await pasteData(user, 'nombre,nombre\nLucía,Marc');
    expect(await screen.findByText('La cabecera repite la columna «nombre».')).toBeVisible();
    await pasteData(user, 'nombre,empresa');
    expect(
      await screen.findByText('Solo hay cabecera: añade una fila por cada vídeo.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Lanzar el lote' })).toBeDisabled();
  });

  it('stops at the row limit of the plan and offers only its resolutions', async () => {
    const user = userEvent.setup();
    // Free workspace: 5 rows per batch, 720p.
    const api = withPreview(
      withVideos(createFakeApi(makeSession('owner', { currentWorkspaceId: WS_B }))),
      5,
    );
    renderFeatures([batch, others], '/batch/new', api);
    await chooseMould(user);
    const six = Array.from({ length: 6 }, (_, index) => `Persona ${index + 1},Empresa`).join('\n');
    await pasteData(user, `nombre,empresa\n${six}\n`);
    expect(
      await screen.findByText(
        'El CSV tiene 6 filas y tu plan admite 5 por lote. Quita filas o divide el lote.',
      ),
    ).toBeVisible();
    expect(screen.getByText('6 filas · máximo 5')).toBeVisible();
    expect(screen.getByRole('radio', { name: '1080p' })).toBeDisabled();
    expect(screen.getByText('Tu plan renderiza a 720p como máximo.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Lanzar el lote' })).toBeDisabled();
    expect(api.requests('POST', '/api/batches/preview')).toHaveLength(0);
  });

  it('launches the batch with rows keyed by variable and follows it', async () => {
    const user = userEvent.setup();
    const job = makeBatch(7, [
      makeItem(0, { nombre: 'Lucía', empresa: 'Ferrer Asesores' }, 'pending'),
      makeItem(1, { nombre: 'Marc', empresa: 'Taller Riera' }, 'pending'),
    ]);
    const api = withPreview(withVideos(createFakeApi()))
      .on('POST', '/api/batches', () => {
        const { items: _items, variables: _variables, ...summary } = job;
        return new Response(JSON.stringify(summary), { status: 202 });
      })
      .on('GET', `/api/batches/${job.id}`, () => job);
    const { router } = renderFeatures([batch, others], '/batch/new', api);
    await chooseMould(user);
    await pasteData(user, 'nombre,empresa\nLucía,Ferrer Asesores\nMarc,Taller Riera\n');
    const name = screen.getByLabelText(/Nombre del lote/);
    await user.clear(name);
    await user.type(name, 'Bienvenida de noviembre');
    await user.click(screen.getByRole('radio', { name: '1080p' }));
    await user.click(await screen.findByRole('button', { name: 'Lanzar 2 vídeos' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/batch/${job.id}`));
    const body = api.requests('POST', '/api/batches')[0]?.body;
    expect(body).toEqual({
      name: 'Bienvenida de noviembre',
      sourceVideoId: mould.id,
      rows: [
        { nombre: 'Lucía', empresa: 'Ferrer Asesores' },
        { nombre: 'Marc', empresa: 'Taller Riera' },
      ],
      resolution: '1080p',
    });
    expect(contract.batches.create.body.safeParse(body).success).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Bienvenida 7' })).toBeVisible();
  });

  it('shows what the server objects to: not enough credits', async () => {
    const user = userEvent.setup();
    const api = withPreview(withVideos(createFakeApi())).on('POST', '/api/batches', () =>
      apiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits'),
    );
    renderFeatures([batch, others], '/batch/new', api);
    await chooseMould(user);
    await pasteData(user, 'nombre,empresa\nLucía,Ferrer Asesores\n');
    await user.click(await screen.findByRole('button', { name: 'Lanzar 1 vídeo' }));
    expect(await screen.findByText('No se ha podido lanzar el lote')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ver planes y créditos' })).toHaveAttribute(
      'href',
      '/settings/billing',
    );
  });

  it('turns a template with variables into the mould through a draft video', async () => {
    const user = userEvent.setup();
    const template = makeTemplate('explainer', { name: 'Vídeo explicativo' });
    const detail = makeTemplateDetail(template);
    const draft = makeVideo(5, {
      title: 'Vídeo explicativo',
      status: 'draft',
      source: 'template',
      composition: detail.composition,
    });
    const api = withVideos(createFakeApi())
      .on('GET', '/api/templates', () => ({ items: [template] }))
      .on('GET', `/api/templates/${template.id}`, () => detail)
      .on(
        'POST',
        `/api/templates/${template.id}/use`,
        () => new Response(JSON.stringify(draft), { status: 201 }),
      );
    renderFeatures([batch, others], '/batch/new', api);
    await user.click(await screen.findByRole('tab', { name: 'Plantillas' }));
    await user.click(await screen.findByRole('radio', { name: /Vídeo explicativo/ }));
    expect(await screen.findByText('Esta plantilla usa 1 variable:')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Crear el borrador y usarlo' }));
    expect(await screen.findByText('Usa 1 variable.')).toBeVisible();
    expect(api.requests('POST', /\/use$/)[0]?.body).toEqual({});
    expect(screen.getByLabelText(/Nombre del lote/)).toHaveValue('Lote de Vídeo explicativo');
  });
});

describe('batch detail', () => {
  usePageTestSetup();

  it('follows a running batch row by row and cancels what is left', async () => {
    const user = userEvent.setup();
    const job = makeBatch(1, [
      makeItem(0, { nombre: 'Lucía', empresa: 'Ferrer' }, 'completed'),
      makeItem(1, { nombre: 'Marc', empresa: 'Riera' }, 'rendering'),
      makeItem(2, { nombre: 'Ainhoa', empresa: 'Ibai' }, 'failed'),
      makeItem(3, { nombre: 'Jon', empresa: 'Arana' }, 'pending'),
    ]);
    const { items: _items, variables: _variables, ...summary } = job;
    const api = createFakeApi()
      .on('GET', `/api/batches/${job.id}`, () => job)
      .on('POST', `/api/batches/${job.id}/cancel`, () => ({ ...summary, status: 'canceled' }));
    renderFeatures([batch, others], `/batch/${job.id}`, api);

    expect(await screen.findByRole('heading', { name: 'Bienvenida 1' })).toBeVisible();
    expect(screen.getByText('2 de 4 vídeos terminados')).toBeVisible();
    const rows = within(screen.getByRole('table', { name: 'Vídeos del lote' })).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[1]).toHaveTextContent('Lucía');
    expect(within(rows[1]!).getByRole('link', { name: /MP4\s*de la fila 1/ })).toHaveAttribute(
      'href',
      expect.stringContaining('download=video.mp4'),
    );
    expect(within(rows[3]!).getByRole('alert')).toHaveTextContent('TTS failed');
    expect(rows[4]).toHaveTextContent('Pendiente');
    expect(within(rows[4]!).queryByRole('link')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancelar el lote' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Los que ya están listos se conservan/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar el lote' }));
    await waitFor(() => expect(api.requests('POST', /\/cancel$/)).toHaveLength(1));
  });

  it('sums up a finished batch and deletes only its record', async () => {
    const user = userEvent.setup();
    const job = makeBatch(2);
    const api = createFakeApi()
      .on('GET', `/api/batches/${job.id}`, () => job)
      .on('GET', '/api/batches', () => page([]))
      .on('DELETE', `/api/batches/${job.id}`, () => ({ ok: true }));
    const { router } = renderFeatures([batch, others], `/batch/${job.id}`, api);
    expect(await screen.findByText(/un render fallido o cancelado se devuelve/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cancelar el lote' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Eliminar el lote' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Sus vídeos se conservan en la biblioteca/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar el lote' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/batch'));
  });

  it('says so when the batch does not exist', async () => {
    renderFeatures([batch, others], `/batch/${batchId(404)}`, createFakeApi());
    expect(await screen.findByRole('heading', { name: 'Lote no disponible' })).toBeVisible();
  });
});
