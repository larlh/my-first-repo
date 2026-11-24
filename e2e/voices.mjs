// End-to-end check of the LOCAL NEURAL voices: the real web app, API and worker (started by
// scripts/e2e.sh against a brand-new database), the voice models installed on this machine and
// a real Chromium. Nothing is mocked and the network is never intercepted.
//
//   bash scripts/e2e.sh e2e/voices.mjs
//
// The same walk runs as the `neural` section of e2e/core.mjs (this file exports it). It is
// SKIPPED, with a visible notice, when the stack has no neural voice: they are not installed
// (`pnpm voices:setup`) or the run forces another provider (`E2E_TTS_PROVIDER=espeak`).
//
// What it walks through:
//   library   neural voices listed first with their provider, the ones that are not installed
//             explained; a preview REALLY sounds (level measured in the browser and in the WAV)
//             and the presenter of the listening desk moves
//   studio    a new video starts with the neural voice; in the preview the mouth of the 2D
//             avatar is open where the model pronounces an open vowel and closed in its pauses
//             (instants taken from the timeline the model returned), and the preview sounds
//   export    the render reuses the audio of the preview (same timeline in the subtitles, no
//             second synthesis) and the MP4 carries the voice
//
// Nobody can listen here: "it sounds" means a measured signal, and it is reported as such.
import {
  API_URL,
  ARTIFACTS_DIR,
  WEB_URL,
  apiCall,
  check,
  checkCount,
  checkEqual,
  compareRgb,
  dumpPage,
  ffprobe,
  fs,
  loadPlaywright,
  log,
  meanVolumeDb,
  newSession,
  notice,
  path,
  registerThroughUi,
  section,
  sleep,
  uniqueEmail,
  until,
  wavLevel,
} from './lib.mjs';
import { pathToFileURL } from 'node:url';

const { chromium } = loadPlaywright();

/** Open vowels with stops between them and a full stop in the middle: easy to tell apart. */
const SCRIPT = 'Mamá ama la casa blanca. Papá baja a la plaza.';
const OPEN_VISEMES = new Set(['A', 'E', 'O']);
const PADDING_START_MS = 300;

const canvasOf = (page) => page.getByTestId('stage-canvas');
const properties = (page) => page.getByRole('complementary', { name: 'Propiedades' });
const timecode = async (page) =>
  ((await page.getByTestId('timecode').textContent()) ?? '').split('/')[0].trim();

