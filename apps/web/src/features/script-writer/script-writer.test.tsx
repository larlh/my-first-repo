import { api as contract } from '@parlante/shared';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { stockAvatars, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import { others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import {
  apiError,
  createFakeApi,
  makeCapabilities,
  makeSession,
  makeVideo,
  renderFeatures,
} from '@/features/videos/testing/harness';
import type { FakeApi } from '@/features/videos/testing/harness';
import scriptWriter from './index';
import { CLAUDE, makeScript } from './kit/testing/fixtures';

const TOPIC = 'Cómo funciona nuestra app de reservas para clínicas dentales';
const FORBIDDEN = 'No tienes acceso a esta sección';

function withCatalogue(api: FakeApi): FakeApi {
  return api
    .on('GET', '/api/avatars', () => ({ items: stockAvatars(), engine: null }))
    .on('GET', '/api/voices', () => ({
      items: [stockVoice('es-f1', 'Carmen'), stockVoice('es-m1', 'Diego')],
    }));
}

async function writeScript(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/^Tema/), TOPIC);
  await user.click(screen.getByRole('button', { name: 'Escribir el guion' }));
  return screen.findByRole('list', { name: 'Escenas del guion' });
}

describe('script writer', () => {
  usePageTestSetup();
  // The work in progress lives in sessionStorage (the shared setup only clears localStorage).
  beforeEach(() => window.sessionStorage.clear());

  it('says up front that the local heuristic will write the script (basic mode)', async () => {
    renderFeatures([scriptWriter, others], '/script-writer', createFakeApi());
    expect(await screen.findByText(/Lo escribirá la heurística local/)).toBeVisible();
    expect(screen.getByText('Modo básico')).toBeVisible();
    expect(screen.getByText('Aquí aparecerá la escaleta')).toBeVisible();
  });

  it('names the external provider and its cost when one is configured', async () => {
    const capabilities = makeCapabilities();
    const api = createFakeApi().on('GET', '/api/capabilities', () => ({
      ...capabilities,
      active: { ...capabilities.active, llm: CLAUDE },
    }));
    renderFeatures([scriptWriter, others], '/script-writer', api);
    expect(
      await screen.findByText(/Lo escribirá Claude \(Anthropic\)\. Cada guion cuesta 1 crédito/),
    ).toBeVisible();
    expect(screen.queryByText(/heurística local/)).not.toBeInTheDocument();
  });

  it('does not send a brief without a topic or with a bad web address', async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    renderFeatures([scriptWriter, others], '/script-writer', api);
    await user.click(await screen.findByRole('button', { name: 'Escribir el guion' }));
    expect(screen.getByText('Describe el tema con al menos 3 caracteres.')).toBeVisible();

    await user.click(screen.getByRole('radio', { name: 'Una página web' }));
    await user.type(screen.getByLabelText(/Dirección de la página/), 'esto no es una url');
    await user.click(screen.getByRole('button', { name: 'Escribir el guion' }));
    expect(screen.getByText(/Escribe una dirección web válida/)).toBeVisible();
    expect(api.requests('POST', '/api/script-writer/generate')).toHaveLength(0);
  });

  it('turns a topic into an editable script and says it was written in basic mode', async () => {
    const user = userEvent.setup();
    const api = createFakeApi().on('POST', '/api/script-writer/generate', () => makeScript());
    renderFeatures([scriptWriter, others], '/script-writer', api);
    const scenes = await writeScript(user);

    const body = api.requests('POST', '/api/script-writer/generate')[0]?.body;
    expect(body).toEqual({
      source: { kind: 'topic', topic: TOPIC },
      tone: 'professional',
      durationSec: 60,
      language: 'es',
    });
    expect(contract.scriptWriter.generate.body.safeParse(body).success).toBe(true);

    expect(within(scenes).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByLabelText('Título del vídeo')).toHaveValue('Reservas sin llamadas');
    expect(screen.getByText('Escrito en modo básico')).toBeVisible();
    expect(screen.queryByText('Con cambios tuyos')).not.toBeInTheDocument();

    // Editing: reorder, remove and rewrite; the draft is marked as the person's own.
    await user.click(screen.getByRole('button', { name: 'Bajar la escena 1' }));
    const names = () =>
      screen
        .getAllByLabelText('Nombre de la escena')
        .map((input) => (input as HTMLInputElement).value);
    expect(names()).toEqual(['Cómo funciona', 'Gancho', 'Cierre']);
    expect(screen.getByText('Con cambios tuyos')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Eliminar la escena 3' }));
    expect(names()).toEqual(['Cómo funciona', 'Gancho']);

    // A scene without narration is allowed (silent) but announced.
    await user.clear(screen.getAllByLabelText(/^Narración/)[1]!);
    expect(screen.getByText('1 escena no tiene narración: quedará en silencio.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crear vídeo con este guion' })).toBeEnabled();
    await user.clear(screen.getAllByLabelText(/^Narración/)[0]!);
    expect(screen.getByText(/Ninguna escena tiene narración/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Crear vídeo con este guion' })).toBeDisabled();
  });

  it('creates a draft video with the chosen avatar and voice and opens it in the Studio', async () => {
    const user = userEvent.setup();
    const api = withCatalogue(createFakeApi())
      .on('POST', '/api/script-writer/generate', () => makeScript())
      .on('POST', '/api/videos', () => makeVideo(7, { status: 'draft', source: 'script' }));
    const { router } = renderFeatures([scriptWriter, others], '/script-writer', api);
    await writeScript(user);
    await user.click(screen.getByRole('button', { name: 'Crear vídeo con este guion' }));

    const dialog = await screen.findByRole('dialog', { name: 'Crear vídeo con este guion' });
    await user.click(await within(dialog).findByRole('radio', { name: /Mateo/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'Vertical 9:16' }));
    const create = within(dialog).getByRole('button', { name: 'Crear el vídeo' });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/studio/vid_0007abcdefgh1234'),
    );
    const body = api.requests('POST', '/api/videos')[0]?.body as {
      title: string;
      source: string;
      composition: {
        canvas: { aspect: string };
        scenes: {
          script: { text: string; voiceId: string };
          layers: { type: string; avatarId?: string }[];
        }[];
      };
    };
    expect(contract.videos.create.body.safeParse(body).success).toBe(true);
    expect(body.title).toBe('Reservas sin llamadas');
    expect(body.source).toBe('script');
    expect(body.composition.canvas.aspect).toBe('9:16');
    expect(body.composition.scenes).toHaveLength(3);
    expect(body.composition.scenes[0]?.script).toMatchObject({
      text: 'Reservar una cita no debería costar una llamada.',
      voiceId: 'espeak:es-f1',
    });
    expect(
      body.composition.scenes[0]?.layers.find((layer) => layer.type === 'avatar')?.avatarId,
    ).toBe('stock_mateo');
  });

  it('keeps the brief and the script across a reload of the tab', async () => {
    const user = userEvent.setup();
    const api = createFakeApi().on('POST', '/api/script-writer/generate', () => makeScript());
    renderFeatures([scriptWriter, others], '/script-writer', api);
    await writeScript(user);
    await user.click(screen.getByRole('button', { name: 'Eliminar la escena 3' }));

    cleanup();
    renderFeatures([scriptWriter, others], '/script-writer', api);
    const scenes = await screen.findByRole('list', { name: 'Escenas del guion' });
    expect(within(scenes).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByLabelText(/^Tema/)).toHaveValue(TOPIC);
    expect(screen.getByText('Con cambios tuyos')).toBeVisible();
    // The script was written once: coming back did not ask for it again.
    expect(api.requests('POST', '/api/script-writer/generate')).toHaveLength(1);
  });

  it('explains a blocked topic, an unsafe address and a provider failure', async () => {
    const user = userEvent.setup();
    let answer = apiError(422, 'CONTENT_BLOCKED', 'Blocked by moderation');
    const api = createFakeApi().on('POST', '/api/script-writer/generate', () => answer.clone());
    renderFeatures([scriptWriter, others], '/script-writer', api);
    await user.type(await screen.findByLabelText(/^Tema/), TOPIC);
    await user.click(screen.getByRole('button', { name: 'Escribir el guion' }));
    expect(await screen.findByText(/no cumplen las normas de uso/)).toBeVisible();

    answer = apiError(502, 'PROVIDER_ERROR', 'LLM returned garbage');
    await user.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText(/No se ha cobrado nada; vuelve a intentarlo/)).toBeVisible();

    answer = apiError(400, 'UNSAFE_URL', 'Private address');
    await user.click(screen.getByRole('radio', { name: 'Una página web' }));
    await user.type(screen.getByLabelText(/Dirección de la página/), 'http://intranet.local/wiki');
    await user.click(screen.getByRole('button', { name: 'Escribir el guion' }));
    expect(await screen.findByText(/solo se leen páginas públicas de internet/)).toBeVisible();
  });

  it('is for editors: a viewer gets the shell\'s "no access" page', async () => {
    const api = createFakeApi(makeSession('viewer'));
    renderFeatures([scriptWriter, others], '/script-writer', api);
    expect(await screen.findByText(FORBIDDEN)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Escribir el guion' })).not.toBeInTheDocument();
  });
});
