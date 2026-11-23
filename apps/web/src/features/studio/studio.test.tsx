import { VoiceSchema, compositionFromScript } from '@parlante/shared';
import type { SynthesizedSpeech, Video } from '@parlante/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/ui';
import {
  apiError,
  createFakeApi,
  makeVideo,
  renderFeatures,
  resetApiClient,
  videoId,
  watchContractWarnings,
} from '../videos/testing/harness';
import type { FakeApi } from '../videos/testing/harness';
import studio from './index';

/* The Studio mounted in the real shell router against a fake API whose bodies are parsed
 * with the zod schemas of the contract. jsdom has no canvas nor WebAudio: drawing and sound
 * are covered by the Playwright walkthrough; here we check editing, autosave and its
 * conflict protocol, shortcuts and the states of the page. */

const ID = videoId(1);
const PATH = `/api/videos/${ID}`;
const SPEECH: SynthesizedSpeech = {
  audioUrl: 'http://localhost:4000/api/files/cache/tts/abc.wav?exp=1999999999&sig=test',
  mimeType: 'audio/wav',
  runtime: {
    audioDurationMs: 2000,
    visemes: [{ tMs: 0, viseme: 'A' }],
    words: [{ tMs: 0, durMs: 400, text: 'Hola' }],
  },
  provider: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic', local: true },
};

function draft(overrides: Partial<Video> = {}): Video {
  return makeVideo(1, {
    status: 'draft',
    title: 'Bienvenida',
    revision: 3,
    composition: compositionFromScript(
      [
        { text: 'Hola, soy Lucía.', headline: 'Bienvenida', title: 'Intro' },
        { text: 'Así se empieza.', title: 'Cierre' },
      ],
      { avatarId: 'stock_lucia', voiceId: 'espeak:es-f1', language: 'es' },
    ),
    ...overrides,
  });
}

/** Fake API with a stored video that PATCH updates like the real one (revision + 1). */
function studioApi(initial: Video = draft()): { api: FakeApi; current: () => Video } {
  let stored = initial;
  const api = createFakeApi();
  api.on('GET', PATH, () => stored);
  api.on('PATCH', PATH, (request) => {
    const body = request.body as { title?: string; composition?: Video['composition'] };
    stored = {
      ...stored,
      title: body.title ?? stored.title,
      composition: body.composition ?? stored.composition,
      revision: stored.revision + 1,
    };
    return stored;
  });
  api.on('GET', '/api/avatars', () => ({ items: [], engine: null }));
  api.on('GET', '/api/voices', () => ({
    items: [
      VoiceSchema.parse({
        id: 'espeak:es-f1',
        kind: 'stock',
        name: 'Carmen',
        provider: SPEECH.provider,
        language: 'es',
        gender: 'female',
        description: '',
        tags: [],
        status: 'ready',
        workspaceId: null,
        consentId: null,
        profile: null,
        error: null,
        createdAt: null,
      }),
    ],
  }));
  api.on('GET', '/api/stock-assets', () => ({ items: [] }));
  api.on('GET', '/api/assets', () => ({ items: [], nextCursor: null }));
  api.on('GET', '/api/brand-kits', () => ({ items: [] }));
  api.on('POST', '/api/tts/synthesize', () => SPEECH);
  return { api, current: () => stored };
}

const wide = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );

async function open(api: FakeApi) {
  renderFeatures([studio], `/studio/${ID}`, api);
  return screen.findByLabelText('Título del vídeo', undefined, { timeout: 5000 });
}

const patches = (api: FakeApi) =>
  api
    .requests('PATCH', PATH)
    .map(
      (request) =>
        request.body as { title: string; baseRevision: number; composition: Video['composition'] },
    );
const saveStatus = () => screen.getByTestId('save-status').getAttribute('data-status');
const script = () => screen.getByLabelText('Texto que dirá el avatar') as HTMLTextAreaElement;

let contract: ReturnType<typeof watchContractWarnings>;
beforeEach(() => {
  wide(true);
  contract = watchContractWarnings();
});
afterEach(() => {
  contract.assert();
  contract.restore();
  resetApiClient();
  toast.clear();
  vi.restoreAllMocks();
});