/** Move the paused playhead to an exact instant with the keyboard (1 s and 100 ms steps). */
async function seekTo(page, ms) {
  await page.getByTestId('timeline').focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < Math.floor(ms / 1000); i += 1) await page.keyboard.press('Shift+ArrowRight');
  for (let i = 0; i < Math.round((ms % 1000) / 100); i += 1)
    await page.keyboard.press('ArrowRight');
  const mm = String(Math.floor(ms / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  const expected = `${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
  await until(`the playhead at ${expected}`, async () => (await timecode(page)) === expected, {
    timeoutMs: 5_000,
    everyMs: 100,
  });
}

/** The stage canvas scaled to 640 px wide, as RGB. */
async function readCanvas(page) {
  const shot = await canvasOf(page).evaluate((canvas) => {
    const probe = document.createElement('canvas');
    probe.width = 640;
    probe.height = Math.round((640 * canvas.height) / canvas.width);
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    let binary = '';
    for (let i = 0; i < data.length; i += 4) {
      binary += String.fromCharCode(data[i], data[i + 1], data[i + 2]);
    }
    return { width: probe.width, height: probe.height, rgb: btoa(binary), png: probe.toDataURL() };
  });
  return { ...shot, rgb: Buffer.from(shot.rgb, 'base64') };
}

/**
 * How open the mouth of the 2D avatar is in a frame, measured on the drawing itself: the dark
 * pixels of the mouth cavity inside the mouth area of the face. The face is found by its skin
 * (so the measure follows the small sway of the avatar), the mouth area is the centre of its
 * lower half, and a closed mouth — a thin lip line — has next to none of those pixels.
 */
function mouthOpening(frame) {
  const { width, height, rgb } = frame;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  // Subtitles and the watermark live in the lowest fifth: the face never does.
  for (let y = 0; y < Math.floor(height * 0.8); y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
      if (r > 170 && r > g + 25 && g > b + 10) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) return { dark: 0, area: 0, box: null };
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const box = {
    x0: Math.round(cx - 0.2 * w),
    x1: Math.round(cx + 0.2 * w),
    y0: Math.round(y0 + 0.5 * h),
    y1: Math.round(y0 + 0.75 * h),
  };
  let dark = 0;
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const i = (y * width + x) * 3;
      if (rgb[i] < 120 && rgb[i + 1] < 70) dark += 1;
    }
  }
  return { dark, area: (box.x1 - box.x0) * (box.y1 - box.y0), box };
}

/**
 * Instants of the scene, on the 100 ms grid the playhead can be put on, that fall well inside
 * a mouth shape of the given kind in the timeline the model returned.
 */
function instantsOf(runtime, wanted, { minMs = 0, leadMs = 12, tailMs = 12 } = {}) {
  const found = [];
  runtime.visemes.forEach((cue, index) => {
    const end = runtime.visemes[index + 1]?.tMs ?? runtime.audioDurationMs;
    if (!wanted(cue.viseme) || end - cue.tMs < minMs) return;
    const from = PADDING_START_MS + cue.tMs + leadMs;
    const to = PADDING_START_MS + end - tailMs;
    for (let t = Math.ceil(from / 100) * 100; t <= to; t += 100) {
      found.push({ sceneMs: t, viseme: cue.viseme, cueMs: cue.tMs, lengthMs: end - cue.tMs });
    }
  });
  return found;
}

/** The whole walk. Resolves to 'ok', or to 'skipped' when the stack has no neural voice. */
export async function neuralVoices(browser) {
  const session = await newSession(browser, { name: 'voices' });
  const { page, context } = session;
  // The library plays previews through an <audio> element: route it through an analyser too,
  // so its level can be read like the Studio's (lib.mjs taps Web Audio graphs only).
  await context.addInitScript(() => {
    const wired = new WeakSet();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function patched(...args) {
      try {
        if (!wired.has(this)) {
          wired.add(this);
          const audio = new AudioContext();
          const source = audio.createMediaElementSource(this);
          source.connect(audio.destination); // lib.mjs taps this connection
          void audio.resume();
        }
      } catch {
        // Never break the page because of the probe.
      }
      return play.apply(this, args);
    };
  });

  try {
    await section('Cuenta nueva', async () => {
      await registerThroughUi(page, { name: 'Vera Voz', email: uniqueEmail('voices') });
      check('registro completado', true);
    });

    const spanish = await apiCall(context, 'GET', '/api/voices?language=es');
    const neural = (spanish.json?.items ?? []).filter((voice) => voice.provider.id === 'kokoro');
    if (neural.length === 0 || !neural[0].isDefault) {
      notice([
        'VOCES NEURONALES NO DISPONIBLES en esta pila: recorrido de voces neuronales SALTADO.',
        'Para cubrirlo: `pnpm voices:setup` y no fijar E2E_TTS_PROVIDER (o `auto`).',
      ]);
      return 'skipped';
    }

    await section('La API ofrece las voces neuronales primero y como voz por defecto', async () => {
      const first = spanish.json.items[0];
      checkEqual('la primera voz en español es neuronal', first.provider, {
        id: 'kokoro',
        name: 'Kokoro (neuronal local)',
        quality: 'premium',
        local: true,
      });
      check('…y es la recomendada para contenido nuevo', first.isDefault === true, first.id);
      checkEqual(
        'eSpeak sigue en el catálogo, al final, como reserva',
        spanish.json.items.at(-1).provider.id,
        'espeak',
      );
      const caps = await apiCall(context, 'GET', '/api/capabilities');
      checkEqual('el proveedor de voz activo es el neuronal', caps.json.active.tts.id, 'kokoro');
      check(
        '…y la lista de proveedores con voces incluye a Kokoro y a eSpeak',
        ['kokoro', 'espeak'].every((id) => caps.json.ttsProviders.some((p) => p.id === id)),
        caps.json.ttsProviders.map((p) => p.id).join(', '),
      );
    });

    await section('Biblioteca de voces: neuronales primero, con su proveedor', async () => {
      await page.goto(`${WEB_URL}/voices`);
      const group = page.getByRole('region', { name: 'Español' });
      await group.waitFor();
      const rows = await group.getByRole('listitem').allTextContents();
      check('la primera voz de «Español» es Dora (Kokoro)', /^.*Dora/.test(rows[0]), rows[0]);
      check(
        '…etiquetada como «Neuronal local», no como modo básico',
        /Neuronal local/.test(rows[0]) && !/Modo básico/.test(rows[0]),
        rows[0],
      );
      check(
        'las voces de eSpeak siguen debajo, como «Modo básico»',
        rows.some((row) => /Carmen/.test(row) && /Modo básico/.test(row)) &&
          rows.findIndex((row) => /Carmen/.test(row)) > rows.findIndex((row) => /Álex/.test(row)),
        rows.map((row) => row.slice(0, 24)).join(' | '),
      );
      const missing = await page.getByText('Sin instalar').count();
      if (missing > 0) {
        const notice = page.getByRole('note').filter({ hasText: 'sin instalar' }).first();
        check(
          'las voces neuronales sin instalar se anuncian con el comando que las instala',
          /pnpm voices:setup/.test((await notice.textContent()) ?? ''),
          `${missing} sin instalar`,
        );
      } else {
        log('   (todas las voces neuronales del catálogo están instaladas: no hay aviso)');
      }
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'voices-library.png') });
    });

    await section('Preescucha real de una voz neuronal', async () => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith('/api/tts/synthesize') && r.request().method() === 'POST',
          { timeout: 120_000 },
        ),
        page.getByRole('button', { name: 'Escuchar a Dora', exact: true }).click(),
      ]);
      const speech = await response.json();
      checkEqual('la síntesis responde 200', response.status(), 200);
      checkEqual(
        'el audio lo generó Kokoro en local',
        [speech.provider.id, speech.provider.local],
        ['kokoro', true],
      );
      check(
        'la línea de tiempo trae palabras y formas de boca',
        speech.runtime.words.length >= 8 && speech.runtime.visemes.length >= 20,
        `${speech.runtime.words.length} palabras, ${speech.runtime.visemes.length} visemas, ${speech.runtime.audioDurationMs} ms`,
      );

      // 1. The WAV the browser was given: speech-level signal of the announced length.
      const file = await context.request.get(speech.audioUrl);
      const level = wavLevel(new Uint8Array(await file.body()));
      fs.writeFileSync(path.join(ARTIFACTS_DIR, 'voices-preview.wav'), await file.body());
      check(
        'el WAV de la preescucha tiene señal de voz (medida, no escuchada)',
        level.rms > 0.02 && level.peak > 0.2 && level.peak < 1,
        `RMS ${level.rms.toFixed(3)}, pico ${level.peak.toFixed(2)}, ${level.seconds.toFixed(2)} s a ${level.sampleRate} Hz`,
      );
      check(
        '…y dura lo que dice la línea de tiempo',
        Math.abs(level.seconds * 1000 - speech.runtime.audioDurationMs) < 5,
      );

      // 2. What the page sends to the speakers while it plays.
      let loudest = 0;
      await until(
        'the preview to sound',
        async () => {
          loudest = Math.max(loudest, await page.evaluate(() => window.__e2eAudioLevel()));
          return loudest > 0.01;
        },
        { timeoutMs: 20_000, everyMs: 60 },
      );
      check(
        'la preescucha suena en el navegador (nivel medido en la salida de audio)',
        true,
        `RMS ${loudest.toFixed(3)}`,
      );

      // 3. The listening desk: who made the sound, and a presenter that moves with it.
      const desk = page.getByRole('region', { name: 'Preescucha de Dora' });
      await desk.getByText('Este audio lo generó').waitFor();
      checkEqual(
        'la mesa de escucha dice quién generó el audio',
        await desk.getByText('Neuronal local · Kokoro (neuronal local)').count(),
        2,
      );
      check(
        '…explica que es una voz neuronal local',
        (await desk.getByText(/Voz neuronal local: un modelo abierto/).count()) === 1,
      );
      check(
        '…y cómo cambia el tono (remuestreo, ±4 semitonos)',
        /hasta −4 st \/ \+4 st/.test(
          (await desk.getByText(/no tiene control de tono propio/).textContent()) ?? '',
        ),
      );
      const presenter = desk.locator(
        'canvas[aria-label="Avatar que mueve los labios con la preescucha"]',
      );
      const frames = new Set();
      for (let i = 0; i < 14; i += 1) {
        frames.add(
          await presenter.evaluate((canvas) => {
            const { data } = canvas
              .getContext('2d')
              .getImageData(0, 0, canvas.width, canvas.height);
            let hash = 0;
            for (let p = 0; p < data.length; p += 16) hash = (Math.imul(hash, 31) + data[p]) | 0;
            return hash;
          }),
        );
        await sleep(90);
      }
      check(
        'el presentador de la mesa se mueve mientras suena',
        frames.size >= 4,
        `${frames.size} fotogramas distintos de 14`,
      );
      await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'voices-console.png') });
      await desk
        .getByRole('button', { name: 'Parar' })
        .click()
        .catch(() => undefined);
    });

    let videoId = null;
    let runtime = null;
    await section('Un vídeo nuevo empieza con la voz neuronal', async () => {
      await page.goto(`${WEB_URL}/videos/new`);
      // The default voice comes from the catalogue: give the page a moment to have it.
      await page
        .waitForResponse((r) => /\/api\/voices(\?|$)/.test(r.url()), { timeout: 20_000 })
        .catch(() => undefined);
      await page.getByLabel(/^Título/).fill('Voz neuronal e2e');
      await page.getByRole('button', { name: 'Crear y abrir el Studio' }).click();
      await page.waitForURL(/\/studio\/vid_/);
      await canvasOf(page).waitFor();
      videoId = /\/studio\/(vid_[a-z0-9]+)/.exec(page.url())?.[1] ?? null;
      const video = await apiCall(context, 'GET', `/api/videos/${videoId}`);
      const script = video.json.composition.scenes[0].script;
      checkEqual(
        'el guion del borrador usa la voz neuronal por defecto',
        [script.kind, script.voiceId, script.language],
        ['tts', 'kokoro:ef_dora', 'es'],
      );
      await properties(page).getByRole('tab', { name: 'Escena' }).click();
      checkEqual(
        'el Studio muestra la voz',
        await page.getByTestId('voice-name').textContent(),
        'Dora',
      );
      check(
        '…con su proveedor',
        /Kokoro \(neuronal local\)/.test(
          (await page.getByTestId('voice-name').locator('..').textContent()) ?? '',
        ),
      );
      check(
        '…y avisa de cómo cambia el tono esta voz',
        /hasta ±4 semitonos/.test((await page.getByTestId('pitch-note').textContent()) ?? ''),
      );
    });

    await section('Vista previa del Studio: la boca sigue al audio real', async () => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url().endsWith('/api/tts/synthesize') &&
            (r.request().postData() ?? '').includes('casa blanca'),
          { timeout: 180_000 },
        ),
        page.getByLabel('Texto que dirá el avatar').fill(SCRIPT),
      ]);
      const speech = await response.json();
      runtime = speech.runtime;
      checkEqual('la narración de la escena la genera Kokoro', speech.provider.id, 'kokoro');
      checkEqual(
        'las palabras de la línea de tiempo son las del guion',
        runtime.words.map((word) => word.text).join(' '),
        SCRIPT,
      );
      await until(
        'the narration to be ready in the Studio',
        async () => {
          const text = (await page.getByTestId('script-counter').textContent()) ?? '';
          return / de voz/.test(text) && !/≈|aprox/.test(text);
        },
        { timeoutMs: 60_000 },
      );

      // Instants from the model's own timeline: open vowels (once the mouth has had 40 ms to
      // get there: the rig blends from the previous shape), and the pause at the full stop.
      const open = instantsOf(runtime, (v) => OPEN_VISEMES.has(v), { leadMs: 40, tailMs: 8 });
      const firstWord = runtime.words[0].tMs;
      const lastWord = runtime.words.at(-1);
      const pauses = instantsOf(runtime, (v) => v === 'rest', { minMs: 130, leadMs: 60 }).filter(
        (i) => i.cueMs > firstWord && i.cueMs < lastWord.tMs,
      );
      check(
        'el modelo pronuncia vocales abiertas y hace una pausa en el punto',
        open.length >= 3 && pauses.length >= 1,
        `${open.length} instantes de vocal, ${pauses.length} de pausa (pausa de ${pauses[0]?.lengthMs ?? 0} ms)`,
      );

      const shot = async (sceneMs, name) => {
        await seekTo(page, sceneMs);
        await sleep(250);
        const frame = await readCanvas(page);
        if (name) {
          fs.writeFileSync(
            path.join(ARTIFACTS_DIR, name),
            Buffer.from(frame.png.split(',')[1], 'base64'),
          );
        }
        return { frame, mouth: mouthOpening(frame) };
      };
      const before = await shot(100, null); // the narration has not started
      const pause = await shot(pauses[0].sceneMs, 'voices-mouth-rest.png');
      check(
        'el avatar está en el fotograma y se le encuentra la boca',
        before.mouth.box !== null && before.mouth.area > 400,
        JSON.stringify(before.mouth.box),
      );
      // Open vowels spread over the whole narration: start, middle and end.
      const picks = [...new Set([open[0], open[Math.floor(open.length / 2)], open.at(-1)])];
      const spoken = [];
      for (const [index, instant] of picks.entries()) {
        const { mouth } = await shot(instant.sceneMs, index === 0 ? 'voices-mouth-open.png' : null);
        spoken.push({ ...instant, dark: mouth.dark });
      }
      check(
        'en cada vocal abierta del audio la boca del avatar está abierta',
        spoken.every((s) => s.dark >= 40),
        spoken.map((s) => `${s.viseme}@${s.sceneMs} ms: ${s.dark} px de cavidad`).join(' · '),
      );
      // A closed mouth is a lip line: the measure counts a few of its darkest pixels, more or
      // fewer with the small nod the avatar makes between sentences (6 to 25 px measured;
      // looked at in voices-mouth-rest.png). Closed = a fraction of the least open vowel.
      const leastOpen = Math.min(...spoken.map((s) => s.dark));
      check(
        'en la pausa del punto la boca está cerrada, igual que antes de empezar a hablar',
        pause.mouth.dark <= 30 && pause.mouth.dark * 2 <= leastOpen && before.mouth.dark <= 15,
        `pausa@${pauses[0].sceneMs} ms: ${pause.mouth.dark} px · antes de hablar: ${before.mouth.dark} px · vocal menos abierta: ${leastOpen} px`,
      );
      // The same instants, frame against frame: speaking differs from the pause.
      const again = await shot(picks[0].sceneMs, null);
      const speaking = compareRgb(again.frame.rgb, pause.frame.rgb);
      check(
        'el fotograma con vocal difiere del de la pausa',
        speaking.farShare > 0,
        `${(speaking.farShare * 100).toFixed(3)} % de píxeles`,
      );
    });

    await section('La vista previa suena con la voz neuronal', async () => {
      await seekTo(page, 0);
      await page.getByRole('button', { name: 'Reproducir escena' }).click();
      let loudest = 0;
      const codes = new Set();
      await until(
        'the Studio preview to sound',
        async () => {
          loudest = Math.max(loudest, await page.evaluate(() => window.__e2eAudioLevel()));
          codes.add(await timecode(page));
          return loudest > 0.01 && codes.size >= 4;
        },
        { timeoutMs: 20_000, everyMs: 70 },
      );
      check(
        'la vista previa del Studio suena y avanza',
        true,
        `RMS ${loudest.toFixed(3)}, ${codes.size} posiciones del cabezal`,
      );
      await sleep(600);
      await page.keyboard.press('Escape').catch(() => undefined);
    });

    await section('La exportación usa el mismo audio que la vista previa', async () => {
      const cacheDir = path.join(ARTIFACTS_DIR, '..', 'storage', 'cache', 'tts');
      const cached = () =>
        fs.existsSync(cacheDir)
          ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.wav')).length
          : -1;
      await page
        .locator('[data-testid="save-status"][data-status="saved"]')
        .waitFor({ timeout: 30_000 });
      const before = cached();
      const started = await apiCall(context, 'POST', `/api/videos/${videoId}/render`, {
        resolution: '720p',
      });
      check(
        'el render se encola',
        started.status === 200 || started.status === 201 || started.status === 202,
        `HTTP ${started.status}`,
      );
      const video = await until(
        'the render to finish',
        async () => {
          const now = await apiCall(context, 'GET', `/api/videos/${videoId}`);
          if (now.json.status === 'failed')
            throw new Error(`render failed: ${JSON.stringify(now.json.error)}`);
          return now.json.status === 'completed' ? now.json : null;
        },
        { timeoutMs: 420_000, everyMs: 1000 },
      );
      checkEqual(
        'la exportación no sintetiza de nuevo: la caché de voz no crece',
        cached(),
        before,
      );
      checkEqual('el vídeo declara qué proveedor puso la voz', video.providers?.tts?.id, 'kokoro');
      const mp4 = path.join(ARTIFACTS_DIR, 'voices-export.mp4');
      const download = await context.request.get(video.videoUrl);
      fs.writeFileSync(mp4, await download.body());
      const probe = await ffprobe(mp4);
      check(
        'el MP4 lleva vídeo y audio',
        probe.streams.some((s) => s.codec_type === 'video') &&
          probe.streams.some((s) => s.codec_type === 'audio'),
      );
      const first = runtime.words[0];
      const speechDb = await meanVolumeDb(mp4, (PADDING_START_MS + first.tMs) / 1000, 1.2);
      const silenceDb = await meanVolumeDb(
        mp4,
        0,
        Math.max(0.1, (PADDING_START_MS + first.tMs - 80) / 1000),
      );
      check(
        'en el MP4 la voz empieza donde la línea de tiempo dice (silencio antes, voz después)',
        speechDb > -35 && silenceDb < speechDb - 20,
        `antes ${silenceDb} dB, desde la primera palabra ${speechDb} dB`,
      );
      // The subtitles of the export carry the timeline of the PREVIEW: same audio, same times.
      const srt = await (await context.request.get(video.srtUrl)).text();
      const stamp = /(\d\d):(\d\d):(\d\d),(\d\d\d) -->/.exec(srt);
      const startMs = stamp
        ? Number(stamp[2]) * 60_000 + Number(stamp[3]) * 1000 + Number(stamp[4])
        : -1;
      check(
        'el primer subtítulo empieza con la primera palabra de la vista previa',
        Math.abs(startMs - (PADDING_START_MS + first.tMs)) <= 40,
        `SRT ${startMs} ms, vista previa ${PADDING_START_MS + first.tMs} ms`,
      );
    });

    // The only expected one: the session probe of a visitor who has not signed up yet.
    const problems = session.problems.filter((p) => !/401 .*\/api\/auth\/me/.test(p));
    check(
      'sin errores de consola durante el recorrido',
      problems.length === 0,
      problems.slice(0, 3).join(' | '),
    );
    return 'ok';
  } catch (err) {
    await dumpPage(session, 'voices');
    throw err;
  } finally {
    await context.close();
  }
}

/** Chromium the way this walk needs it: previews play without a click on the page first. */
export const launchForVoices = () =>
  chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const browser = await launchForVoices();
  let failed = null;
  let outcome = 'ok';
  try {
    outcome = await neuralVoices(browser);
  } catch (err) {
    failed = err;
  } finally {
    await browser.close();
  }
  if (failed) {
    console.error(
      `\n✘ e2e/voices.mjs failed after ${checkCount()} checks:\n${failed?.stack ?? failed}`,
    );
    process.exit(1);
  }
  console.log(
    outcome === 'skipped'
      ? `\n⚠ e2e/voices.mjs: SKIPPED (no neural voice in this stack: pnpm voices:setup) — ${checkCount()} comprobaciones previas en verde`
      : `\n✔ e2e/voices.mjs: ${checkCount()} comprobaciones en verde (API ${API_URL})`,
  );
}
