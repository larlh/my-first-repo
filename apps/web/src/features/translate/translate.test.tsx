import { api as contract } from '@parlante/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { makeAsset, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import { fakeUploads, others, usePageTestSetup } from '@/features/avatars/kit/testing/page';
import {
  makeOutput,
  makeTranslation,
  translationId,
} from '@/features/script-writer/kit/testing/fixtures';
import {
  WS_B,
  apiError,
  createFakeApi,
  makeCapabilities,
  makeSession,
  makeVideo,
  renderFeatures,
  toSummary,
} from '@/features/videos/testing/harness';
import type { FakeApi } from '@/features/videos/testing/harness';
import translate from './index';

const SRT = `1
00:00:00,000 --> 00:00:01,500
Hola, soy Marta.

2
00:00:01,500 --> 00:00:04,000
Te doy la bienvenida al equipo.
`;

const page = <T,>(items: T[]) => ({ items, nextCursor: null });

/** Everything the "new translation" form reads. */
function withForm(api: FakeApi): FakeApi {
  return api
    .on('GET', '/api/assets', () => page([]))
    .on('GET', '/api/videos', () => page([toSummary(makeVideo(1)), toSummary(makeVideo(2))]))
    .on('GET', '/api/voices', ({ url }) => {
      const language = url.searchParams.get('language') ?? 'es';
      return {
        items: [
          stockVoice(`${language}-f1`, `Voz ${language} A`),
          stockVoice(`${language}-m1`, `Voz ${language} B`),
        ],
      };
    })
    .on('GET', /^\/api\/voices\/[^/]+$/, () => stockVoice('en-f1', 'Emma'));
}

async function pickVideo(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await screen.findByRole('tab', { name: 'Mis vídeos' }));
  await user.click(await screen.findByRole('radio', { name: new RegExp(title) }));
}

describe('translations list', () => {
  usePageTestSetup();

  it('invites to translate the first video', async () => {
    const api = createFakeApi().on('GET', '/api/translations', () => page([]));
    renderFeatures([translate, others], '/translate', api);
    expect(await screen.findByText('Ningún vídeo doblado todavía')).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Nueva traducción' })[0]).toHaveAttribute(
      'href',
      '/translate/new',
    );
  });

  it('lists jobs with their languages, state and cost; a viewer cannot start one', async () => {
    const api = createFakeApi(makeSession('viewer')).on('GET', '/api/translations', () =>
      page([
        makeTranslation(1, { status: 'processing', targetLanguages: ['en', 'fr'] }),
        makeTranslation(2, { status: 'completed', targetLanguages: ['de'] }),
      ]),
    );
    renderFeatures([translate, others], '/translate', api);
    const running = await screen.findByRole('link', { name: /Presentación 1/ });
    expect(running).toHaveAttribute('href', `/translate/${translationId(1)}`);
    expect(
      within(running).getByRole('progressbar', { name: 'Traducción de «Presentación 1»' }),
    ).toHaveAttribute('aria-valuenow', '40');
    const done = screen.getByRole('link', { name: /Presentación 2/ });
    expect(within(done).getByText('1 de 1 idioma listo')).toBeVisible();
    expect(within(done).getByText(/4 créditos/)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Nueva traducción' })).not.toBeInTheDocument();
  });

  it('offers to retry when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    const api = createFakeApi().on('GET', '/api/translations', () =>
      fail ? apiError(500, 'INTERNAL', 'boom') : page([makeTranslation(1)]),
    );
    renderFeatures([translate, others], '/translate', api);
    const retry = await screen.findByRole('button', { name: 'Reintentar' });
    fail = false;
    await user.click(retry);
    expect(await screen.findByRole('link', { name: /Presentación 1/ })).toBeVisible();
  });
});

