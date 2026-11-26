import { api as contract } from '@parlante/shared';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { stockAvatars, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import { others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import {
  apiError,
  createFakeApi,
  makeCapabilities,
  makeSession,
  renderFeatures,
} from '@/features/videos/testing/harness';
import type { FakeApi } from '@/features/videos/testing/harness';
import {
  CLAUDE,
  ESPEAK,
  SESSION_ID,
  makeMessage,
  makeReply,
  makeTalk,
} from '@/features/script-writer/kit/testing/fixtures';
import type { InteractiveMessage, InteractiveSession } from '@parlante/shared';
import interactive from './index';

const VOICES = [stockVoice('es-f1', 'Carmen'), stockVoice('es-m1', 'Diego')];

function withCatalogue(api: FakeApi): FakeApi {
  return api
    .on('GET', '/api/avatars', () => ({ items: stockAvatars(), engine: null }))
    .on('GET', /^\/api\/avatars\/([a-z0-9_]+)$/, ({ match }) => {
      const avatar = stockAvatars().find((item) => item.id === match[1]);
      return avatar ?? apiError(404, 'NOT_FOUND');
    })
    .on('GET', '/api/voices', () => ({ items: VOICES }))
    .on('GET', /^\/api\/voices\/[^/]+$/, () => VOICES[0])
    .on('GET', '/api/interactive/sessions', () => ({ items: [], nextCursor: null }));
}

function withTalk(
  api: FakeApi,
  talk: InteractiveSession = makeTalk(),
  messages: InteractiveMessage[] = [],
): FakeApi {
  return withCatalogue(api).on('GET', `/api/interactive/sessions/${talk.id}`, () => ({
    session: talk,
    messages,
  }));
}

const audio = () => {
  const element = document.querySelector<HTMLAudioElement>('[data-interactive-audio]');
  if (!element) throw new Error('the conversation has no audio element');
  return element;
};
const phase = () => document.querySelector('[data-talk-phase]')?.getAttribute('data-talk-phase');
const pauseSpy = () => vi.mocked(window.HTMLMediaElement.prototype.pause);

describe('interactive avatar: set-up', () => {
  usePageTestSetup();

  it('offers avatars and voices, says who will answer and starts a conversation', async () => {
    const user = userEvent.setup();
    const api = withCatalogue(createFakeApi()).on('POST', '/api/interactive/sessions', () =>
      makeTalk(),
    );
    withTalk(api);
    const { router } = renderFeatures([interactive, others], '/interactive', api);

    expect(await screen.findByRole('radio', { name: /Lucía/ })).toBeChecked();
    expect(screen.getByText(/Contestará la heurística local/)).toBeVisible();
    expect(screen.getByText('Todavía no has hablado con nadie')).toBeVisible();
    // The persona is named after the avatar until the person writes another name.
    const name = screen.getByLabelText(/Nombre con el que se presenta/);
    expect(name).toHaveValue('Lucía');
    await user.click(screen.getByRole('radio', { name: /Mateo/ }));
    expect(name).toHaveValue('Mateo');
    await user.clear(name);
    await user.type(name, 'Recepción');
    await user.type(screen.getByLabelText(/Instrucciones/), 'Contesta en dos frases.');
    await user.type(screen.getByLabelText(/Conocimiento/), 'Abrimos de 9 a 20 h.');
    await user.click(screen.getByRole('button', { name: 'Empezar a hablar' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/interactive/${SESSION_ID}`));
    const body = api.requests('POST', '/api/interactive/sessions')[0]?.body;
    expect(body).toEqual({
      avatarId: 'stock_mateo',
      voiceId: 'espeak:es-f1',
      language: 'es',
      persona: {
        name: 'Recepción',
        instructions: 'Contesta en dos frases.',
        knowledge: 'Abrimos de 9 a 20 h.',
      },
    });
    expect(contract.interactive.createSession.body.safeParse(body).success).toBe(true);
  });

  it('names the external model and what a conversation costs when one is configured', async () => {
    const capabilities = makeCapabilities();
    const api = withCatalogue(createFakeApi()).on('GET', '/api/capabilities', () => ({
      ...capabilities,
      active: { ...capabilities.active, llm: CLAUDE },
    }));
    renderFeatures([interactive, others], '/interactive', api);
    expect(await screen.findByText(/Contestará Claude \(Anthropic\)/)).toBeVisible();
    expect(screen.getByText('Cuesta 2 créditos')).toBeVisible();
    expect(screen.queryByText(/heurística local/)).not.toBeInTheDocument();
  });

  it('needs a name and shows where moderation objected', async () => {
    const user = userEvent.setup();
    const api = withCatalogue(createFakeApi()).on('POST', '/api/interactive/sessions', () =>
      apiError(422, 'CONTENT_BLOCKED', 'Blocked', { field: 'persona.instructions' }),
    );
    renderFeatures([interactive, others], '/interactive', api);
    const name = await screen.findByLabelText(/Nombre con el que se presenta/);
    await waitFor(() => expect(name).toHaveValue('Lucía'));
    await user.clear(name);
    await user.click(screen.getByRole('button', { name: 'Empezar a hablar' }));
    expect(screen.getByText('Escribe el nombre con el que se presentará.')).toBeVisible();
    expect(api.requests('POST', '/api/interactive/sessions')).toHaveLength(0);

    await user.type(name, 'Lucía');
    await user.click(screen.getByRole('button', { name: 'Empezar a hablar' }));
    expect(await screen.findByText(/Este texto no cumple las normas de uso/)).toBeVisible();
  });

  it('lists earlier conversations and lets a viewer only read them', async () => {
    const api = withCatalogue(createFakeApi(makeSession('viewer'))).on(
      'GET',
      '/api/interactive/sessions',
      () => ({
        items: [
          makeTalk({ messageCount: 4 }),
          makeTalk({
            id: 'ivs_z9y8x7w6v5u4t3s2',
            status: 'ended',
            endedAt: '2026-11-20T11:00:00.000Z',
            messageCount: 1,
            persona: { name: 'Tutor', instructions: '', knowledge: '' },
          }),
        ],
        nextCursor: null,
      }),
    );
    renderFeatures([interactive, others], '/interactive', api);
    const open = await screen.findByRole('link', { name: /Lucía/ });
    expect(open).toHaveAttribute('href', `/interactive/${SESSION_ID}`);
    expect(within(open).getByText(/4 mensajes/)).toBeVisible();
    expect(
      within(screen.getByRole('link', { name: /Tutor/ })).getByText('Terminada'),
    ).toBeVisible();
    expect(screen.getByText(/no empezar una nueva/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Empezar a hablar' })).toBeDisabled();
  });
});

describe('interactive avatar: conversation', () => {
  const { play } = usePageTestSetup();

  it('shows the history, thinks, then speaks the reply with its audio and provider', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const reply = makeReply(
      3,
      '¿Cuál es el horario?',
      'Abrimos de lunes a viernes de nueve a ocho.',
    );
    const api = withTalk(createFakeApi(), makeTalk({ messageCount: 2 }), [
      makeMessage(1, 'user', 'Hola'),
      makeMessage(2, 'assistant', 'Hola, soy Lucía. ¿En qué te ayudo?'),
    ]).on('POST', `/api/interactive/sessions/${SESSION_ID}/messages`, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return reply;
    });
    renderFeatures([interactive, others], `/interactive/${SESSION_ID}`, api);

    const log = await screen.findByRole('log', { name: 'Mensajes de la conversación' });
    expect(within(log).getByText('Hola, soy Lucía. ¿En qué te ayudo?')).toBeVisible();
    expect(phase()).toBe('idle');
    expect(screen.getByText('A la escucha')).toBeVisible();
    // Honesty: who answers and who speaks, and that it is the basic mode.
    expect(screen.getByText('Modo básico · Heurística local')).toBeVisible();
    expect(screen.getByText('Modo básico · eSpeak NG (local)')).toBeVisible();
    expect(screen.getByText(/no de un modelo de lenguaje/)).toBeVisible();

    const box = screen.getByRole('textbox', { name: 'Mensaje para Lucía' });
    await user.type(box, '¿Cuál es el horario?{Enter}');
    // The message shows at once and the avatar is "thinking" until the reply arrives.
    expect(within(log).getByText('¿Cuál es el horario?')).toBeVisible();
    expect(await screen.findByText('Pensando la respuesta…')).toBeVisible();
    expect(phase()).toBe('thinking');
    expect(box).toHaveValue('');
    expect(screen.getByRole('button', { name: /Enviar/ })).toBeDisabled();

    await waitFor(() => expect(release).toBeDefined());
    release?.();
    expect(await within(log).findByText(reply.assistantMessage.text)).toBeVisible();
    await waitFor(() => expect(phase()).toBe('speaking'));
    expect(screen.getByText('En el aire')).toBeVisible();
    expect(play).toHaveBeenCalledTimes(1);
    expect(audio().getAttribute('src')).toBe(
      '/api/files/cache/tts/reply-3.wav?exp=1999999999&sig=test',
    );
    expect(within(log).getByText('Respuesta en modo básico')).toBeVisible();
    expect(api.requests('POST', /\/messages$/)[0]?.body).toEqual({ text: '¿Cuál es el horario?' });

    // When the audio ends the avatar goes back to listening.
    audio().dispatchEvent(new Event('ended'));
    await waitFor(() => expect(phase()).toBe('idle'));
  });

  it('stops the audio when another message is sent and when the page is left', async () => {
    const user = userEvent.setup();
    let n = 1;
    const api = withTalk(createFakeApi()).on(
      'POST',
      `/api/interactive/sessions/${SESSION_ID}/messages`,
      ({ body }) => {
        n += 2;
        return makeReply(n, (body as { text: string }).text, `Respuesta número ${n}.`);
      },
    );
    renderFeatures([interactive, others], `/interactive/${SESSION_ID}`, api);
    const box = await screen.findByRole('textbox', { name: 'Mensaje para Lucía' });
    expect(screen.getByText('Saluda a Lucía para empezar.')).toBeVisible();

    await user.type(box, 'Primera{Enter}');
    await waitFor(() => expect(phase()).toBe('speaking'));
    const element = audio();
    expect(element.getAttribute('src')).toContain('reply-3.wav');

    // Second message: the first reply is cut before the request even leaves.
    const pausesBefore = pauseSpy().mock.calls.length;
    await user.type(box, 'Segunda');
    expect(phase()).toBe('speaking');
    await user.keyboard('{Enter}');
    expect(pauseSpy().mock.calls.length).toBeGreaterThan(pausesBefore);
    await waitFor(() => expect(element.getAttribute('src')).toContain('reply-5.wav'));
    await waitFor(() => expect(phase()).toBe('speaking'));
    expect(play).toHaveBeenCalledTimes(2);

    // The stop button silences the avatar by hand.
    await user.click(screen.getByRole('button', { name: 'Callar al avatar' }));
    expect(phase()).toBe('idle');
    expect(element.hasAttribute('src')).toBe(false);

    // Listen again, then leave: unmounting the page pauses and unloads the audio.
    await user.click(screen.getAllByRole('button', { name: 'Escuchar esta respuesta' })[0]!);
    await waitFor(() => expect(phase()).toBe('speaking'));
    expect(element.getAttribute('src')).toContain('reply-3.wav');
    const pausesBeforeLeaving = pauseSpy().mock.calls.length;
    cleanup();
    expect(pauseSpy().mock.calls.length).toBeGreaterThan(pausesBeforeLeaving);
    expect(element.hasAttribute('src')).toBe(false);
  });

  it('offers a button when the browser refuses to start the audio by itself', async () => {
    const user = userEvent.setup();
    play.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })),
    );
    const api = withTalk(createFakeApi()).on(
      'POST',
      `/api/interactive/sessions/${SESSION_ID}/messages`,
      () => makeReply(3, 'Hola', 'Hola, ¿en qué te ayudo?'),
    );
    renderFeatures([interactive, others], `/interactive/${SESSION_ID}`, api);
    await user.type(
      await screen.findByRole('textbox', { name: 'Mensaje para Lucía' }),
      'Hola{Enter}',
    );
    expect(await screen.findByText('El navegador ha retenido el audio')).toBeVisible();
    expect(phase()).toBe('idle');
    await user.click(screen.getByRole('button', { name: 'Escuchar la respuesta' }));
    await waitFor(() => expect(phase()).toBe('speaking'));
    expect(screen.queryByText('El navegador ha retenido el audio')).not.toBeInTheDocument();
  });

  it('keeps a rejected message with its reason, and shows a reply without audio as text', async () => {
    const user = userEvent.setup();
    let answer: () => unknown = () => apiError(422, 'CONTENT_BLOCKED', 'Blocked');
    const api = withTalk(createFakeApi()).on(
      'POST',
      `/api/interactive/sessions/${SESSION_ID}/messages`,
      () => answer(),
    );
    renderFeatures([interactive, others], `/interactive/${SESSION_ID}`, api);
    const box = await screen.findByRole('textbox', { name: 'Mensaje para Lucía' });
    await user.type(box, 'algo prohibido{Enter}');
    expect(
      await screen.findByText('Mensaje bloqueado por las normas de uso. No se ha enviado.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Quitar' }));
    expect(screen.queryByText('algo prohibido')).not.toBeInTheDocument();

    // A provider failure can be retried; the retry replaces the failed bubble.
    answer = () => apiError(502, 'PROVIDER_ERROR', 'LLM down');
    await user.type(box, '¿Abrís mañana?{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    answer = () => makeReply(3, '¿Abrís mañana?', 'Sí, de nueve a ocho.', { speech: null });
    await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Sí, de nueve a ocho.')).toBeVisible();
    expect(screen.getAllByText('¿Abrís mañana?')).toHaveLength(1);
    expect(screen.getByText(/sin audio: la síntesis de voz ha fallado/)).toBeVisible();
    expect(play).not.toHaveBeenCalled();
    expect(phase()).toBe('idle');
  });

  it('ends a conversation and leaves it readable, with no way to write', async () => {
    const user = userEvent.setup();
    const ended = makeTalk({ status: 'ended', endedAt: '2026-11-20T11:00:00.000Z' });
    const api = withTalk(createFakeApi(), makeTalk({ messageCount: 2 }), [
      makeMessage(1, 'user', 'Hola'),
      makeMessage(2, 'assistant', 'Hola, soy Lucía.'),
    ])
      .on('POST', `/api/interactive/sessions/${SESSION_ID}/end`, () => ended)
      .on('POST', '/api/tts/synthesize', () => ({
        audioUrl: 'http://localhost:4000/api/files/cache/tts/old.wav?exp=1&sig=t',
        mimeType: 'audio/wav',
        runtime: makeReply(9, 'x', 'Hola, soy Lucía.').speech?.runtime,
        provider: ESPEAK,
      }));
    renderFeatures([interactive, others], `/interactive/${SESSION_ID}`, api);
    await user.click(await screen.findByRole('button', { name: 'Terminar' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Terminar' }));

    expect(await screen.findByText('Esta conversación ha terminado')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Mensaje para Lucía' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hablar otra vez' })).toHaveAttribute(
      'href',
      '/interactive',
    );
    // An old reply has no audio at hand: it is synthesised again with the session voice.
    await user.click(screen.getByRole('button', { name: 'Escuchar esta respuesta' }));
    await waitFor(() => expect(phase()).toBe('speaking'));
    expect(api.requests('POST', '/api/tts/synthesize')[0]?.body).toEqual({
      text: 'Hola, soy Lucía.',
      voiceId: 'espeak:es-f1',
      language: 'es',
    });
  });

  it('explains a conversation that does not exist', async () => {
    const api = withCatalogue(createFakeApi());
    renderFeatures([interactive, others], '/interactive/ivs_0000000000000000', api);
    expect(
      await screen.findByRole('heading', { name: 'Conversación no disponible' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Volver al avatar interactivo' })).toHaveAttribute(
      'href',
      '/interactive',
    );
  });
});
