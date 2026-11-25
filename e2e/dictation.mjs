// End-to-end check of dictation by microphone with the LOCAL engine: the real web app, API and
// worker (started by scripts/e2e.sh against a brand-new database), the speech model installed
// on this machine and a real Chromium whose microphone is fed from a WAV file. Nothing is
// mocked and the network is never intercepted: the browser captures "the microphone", cuts the
// phrase, posts it to the API, the model transcribes it and the text lands in the field.
//
//   bash scripts/e2e.sh e2e/dictation.mjs
//
// The spoken phrase is synthesised by the product itself, through the API, with the default
// English voice of the stack (a local neural voice when one is installed, eSpeak NG otherwise):
// no recording of a person is involved. The run is SKIPPED, with a visible notice, when the
// local speech model is not installed (`pnpm dictation:setup`).
//
// What it walks through: preferences (engine, language, what the page explains) → fields that
// must never offer dictation → title of a new video → Studio script (language of the scene
// voice, autosave, undo / redo, reload) → Studio title → script writer topic → message to the
// interactive avatar. The browser engine (Web Speech API) needs the speech service of the
// browser vendor and cannot be exercised here; the unit tests cover it with a double.
import {
  API_URL,
  ARTIFACTS_DIR,
  WEB_URL,
  apiCall,
  check,
  checkCount,
  checkEqual,
  dumpPage,
  fs,
  loadPlaywright,
  log,
  newSession,
  path,
  registerThroughUi,
  run,
  section,
  uniqueEmail,
  until,
  voiceSetup,
} from './lib.mjs';

const { chromium } = loadPlaywright();

/**
 * English: the open model understands the English voices of the product reliably — also the
 * basic eSpeak one, whose Spanish it understands poorly.
 */
const PHRASE = 'Next week we have an important meeting with the whole team.';
const PHRASE_LANGUAGE = 'en';
/** Share of the words that must match: the check is about the pipeline, not the model's WER. */
const MIN_SIMILARITY = 0.8;
const WAV = path.join(ARTIFACTS_DIR, 'dictation-phrase.wav');

const normalize = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 1 − (word edit distance / length of the longer text). */
function similarity(a, b) {
  const x = normalize(a).split(' ').filter(Boolean);
  const y = normalize(b).split(' ').filter(Boolean);
  if (x.length === 0 || y.length === 0) return 0;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length);
}

const heard = (text) => similarity(text, PHRASE) >= MIN_SIMILARITY;
const properties = (page) => page.getByRole('complementary', { name: 'Propiedades' });
const videoIdOf = (page) => /\/(?:studio|videos)\/(vid_[a-z0-9]+)/.exec(page.url())?.[1] ?? null;
/** The microphone of a kit field lives in the wrapper of the control, next to it. */
const micOf = (field) => field.locator('xpath=..').locator('[data-dictation-button]');
const panelOf = (page) => page.locator('[data-dictation-panel]');

async function waitSaved(page) {
  await page
    .locator('[data-testid="save-status"][data-status="saved"]')
    .waitFor({ timeout: 30_000 });
}

/* ------------------------------------------------------------------------------------------
 * The dictation itself: press the microphone, let Chromium "speak" the WAV, wait for the text
 * ---------------------------------------------------------------------------------------- */

/**
 * `added(now, before)` tells which part of the field is the dictated text; by default what
 * was appended after the previous content. `accept(text)` says when that text is the dictated
 * phrase; by default when it reads like PHRASE.
 */