describe('new translation', () => {
  usePageTestSetup();

  it('says the transcript is mandatory in basic mode and lists what is missing', async () => {
    const user = userEvent.setup();
    const api = withForm(createFakeApi());
    renderFeatures([translate, others], '/translate/new', api);
    expect(
      await screen.findByText(/el reconocimiento de voz es manual \(modo básico\)/),
    ).toBeVisible();
    expect(await screen.findByText('Traducción en modo básico')).toBeVisible();
    expect(screen.getByText('Elige el vídeo y los idiomas para calcular el coste')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Traducir' }));
    const problems = within(
      screen.getByText('Falta algo para poder lanzarla').closest('[role="alert"]') as HTMLElement,
    ).getAllByRole('listitem');
    expect(problems.map((item) => item.textContent)).toEqual([
      'Elige o sube el vídeo que quieres traducir.',
      'Marca al menos un idioma de destino.',
      'Aporta la transcripción: en modo básico es obligatoria.',
    ]);
    expect(api.requests('POST', '/api/translations')).toHaveLength(0);
  });

  it('translates a workspace video: languages, transcript, voices, cost and launch', async () => {
    const user = userEvent.setup();
    const job = makeTranslation(9, { status: 'queued', targetLanguages: ['en', 'fr'] });
    const api = withForm(createFakeApi())
      .on('POST', '/api/translations', () => new Response(JSON.stringify(job), { status: 202 }))
      .on('GET', `/api/translations/${job.id}`, () => job);
    const { router } = renderFeatures([translate, others], '/translate/new', api);

    await pickVideo(user, 'Vídeo 1');
    expect(await screen.findByText('Vídeo del workspace · 42 s')).toBeVisible();
    await user.click(screen.getByRole('checkbox', { name: /Français/ }));
    await user.click(screen.getByRole('checkbox', { name: /English/ }));
    // The source language is never a target.
    expect(screen.queryByRole('checkbox', { name: /^Español/ })).not.toBeInTheDocument();
    expect(screen.getByText('2 de 5')).toBeVisible();

    const transcript = screen.getByLabelText(/Transcripción del vídeo original/);
    await user.click(transcript);
    await user.paste(SRT);
    expect(
      await screen.findByText('2 fragmentos reconocidos; cubren hasta 0:04 de 0:42.'),
    ).toBeVisible();

    // One voice selector per target language; "automatic" unless the person chooses.
    expect(screen.getByRole('combobox', { name: /Voz para English/ })).toBeVisible();
    expect(screen.getByRole('combobox', { name: /Voz para Français/ })).toBeVisible();
    await user.click(screen.getByRole('switch', { name: 'Incrustar los subtítulos traducidos' }));

    // 42 s → 1 started minute × 2 languages × 2 credits.
    expect(screen.getByText('Cuesta 4 créditos')).toBeVisible();
    expect(screen.getByText(/1 min × 2 idiomas/)).toBeVisible();
    expect(screen.getByText('«Vídeo 1», de español a inglés, francés.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Traducir a 2 idiomas' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/translate/${job.id}`));
    const body = api.requests('POST', '/api/translations')[0]?.body;
    expect(body).toEqual({
      name: 'Vídeo 1',
      sourceVideoId: 'vid_0001abcdefgh1234',
      sourceLanguage: 'es',
      targetLanguages: ['en', 'fr'],
      transcript: { format: 'srt', content: SRT },
      voices: {},
      options: { originalAudioVolume: 0.08, burnSubtitles: true },
    });
    expect(contract.translations.create.body.safeParse(body).success).toBe(true);
  });

  it('opens from a finished video with it selected and its subtitles as the transcript', async () => {
    const user = userEvent.setup();
    const video = makeVideo(1, { title: 'Bienvenida al equipo' });
    const job = makeTranslation(9, { status: 'queued', targetLanguages: ['en'] });
    const api = withForm(createFakeApi())
      .on('GET', `/api/videos/${video.id}`, () => video)
      .on('POST', '/api/translations', () => new Response(JSON.stringify(job), { status: 202 }))
      .on('GET', `/api/translations/${job.id}`, () => job);
    renderFeatures([translate, others], `/translate/new?video=${video.id}`, api);

    // Step 1 is already answered and the local mode's mandatory transcript is filled in with
    // the subtitles file of the render (the test harness serves a WebVTT for any file).
    expect(await screen.findByText(/Vídeo del workspace/)).toBeVisible();
    const transcript = screen.getByLabelText(/Transcripción del vídeo original/);
    await waitFor(() => expect((transcript as HTMLTextAreaElement).value).toMatch(/-->/));
    const filled = (transcript as HTMLTextAreaElement).value;
    expect(
      screen.getByText(/Rellenada con los subtítulos de «Bienvenida al equipo»/),
    ).toBeVisible();

    await user.click(screen.getByRole('checkbox', { name: /English/ }));
    await user.click(screen.getByRole('button', { name: 'Traducir a 1 idioma' }));
    await waitFor(() => expect(api.requests('POST', '/api/translations')).toHaveLength(1));
    const body = api.requests('POST', '/api/translations')[0]?.body;
    expect(body).toMatchObject({
      name: 'Bienvenida al equipo',
      sourceVideoId: video.id,
      sourceLanguage: 'es',
      targetLanguages: ['en'],
      transcript: { format: filled.startsWith('WEBVTT') ? 'vtt' : 'srt', content: filled },
    });
    expect(contract.translations.create.body.safeParse(body).success).toBe(true);
  });

  it('uploads a video as the source and reuses it by asset id', async () => {
    const user = userEvent.setup();
    const asset = makeAsset(5, {
      kind: 'video',
      purpose: 'translation_source',
      name: 'demo.mp4',
      mimeType: 'video/mp4',
      durationMs: 125_000,
    });
    const uploads = fakeUploads(() => ({ status: 201, body: asset }));
    const job = makeTranslation(9, { status: 'queued' });
    const api = withForm(createFakeApi())
      .on('POST', '/api/translations', () => new Response(JSON.stringify(job), { status: 202 }))
      .on('GET', `/api/translations/${job.id}`, () => job);
    renderFeatures([translate, others], '/translate/new', api);

    await screen.findByRole('button', { name: 'Subir el vídeo que quieres traducir' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('the dropzone has no file input');
    await user.upload(input, new File(['video'], 'demo.mp4', { type: 'video/mp4' }));
    expect(await screen.findByText('Vídeo subido · 2 min 5 s')).toBeVisible();
    expect(uploads[0]?.fields).toMatchObject({ purpose: 'translation_source', name: 'demo.mp4' });

    await user.click(screen.getByRole('checkbox', { name: /Deutsch/ }));
    await user.click(screen.getByRole('radio', { name: 'Texto sin tiempos' }));
    await user.click(screen.getByLabelText(/Transcripción del vídeo original/));
    await user.paste('Hola, soy Marta. Te doy la bienvenida.');
    // 125 s → 3 started minutes × 1 language × 2 credits.
    expect(await screen.findByText('Cuesta 6 créditos')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Traducir a 1 idioma' }));
    await waitFor(() => expect(api.requests('POST', '/api/translations')).toHaveLength(1));
    expect(api.requests('POST', '/api/translations')[0]?.body).toMatchObject({
      sourceAssetId: asset.id,
      targetLanguages: ['de'],
      transcript: { format: 'text', content: 'Hola, soy Marta. Te doy la bienvenida.' },
    });
  });

  it('caps the target languages at the plan limit and blocks what the balance cannot pay', async () => {
    const user = userEvent.setup();
    // The free workspace: one target language, 3 credits.
    const api = withForm(createFakeApi(makeSession('owner', { currentWorkspaceId: WS_B }))).on(
      'GET',
      '/api/videos',
      () => page([toSummary(makeVideo(1, { durationMs: 150_000 }))]),
    );
    renderFeatures([translate, others], '/translate/new', api);
    await pickVideo(user, 'Vídeo 1');
    await user.click(screen.getByRole('checkbox', { name: /English/ }));
    expect(
      screen.getByText('Has llegado al límite de tu plan: 1 idioma por traducción.'),
    ).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Français/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /English/ })).toBeEnabled();

    await user.click(screen.getByLabelText(/Transcripción del vídeo original/));
    await user.paste(SRT);
    // 150 s → 3 minutes × 1 × 2 = 6 credits, the workspace has 3.
    const cost = screen.getByText('Cuesta 6 créditos').closest('[role="alert"]') as HTMLElement;
    expect(within(cost).getByText(/Te faltan 3 créditos/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Traducir a 1 idioma' }));
    expect(
      await screen.findByText('No hay créditos suficientes para esta traducción.'),
    ).toBeVisible();
    expect(api.requests('POST', '/api/translations')).toHaveLength(0);
  });

  it('makes the transcript optional when the server can recognise speech', async () => {
    const capabilities = makeCapabilities();
    const whisper = { id: 'openai', name: 'Whisper', quality: 'premium' as const, local: false };
    const api = withForm(createFakeApi()).on('GET', '/api/capabilities', () => ({
      ...capabilities,
      active: { ...capabilities.active, stt: whisper },
      sttRequiresTranscript: false,
    }));
    renderFeatures([translate, others], '/translate/new', api);
    expect(
      await screen.findByText(/El servidor transcribe el audio automáticamente/),
    ).toBeVisible();
    expect(screen.getAllByText('Alta calidad · Whisper').length).toBeGreaterThan(0);
  });
});

describe('translation detail', () => {
  usePageTestSetup();

  it('follows a running job language by language', async () => {
    const job = makeTranslation(1, {
      status: 'processing',
      targetLanguages: ['en', 'fr', 'de'],
      outputs: [makeOutput('en', 'completed'), makeOutput('fr', 'processing')],
    });
    const api = withForm(createFakeApi()).on('GET', `/api/translations/${job.id}`, () => job);
    renderFeatures([translate, others], `/translate/${job.id}`, api);

    expect(await screen.findByRole('heading', { name: 'Presentación 1' })).toBeVisible();
    expect(screen.getByText('Grabando las voces del doblaje')).toBeVisible();
    expect(screen.getByText('1 de 3 idiomas listos')).toBeVisible();
    expect(screen.getByText('Doblando al francés…')).toBeVisible();
    expect(screen.getByText('A la espera de su turno.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Descargar MP4' })).toBeVisible();
    // Honesty: who did each step and that the translation is the basic one.
    expect(screen.getByText('Modo básico · Traducción básica por glosario (local)')).toBeVisible();
    expect(screen.getByText(/sustitución por glosario, palabra a palabra/)).toBeVisible();
    expect(screen.getByText('Aportada por ti')).toBeVisible();
    expect(screen.getByText('8 %')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancelar y eliminar' })).toBeVisible();
  });

  it('offers the player and the downloads of every finished language', async () => {
    const job = makeTranslation(2, { targetLanguages: ['en'] });
    const api = withForm(createFakeApi()).on('GET', `/api/translations/${job.id}`, () => job);
    renderFeatures([translate, others], `/translate/${job.id}`, api);

    const mp4 = await screen.findByRole('link', { name: 'Descargar MP4' });
    expect(mp4.getAttribute('href')).toContain('/en/video.mp4');
    expect(mp4.getAttribute('href')).toContain('download=video.mp4');
    expect(screen.getByRole('link', { name: 'SRT' })).toHaveAttribute(
      'download',
      'Presentación 2.en.srt',
    );
    expect(screen.getByRole('link', { name: 'VTT' }).getAttribute('href')).toContain(
      '/en/subtitles.vtt',
    );
    const videos = [...document.querySelectorAll('video')].map((video) =>
      video.getAttribute('src'),
    );
    expect(videos.some((src) => src?.includes('/en/video.mp4'))).toBe(true);
    expect(videos.some((src) => src?.includes('source-2.mp4'))).toBe(true);
  });

  it('explains a partial result and deletes the job on request', async () => {
    const user = userEvent.setup();
    const job = makeTranslation(3, {
      status: 'partial',
      targetLanguages: ['en', 'fr'],
      outputs: [makeOutput('en', 'completed'), makeOutput('fr', 'failed')],
    });
    const api = withForm(createFakeApi())
      .on('GET', `/api/translations/${job.id}`, () => job)
      .on('GET', '/api/translations', () => page([]))
      .on('DELETE', `/api/translations/${job.id}`, () => ({ ok: true }));
    const { router } = renderFeatures([translate, others], `/translate/${job.id}`, api);

    expect(
      await screen.findByText(/Los créditos de los idiomas fallidos se han devuelto/),
    ).toBeVisible();
    expect(screen.getByText(/1 de 2 idiomas listos · 1 fallido/)).toBeVisible();
    // A sentence of the worker with no Spanish wording is shown, labelled as a technical detail.
    expect(screen.getByText('Detalle técnico (en inglés): TTS provider timed out')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Eliminar' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/Se borran los vídeos doblados y sus subtítulos/),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/translate'));
    expect(api.requests('DELETE', `/api/translations/${job.id}`)).toHaveLength(1);
  });

  it('says so when the job does not exist', async () => {
    const api = createFakeApi();
    renderFeatures([translate, others], `/translate/${translationId(404)}`, api);
    expect(await screen.findByRole('heading', { name: 'Traducción no disponible' })).toBeVisible();
  });
});