describe('Studio page', () => {
  it('opens the video with its scenes, script and a saved status', async () => {
    const { api } = studioApi();
    const title = await open(api);
    expect(title).toHaveValue('Bienvenida');
    const scenes = within(screen.getByRole('navigation', { name: 'Escenas' }));
    expect(scenes.getByRole('button', { name: 'Escena 1: Intro' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(scenes.getByRole('button', { name: 'Escena 2: Cierre' })).toBeInTheDocument();
    expect(script()).toHaveValue('Hola, soy Lucía.');
    expect(screen.getByRole('img', { name: 'Vista previa de la escena' })).toBeInTheDocument();
    expect(saveStatus()).toBe('saved');
    // One hit box per layer of the scene on the stage.
    expect(screen.getByRole('button', { name: 'Capa Avatar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Capa Titular' })).toBeInTheDocument();
    expect(patches(api)).toHaveLength(0);
  });

  it('shows a notice instead of the editor on screens narrower than 1024 px', async () => {
    wide(false);
    const { api } = studioApi();
    renderFeatures([studio], `/studio/${ID}`, api);
    expect(
      await screen.findByText('El Studio necesita una pantalla más ancha'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver el vídeo' })).toHaveAttribute(
      'href',
      `/videos/${ID}`,
    );
    expect(api.requests('GET', PATH)).toHaveLength(0);
  });

  it('explains a video that does not exist', async () => {
    const api = createFakeApi();
    api.on('GET', PATH, () => apiError(404, 'NOT_FOUND', 'Video not found'));
    renderFeatures([studio], `/studio/${ID}`, api);
    expect(await screen.findByText('Este vídeo no existe')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ir a mis vídeos' })).toHaveAttribute(
      'href',
      '/videos',
    );
  });
});

describe('Studio editing and autosave', () => {
  it('autosaves edits with the base revision and chains the revision it gets back', async () => {
    const user = userEvent.setup();
    const { api, current } = studioApi();
    await open(api);
    await user.type(script(), ' Bienvenida.');
    expect(saveStatus()).toBe('dirty');
    await waitFor(() => expect(patches(api)).toHaveLength(1), { timeout: 4000 });
    const first = patches(api)[0]!;
    expect(first.baseRevision).toBe(3);
    expect(first.title).toBe('Bienvenida');
    expect(first.composition.scenes[0]!.script).toMatchObject({
      kind: 'tts',
      text: 'Hola, soy Lucía. Bienvenida.',
    });
    await waitFor(() => expect(saveStatus()).toBe('saved'));
    expect(current().revision).toBe(4);

    await user.clear(screen.getByLabelText('Título del vídeo'));
    await user.type(screen.getByLabelText('Título del vídeo'), 'Otro título');
    await waitFor(() => expect(patches(api)).toHaveLength(2), { timeout: 4000 });
    expect(patches(api)[1]).toMatchObject({ baseRevision: 4, title: 'Otro título' });
  });

  it('undoes and redoes with the keyboard, one step per burst of typing', async () => {
    const user = userEvent.setup();
    const { api } = studioApi();
    await open(api);
    await user.type(script(), ' Uno dos.');
    expect(script()).toHaveValue('Hola, soy Lucía. Uno dos.');
    await user.keyboard('{Control>}z{/Control}');
    expect(script()).toHaveValue('Hola, soy Lucía.');
    expect(screen.getByRole('button', { name: /^Deshacer/ })).toBeDisabled();
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(script()).toHaveValue('Hola, soy Lucía. Uno dos.');
    // Ctrl+S saves at once, without waiting for the debounce.
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(patches(api)).toHaveLength(1));
  });

  it('adds, duplicates and deletes scenes', async () => {
    const user = userEvent.setup();
    const { api } = studioApi();
    await open(api);
    const list = within(screen.getByRole('navigation', { name: 'Escenas' }));
    await user.click(screen.getByRole('button', { name: 'Añadir escena' }));
    // The new scene goes after the selected one, is selected and starts with an empty script.
    expect(list.getByRole('button', { name: 'Escena 2: Escena 3' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(script()).toHaveValue('');
    expect(screen.getByTestId('voice-name')).toHaveTextContent('Carmen');

    await user.click(list.getByRole('button', { name: 'Acciones de Intro' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicar' }));
    expect(list.getByRole('button', { name: 'Escena 2: Intro (copia)' })).toBeInTheDocument();
    expect(list.getAllByRole('listitem')).toHaveLength(4);

    await user.click(list.getByRole('button', { name: 'Acciones de Intro (copia)' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Eliminar' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(3));
    await waitFor(() => expect(patches(api).length).toBeGreaterThan(0), { timeout: 4000 });
    expect(
      patches(api)
        .at(-1)!
        .composition.scenes.map((scene) => scene.name),
    ).toEqual(['Intro', 'Escena 3', 'Cierre']);
  });

  it('moves and deletes the selected layer with the keyboard', async () => {
    const user = userEvent.setup();
    const { api } = studioApi();
    await open(api);
    await user.click(screen.getByRole('tab', { name: 'Capas' }));
    const layers = within(screen.getByRole('list', { name: 'Capas de la escena' }));
    await user.click(layers.getByRole('button', { name: 'Titular' }));
    const x = screen.getByLabelText('X') as HTMLInputElement;
    const before = Number(x.value);
    fireEvent.keyDown(document.body, { key: 'ArrowRight', shiftKey: true });
    // 10 px of a 1280 px canvas ≈ 0.8 %.
    await waitFor(() => expect(Number(x.value)).toBeCloseTo(before + 0.8, 1));
    fireEvent.keyDown(document.body, { key: 'Delete' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Capa Titular' })).not.toBeInTheDocument(),
    );
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(await screen.findByRole('button', { name: 'Capa Titular' })).toBeInTheDocument();
  });

  it('requests the narration of each scene and says which provider produced it', async () => {
    const { api } = studioApi();
    await open(api);
    await waitFor(() => expect(api.requests('POST', '/api/tts/synthesize')).toHaveLength(2), {
      timeout: 4000,
    });
    expect(api.requests('POST', '/api/tts/synthesize')[0]!.body).toMatchObject({
      text: 'Hola, soy Lucía.',
      voiceId: 'espeak:es-f1',
      language: 'es',
    });
    expect(await screen.findByText(/Modo básico · eSpeak NG/)).toBeInTheDocument();
    const counter = screen.getByTestId('script-counter');
    expect(counter).toHaveTextContent('3 palabras');
    expect(counter).toHaveTextContent('de voz');
    expect(counter).not.toHaveTextContent('estimado');
  });
});

describe('Studio revision conflicts', () => {
  function conflicting() {
    const { api, current } = studioApi();
    const server = draft({ title: 'Versión del servidor', revision: 7 });
    let conflict = true;
    api.on('GET', PATH, () =>
      conflict && api.requests('PATCH', PATH).length > 0 ? server : current(),
    );
    api.on('PATCH', PATH, (request) => {
      const body = request.body as { title: string; baseRevision: number };
      if (body.baseRevision !== 7) {
        return apiError(409, 'REVISION_CONFLICT', 'The video changed', { currentRevision: 7 });
      }
      conflict = false;
      return { ...server, title: body.title, revision: 8 };
    });
    return api;
  }

  it('stops saving on 409 and loads the server version when asked', async () => {
    const user = userEvent.setup();
    const api = conflicting();
    const title = await open(api);
    await user.type(title, ' mía');
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Este vídeo se ha modificado en otro sitio' },
      { timeout: 4000 },
    );
    expect(saveStatus()).toBe('conflict');
    expect(patches(api)).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cargar la otra versión' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Título del vídeo')).toHaveValue('Versión del servidor'),
    );
    expect(saveStatus()).toBe('saved');
    // Nothing was overwritten and the undo history starts again.
    expect(patches(api)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Deshacer/ })).toBeDisabled();
  });

  it('keeps the local version on top of the revision the server reported', async () => {
    const user = userEvent.setup();
    const api = conflicting();
    const title = await open(api);
    await user.type(title, ' mía');
    const dialog = await screen.findByRole(
      'dialog',
      { name: 'Este vídeo se ha modificado en otro sitio' },
      { timeout: 4000 },
    );
    await user.click(within(dialog).getByRole('button', { name: 'Conservar mi versión' }));
    await waitFor(() => expect(patches(api)).toHaveLength(2));
    expect(patches(api)[1]).toMatchObject({ baseRevision: 7, title: 'Bienvenida mía' });
    await waitFor(() => expect(saveStatus()).toBe('saved'));
    expect(screen.getByLabelText('Título del vídeo')).toHaveValue('Bienvenida mía');
  });
});

describe('Studio render dialog', () => {
  it('shows the cost and reports a refusal of the API in plain words', async () => {
    const user = userEvent.setup();
    const { api } = studioApi();
    api.on('POST', `${PATH}/render`, () =>
      apiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits'),
    );
    await open(api);
    await user.click(screen.getByRole('button', { name: 'Renderizar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renderizar vídeo' });
    expect(within(dialog).getByTestId('render-cost')).toHaveTextContent('1 crédito');
    expect(within(dialog).getByText('212 créditos')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Renderizar' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(api.requests('POST', `${PATH}/render`)[0]!.body).toEqual({ resolution: '720p' });
    // Still a form: nothing is in progress.
    expect(screen.getByRole('dialog', { name: 'Renderizar vídeo' })).toBeInTheDocument();
  });
});
