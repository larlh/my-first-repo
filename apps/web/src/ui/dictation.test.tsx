import type { DictationCapabilities, SessionInfo } from '@parlante/shared';
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/App';
import { apiRequester } from '@/lib/api/instance';
import { dictation } from '@/lib/dictation';
import { dictationStorageKey } from '@/lib/dictation/preferences';
import {
  FakeRecognition,
  WHISPER,
  concat,
  deferred,
  fakeMicrophone,
  flush,
  noise,
  transcription,
  voice,
} from '@/lib/dictation/testing';
import { i18n } from '@/lib/i18n';
import { DictationButton, Input, Textarea } from '@/ui';

const USER = 'usr_kit_dictation_01';
const BUTTON = 'Dictar con el micrófono';

const READY: DictationCapabilities = {
  local: {
    available: true,
    provider: WHISPER,
    reason: null,
    reasonCode: null,
    languages: ['es', 'en'],
  },
  maxSegmentMs: 30_000,
};
const MISSING: DictationCapabilities = {
  local: {
    available: false,
    provider: null,
    reason: 'Model not installed',
    reasonCode: 'model_not_installed',
    languages: [],
  },
  maxSegmentMs: 30_000,
};

/** Connect the application controller with doubles of the microphone, the API and Web Speech. */
function connect(options: { caps?: DictationCapabilities; browser?: boolean } = {}) {
  const mic = fakeMicrophone();
  const requests: {
    language: string | undefined;
    done: ReturnType<typeof deferred<ReturnType<typeof transcription>>>;
  }[] = [];
  const caps = options.caps ?? READY;
  act(() => {
    dictation.connect({
      userId: USER,
      uiLanguage: () => 'es',
      loadCapabilities: () => Promise.resolve(caps),
      transcribe: (_wav, language) => {
        const done = deferred<ReturnType<typeof transcription>>();
        requests.push({ language, done });
        return done.promise;
      },
      openMicrophone: mic.open,
      ...(options.browser === false ? {} : { Recognition: FakeRecognition }),
    });
    dictation.setCapabilities(caps);
  });
  const say = () => act(() => mic.feed(concat(noise(300), voice(900), noise(1000))));
  const answer = async (index: number, text: string) => {
    await act(async () => {
      requests[index]?.done.resolve(transcription(text));
      await flush();
    });
  };
  return { mic, requests, say, answer };
}

function Controlled({
  label,
  initial = '',
  onValue,
  ...props
}: { label: string; initial?: string; onValue?: (value: string) => void } & Omit<
  React.ComponentProps<typeof Textarea>,
  'value' | 'onChange' | 'label'
>) {
  const [value, setValue] = useState(initial);
  return (
    <Textarea
      label={label}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        onValue?.(event.target.value);
      }}
      {...props}
    />
  );
}

const micOf = (fieldLabel: string) => {
  const field = screen.getByLabelText(fieldLabel);
  const wrapper = field.parentElement as HTMLElement;
  return within(wrapper).queryByRole('button', { name: /dict/i });
};

beforeEach(async () => {
  FakeRecognition.reset();
  window.localStorage.removeItem(dictationStorageKey(USER));
  await i18n.changeLanguage('es');
});
afterEach(() => {
  act(() => dictation.disconnect());
});