async function dictate(
  page,
  { field, mic, label, added = (now, before) => now.slice(before.length), accept = heard },
) {
  const before = await field.inputValue();
  checkEqual(
    `${label}: micrófono en reposo, sin pulsar`,
    await mic.getAttribute('aria-pressed'),
    'false',
  );
  checkEqual(
    `${label}: el botón se llama`,
    await mic.getAttribute('aria-label'),
    'Dictar con el micrófono',
  );

  await mic.click();
  const panel = panelOf(page);
  await panel.and(page.locator('[data-state="listening"]')).waitFor({ timeout: 20_000 });
  checkEqual(
    `${label}: al escuchar, el botón queda pulsado`,
    await mic.getAttribute('aria-pressed'),
    'true',
  );
  const status = (await panel.textContent()).replace(/\s+/g, ' ');
  check(`${label}: el panel dice que está escuchando`, /Escuchando/.test(status));
  check(
    `${label}: nombra el motor que transcribe (local, modo básico)`,
    /Modo básico · Whisper/.test(status) && /no sale de ella/.test(status),
    status,
  );
  // The fake microphone is playing the phrase: the input level must move.
  await until(
    'the input level to rise while the phrase plays',
    async () =>
      Number(await panel.locator('[data-dictation-level]').getAttribute('data-dictation-level')) >=
      0.4,
    { timeoutMs: 10_000, everyMs: 60 },
  );
  check(`${label}: el nivel de entrada sube mientras suena la frase`, true);

  const value = await until(
    'the dictated phrase to appear in the field',
    async () => {
      const now = await field.inputValue();
      return now !== before && accept(added(now, before)) ? now : null;
    },
    { timeoutMs: 60_000 },
  );
  const text = added(value, before).trim();
  check(
    `${label}: el texto dictado aparece en el campo`,
    true,
    `«${text}» (parecido ${similarity(text, PHRASE).toFixed(2)})`,
  );

  await page.keyboard.press('Escape');
  await mic.and(page.locator('[data-state="idle"]')).waitFor({ timeout: 30_000 });
  checkEqual(
    `${label}: Escape detiene el dictado`,
    await mic.getAttribute('aria-pressed'),
    'false',
  );
  check(`${label}: el panel de estado desaparece`, (await panel.count()) === 0);
  checkEqual(`${label}: nada más se escribe tras detener`, await field.inputValue(), value);
  return value;
}

/* ------------------------------------------------------------------------------------------
 * main
 * ---------------------------------------------------------------------------------------- */

async function main(browser) {
  const session = await newSession(browser, { name: 'dictation' });
  const { page, context } = session;
  const email = uniqueEmail('dictation');
  /** Every answer of the real transcription route (the request body cannot be read back). */
  const transcriptions = [];
  page.on('response', (response) => {
    if (!response.url().endsWith('/api/dictation/transcribe')) return;
    response
      .json()
      .catch(() => null)
      .then((body) => transcriptions.push({ status: response.status(), body }));
  });
  let videoId = null;
  let title = '';
  let script = '';

  try {
    let installed = false;
    let voices = null;
    await section('Preparación: cuenta, motor local y frase sintetizada', async () => {
      await registerThroughUi(page, { name: 'Diana Dictado', email });
      await page.getByRole('heading', { level: 1, name: /Diana/ }).waitFor();
      const capabilities = await apiCall(context, 'GET', '/api/capabilities');
      checkEqual('GET /api/capabilities', capabilities.status, 200);
      const { local } = capabilities.json.dictation;
      installed = local.available;
      if (!installed) return;
      checkEqual('el motor local se anuncia como proveedor local básico', local.provider, {
        id: local.provider.id,
        name: local.provider.name,
        quality: 'basic',
        local: true,
      });

      // The default English voice of this stack: neural when installed, eSpeak NG otherwise.
      voices = await voiceSetup(context);
      const speaker = voices.pick(PHRASE_LANGUAGE, 'male');
      const speech = await apiCall(context, 'POST', '/api/tts/synthesize', {
        text: PHRASE,
        voiceId: speaker.id,
        language: PHRASE_LANGUAGE,
        speed: 1,
        pitch: 0,
      });
      checkEqual('POST /api/tts/synthesize', speech.status, 200);
      checkEqual(
        `la frase la sintetiza la voz del producto (${speaker.name} · ${speaker.provider.name})`,
        speech.json.provider.id,
        speaker.provider.id,
      );
      const audio = await context.request.get(speech.json.audioUrl.replace(API_URL, WEB_URL));
      const raw = path.join(ARTIFACTS_DIR, 'dictation-phrase-raw.wav');
      fs.writeFileSync(raw, await audio.body());
      // What the fake microphone will "hear": a moment of silence, the phrase, silence.
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        raw,
        '-af',
        'adelay=700:all=1,apad=pad_dur=4',
        '-ar',
        '48000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        WAV,
      ]);
      check(
        'WAV para el micrófono simulado',
        fs.statSync(WAV).size > 100_000,
        `${(fs.statSync(WAV).size / 1024).toFixed(0)} KiB, ${speech.json.runtime.audioDurationMs} ms de voz`,
      );
    });

    if (!installed) {
      console.log(
        '\n' +
          '  ┌──────────────────────────────────────────────────────────────────────────┐\n' +
          '  │  SKIPPED · e2e/dictation.mjs                                             │\n' +
          '  │  The local speech model is not installed on this machine.                │\n' +
          '  │  Run `pnpm dictation:setup` (one download, about 140 MB) and try again.  │\n' +
          '  └──────────────────────────────────────────────────────────────────────────┘\n',
      );
      return 'skipped';
    }

    await section('Preferencias: motor, idioma y qué sale del equipo', async () => {
      await page.goto(`${WEB_URL}/settings/preferences`);
      const panel = page.getByRole('region', { name: 'Dictado por micrófono' });
      await panel.getByText(/^Disponible · Whisper/).waitFor();
      check('la página dice que el motor local está disponible y cuál es', true);
      check(
        'el motor por defecto es el automático (local)',
        await panel.getByRole('radio', { name: /Automático/ }).isChecked(),
      );
      const text = (await panel.textContent()).replace(/\s+/g, ' ');
      check(
        'explica qué sale del equipo con cada motor',
        /Nada sale de tu instalación/.test(text) &&
          /en Chrome, a los servidores de Google/.test(text),
      );

      // Choosing the browser engine shows the notice first; declining changes nothing.
      const browserChoice = panel.getByRole('radio', { name: /^Navegador/ });
      if (await browserChoice.isEnabled()) {
        await browserChoice.click({ force: true });
        const notice = page.getByRole('dialog', { name: 'Antes de usar el dictado del navegador' });
        await notice.waitFor();
        check(
          'elegir el motor del navegador avisa antes de que el audio salga hacia Google',
          /En Chrome, el audio se envía a los servidores de Google/.test(
            await notice.textContent(),
          ),
        );
        await notice.getByRole('button', { name: 'Cancelar' }).click();
        await notice.waitFor({ state: 'hidden' });
        check(
          'sin aceptar el aviso, el motor sigue siendo el automático',
          await panel.getByRole('radio', { name: /Automático/ }).isChecked(),
        );
      } else {
        log('   este Chromium no tiene Web Speech API: el motor del navegador aparece desactivado');
      }

      await panel.getByRole('combobox', { name: 'Idioma en el que dictas' }).click();
      await page.getByRole('option', { name: 'English' }).click();
      const stored = await page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('parlante.dictation.'));
        return key ? JSON.parse(localStorage.getItem(key)) : null;
      });
      checkEqual('la preferencia se guarda para este usuario en el navegador', stored, {
        engine: 'auto',
        language: 'en',
        showButtons: true,
        browserConsentAt: null,
      });
    });

    await section('Campos que nunca ofrecen dictado', async () => {
      await page.goto(`${WEB_URL}/settings/profile`);
      const name = page.getByRole('textbox', { name: 'Nombre', exact: true });
      await name.waitFor();
      await micOf(name).waitFor();
      check('el nombre (texto libre) tiene micrófono', true);
      checkEqual(
        'el correo (solo lectura) no lo tiene',
        await micOf(page.getByRole('textbox', { name: 'Correo electrónico' })).count(),
        0,
      );
      const passwords = page.locator('input[type=password]');
      check('la página tiene campos de contraseña', (await passwords.count()) >= 2);
      checkEqual(
        'las contraseñas no tienen micrófono',
        await passwords.locator('xpath=..').locator('[data-dictation-button]').count(),
        0,
      );
      checkEqual(
        'solo el nombre ofrece dictado en el perfil',
        await page.getByRole('main').locator('[data-dictation-button]').count(),
        1,
      );
    });

    await section('Título de un vídeo nuevo', async () => {
      await page.goto(`${WEB_URL}/videos/new`);
      const field = page.getByLabel(/^Título/);
      title = await dictate(page, { field, mic: micOf(field), label: 'título' });
      await until('the transcription to be recorded', () => transcriptions.length > 0);
      checkEqual(
        'el título se dicta en el idioma elegido en las preferencias (no en el de la interfaz)',
        transcriptions[0].body.language,
        'en',
      );
      check('en un título no se añade el punto final de la frase', !title.endsWith('.'), title);
      check('empieza con mayúscula', /^[A-Z]/.test(title), title);
      await page.getByRole('button', { name: 'Crear y abrir el Studio' }).click();
      await page.waitForURL(/\/studio\/vid_/);
      await page.getByTestId('stage-canvas').waitFor();
      videoId = videoIdOf(page);
      checkEqual(
        'el vídeo se crea con el título dictado',
        (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json.title,
        title,
      );
      checkEqual(
        'el Studio abre con ese título',
        await page.getByLabel('Título del vídeo').inputValue(),
        title,
      );
    });

    await section(
      'Guion del Studio: idioma de la voz, autoguardado, recarga y deshacer',
      async () => {
        await properties(page).getByRole('tab', { name: 'Escena' }).click();
        await page.getByRole('radio', { name: 'Texto a voz' }).click();
        // The scene speaks Spanish (the default voice) while the user's dictation language is
        // English: the script must be dictated in the language of the scene, not the user's.
        const voice = (await properties(page).getByTestId('voice-name').textContent()).trim();
        const sceneLanguage = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json
          .composition.scenes[0].script.language;
        checkEqual(`la voz de la escena (${voice}) habla`, sceneLanguage, 'es');
        // A new scene comes with a sample line: start from an empty script.
        const field = page.getByLabel('Texto que dirá el avatar');
        await field.fill('');
        await field.blur();
        await waitSaved(page);
        const sent = transcriptions.length;
        await field.click();
        // The microphone still "hears" the English phrase, now transcribed as Spanish: what the
        // model writes then depends on the voice (it keeps eSpeak's English words and renders a
        // natural English voice into Spanish), so the words are not compared with the phrase
        // here. What must hold is the path: one sentence lands in the script, it is exactly
        // what the server transcribed, and it was transcribed in the language of the scene.
        script = await dictate(page, {
          field,
          mic: micOf(field),
          label: 'guion',
          accept: (text) => normalize(text).split(' ').length >= 4,
        });
        await until('the transcription to be recorded', () => transcriptions.length > sent);
        // Unlike a title, the script keeps the sentence's closing mark. Whether there IS one is
        // up to the model: with eSpeak it writes the full sentence with its period, but a natural
        // neural English voice transcribed as Spanish can come back cut short and without one.
        // So the script must end the way the server's text ends — never stripped, never invented.
        const served = String(transcriptions[sent].body.text ?? '').trim();
        const closing = /[.!?…]$/.test(served) ? served.slice(-1) : '';
        check(
          'en el guion la frase conserva su puntuación final',
          closing ? script.trim().endsWith(closing) : !/[.!?…]$/.test(script.trim()),
          `servidor: «${served}» → guion: «${script.trim()}»`,
        );
        checkEqual(
          'el guion se dicta en el idioma de la voz de la escena, no en el del usuario',
          transcriptions[sent].body.language,
          sceneLanguage,
        );
        checkEqual(
          'lo que queda en el guion es lo que transcribió el servidor',
          normalize(script),
          normalize(transcriptions[sent].body.text),
        );

        await field.blur();
        await waitSaved(page);
        const saved = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json;
        checkEqual(
          'el guion dictado se autoguarda en el servidor',
          saved.composition.scenes[0].script.text,
          script,
        );

        // Undo / redo treat the dictated text like typed text.
        const banner = page.getByRole('banner');
        await banner.getByRole('button', { name: 'Deshacer' }).click();
        checkEqual('deshacer quita el texto dictado', await field.inputValue(), '');
        await banner.getByRole('button', { name: 'Rehacer' }).click();
        checkEqual('rehacer lo devuelve', await field.inputValue(), script);
        await waitSaved(page);

        await page.reload();
        await page.getByTestId('stage-canvas').waitFor();
        await properties(page).getByRole('tab', { name: 'Escena' }).click();
        checkEqual(
          'tras recargar, el guion dictado sigue ahí',
          await page.getByLabel('Texto que dirá el avatar').inputValue(),
          script,
        );
      },
    );

    await section('Título en la barra del Studio (campo fuera del kit)', async () => {
      const field = page.getByLabel('Título del vídeo');
      const mic = page.getByRole('banner').locator('[data-dictation-button]');
      await field.fill('Borrador sin nombre');
      await field.blur();
      await waitSaved(page);
      // Select the whole title: the dictation replaces the selection.
      await field.click();
      await field.selectText();
      const next = await dictate(page, {
        field,
        mic,
        label: 'título del Studio',
        added: (now) => now,
      });
      check('el texto dictado sustituye a la selección', !/Borrador/.test(next), next);
      await field.blur();
      await waitSaved(page);
      checkEqual(
        'el título dictado se autoguarda',
        (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json.title,
        next,
      );
    });

    await section('Tema del guionista: inserción en el cursor', async () => {
      await page.goto(`${WEB_URL}/script-writer`);
      const field = page.getByLabel(/^Tema/);
      const [head, tail] = ['First point. ', 'Last point.'];
      await field.fill(head + tail);
      // Caret between the two sentences: the phrase goes there, with its spaces.
      await field.focus();
      await field.evaluate((element, at) => element.setSelectionRange(at, at), head.length);
      const value = await dictate(page, {
        field,
        mic: micOf(field),
        label: 'tema',
        added: (now) => now.slice(head.length, Math.max(head.length, now.length - tail.length)),
      });
      check(
        'el texto entra donde estaba el cursor y conserva lo de antes y lo de después',
        value.startsWith(head) && value.endsWith(` ${tail}`),
        value,
      );
    });

    await section('Mensaje al avatar interactivo', async () => {
      await page.goto(`${WEB_URL}/interactive`);
      await page.getByRole('button', { name: 'Empezar a hablar' }).waitFor();
      await page
        .getByLabel(/^Conocimiento/)
        .fill('When is the meeting? The meeting with the whole team is next week, on Tuesday.');
      await page.getByRole('button', { name: 'Empezar a hablar' }).click();
      await page.waitForURL(/\/interactive\/[a-z]+_[a-z0-9]+/);
      const box = page.getByRole('textbox', { name: /^Mensaje para / });
      await box.waitFor();
      // The avatar speaks Spanish (the default voice of a new session), so the message is
      // transcribed as Spanish: as in the Studio script, the words depend on the voice that
      // "speaks" into the microphone and are not compared with the phrase.
      const sent = transcriptions.length;
      const message = await dictate(page, {
        field: box,
        mic: micOf(box),
        label: 'mensaje',
        accept: (text) => normalize(text).split(' ').length >= 4,
      });
      await until('the transcription to be recorded', () => transcriptions.length > sent);
      const sessionId = /\/interactive\/([a-z]+_[a-z0-9]+)/.exec(page.url())[1];
      const { session: talk } = (
        await apiCall(context, 'GET', `/api/interactive/sessions/${sessionId}`)
      ).json;
      const talkVoice = voices.items.find((voice) => voice.id === talk.voiceId);
      checkEqual(
        `el mensaje se dicta en el idioma de la voz del avatar (${talkVoice?.name})`,
        transcriptions[sent].body.language,
        talkVoice?.language.slice(0, 2),
      );
      const reply = page.waitForResponse(
        (response) =>
          /\/api\/interactive\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      );
      await box.press('Enter');
      const response = await reply;
      checkEqual('el mensaje dictado se envía al avatar', response.status(), 200);
      const exchange = await response.json();
      checkEqual('el servidor recibe el texto dictado', exchange.userMessage.text, message.trim());
      check('y el avatar contesta', exchange.assistantMessage.text.length > 0);
      // …out loud, with a default voice of the stack (neural when one is installed).
      const speakers = new Set(voices.items.filter((v) => v.isDefault).map((v) => v.provider.id));
      check(
        '…en voz alta, con la voz por defecto de la pila',
        typeof exchange.speech?.audioUrl === 'string' && speakers.has(exchange.speech.provider.id),
        `${exchange.speech?.provider?.name}${voices.neural ? '' : ' (reserva: sin voces neuronales)'}`,
      );
      if (voices.neural) {
        check(
          '…que es neuronal local',
          ['kokoro', 'piper'].includes(exchange.speech.provider.id),
          exchange.speech.provider.id,
        );
      }
    });

    await section('Lo que pasó por la red', async () => {
      check(
        'hubo una transcripción real por cada dictado',
        transcriptions.length >= 5,
        `${transcriptions.length}`,
      );
      checkEqual(
        'todas contestaron 200',
        transcriptions.map((entry) => entry.status).filter((status) => status !== 200),
        [],
      );
      checkEqual(
        'todas las hizo el proveedor local',
        [
          ...new Set(
            transcriptions.map((entry) => `${entry.body.provider.id}:${entry.body.provider.local}`),
          ),
        ],
        ['local-whisper:true'],
      );
      check(
        'cada petición llevó una frase corta, no una grabación continua',
        transcriptions.every((entry) => entry.body.audioMs > 2000 && entry.body.audioMs < 8000),
        transcriptions.map((entry) => `${entry.body.audioMs} ms`).join(', '),
      );
      log(
        `   idiomas: ${transcriptions.map((entry) => entry.body.language ?? '—').join(', ')} · ` +
          `servidor: ${transcriptions.map((entry) => `${entry.body.processingMs} ms`).join(', ')}`,
      );
      checkEqual(
        'sin errores de consola (salvo el 401 de la sesión anónima antes de registrarse)',
        session.problems.filter((problem) => !/401 .*\/api\/auth\/me/.test(problem)),
        [],
      );
    });
    return 'ok';
  } catch (err) {
    await dumpPage(session, 'dictation');
    throw err;
  } finally {
    await context.close();
  }
}

// Chromium "hears" the WAV as its microphone; `%noloop` plays it once per capture. The file is
// opened when a capture starts, so it can be written after the browser is launched.
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}%noloop`,
  ],
});
let failed = null;
let outcome = 'ok';
try {
  outcome = await main(browser);
} catch (err) {
  failed = err;
} finally {
  await browser.close();
}
if (failed) {
  console.error(
    `\n✘ e2e/dictation.mjs failed after ${checkCount()} checks:\n${failed?.stack ?? failed}`,
  );
  process.exit(1);
}
console.log(
  outcome === 'skipped'
    ? `\n⚠ e2e/dictation.mjs: SKIPPED (local speech model not installed) — ${checkCount()} comprobaciones previas en verde`
    : `\n✔ e2e/dictation.mjs: ${checkCount()} comprobaciones en verde`,
);