describe('dictation button of the kit fields', () => {
  it('is absent while nobody is signed in (the kit renders exactly as before)', () => {
    render(<Input label="Nombre" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is part of every free-text Input and Textarea by default', () => {
    connect();
    render(
      <>
        <Input label="Título" />
        <Input label="Buscar" type="search" />
        <Textarea label="Guion" />
      </>,
    );
    for (const label of ['Título', 'Buscar', 'Guion']) {
      const button = micOf(label);
      expect(button, label).not.toBeNull();
      expect(button).toHaveAccessibleName(BUTTON);
      expect(button).toHaveAttribute('aria-pressed', 'false');
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  it('is never offered for passwords, e-mail, URL, numbers, dates, read-only, disabled or secret fields', () => {
    connect();
    render(
      <>
        <Input label="Contraseña" type="password" />
        <Input label="Correo" type="email" />
        <Input label="Web" type="url" />
        <Input label="Cantidad" type="number" />
        <Input label="Fecha" type="date" />
        <Input label="Hora" type="time" />
        <Input label="Teléfono" type="tel" />
        <Input label="Enlace" readOnly defaultValue="https://ejemplo.test/x" />
        <Input label="Apagado" disabled />
        <Input label="Clave de API" secret />
        <Input label="Usuario" autoComplete="username" />
        <Input label="Código" inputMode="numeric" />
        <Textarea label="Secreto del webhook" secret />
        <Textarea label="Solo lectura" readOnly defaultValue="x" />
        <Input label="Sin dictado" dictation={false} />
        <Textarea label="Notas sin dictado" dictation={false} />
      </>,
    );
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getByLabelText('Clave de API')).toHaveAttribute('data-secret');
  });

  it('keeps what the field already had at its end, and still forwards the ref', () => {
    connect();
    const ref = { current: null as HTMLInputElement | null };
    render(<Input label="Buscar" ref={ref} trailing={<button type="button">Borrar</button>} />);
    expect(ref.current).toBe(screen.getByLabelText('Buscar'));
    expect(screen.getByRole('button', { name: 'Borrar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: BUTTON })).toBeInTheDocument();
  });

  it('can be hidden everywhere from the preferences', () => {
    connect();
    render(<Input label="Título" />);
    expect(micOf('Título')).not.toBeNull();
    act(() => dictation.setPreferences({ showButtons: false }));
    expect(micOf('Título')).toBeNull();
    act(() => dictation.setPreferences({ showButtons: true }));
    expect(micOf('Título')).not.toBeNull();
  });

  it('dictates into the field: pressed state, level, provider label, and the text through onChange', async () => {
    const user = userEvent.setup();
    const h = connect();
    const onValue = vi.fn();
    render(<Controlled label="Guion" initial="Hola." onValue={onValue} />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('Guion');
    await user.click(field);
    const button = screen.getByRole('button', { name: BUTTON });
    await user.click(button);

    const stop = await screen.findByRole('button', { name: 'Detener el dictado' });
    expect(stop).toBe(button);
    expect(stop).toHaveAttribute('aria-pressed', 'true');
    expect(stop).toHaveAttribute('data-state', 'listening');
    const panel = screen.getByRole('group', { name: 'Estado del dictado' });
    expect(within(panel).getByText('Escuchando…')).toBeInTheDocument();
    expect(
      within(panel).getByRole('meter', { name: 'Nivel de entrada del micrófono' }),
    ).toBeInTheDocument();
    // Honesty rule: the panel always says who is transcribing, and that it is the basic tier.
    expect(within(panel).getByText('Modo básico · Whisper base (local)')).toBeInTheDocument();
    expect(within(panel).getByText(/el audio no sale de ella ni se guarda/)).toBeInTheDocument();
    // The focus stays in the field, where the text will go.
    expect(field).toHaveFocus();

    h.say();
    expect(await within(panel).findByText('Transcribiendo 1 frase…')).toBeInTheDocument();
    await h.answer(0, 'esto lo he dictado.');
    expect(field.value).toBe('Hola. Esto lo he dictado.');
    expect(onValue).toHaveBeenLastCalledWith('Hola. Esto lo he dictado.');

    await user.click(within(panel).getByRole('button', { name: 'Detener' }));
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
    expect(button).toHaveAccessibleName(BUTTON);
    expect(screen.queryByRole('group', { name: 'Estado del dictado' })).toBeNull();
    expect(h.mic.state.stopped).toBe(1);
  });

  it('inserts at the caret and replaces a selection the person made', async () => {
    const user = userEvent.setup();
    const h = connect();
    render(<Controlled label="Guion" initial="Hola mundo cruel" />);
    const field = screen.getByLabelText<HTMLTextAreaElement>('Guion');
    await user.click(field);
    field.setSelectionRange(5, 10);
    await user.click(screen.getByRole('button', { name: BUTTON }));
    await screen.findByText('Escuchando…');
    h.say();
    await h.answer(0, 'planeta');
    expect(field.value).toBe('Hola planeta cruel');
  });

  it('works from the keyboard, and tabbing through a filled field never gets it replaced', async () => {
    const user = userEvent.setup();
    const h = connect();
    render(<Input label="Título" defaultValue="Mi vídeo" />);
    const field = screen.getByLabelText<HTMLInputElement>('Título');
    await user.tab();
    expect(field).toHaveFocus();
    // Browsers select the whole content of an input reached with Tab.
    field.select();
    await user.tab();
    const button = screen.getByRole('button', { name: BUTTON });
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByText('Escuchando…');
    h.say();
    await h.answer(0, 'de prueba.');
    expect(field.value).toBe('Mi vídeo de prueba');

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: BUTTON })).toHaveAttribute('aria-pressed', 'false'),
    );
  });

  it('only one field dictates at a time', async () => {
    const user = userEvent.setup();
    const h = connect();
    render(
      <>
        <Input label="Título" />
        <Controlled label="Guion" />
      </>,
    );
    await user.click(micOf('Título') as HTMLElement);
    await waitFor(() => expect(micOf('Título')).toHaveAttribute('aria-pressed', 'true'));
    await user.click(micOf('Guion') as HTMLElement);
    await waitFor(() => expect(micOf('Guion')).toHaveAttribute('aria-pressed', 'true'));
    expect(micOf('Título')).toHaveAttribute('aria-pressed', 'false');
    expect(h.mic.state.opened).toBe(2);
    expect(h.mic.state.stopped).toBe(1);
    expect(screen.getAllByRole('group', { name: 'Estado del dictado' })).toHaveLength(1);
  });

  it('speaks the language the field asks for', async () => {
    const user = userEvent.setup();
    const h = connect();
    render(<Controlled label="Guion" dictationLanguage="en" />);
    await user.click(screen.getByRole('button', { name: BUTTON }));
    await screen.findByText('Escuchando…');
    h.say();
    expect(h.requests[0]?.language).toBe('en');
  });

  it('stops and forgets the field when it leaves the page', async () => {
    const user = userEvent.setup();
    const h = connect();
    const view = render(<Controlled label="Guion" />);
    await user.click(screen.getByRole('button', { name: BUTTON }));
    await screen.findByText('Escuchando…');
    view.unmount();
    expect(h.mic.state.stopped).toBe(1);
    expect(dictation.getGlobal().activeFieldId).toBeNull();
  });

  it('says when the field reached its limit', async () => {
    const user = userEvent.setup();
    const h = connect();
    render(<Controlled label="Guion" maxLength={12} />);
    await user.click(screen.getByRole('button', { name: BUTTON }));
    await screen.findByText('Escuchando…');
    h.say();
    await h.answer(0, 'uno dos tres cuatro cinco');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Guion').value).toBe('Uno dos tres');
    expect(
      await screen.findByText(
        'El campo ha llegado a su límite de 12 caracteres. Dictado detenido.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: BUTTON })).toHaveAttribute('data-state', 'error');
  });
});

describe('when dictation cannot run', () => {
  it('the button says it is unavailable, explains why and what to run — and does nothing else', async () => {
    const user = userEvent.setup();
    const h = connect({ caps: MISSING, browser: false });
    render(
      <MemoryRouter>
        <Input label="Título" />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: 'Dictado no disponible' });
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(button).toHaveAttribute('data-state', 'unavailable');
    await user.click(button);
    const panel = await screen.findByRole('group', { name: 'Estado del dictado' });
    expect(panel).toHaveTextContent('No hay ningún motor de dictado disponible.');
    expect(panel).toHaveTextContent('pnpm dictation:setup');
    expect(within(panel).queryByRole('button', { name: /navegador/i })).toBeNull();
    expect(within(panel).getByRole('link', { name: 'Preferencias de dictado' })).toHaveAttribute(
      'href',
      '/settings/preferences#dictation',
    );
    expect(h.mic.state.opened).toBe(0);
    await user.click(within(panel).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('group', { name: 'Estado del dictado' })).toBeNull();
  });

  it('offers the browser engine, which only starts after its notice is accepted', async () => {
    const user = userEvent.setup();
    const h = connect({ caps: MISSING });
    render(
      <MemoryRouter>
        <Input label="Título" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Dictado no disponible' }));
    const panel = await screen.findByRole('group', { name: 'Estado del dictado' });
    expect(panel).toHaveTextContent('El modelo de voz local no está instalado');
    await user.click(within(panel).getByRole('button', { name: 'Usar el dictado del navegador…' }));

    // The notice says, before anything is recorded, that the audio leaves the machine.
    const notice = await screen.findByRole('dialog', {
      name: 'Antes de usar el dictado del navegador',
    });
    expect(notice).toHaveTextContent('En Chrome, el audio se envía a los servidores de Google');
    expect(FakeRecognition.instances).toHaveLength(0);

    // Declining changes nothing.
    await user.click(within(notice).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(FakeRecognition.instances).toHaveLength(0);
    expect(dictation.getGlobal().preferences).toMatchObject({
      engine: 'auto',
      browserConsentAt: null,
    });

    await user.click(screen.getByRole('button', { name: 'Dictado no disponible' }));
    await user.click(await screen.findByRole('button', { name: 'Usar el dictado del navegador…' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Aceptar y usar el del navegador',
      }),
    );
    const listening = await screen.findByRole('group', { name: 'Estado del dictado' });
    await within(listening).findByText('Escuchando…');
    // The engine in use is named, with what it implies.
    expect(within(listening).getByText('Navegador · Web Speech')).toBeInTheDocument();
    expect(listening).toHaveTextContent('en Chrome se envía a Google');
    expect(dictation.getGlobal().preferences.engine).toBe('browser');

    // Live provisional text, then the final text in the field (SpeechRecognition double).
    act(() => FakeRecognition.last().say('mi primer', false));
    expect(within(listening).getByText('mi primer')).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('Título').value).toBe('');
    act(() => FakeRecognition.last().say('mi primer vídeo', true));
    expect(screen.getByLabelText<HTMLInputElement>('Título').value).toBe('Mi primer vídeo');
    expect(h.requests).toHaveLength(0);
  });

  it('translates errors: the same failure reads in English with the English interface', async () => {
    const user = userEvent.setup();
    connect({ caps: MISSING, browser: false });
    await i18n.changeLanguage('en');
    render(
      <MemoryRouter>
        <Input label="Title" />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Dictation unavailable' }));
    const panel = await screen.findByRole('group', { name: 'Dictation status' });
    expect(panel).toHaveTextContent('No dictation engine is available.');
    expect(panel).toHaveTextContent('run "pnpm dictation:setup"');
  });
});

describe('DictationButton next to a field that is not from the kit', () => {
  function RawTitle() {
    const ref = useRef<HTMLInputElement>(null);
    const [title, setTitle] = useState('');
    return (
      <>
        <input
          ref={ref}
          aria-label="Título del vídeo"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
        />
        <DictationButton target={ref} size="sm" />
      </>
    );
  }

  it('dictates into the referenced field', async () => {
    const user = userEvent.setup();
    const h = connect();
    render(<RawTitle />);
    await user.click(screen.getByRole('button', { name: BUTTON }));
    await screen.findByText('Escuchando…');
    h.say();
    await h.answer(0, 'presentación del producto.');
    expect(screen.getByLabelText<HTMLInputElement>('Título del vídeo').value).toBe(
      'Presentación del producto',
    );
  });

  it('renders nothing when signed out', () => {
    render(<RawTitle />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

/* The real runtime (session → capabilities → controller → live region), with the API answered
 * by a fetch double. jsdom has no microphone, which is exactly the case under test. */
describe('DictationRuntime inside the application providers', () => {
  const NOW = '2026-11-01T10:00:00.000Z';
  const session: SessionInfo = {
    user: { id: USER, email: 'lucia@example.test', name: 'Lucía', locale: 'es', createdAt: NOW },
    session: { id: 'ses_a1b2c3d4e5f6g7h8', expiresAt: '2026-12-01T10:00:00.000Z', createdAt: NOW },
    workspaces: [
      {
        id: 'ws_a1b2c3d4e5f6g7h8',
        name: 'Estudio',
        plan: 'free',
        credits: 30,
        createdAt: NOW,
        role: 'owner',
      },
    ],
    currentWorkspaceId: 'ws_a1b2c3d4e5f6g7h8',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function mount(caps: DictationCapabilities, signedIn = true) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/me') {
        return signedIn
          ? json(session)
          : json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401);
      }
      if (url === '/api/capabilities') return json({ dictation: caps });
      return json({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404);
    });
    apiRequester.configure({
      fetch: fetchMock as unknown as typeof fetch,
      validateResponses: false,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <AppProviders client={client}>
        <MemoryRouter>
          <Input label="Título" />
          <Input label="Contraseña" type="password" />
        </MemoryRouter>
      </AppProviders>,
    );
    return fetchMock;
  }

  afterEach(() => {
    apiRequester.configure({ fetch: undefined, validateResponses: undefined });
  });

  it('gives the fields their microphone once the session is known, and reads the capabilities', async () => {
    const fetchMock = mount(READY);
    const button = await screen.findByRole('button', { name: BUTTON });
    expect(button).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /dict/i })).toHaveLength(1);
    await waitFor(() => expect(dictation.getGlobal().capabilities?.local.available).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/capabilities')).toBe(true);
    expect(dictation.getGlobal().preferences.engine).toBe('auto');
  });

  it('offers nothing to a visitor without a session, and asks the server nothing', async () => {
    const fetchMock = mount(READY, false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await flush();
    expect(screen.queryByRole('button', { name: /dict/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/capabilities')).toBe(false);
  });

  it('explains a browser that cannot capture audio, in the panel and in the live region', async () => {
    const user = userEvent.setup();
    mount(READY);
    await user.click(await screen.findByRole('button', { name: BUTTON }));
    const message =
      'Este navegador no puede capturar audio para el dictado local. Actualízalo o usa otro.';
    const panel = await screen.findByRole('group', { name: 'Estado del dictado' });
    await waitFor(() => expect(panel).toHaveTextContent(message));
    const live = document.querySelector('[data-dictation-live]');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent(`Dictado detenido. ${message}`);
    // A capture problem can be retried; it is not a reason to push the browser engine.
    expect(within(panel).getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /navegador/i })).toBeNull();
  });

  it('shows the reason the server gives when the local model is not installed', async () => {
    const user = userEvent.setup();
    mount(MISSING);
    const button = await screen.findByRole('button', { name: 'Dictado no disponible' });
    await user.click(button);
    const panel = await screen.findByRole('group', { name: 'Estado del dictado' });
    await waitFor(() => expect(panel).toHaveTextContent('pnpm dictation:setup'));
  });
});
