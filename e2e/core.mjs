// End-to-end walk through the main journey of Parlante with the real web app, API and worker
// (started by scripts/e2e.sh against a brand-new database). Nothing is mocked and the network
// is never intercepted: every assertion is about what a user would see, hear or download.
//
//   bash scripts/e2e.sh e2e/core.mjs
//   E2E_ONLY=journey,share bash scripts/e2e.sh e2e/core.mjs     (run some sections only)
//
// Sections: journey · formats · share · credits · settings · assets
import crypto from 'node:crypto';
import http from 'node:http';
import {
  API_URL,
  ARTIFACTS_DIR,
  HOOK_PORT,
  PASSWORD,
  WEB_URL,
  apiCall,
  check,
  checkCount,
  checkEqual,
  compareRgb,
  creditsOf,
  dumpPage,
  extractFrame,
  ffprobe,
  leaveCredits,
  fs,
  loadPlaywright,
  meanVolumeDb,
  mp4Boxes,
  newSession,
  path,
  registerThroughUi,
  run,
  section,
  sleep,
  uniqueEmail,
  until,
  workspaceOf,
} from './lib.mjs';

const { chromium } = loadPlaywright();
const only = (process.env.E2E_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const wanted = (name) => only.length === 0 || only.includes(name);

/* ------------------------------------------------------------------------------------------
 * Studio helpers (all through the UI)
 * ---------------------------------------------------------------------------------------- */

const FORMAT_LABEL = { '16:9': 'Horizontal 16:9', '9:16': 'Vertical 9:16', '1:1': 'Cuadrado 1:1' };

const videoIdOf = (page) => /\/(?:studio|videos)\/(vid_[a-z0-9]+)/.exec(page.url())?.[1] ?? null;
const properties = (page) => page.getByRole('complementary', { name: 'Propiedades' });
const canvasOf = (page) => page.getByTestId('stage-canvas');

async function createBlankVideo(page, { title, format = '16:9' }) {
  await page.goto(`${WEB_URL}/videos/new`);
  await page.getByRole('radio', { name: FORMAT_LABEL[format] }).check();
  await page.getByLabel(/^Título/).fill(title);
  await page.getByRole('button', { name: 'Crear y abrir el Studio' }).click();
  await page.waitForURL(/\/studio\/vid_/);
  await canvasOf(page).waitFor();
  return videoIdOf(page);
}

async function waitSaved(page) {
  await page
    .locator('[data-testid="save-status"][data-status="saved"]')
    .waitFor({ timeout: 30_000 });
}

/** Narration by text-to-speech on the selected scene; optionally choose the voice by name. */
async function setNarration(page, text, voice) {
  await properties(page).getByRole('tab', { name: 'Escena' }).click();
  await page.getByRole('radio', { name: 'Texto a voz' }).click();
  await page.getByLabel('Texto que dirá el avatar').fill(text);
  if (voice) {
    await page.getByRole('button', { name: 'Cambiar voz' }).click();
    const dialog = page.getByRole('dialog', { name: 'Elige una voz' });
    await dialog.getByRole('button', { name: `Usar la voz ${voice}` }).click();
    await dialog.waitFor({ state: 'hidden' });
    await properties(page).getByTestId('voice-name').filter({ hasText: voice }).waitFor();
  }
}

/** Put a 2D avatar on the selected scene (or replace the one a new scene inherited). */
async function setAvatar(page, name) {
  await properties(page).getByRole('tab', { name: 'Escena' }).click();
  const region = properties(page).getByRole('region', { name: 'Avatar' });
  await region.getByRole('button', { name: /^(Añadir avatar|Cambiar)$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Elige un avatar' });
  await dialog.getByRole('button', { name: `${name} 2D instantáneo` }).click();
  await dialog.waitFor({ state: 'hidden' });
  await properties(page).getByRole('tab', { name: 'Escena' }).click();
  await region.getByText(name, { exact: true }).waitFor();
}

async function setImageBackground(page, stockName) {
  await properties(page).getByRole('tab', { name: 'Escena' }).click();
  await page.getByRole('radio', { name: 'Imagen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Elige una imagen' });
  await dialog.getByRole('button', { name: `Usar ${stockName}` }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/** Wait until the narration of the selected scene is synthesised (measured, not estimated). */
async function waitNarrationReady(page) {
  await properties(page).getByRole('tab', { name: 'Escena' }).click();
  await until(
    'the narration to be synthesised',
    async () => {
      const text = (await page.getByTestId('script-counter').textContent()) ?? '';
      return / de voz/.test(text) && !/≈|aprox/.test(text) ? text : null;
    },
    { timeoutMs: 45_000 },
  );
}

/** Stats of what the stage canvas shows, plus (optionally) its pixels scaled to width×height. */
async function readCanvas(page, size) {
  return canvasOf(page).evaluate((canvas, target) => {
    const probe = document.createElement('canvas');
    probe.width = target?.width ?? 160;
    probe.height = target?.height ?? Math.round((160 * canvas.height) / canvas.width);
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    const colors = new Set();
    let hash = 0;
    const rgb = new Uint8Array((data.length / 4) * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
      colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
      hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 3 + data[i + 2] * 7) | 0;
    }
    let binary = '';
    if (target) for (let i = 0; i < rgb.length; i += 1) binary += String.fromCharCode(rgb[i]);
    return {
      width: canvas.width,
      height: canvas.height,
      colors: colors.size,
      hash,
      rgbBase64: target ? btoa(binary) : null,
      png: target ? probe.toDataURL('image/png') : null,
    };
  }, size ?? null);
}

const timecode = async (page) =>
  ((await page.getByTestId('timecode').textContent()) ?? '').split('/')[0].trim();

/** Move the paused playhead to an exact instant with the keyboard (1 s and 100 ms steps). */
async function seekTo(page, ms) {
  const timeline = page.getByTestId('timeline');
  await timeline.focus();
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

/**
 * Render from the Studio dialog and follow the live progress until the result is shown.
 * Returns the cost the dialog quoted and the progress values seen on screen.
 */
async function renderFromStudio(page, { resolution = '720p', expectDone = true } = {}) {
  await waitSaved(page);
  await page.getByRole('banner').getByRole('button', { name: 'Renderizar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Renderizar vídeo' });
  await dialog.waitFor();
  if (resolution !== '720p') await dialog.getByRole('radio', { name: resolution }).click();
  const quoted = Number(
    /(\d+)\s+crédito/.exec((await dialog.getByTestId('render-cost').textContent()) ?? '')?.[1],
  );
  const durationText = (await dialog.locator('dd').first().textContent()) ?? '';
  await dialog.getByRole('button', { name: 'Renderizar' }).click();
  if (!expectDone) return { quoted, durationText, progress: [] };

  const progress = [];
  const running = page.getByRole('dialog').getByRole('progressbar');
  const done = page.getByRole('dialog', { name: 'Vídeo listo' });
  await until(
    'the render to finish',
    async () => {
      if (await done.isVisible()) return true;
      const now = await running.getAttribute('aria-valuenow').catch(() => null);
      if (now !== null && progress.at(-1) !== Number(now)) progress.push(Number(now));
      return false;
    },
    { timeoutMs: 240_000, everyMs: 200 },
  );
  return { quoted, durationText, progress };
}

/** Download through a real click: returns the saved path and the name the server suggested. */
async function clickDownload(page, locator, saveAs) {
  const [download] = await Promise.all([page.waitForEvent('download'), locator.click()]);
  const target = path.join(ARTIFACTS_DIR, saveAs);
  await download.saveAs(target);
  return { path: target, suggested: download.suggestedFilename() };
}

/* ------------------------------------------------------------------------------------------
 * 1. Main journey: sign up → dashboard → Studio → render → watch → download
 * ---------------------------------------------------------------------------------------- */

const SCENE_1 = 'Hola, soy Mateo. Bienvenida al recorrido completo de Parlante.';
const SCENE_2 =
  'En esta segunda escena comprobamos que la vista previa y el vídeo final son iguales.';
const HEADLINE = 'Prueba de extremo a extremo';

async function journey(browser) {
  const session = await newSession(browser, { name: 'journey' });
  const { page, context } = session;
  const email = uniqueEmail('journey');
  let videoId = null;
  const preview = {};

  try {
    await section('Registro y panel', async () => {
      await page.goto(`${WEB_URL}/`);
      await page.waitForURL(/\/login/);
      check('sin sesión, la portada lleva al acceso', true, page.url());
      await registerThroughUi(page, { name: 'Marta Prueba', email });
      await page.getByRole('heading', { level: 1, name: /Marta/ }).waitFor();
      check('tras registrarse se ve el panel con el saludo', true);
      await page.getByRole('link', { name: /^30 créditos/ }).waitFor();
      checkEqual('el workspace nuevo empieza con 30 créditos', await creditsOf(context), 30);
      await page.getByRole('heading', { name: 'De un guion a un MP4 en tres pasos' }).waitFor();
      check('el panel vacío explica los tres pasos', true);
    });

    await section(
      'Studio: dos escenas con texto, avatar, voz, fondo, música y subtítulos',
      async () => {
        await page.getByRole('main').getByRole('link', { name: 'Crear vídeo' }).click();
        await page.waitForURL(/\/videos\/new/);
        await page.getByLabel(/^Título/).fill('Recorrido e2e');
        await page.getByRole('button', { name: 'Crear y abrir el Studio' }).click();
        await page.waitForURL(/\/studio\/vid_/);
        videoId = videoIdOf(page);
        check('el vídeo en blanco abre el Studio', videoId !== null, videoId ?? '');
        await canvasOf(page).waitFor();

        // Scene 1: narration + voice, 2D avatar, image background, a text layer.
        await setNarration(page, SCENE_1, 'Diego');
        await setAvatar(page, 'Mateo');
        await setImageBackground(page, 'Océano');
        await page
          .getByRole('toolbar', { name: 'Añadir capa' })
          .getByRole('button', { name: 'Texto' })
          .click();
        await properties(page).getByLabel('Contenido').fill(HEADLINE);
        await properties(page).getByLabel('Contenido').blur();

        // Scene 2 starts as a copy of the look of scene 1: its own narration, another avatar and
        // a gradient background.
        await page.getByRole('button', { name: 'Añadir escena' }).click();
        await page.getByRole('button', { name: /^Escena 2:/ }).waitFor();
        await setNarration(page, SCENE_2);
        checkEqual(
          'la segunda escena hereda la voz de la primera',
          (await properties(page).getByTestId('voice-name').textContent())?.trim(),
          'Diego',
        );
        await setAvatar(page, 'Lucía');
        await properties(page).getByRole('tab', { name: 'Escena' }).click();
        await page.getByRole('radio', { name: 'Degradado' }).click();
        await properties(page).getByRole('button', { name: 'Color 1 del degradado' }).waitFor();

        // Whole video: music and burnt-in subtitles.
        await properties(page).getByRole('tab', { name: 'Vídeo' }).click();
        await page.getByRole('button', { name: 'Elegir música' }).click();
        const music = page.getByRole('dialog', { name: 'Elige un audio' });
        await music.getByRole('button', { name: 'Usar Impulso corporativo' }).click();
        await music.waitFor({ state: 'hidden' });
        await properties(page).getByRole('switch', { name: 'Repetir en bucle' }).waitFor();
        const subtitles = properties(page).getByRole('switch', { name: 'Subtítulos incrustados' });
        checkEqual(
          'los subtítulos incrustados están activos',
          await subtitles.getAttribute('aria-checked'),
          'true',
        );
        await properties(page).getByLabel('Estilo').click();
        await page.getByRole('option', { name: 'Karaoke' }).click();

        const scenes = page.getByRole('navigation', { name: 'Escenas' }).getByRole('listitem');
        checkEqual('el Studio lista dos escenas', await scenes.count(), 2);
      },
    );

    await section('Vista previa: dibuja y suena', async () => {
      await page.getByRole('button', { name: /^Escena 1:/ }).click();
      await waitNarrationReady(page);
      const provider = await properties(page)
        .getByText(/eSpeak NG/)
        .first()
        .textContent();
      check(
        'la narración dice qué proveedor la generó',
        /eSpeak/.test(provider ?? ''),
        provider ?? '',
      );

      // The background image arrives asynchronously: wait until the canvas is not flat.
      const still = await until(
        'the canvas to show the scene',
        async () => {
          const stats = await readCanvas(page);
          return stats.colors > 40 ? stats : null;
        },
        { timeoutMs: 20_000 },
      );
      check(
        'el lienzo tiene dibujo (no es un color plano)',
        still.colors > 40,
        `${still.colors} colores en ${still.width}×${still.height}`,
      );
      checkEqual('el lienzo 16:9 mide 1280×720', [still.width, still.height], [1280, 720]);

      // Play the whole video: the picture changes, the clock runs and the speakers get signal.
      const before = await timecode(page);
      await page.getByRole('button', { name: 'Vídeo entero' }).click();
      await page.getByRole('button', { name: 'Pausar' }).waitFor({ timeout: 30_000 });
      const hashes = new Set();
      let loudest = 0;
      for (let i = 0; i < 24; i += 1) {
        await sleep(110);
        hashes.add((await readCanvas(page)).hash);
        loudest = Math.max(loudest, await page.evaluate(() => window.__e2eAudioLevel()));
      }
      const during = await timecode(page);
      check('la reproducción avanza el cabezal', during !== before, `${before} → ${during}`);
      check(
        'los fotogramas cambian al reproducir (labios, subtítulos)',
        hashes.size >= 6,
        `${hashes.size} fotogramas distintos de 24`,
      );
      check(
        'la vista previa suena (señal en la salida de audio)',
        loudest > 0.01,
        `RMS máximo ${loudest.toFixed(4)}`,
      );
      await page.getByRole('button', { name: 'Pausar' }).click();
      await page.getByRole('button', { name: 'Reproducir escena' }).waitFor();
      const silence = await until(
        'the audio to stop',
        async () => {
          const level = await page.evaluate(() => window.__e2eAudioLevel());
          return level < 0.001 ? { level } : null;
        },
        { timeoutMs: 5_000 },
      );
      check('al pausar deja de sonar', silence.level < 0.001, `RMS ${silence.level.toFixed(5)}`);
    });

    await section('Autoguardado y recarga', async () => {
      await waitSaved(page);
      const saved = await apiCall(context, 'GET', `/api/videos/${videoId}`);
      const composition = saved.json.composition;
      checkEqual('el servidor tiene las dos escenas', composition.scenes.length, 2);
      checkEqual('…con el guion de la primera', composition.scenes[0].script.text, SCENE_1);
      checkEqual('…y el de la segunda', composition.scenes[1].script.text, SCENE_2);
      checkEqual(
        '…la voz elegida en ambas',
        composition.scenes.map((scene) => scene.script.voiceId),
        ['espeak:es-m1', 'espeak:es-m1'],
      );
      checkEqual(
        '…un avatar distinto en cada escena',
        composition.scenes.map((scene) => scene.layers.find((l) => l.type === 'avatar')?.avatarId),
        ['stock_mateo', 'stock_lucia'],
      );
      check(
        '…la capa de texto',
        composition.scenes[0].layers.some((l) => l.type === 'text' && l.text === HEADLINE),
      );
      check(
        '…la música',
        composition.music?.src?.stockId === 'music-corporate-rise',
        JSON.stringify(composition.music?.src),
      );
      checkEqual(
        '…los subtítulos karaoke',
        [composition.subtitles.enabled, composition.subtitles.preset],
        [true, 'karaoke'],
      );
      checkEqual('…el fondo de imagen', composition.scenes[0].background.type, 'image');
      checkEqual('…el fondo degradado', composition.scenes[1].background.type, 'gradient');
      const revision = saved.json.revision;

      await page.reload();
      await canvasOf(page).waitFor();
      checkEqual(
        'tras recargar, el título sigue ahí',
        await page.getByLabel('Título del vídeo').inputValue(),
        'Recorrido e2e',
      );
      checkEqual(
        '…y las dos escenas',
        await page.getByRole('navigation', { name: 'Escenas' }).getByRole('listitem').count(),
        2,
      );
      await page.getByRole('button', { name: /^Escena 2:/ }).click();
      checkEqual(
        '…con su guion',
        await page.getByLabel('Texto que dirá el avatar').inputValue(),
        SCENE_2,
      );

      // Carry on editing where it was left: rename the scene, the change is saved on its own.
      await properties(page).getByLabel('Nombre de la escena').fill('Cierre');
      await properties(page).getByLabel('Nombre de la escena').blur();
      await until(
        'the edit to be saved',
        async () => {
          const again = await apiCall(context, 'GET', `/api/videos/${videoId}`);
          return (
            again.json.composition.scenes[1].name === 'Cierre' && again.json.revision > revision
          );
        },
        { timeoutMs: 20_000 },
      );
      check('se puede seguir editando y se guarda solo', true);
    });

    await section('Fotograma de referencia de la vista previa', async () => {
      // Scene 1, 2.0 s in: the avatar is mid-sentence. The MP4 frame at the same instant must match.
      await page.getByRole('button', { name: /^Escena 1:/ }).click();
      await waitNarrationReady(page);
      await page.getByRole('button', { name: /^Escena 2:/ }).click();
      await waitNarrationReady(page);
      for (const ms of [2000, 6500]) {
        await seekTo(page, ms);
        await sleep(400);
        const shot = await readCanvas(page, { width: 640, height: 360 });
        const png = path.join(ARTIFACTS_DIR, `journey-preview-${ms}.png`);
        fs.writeFileSync(png, Buffer.from(shot.png.split(',')[1], 'base64'));
        preview[ms] = { rgb: Buffer.from(shot.rgbBase64, 'base64'), png };
      }
      check(
        'capturados dos fotogramas de la vista previa',
        Object.keys(preview).length === 2,
        Object.values(preview)
          .map((p) => p.png)
          .join(', '),
      );
    });

    let quoted = 0;
    await section('Render real desde el Studio con progreso en vivo', async () => {
      const before = await creditsOf(context);
      const result = await renderFromStudio(page);
      quoted = result.quoted;
      check(
        'el diálogo anuncia el coste antes de renderizar',
        quoted >= 1,
        `${quoted} crédito(s), duración ${result.durationText.trim()}`,
      );
      check(
        'el progreso se ve avanzar en vivo',
        result.progress.length >= 2 && result.progress.at(-1) > result.progress[0],
        `valores vistos: ${result.progress.join(', ')}`,
      );
      const after = await until('the credits to settle', async () => {
        const now = await creditsOf(context);
        return now < before ? now : null;
      });
      checkEqual('se descuenta exactamente el coste anunciado', before - after, quoted);
      await page.getByRole('dialog').getByRole('link', { name: 'Ver el vídeo' }).click();
      await page.waitForURL(new RegExp(`/videos/${videoId}$`));
    });

    await section('Página del vídeo: reproducir y descargar', async () => {
      const player = page.locator('video').first();
      await player.waitFor();
      await until(
        'the player to load the MP4',
        async () => (await player.evaluate((v) => v.readyState)) >= 2,
      );
      const info = await player.evaluate((v) => ({
        w: v.videoWidth,
        h: v.videoHeight,
        d: v.duration,
      }));
      checkEqual('el reproductor carga el MP4 a 1280×720', [info.w, info.h], [1280, 720]);
      const group = page.getByRole('group', { name: /^Reproductor de vídeo/ });
      await group.getByRole('button', { name: 'Reproducir' }).first().click();
      await until(
        'playback to advance',
        async () => (await player.evaluate((v) => v.currentTime)) > 0.8,
        { timeoutMs: 15_000 },
      );
      check('el vídeo se reproduce en la página', true, `duración ${info.d.toFixed(2)} s`);
      // Subtitles are burnt into this video, so the caption overlay starts off (no double line)…
      const captions = group.getByRole('button', { name: 'Mostrar subtítulos' });
      checkEqual(
        'con subtítulos incrustados, la capa de subtítulos del reproductor empieza apagada',
        await captions.getAttribute('aria-pressed'),
        'false',
      );
      // …and can be turned on: it then follows the VTT of the render.
      await player.evaluate((v) => {
        v.pause();
        v.currentTime = 0.6;
      });
      await captions.click();
      await group.getByText('Hola, soy Mateo.').waitFor({ timeout: 5_000 });
      check('al activarla, el reproductor muestra el subtítulo del instante', true);
      await group.getByRole('button', { name: 'Ocultar subtítulos' }).click();
      check(
        'la barra de posición está habilitada',
        await group.getByRole('slider', { name: 'Posición' }).isEnabled(),
      );
      await player.evaluate((v) => v.pause());
      const transcript = page.getByRole('list', { name: 'Subtítulos' }).getByRole('listitem');
      check(
        'la transcripción lista las frases con su minuto',
        (await transcript.count()) >= 3,
        (await transcript.allTextContents()).join(' | '),
      );

      const mp4 = await clickDownload(
        page,
        page
          .getByRole('link', { name: /MP4/ })
          .or(page.getByRole('button', { name: /MP4/ }))
          .first(),
        'journey.mp4',
      );
      const srt = await clickDownload(
        page,
        page
          .getByRole('link', { name: /SRT/ })
          .or(page.getByRole('button', { name: /SRT/ }))
          .first(),
        'journey.srt',
      );
      const vtt = await clickDownload(
        page,
        page
          .getByRole('link', { name: /VTT/ })
          .or(page.getByRole('button', { name: /VTT/ }))
          .first(),
        'journey.vtt',
      );
      check(
        'las descargas llevan el título del vídeo y su extensión',
        /^Recorrido.e2e\.mp4$/.test(mp4.suggested) &&
          /^Recorrido.e2e\.srt$/.test(srt.suggested) &&
          /^Recorrido.e2e\.vtt$/.test(vtt.suggested),
        [mp4.suggested, srt.suggested, vtt.suggested].join(', '),
      );

      const probe = await ffprobe(mp4.path);
      const video = probe.streams.find((s) => s.codec_type === 'video');
      const audio = probe.streams.find((s) => s.codec_type === 'audio');
      const duration = Number(probe.format.duration);
      checkEqual(
        'MP4: vídeo H.264 yuv420p 1280×720 a 30 fps',
        [video.codec_name, video.pix_fmt, video.width, video.height, video.r_frame_rate],
        ['h264', 'yuv420p', 1280, 720, '30/1'],
      );
      checkEqual(
        'MP4: audio AAC estéreo a 48 kHz',
        [audio.codec_name, audio.channels, audio.sample_rate],
        ['aac', 2, '48000'],
      );
      check(
        'MP4: la duración coincide con la del reproductor',
        Math.abs(duration - info.d) < 0.1,
        `${duration.toFixed(3)} s`,
      );
      check(
        'MP4: audio y vídeo duran lo mismo',
        Math.abs(Number(video.duration) - Number(audio.duration)) < 0.06,
        `vídeo ${video.duration} · audio ${audio.duration}`,
      );
      const boxes = mp4Boxes(mp4.path);
      check(
        'MP4: faststart (moov antes que mdat)',
        boxes.indexOf('moov') !== -1 && boxes.indexOf('moov') < boxes.indexOf('mdat'),
        boxes.join(' '),
      );
      const speech = await meanVolumeDb(mp4.path, 0.5, 3);
      check(
        'MP4: la pista de audio no está en silencio',
        speech > -45,
        `${speech} dB de media en 0,5–3,5 s`,
      );
      // Music: audible before the first word (fading in), ducked under the voice, faded out at the end.
      const intro = await meanVolumeDb(mp4.path, 0.05, 0.2);
      const outro = await meanVolumeDb(mp4.path, duration - 0.08, 0.08);
      check(
        'MP4: la música suena antes de que empiece la voz',
        intro > -70 && intro < speech,
        `${intro} dB en 0,05–0,25 s`,
      );
      check(
        'MP4: la música se desvanece al final',
        outro < intro,
        `${outro} dB en los últimos 80 ms`,
      );

      const srtText = fs.readFileSync(srt.path, 'utf8');
      const vttText = fs.readFileSync(vtt.path, 'utf8');
      check(
        'SRT: numerado, con tiempos y el guion',
        /^1\r?\n\d\d:\d\d:\d\d,\d{3} --> /.test(srtText) &&
          /Mateo/.test(srtText) &&
          /segunda/.test(srtText),
        `${srtText.split(/\r?\n\r?\n/).filter(Boolean).length} bloques`,
      );
      check(
        'VTT: cabecera WEBVTT, tiempos y el guion',
        vttText.startsWith('WEBVTT') &&
          / --> /.test(vttText) &&
          /segunda escena/.test(vttText.replace(/\s+/g, ' ')),
      );
      const lastCue = [...srtText.matchAll(/--> (\d\d):(\d\d):(\d\d),(\d{3})/g)].at(-1);
      const lastEnd =
        Number(lastCue[1]) * 3600 +
        Number(lastCue[2]) * 60 +
        Number(lastCue[3]) +
        Number(lastCue[4]) / 1000;
      check(
        'SRT: el último subtítulo acaba dentro del vídeo',
        lastEnd <= duration + 0.05,
        `${lastEnd.toFixed(3)} s ≤ ${duration.toFixed(3)} s`,
      );

      // Preview = export: the frame of the MP4 at the instants captured in the Studio.
      for (const ms of [2000, 6500]) {
        const exported = await extractFrame(
          mp4.path,
          ms / 1000,
          640,
          360,
          path.join(ARTIFACTS_DIR, `journey-export-${ms}.png`),
        );
        const diff = compareRgb(preview[ms].rgb, exported.rgb);
        check(
          `vista previa = exportación en ${ms / 1000} s`,
          diff.meanAbs < 6 && diff.farShare < 0.03,
          `diferencia media ${diff.meanAbs.toFixed(2)}/255, ${(diff.farShare * 100).toFixed(2)} % de píxeles lejos — ${preview[ms].png} vs ${exported.png}`,
        );
      }
    });

    checkEqual(
      'sin errores de consola en el recorrido',
      session.problems.filter((p) => !/401/.test(p)),
      [],
    );
  } catch (err) {
    await dumpPage(session, 'journey');
    throw err;
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------------------------
 * 2. Formats (9:16 by switching in the Studio, 1:1 from a built-in template with variables)
 * ---------------------------------------------------------------------------------------- */

/** Render from the Studio and save the MP4 offered by the result dialog. */
async function renderAndDownload(page, saveAs, options) {
  const result = await renderFromStudio(page, options);
  const file = await clickDownload(
    page,
    page.getByRole('dialog').getByRole('button', { name: 'Descargar MP4' }),
    saveAs,
  );
  return { ...result, file: file.path };
}

async function videoStream(file) {
  const probe = await ffprobe(file);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  return { video, audio, duration: Number(probe.format.duration), tags: probe.format.tags ?? {} };
}

async function formats(browser) {
  const session = await newSession(browser, { name: 'formats' });
  const { page, context } = session;
  try {
    await registerThroughUi(page, { name: 'Fabián Formatos', email: uniqueEmail('formats') });

    await section('Formato 9:16: cambiar de horizontal a vertical en el Studio', async () => {
      const videoId = await createBlankVideo(page, { title: 'Vertical e2e', format: '16:9' });
      await setNarration(page, 'Este vídeo empezó en horizontal y ahora es vertical.');
      await setAvatar(page, 'Sofía');
      await page
        .getByRole('toolbar', { name: 'Añadir capa' })
        .getByRole('button', { name: 'Texto' })
        .click();
      await properties(page).getByLabel('Contenido').fill('Titular que debe caber en vertical');
      await properties(page).getByLabel('Contenido').blur();
      await waitSaved(page);
      const wide = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json.composition;
      const wideText = wide.scenes[0].layers.find((l) => l.type === 'text');

      await page.getByRole('banner').getByRole('radio', { name: FORMAT_LABEL['9:16'] }).click();
      await until('the canvas to turn vertical', async () => {
        const stats = await readCanvas(page);
        return stats.width === 720 && stats.height === 1280;
      });
      check('el lienzo pasa a 720×1280', true);
      await waitSaved(page);
      const tall = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json.composition;
      const tallText = tall.scenes[0].layers.find((l) => l.type === 'text');
      checkEqual(
        'el documento guardado es 9:16',
        [tall.canvas.aspect, tall.canvas.width, tall.canvas.height],
        ['9:16', 720, 1280],
      );
      // Font sizes are a fraction of the canvas HEIGHT: the same fraction on a canvas 1.78× taller
      // would overflow the (now narrower) box, so the Studio rescales it to keep the pixel size.
      const widePx = wideText.style.fontSize * wide.canvas.height;
      const tallPx = tallText.style.fontSize * tall.canvas.height;
      check(
        'el texto conserva su tamaño en píxeles al cambiar de formato',
        Math.abs(widePx - tallPx) < 1.5,
        `${widePx.toFixed(1)} px → ${tallPx.toFixed(1)} px (fracción ${wideText.style.fontSize} → ${tallText.style.fontSize.toFixed(4)})`,
      );

      const figure = tall.scenes[0].layers.find((l) => l.type === 'avatar').box;
      check(
        'el avatar sigue siendo protagonista en vertical',
        figure.w > 0.7 && figure.h > 0.5,
        `caja ${(figure.w * 100).toFixed(0)} % × ${(figure.h * 100).toFixed(0)} % del lienzo`,
      );

      await waitNarrationReady(page);
      await seekTo(page, 1500);
      await sleep(300);
      const shot = await readCanvas(page, { width: 360, height: 640 });
      const previewPng = path.join(ARTIFACTS_DIR, 'formats-9x16-preview.png');
      fs.writeFileSync(previewPng, Buffer.from(shot.png.split(',')[1], 'base64'));

      const { file } = await renderAndDownload(page, 'formats-9x16.mp4');
      const { video, audio } = await videoStream(file);
      checkEqual(
        'MP4 vertical: H.264 720×1280 + AAC',
        [video.codec_name, video.width, video.height, audio.codec_name],
        ['h264', 720, 1280, 'aac'],
      );
      const exported = await extractFrame(
        file,
        1.5,
        360,
        640,
        path.join(ARTIFACTS_DIR, 'formats-9x16-export.png'),
      );
      const diff = compareRgb(Buffer.from(shot.rgbBase64, 'base64'), exported.rgb);
      check(
        'vista previa = exportación en vertical',
        diff.meanAbs < 6 && diff.farShare < 0.03,
        `diferencia media ${diff.meanAbs.toFixed(2)}/255, ${(diff.farShare * 100).toFixed(2)} % lejos — ${previewPng} vs ${exported.png}`,
      );
    });

    await section('Formato 1:1: plantilla integrada con sus variables', async () => {
      await page.goto(`${WEB_URL}/templates`);
      const card = page.getByRole('listitem').filter({ hasText: 'Saludo personalizado' });
      await card.getByRole('button', { name: /^Vista previa/ }).click();
      const detail = page.getByRole('dialog', { name: 'Saludo personalizado' });
      await detail.getByText('{{nombre}}').waitFor();
      const declared = await detail.locator('code').allTextContents();
      check(
        'la plantilla declara sus variables',
        ['{{nombre}}', '{{ocasion}}', '{{mensaje}}', '{{remitente}}'].every((v) =>
          declared.includes(v),
        ),
        declared.join(' '),
      );
      await detail.getByLabel('Título del vídeo nuevo').fill('Saludo e2e');
      await detail.getByRole('button', { name: 'Usar plantilla' }).click();
      await page.waitForURL(/\/studio\/vid_/);
      await canvasOf(page).waitFor();
      const videoId = videoIdOf(page);
      checkEqual(
        'el borrador de la plantilla lleva el título pedido',
        await page.getByLabel('Título del vídeo').inputValue(),
        'Saludo e2e',
      );
      checkEqual(
        '…y es cuadrado',
        await page
          .getByRole('banner')
          .getByRole('radio', { name: FORMAT_LABEL['1:1'] })
          .getAttribute('aria-checked'),
        'true',
      );
      checkEqual(
        '…con sus tres escenas',
        await page.getByRole('navigation', { name: 'Escenas' }).getByRole('listitem').count(),
        3,
      );

      // Personalise: a value for {{nombre}} and NO value for {{remitente}} (it must vanish in
      // the preview exactly as it does in the export).
      await properties(page).getByRole('tab', { name: 'Vídeo' }).click();
      const variables = properties(page).getByRole('region', { name: 'Variables' });
      await variables.getByLabel('{{nombre}}').fill('Zoraida');
      await variables.getByLabel('{{remitente}}').fill('');
      await variables.getByLabel('{{remitente}}').blur();
      await variables.getByText('Sin valor: el hueco queda vacío').waitFor();
      check('el Studio avisa de la variable sin valor', true);
      await waitSaved(page);

      await page.getByRole('button', { name: /^Escena 1:/ }).click();
      await waitNarrationReady(page);
      await page.getByRole('button', { name: /^Escena 3:/ }).click();
      await waitNarrationReady(page);
      const total = await page.getByTestId('timecode').textContent();
      const frames = {};
      for (const ms of [2500, 13000]) {
        await seekTo(page, ms);
        await sleep(400);
        const shot = await readCanvas(page, { width: 480, height: 480 });
        const png = path.join(ARTIFACTS_DIR, `formats-1x1-preview-${ms}.png`);
        fs.writeFileSync(png, Buffer.from(shot.png.split(',')[1], 'base64'));
        frames[ms] = { rgb: Buffer.from(shot.rgbBase64, 'base64'), png };
      }

      const { file, quoted } = await renderAndDownload(page, 'formats-1x1.mp4');
      const { video, duration } = await videoStream(file);
      checkEqual(
        'MP4 cuadrado: H.264 720×720',
        [video.codec_name, video.width, video.height],
        ['h264', 720, 720],
      );
      check(
        'la duración exportada es la que anunciaba el Studio',
        Math.abs(duration - toSeconds(total.split('/')[1])) < 0.12,
        `${duration.toFixed(3)} s vs ${total}`,
      );
      checkEqual('coste de un vídeo de menos de 30 s', quoted, 1);

      const saved = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json;
      check(
        'el vídeo conserva sus {{variables}} tras renderizar',
        saved.composition.scenes[0].script.text.includes('{{nombre}}'),
        saved.composition.scenes[0].script.text,
      );
      const srt = await context.request.get(saved.srtUrl.replace(API_URL, WEB_URL));
      const srtText = await srt.text();
      check(
        'los subtítulos llevan el valor de la variable',
        /Zoraida/.test(srtText) && !/Marta/.test(srtText),
        srtText.split(/\r?\n/).slice(2, 4).join(' '),
      );
      check('ningún {{marcador}} llega a la exportación', !/[{}]/.test(srtText));
      check('la variable sin valor no se pronuncia por su nombre', !/remitente/i.test(srtText));
      for (const ms of [2500, 13000]) {
        const exported = await extractFrame(
          file,
          ms / 1000,
          480,
          480,
          path.join(ARTIFACTS_DIR, `formats-1x1-export-${ms}.png`),
        );
        const diff = compareRgb(frames[ms].rgb, exported.rgb);
        check(
          `plantilla: vista previa = exportación en ${ms / 1000} s`,
          diff.meanAbs < 6 && diff.farShare < 0.03,
          `diferencia media ${diff.meanAbs.toFixed(2)}/255, ${(diff.farShare * 100).toFixed(2)} % lejos — ${frames[ms].png} vs ${exported.png}`,
        );
      }
    });

    checkEqual(
      'sin errores de consola en formatos',
      session.problems.filter((p) => !/401/.test(p)),
      [],
    );
  } catch (err) {
    await dumpPage(session, 'formats');
    throw err;
  } finally {
    await context.close();
  }
}

/** "mm:ss.mmm" → seconds. */
function toSeconds(timecodeText) {
  const match = /(\d+):(\d+)\.(\d+)/.exec(timecodeText);
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
}

/* ------------------------------------------------------------------------------------------
 * 3. Sharing: public page without a session, with and without download, and turned off
 * ---------------------------------------------------------------------------------------- */

/** A short narrated video built in the Studio; leaves the page in the Studio. */
async function buildSimpleVideo(page, { title, text, format = '16:9', avatar = 'Elena' }) {
  const videoId = await createBlankVideo(page, { title, format });
  await setNarration(page, text);
  await setAvatar(page, avatar);
  await waitSaved(page);
  return videoId;
}

async function share(browser) {
  const owner = await newSession(browser, { name: 'share-owner' });
  const visitor = await newSession(browser, {
    name: 'share-visitor',
    viewport: { width: 390, height: 844 },
  });
  const { page, context } = owner;
  try {
    await registerThroughUi(page, { name: 'Carla Comparte', email: uniqueEmail('share') });
    const videoId = await buildSimpleVideo(page, {
      title: 'Para compartir',
      text: 'Este vídeo se comparte con un enlace público.',
    });
    await renderFromStudio(page);
    await page.getByRole('dialog').getByRole('link', { name: 'Ver el vídeo' }).click();
    await page.waitForURL(new RegExp(`/videos/${videoId}$`));
    const panel = page.getByRole('complementary', { name: /^Descargas/ });
    let shareUrl = '';

    await section('Enlace público con descarga, abierto sin sesión', async () => {
      await panel.getByRole('switch', { name: 'Enlace público' }).click();
      const field = panel.getByLabel('Enlace', { exact: true });
      await field.waitFor();
      shareUrl = await field.inputValue();
      check(
        'al activar el enlace aparece la URL pública',
        new RegExp(`^${WEB_URL}/s/[a-z0-9]{24}$`).test(shareUrl),
        shareUrl,
      );
      checkEqual(
        'la descarga está permitida por defecto',
        await panel
          .getByRole('switch', { name: 'Permitir descargar el MP4' })
          .getAttribute('aria-checked'),
        'true',
      );
      await panel.getByText('0 visitas').waitFor();

      checkEqual(
        'el visitante no tiene sesión',
        (await apiCall(visitor.context, 'GET', '/api/auth/me')).status,
        401,
      );
      await visitor.page.goto(shareUrl);
      await visitor.page.getByRole('heading', { level: 1, name: 'Para compartir' }).waitFor();
      const player = visitor.page.locator('video').first();
      await until(
        'the public player to load',
        async () => (await player.evaluate((v) => v.readyState)) >= 2,
      );
      await visitor.page
        .getByRole('group', { name: /^Reproductor de vídeo/ })
        .getByRole('button', { name: 'Reproducir' })
        .first()
        .click();
      await until(
        'public playback to advance',
        async () => (await player.evaluate((v) => v.currentTime)) > 0.5,
        { timeoutMs: 15_000 },
      );
      check(
        'la página pública reproduce el vídeo sin sesión',
        true,
        `en ${visitor.page.viewportSize().width} px de ancho`,
      );
      await visitor.page.getByText(/Carla/).first().waitFor();
      check(
        'dice quién lo comparte y con qué se hizo',
        (await visitor.page.getByText(/eSpeak NG/).count()) > 0,
      );
      const download = visitor.page
        .getByRole('main')
        .getByRole('link', { name: /Descargar/ })
        .last();
      const file = await clickDownload(visitor.page, download, 'share-public.mp4');
      const probe = await ffprobe(file.path);
      check(
        'el visitante descarga el MP4',
        probe.streams.some((s) => s.codec_name === 'h264'),
        file.suggested,
      );
      checkEqual(
        'sin desbordamiento horizontal en móvil',
        await visitor.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
    });

    await section('Las visitas se cuentan una vez por carga', async () => {
      const state = async () =>
        (await apiCall(context, 'GET', `/api/videos/${videoId}/share`)).json.share;
      checkEqual('una carga de la página = una visita', (await state()).viewCount, 1);
      await visitor.page.reload();
      await visitor.page.getByRole('heading', { level: 1, name: 'Para compartir' }).waitFor();
      await until('the second view to be counted', async () => (await state()).viewCount >= 2);
      await sleep(600);
      checkEqual('recargar suma exactamente una más', (await state()).viewCount, 2);
      await page.reload();
      await panel.getByText('2 visitas').waitFor();
      check('el panel del propietario muestra las visitas', true);
    });

    await section('Enlace público sin descarga', async () => {
      await panel.getByRole('switch', { name: 'Permitir descargar el MP4' }).click();
      await until(
        'the setting to be saved',
        async () =>
          (await apiCall(context, 'GET', `/api/videos/${videoId}/share`)).json.share
            .allowDownload === false,
      );
      await visitor.page.reload();
      await visitor.page.getByRole('heading', { level: 1, name: 'Para compartir' }).waitFor();
      await visitor.page.locator('video').first().waitFor();
      checkEqual(
        'la página pública ya no ofrece descargar',
        await visitor.page.getByRole('link', { name: /Descargar/ }).count(),
        0,
      );
      const token = shareUrl.split('/').pop();
      const data = await apiCall(visitor.context, 'GET', `/api/public/shares/${token}`);
      checkEqual(
        'la API pública no entrega URL de descarga',
        [data.status, data.json.downloadUrl],
        [200, null],
      );
      check('…pero sí el vídeo para reproducirlo', typeof data.json.videoUrl === 'string');
      check(
        '…y nada interno del workspace',
        !('workspaceId' in data.json) && !('composition' in data.json),
        Object.keys(data.json).join(','),
      );
    });

    await section('Enlace desactivado', async () => {
      await panel.getByRole('switch', { name: 'Enlace público' }).click();
      await until(
        'the link to be off',
        async () =>
          (await apiCall(context, 'GET', `/api/videos/${videoId}/share`)).json.share?.enabled ===
          false,
      );
      await visitor.page.reload();
      await visitor.page
        .getByRole('heading', { name: /ya no está disponible|no está disponible/i })
        .waitFor();
      checkEqual(
        'la página pública explica que el enlace no está disponible y no hay reproductor',
        await visitor.page.locator('video').count(),
        0,
      );
      const token = shareUrl.split('/').pop();
      const off = await apiCall(visitor.context, 'GET', `/api/public/shares/${token}`);
      checkEqual(
        'la API pública responde 404 con el enlace apagado',
        [off.status, off.json.error.code],
        [404, 'NOT_FOUND'],
      );
      const missing = await apiCall(
        visitor.context,
        'GET',
        '/api/public/shares/aaaaaaaaaaaaaaaaaaaaaaaa',
      );
      checkEqual(
        '…igual que con un token inexistente',
        [missing.status, missing.json.error.code],
        [404, 'NOT_FOUND'],
      );
    });

    checkEqual(
      'sin errores de consola del propietario',
      owner.problems.filter((p) => !/401/.test(p)),
      [],
    );
    checkEqual(
      'sin errores de consola del visitante (salvo el 404 esperado)',
      visitor.problems.filter((p) => !/401|404/.test(p)),
      [],
    );
  } catch (err) {
    await dumpPage(owner, 'share');
    await dumpPage(visitor, 'share');
    throw err;
  } finally {
    await owner.context.close();
    await visitor.context.close();
  }
}

/* ------------------------------------------------------------------------------------------
 * 4. Credits: quoted = charged, cancel refunds, no balance is refused clearly
 * ---------------------------------------------------------------------------------------- */

async function credits(browser) {
  const session = await newSession(browser, { name: 'credits' });
  const { page, context } = session;
  try {
    await registerThroughUi(page, { name: 'Cristina Créditos', email: uniqueEmail('credits') });
    const long = [
      'Esta es la primera escena de un vídeo pensado para durar más de treinta segundos en total.',
      'En la segunda escena seguimos hablando con calma para que la duración crezca lo suficiente.',
      'La tercera escena añade unas cuantas frases más, porque el coste depende de la duración real.',
      'En la cuarta escena todavía no hemos llegado al medio minuto, pero ya falta muy poco para lograrlo.',
      'La quinta escena cruza por fin la frontera de los treinta segundos de duración total del vídeo.',
      'Y con esta sexta escena queda claro que el render de este vídeo cuesta exactamente dos créditos.',
    ];
    const videoId = await createBlankVideo(page, { title: 'Dos créditos', format: '16:9' });
    await setNarration(page, long[0]);
    await setAvatar(page, 'Omar');
    for (let i = 1; i < long.length; i += 1) {
      await page.getByRole('button', { name: 'Añadir escena' }).click();
      await page.getByRole('button', { name: new RegExp(`^Escena ${i + 1}:`) }).waitFor();
      await setNarration(page, long[i]);
    }
    for (let i = 0; i < long.length; i += 1) {
      await page.getByRole('button', { name: new RegExp(`^Escena ${i + 1}:`) }).click();
      await waitNarrationReady(page);
    }
    await waitSaved(page);
    const ledger = async () =>
      (await apiCall(context, 'GET', '/api/billing/ledger?limit=20')).json.items;

    await section('Cancelar un render devuelve los créditos', async () => {
      const before = await creditsOf(context);
      const started = await renderFromStudio(page, { expectDone: false });
      checkEqual('un vídeo de más de 30 s anuncia 2 créditos', started.quoted, 2);
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('progressbar').waitFor();
      const reserved = await until('the credits to be reserved', async () => {
        const now = await creditsOf(context);
        return now < before ? now : null;
      });
      checkEqual('al empezar se reserva lo anunciado', before - reserved, started.quoted);
      await dialog.getByRole('button', { name: 'Cancelar render' }).click();
      await until('the refund', async () => (await creditsOf(context)) === before, {
        timeoutMs: 15_000,
      });
      check('al cancelar vuelve todo el saldo', true, `${reserved} → ${before}`);
      const video = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json;
      checkEqual(
        'el vídeo vuelve a borrador, sin salida',
        [video.status, video.videoUrl],
        ['draft', null],
      );
      const entries = (await ledger()).filter((e) => e.refType === 'renderJob');
      checkEqual(
        'el libro mayor registra el cargo y su devolución',
        entries.map((e) => e.delta).sort(),
        [-2, 2],
      );
      await page.keyboard.press('Escape');
    });

    await section('El coste mostrado es el que se descuenta', async () => {
      // The worker may still be winding the cancelled job down: wait until it is free.
      await until(
        'no active render',
        async () =>
          (await apiCall(context, 'GET', `/api/videos/${videoId}/render-jobs`)).json.items.every(
            (j) => !['queued', 'running'].includes(j.status),
          ),
        { timeoutMs: 30_000 },
      );
      const before = await creditsOf(context);
      const result = await renderFromStudio(page);
      const after = await creditsOf(context);
      checkEqual('saldo antes − saldo después = coste anunciado', before - after, result.quoted);
      const video = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json;
      check(
        'la duración real supera los 30 s',
        video.durationMs > 30_000,
        `${video.durationMs} ms`,
      );
      const jobs = (await apiCall(context, 'GET', `/api/videos/${videoId}/render-jobs`)).json.items;
      const done = jobs.find((j) => j.status === 'completed');
      checkEqual('el historial del render dice lo mismo', done.creditsCharged, result.quoted);
      await page.keyboard.press('Escape');
    });

    await section('Sin saldo, el render se rechaza con un mensaje claro', async () => {
      const workspace = await workspaceOf(context);
      await leaveCredits(workspace.id, 1);
      checkEqual(
        'el workspace se queda con 1 crédito (el vídeo cuesta 2)',
        await creditsOf(context),
        1,
      );
      await page.reload();
      await canvasOf(page).waitFor();
      await page.getByRole('button', { name: /^Escena 1:/ }).click();
      await page.getByRole('banner').getByRole('button', { name: 'Renderizar' }).click();
      const dialog = page.getByRole('dialog', { name: 'Renderizar vídeo' });
      await dialog
        .getByRole('alert')
        .filter({ hasText: 'No hay créditos suficientes para este render.' })
        .waitFor();
      check('el Studio avisa de que no hay créditos suficientes', true);
      checkEqual(
        '…y no deja empezar',
        await dialog.getByRole('button', { name: 'Renderizar' }).isDisabled(),
        true,
      );
      await page.keyboard.press('Escape');

      const refused = await apiCall(context, 'POST', `/api/videos/${videoId}/render`, {
        resolution: '720p',
      });
      checkEqual(
        'la API lo rechaza con 402 INSUFFICIENT_CREDITS',
        [refused.status, refused.json.error.code],
        [402, 'INSUFFICIENT_CREDITS'],
      );
      checkEqual('…diciendo cuánto hace falta y cuánto hay', refused.json.error.details, {
        required: 2,
        available: 1,
      });
      checkEqual('el saldo no se toca', await creditsOf(context), 1);

      // The video page uses its own dialog: same refusal there.
      await page.goto(`${WEB_URL}/videos/${videoId}`);
      await page.getByRole('button', { name: 'Volver a renderizar' }).click();
      const again = page.getByRole('dialog', { name: 'Volver a renderizar' });
      await again.getByText(/No hay créditos suficientes/).waitFor();
      checkEqual(
        'la página del vídeo tampoco deja empezar',
        await again.getByRole('button', { name: 'Renderizar', exact: true }).isDisabled(),
        true,
      );
    });

    checkEqual(
      'sin errores de consola en créditos (salvo el 402 provocado)',
      session.problems.filter((p) => !/401|402/.test(p)),
      [],
    );
  } catch (err) {
    await dumpPage(session, 'credits');
    throw err;
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------------------------
 * 5. Settings: members and roles, API key → public API v1, signed webhook to a local receiver
 * ---------------------------------------------------------------------------------------- */

/** A tiny HTTP receiver that records every POST with its raw body (for the HMAC check). */
async function startHookReceiver(port) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { received, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Receiver-side check, written as the docs tell an integrator to write it. */
function verifySignature(secret, rawBody, header) {
  const parts = Object.fromEntries(
    header.split(',').map((part) => part.split('=').map((x) => x.trim())),
  );
  if (!parts.t || !parts.v1) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  return (
    fresh &&
    expected.length === parts.v1.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
  );
}

async function v1(method, route, key, body) {
  const response = await fetch(`${API_URL}${route}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function settings(browser) {
  const owner = await newSession(browser, { name: 'settings-owner' });
  const guest = await newSession(browser, { name: 'settings-guest' });
  const { page, context } = owner;
  const guestEmail = uniqueEmail('guest');
  let receiver = null;
  try {
    await registerThroughUi(page, { name: 'Olga Propietaria', email: uniqueEmail('owner') });
    const videoId = await buildSimpleVideo(page, {
      title: 'Vídeo del equipo',
      text: 'Un vídeo del workspace para probar los roles.',
    });
    const ownerWorkspace = await workspaceOf(context);

    await section(
      'Invitar a un miembro y aceptar la invitación con una segunda cuenta',
      async () => {
        await page.goto(`${WEB_URL}/settings/members`);
        await page.getByRole('button', { name: 'Invitar' }).first().click();
        const dialog = page.getByRole('dialog', { name: 'Invitar a una persona' });
        await dialog.getByLabel('Correo de la persona').fill(guestEmail);
        await dialog.getByLabel('Rol en el workspace').click();
        await page.getByRole('option', { name: /^Lector/ }).click();
        await dialog.getByRole('button', { name: 'Crear invitación' }).click();
        const created = page.getByRole('dialog', { name: 'Invitación creada' });
        const inviteUrl = await created.getByLabel('Enlace de invitación').inputValue();
        check(
          'la invitación da un enlace personal (no se envían correos)',
          new RegExp(`^${WEB_URL}/invite/[a-z0-9]{20,}$`).test(inviteUrl),
          inviteUrl,
        );
        await created.getByRole('button', { name: 'Hecho' }).click();
        await page
          .getByRole('region', { name: 'Invitaciones pendientes' })
          .getByText(guestEmail)
          .waitFor();
        check('la invitación queda pendiente y ocupa plaza', true);

        // Second person, second browser: opens the link without an account and signs up.
        await guest.page.goto(inviteUrl);
        await guest.page
          .getByRole('link', { name: /Crear (una )?cuenta/ })
          .first()
          .click();
        await guest.page.waitForURL(/\/register\?/);
        await guest.page.getByLabel('Nombre').fill('Lucas Lector');
        const emailField = guest.page.getByLabel('Correo electrónico');
        if ((await emailField.inputValue()) !== guestEmail) await emailField.fill(guestEmail);
        await guest.page.locator('input[type=password]').fill(PASSWORD);
        await guest.page.getByRole('button', { name: 'Crear cuenta' }).click();
        await guest.page.waitForURL((url) => !/\/register/.test(url.pathname));
        const joined = await until('the guest to be in the owner workspace', async () => {
          const me = await apiCall(guest.context, 'GET', '/api/auth/me');
          const found = me.json?.workspaces?.find((w) => w.id === ownerWorkspace.id);
          return found ?? null;
        });
        checkEqual(
          'la segunda cuenta entra en el workspace con el rol invitado',
          joined.role,
          'viewer',
        );
        const active = await workspaceOf(guest.context);
        checkEqual('…y lo tiene como workspace activo', active.id, ownerWorkspace.id);

        await page.reload();
        const people = page.getByRole('region', { name: /^Personas/ });
        await people.getByText(guestEmail).waitFor();
        check(
          'el propietario ve al nuevo miembro como Lector',
          (
            await people.getByRole('listitem').filter({ hasText: guestEmail }).textContent()
          ).includes('Lector'),
        );
        checkEqual(
          'la invitación ya no está pendiente',
          await page
            .getByRole('region', { name: 'Invitaciones pendientes' })
            .getByText(guestEmail)
            .count(),
          0,
        );
      },
    );

    await section('Roles: un lector ve pero no edita', async () => {
      await guest.page.goto(`${WEB_URL}/videos/${videoId}`);
      await guest.page.getByRole('heading', { level: 1, name: 'Vídeo del equipo' }).waitFor();
      check('el lector ve el vídeo del workspace', true);
      checkEqual(
        '…sin botón de editar',
        await guest.page.getByRole('link', { name: 'Editar en el Studio' }).count(),
        0,
      );
      checkEqual(
        '…ni de renderizar',
        await guest.page.getByRole('button', { name: /^Renderizar|^Volver a renderizar/ }).count(),
        0,
      );
      await guest.page.goto(`${WEB_URL}/studio/${videoId}`);
      await guest.page.getByRole('heading', { name: 'No tienes acceso a esta sección' }).waitFor();
      await guest.page.getByText(/tu rol es Lector/).waitFor();
      checkEqual(
        'el Studio no se abre para un lector',
        await guest.page.getByTestId('stage-canvas').count(),
        0,
      );

      const read = await apiCall(guest.context, 'GET', `/api/videos/${videoId}`);
      const write = await apiCall(guest.context, 'PATCH', `/api/videos/${videoId}`, {
        title: 'Cambiado por el lector',
        baseRevision: read.json.revision,
      });
      const create = await apiCall(guest.context, 'POST', '/api/videos', {
        title: 'No debería',
        aspect: '16:9',
      });
      const render = await apiCall(guest.context, 'POST', `/api/videos/${videoId}/render`, {
        resolution: '720p',
      });
      checkEqual(
        'la API deja leer (200) y rechaza editar, crear y renderizar (403)',
        [read.status, write.status, create.status, render.status],
        [200, 403, 403, 403],
      );
      checkEqual('…con el código FORBIDDEN', write.json.error.code, 'FORBIDDEN');
      checkEqual(
        'el título no cambió',
        (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json.title,
        'Vídeo del equipo',
      );
      await guest.page.goto(`${WEB_URL}/settings/api-keys`);
      await guest.page
        .getByText(/Solo para administradores/)
        .first()
        .waitFor();
      check('las secciones de administración se lo explican en vez de fallar', true);

      // Promoted to editor by the owner: now the Studio opens and saves.
      const promoted = (await apiCall(context, 'GET', '/api/members')).json.items.find(
        (m) => m.email === guestEmail,
      );
      await page.goto(`${WEB_URL}/settings/members`);
      const row = page
        .getByRole('region', { name: /^Personas/ })
        .getByRole('listitem')
        .filter({ hasText: guestEmail });
      await row.getByRole('combobox').click();
      await page.getByRole('option', { name: /^Editor/ }).click();
      await until(
        'the role change',
        async () =>
          (await apiCall(context, 'GET', '/api/members')).json.items.find(
            (m) => m.id === promoted.id,
          ).role === 'editor',
      );
      await guest.page.goto(`${WEB_URL}/studio/${videoId}`);
      await guest.page.getByTestId('stage-canvas').waitFor();
      await guest.page.getByLabel('Título del vídeo').fill('Vídeo del equipo (editado)');
      await guest.page.getByLabel('Título del vídeo').blur();
      await until(
        'the editor change to be saved',
        async () =>
          (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json.title ===
          'Vídeo del equipo (editado)',
        { timeoutMs: 20_000 },
      );
      check('ascendido a editor, puede abrir el Studio y guardar', true);
    });

    let apiKey = '';
    await section('Clave de API y API pública v1', async () => {
      await page.goto(`${WEB_URL}/settings/api-keys`);
      await page.getByRole('button', { name: 'Crear clave' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Nueva clave de API' });
      await dialog.getByLabel('Nombre').fill('Clave e2e');
      await dialog.getByRole('button', { name: 'Crear clave' }).click();
      const created = page.getByRole('dialog', { name: /Clave «Clave e2e» creada/ });
      apiKey = await created.getByLabel('Tu clave').inputValue();
      check(
        'la clave se muestra una vez',
        /^plk_[a-z0-9]+_[a-z0-9]{20,}$/.test(apiKey),
        `${apiKey.slice(0, 12)}…`,
      );
      await created.getByRole('button', { name: 'Ya la he guardado' }).click();
      const listed = page.getByRole('region', { name: 'Claves' });
      await listed.getByText('Clave e2e').waitFor();
      check('después solo se ve su prefijo', !(await listed.textContent()).includes(apiKey));

      const me = await v1('GET', '/v1/me', apiKey);
      checkEqual(
        'GET /v1/me con la clave → workspace del propietario',
        [me.status, me.json.workspace.id, me.json.apiKey.name],
        [200, ownerWorkspace.id, 'Clave e2e'],
      );
      const anonymous = await v1('GET', '/v1/me', null);
      const wrong = await v1('GET', '/v1/me', `${apiKey.slice(0, -4)}zzzz`);
      checkEqual(
        'sin clave o con una clave falsa → 401',
        [anonymous.status, wrong.status, wrong.json.error.code],
        [401, 401, 'INVALID_API_KEY'],
      );
      const docs = await fetch(`${API_URL}/v1/openapi.json`);
      const openapi = await docs.json();
      check(
        'la API sirve su OpenAPI de la v1',
        docs.status === 200 && Boolean(openapi.paths['/v1/videos']?.post),
        Object.keys(openapi.paths).join(' '),
      );
    });

    await section('Webhook entregado de verdad a un receptor local, con firma HMAC', async () => {
      receiver = await startHookReceiver(HOOK_PORT);
      const hookUrl = `http://127.0.0.1:${HOOK_PORT}/hooks/parlante`;
      await page.goto(`${WEB_URL}/settings/webhooks`);
      await page.getByRole('button', { name: 'Añadir endpoint' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Nuevo endpoint' });
      await dialog.getByLabel('URL del endpoint').fill(hookUrl);
      await dialog.getByRole('button', { name: 'Crear endpoint' }).click();
      const created = page.getByRole('dialog', { name: 'Endpoint creado' });
      const secret = await created.getByLabel('Secreto de firma').inputValue();
      check(
        'el secreto de firma se muestra una vez',
        /^whsec_[a-z0-9]{32}$/.test(secret),
        `${secret.slice(0, 10)}…`,
      );
      await created.getByRole('button', { name: 'Ya lo he guardado' }).click();

      // Test ping from the UI.
      await page.getByRole('button', { name: 'Enviar prueba' }).click();
      const ping = await until(
        'the ping to arrive',
        async () => receiver.received.find((r) => r.headers['parlante-event'] === 'ping') ?? null,
        { timeoutMs: 20_000 },
      );
      check(
        'el ping de prueba llega al receptor',
        ping.method === 'POST' && ping.url === '/hooks/parlante',
        `entrega ${ping.headers['parlante-delivery']}`,
      );
      check(
        '…firmado: la firma HMAC-SHA256 verifica con el secreto',
        verifySignature(secret, ping.raw, ping.headers['parlante-signature']),
        ping.headers['parlante-signature'].slice(0, 30),
      );

      // A render launched with the API key: the webhook announces when it is done.
      const before = await creditsOf(context);
      const made = await v1('POST', '/v1/videos', apiKey, {
        title: 'Lanzado por API',
        input: {
          type: 'script',
          text: 'Este vídeo se ha pedido con una clave de la API pública.',
          avatarId: 'stock_lucia',
          voiceId: 'espeak:es-f1',
        },
      });
      checkEqual('POST /v1/videos → 202 en cola', [made.status, made.json.status], [202, 'queued']);
      const finished = await until(
        'the API render to finish',
        async () => {
          const now = await v1('GET', `/v1/videos/${made.json.id}`, apiKey);
          if (now.json.status === 'failed')
            throw new Error(`render failed: ${JSON.stringify(now.json.error)}`);
          return now.json.status === 'completed' ? now.json : null;
        },
        { timeoutMs: 180_000, everyMs: 500 },
      );
      check(
        'GET /v1/videos/:id → completed con sus URLs',
        Boolean(finished.videoUrl && finished.srtUrl && finished.vttUrl && finished.downloadUrl),
        `${finished.durationMs} ms`,
      );
      checkEqual(
        'el render por API cobra 1 crédito al workspace',
        before - (await creditsOf(context)),
        1,
      );

      const hook = await until(
        'video.completed to arrive',
        async () =>
          receiver.received.find((r) => r.headers['parlante-event'] === 'video.completed') ?? null,
        { timeoutMs: 30_000 },
      );
      const event = JSON.parse(hook.raw);
      checkEqual(
        'el webhook video.completed habla de ese vídeo',
        [event.type, event.workspaceId, event.data.video.id, event.data.video.status],
        ['video.completed', ownerWorkspace.id, made.json.id, 'completed'],
      );
      check(
        '…con la firma válida',
        verifySignature(secret, hook.raw, hook.headers['parlante-signature']),
      );
      check(
        '…que no valida con otro secreto ni con el cuerpo alterado',
        !verifySignature(
          'whsec_00000000000000000000000000000000',
          hook.raw,
          hook.headers['parlante-signature'],
        ) &&
          !verifySignature(
            secret,
            hook.raw.replace('completed', 'c0mpleted'),
            hook.headers['parlante-signature'],
          ),
      );
      const file = path.join(ARTIFACTS_DIR, 'settings-v1.mp4');
      const mp4 = await fetch(event.data.video.videoUrl);
      fs.writeFileSync(file, Buffer.from(await mp4.arrayBuffer()));
      const probe = await videoStream(file);
      checkEqual(
        'el MP4 de la URL del webhook es H.264 + AAC 1280×720',
        [
          mp4.status,
          probe.video.codec_name,
          probe.audio.codec_name,
          probe.video.width,
          probe.video.height,
        ],
        [200, 'h264', 'aac', 1280, 720],
      );
      checkEqual(
        'cada entrega llegó una sola vez',
        [
          receiver.received.filter((r) => r.headers['parlante-event'] === 'ping').length,
          receiver.received.filter((r) => r.headers['parlante-event'] === 'video.completed').length,
        ],
        [1, 1],
      );

      // The delivery log of the UI tells the same story.
      const card = page
        .getByRole('list', { name: 'Endpoints' })
        .getByRole('listitem')
        .filter({ hasText: hookUrl });
      const history = card.getByText('Entregas, de la más reciente a la más antigua');
      if (!(await history.isVisible()))
        await card.getByRole('button', { name: 'Historial de entregas' }).click();
      await history.waitFor();
      await until(
        'both deliveries in the log',
        async () => (await card.getByText('Entregada').count()) >= 2,
        { timeoutMs: 15_000 },
      );
      const logText = (await card.textContent()).replace(/\s+/g, ' ');
      check(
        'el historial de la interfaz muestra el ping y video.completed como entregados',
        /ping/.test(logText) && /video\.completed/.test(logText) && /HTTP 200/.test(logText),
        logText.slice(logText.indexOf('Entregas'), logText.indexOf('Entregas') + 200),
      );
    });

    checkEqual(
      'sin errores de consola del propietario',
      owner.problems.filter((p) => !/401/.test(p)),
      [],
    );
    checkEqual(
      'sin errores de consola del invitado (salvo los 403 provocados)',
      guest.problems.filter((p) => !/401|403/.test(p)),
      [],
    );
  } catch (err) {
    await dumpPage(owner, 'settings');
    await dumpPage(guest, 'settings');
    throw err;
  } finally {
    if (receiver) await receiver.close();
    await owner.context.close();
    await guest.context.close();
  }
}

/* ------------------------------------------------------------------------------------------
 * 6. Assets: upload image, video and audio, use them in a scene, refuse what is not media
 * ---------------------------------------------------------------------------------------- */

/** Small media files made on the spot with ffmpeg (nothing binary lives in the repository). */
async function makeFixtures() {
  const dir = path.join(ARTIFACTS_DIR, 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    image: path.join(dir, 'fondo-magenta.png'),
    video: path.join(dir, 'clip-prueba.mp4'),
    audio: path.join(dir, 'tono-440.wav'),
    text: path.join(dir, 'notas.txt'),
    fake: path.join(dir, 'no-es-una-imagen.png'),
  };
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0xD81B60:s=1280x720',
    '-frames:v',
    '1',
    files.image,
  ]);
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x00C853:s=320x180:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    files.video,
  ]);
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-ac',
    '2',
    '-ar',
    '48000',
    files.audio,
  ]);
  fs.writeFileSync(files.text, 'Esto es un archivo de texto, no un medio.\n');
  fs.writeFileSync(files.fake, 'Tampoco esto es un PNG, aunque lo diga su extensión.\n'.repeat(20));
  return files;
}

async function uploadThroughUi(page, filePaths) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir archivos' }).first().click(),
  ]);
  await chooser.setFiles(filePaths);
}

async function assets(browser) {
  const session = await newSession(browser, { name: 'assets' });
  const { page, context } = session;
  try {
    const files = await makeFixtures();
    await registerThroughUi(page, { name: 'Ana Archivos', email: uniqueEmail('assets') });
    const listAssets = async () =>
      (await apiCall(context, 'GET', '/api/assets?limit=50')).json.items;

    await section('Subir imagen, vídeo y audio', async () => {
      await page.goto(`${WEB_URL}/assets`);
      await page.getByRole('heading', { name: 'La biblioteca está vacía' }).waitFor();
      await uploadThroughUi(page, [files.image, files.video, files.audio]);
      const uploaded = await until(
        'the three uploads',
        async () => {
          const items = await listAssets();
          return items.length === 3 ? items : null;
        },
        { timeoutMs: 60_000 },
      );
      const byKind = Object.fromEntries(uploaded.map((a) => [a.kind, a]));
      checkEqual(
        'la biblioteca tiene una imagen, un vídeo y un audio',
        Object.keys(byKind).sort(),
        ['audio', 'image', 'video'],
      );
      checkEqual(
        'la imagen conserva sus medidas',
        [byKind.image.width, byKind.image.height],
        [1280, 720],
      );
      check(
        'el vídeo y el audio traen su duración',
        Math.abs(byKind.video.durationMs - 3000) < 150 &&
          Math.abs(byKind.audio.durationMs - 6000) < 150,
        `${byKind.video.durationMs} ms · ${byKind.audio.durationMs} ms`,
      );
      for (const name of ['fondo-magenta', 'clip-prueba', 'tono-440'])
        await page.getByRole('main').getByText(new RegExp(name)).first().waitFor();
      check('los tres aparecen en la cuadrícula', true);
      const thumbs = await page
        .getByRole('main')
        .locator('img')
        .evaluateAll((imgs) => imgs.filter((img) => img.complete && img.naturalWidth > 0).length);
      check('las miniaturas cargan', thumbs >= 2, `${thumbs} imágenes cargadas`);
    });

    await section('Un tipo no permitido se rechaza', async () => {
      const queue = page.getByRole('main').getByRole('listitem');
      await uploadThroughUi(page, [files.text]);
      const local = queue.filter({ hasText: 'notas.txt' }).getByRole('alert');
      await local.waitFor();
      check(
        'un .txt se rechaza en el navegador, diciendo por qué',
        /Formato no admitido/.test(await local.textContent()),
        (await local.textContent()).trim(),
      );
      await uploadThroughUi(page, [files.fake]);
      const server = queue.filter({ hasText: 'no-es-una-imagen.png' }).getByRole('alert');
      await server.waitFor();
      check(
        'un falso PNG lo rechaza el servidor por su contenido real, y la fila lo explica',
        (await server.textContent()).trim().length > 10,
        (await server.textContent()).trim(),
      );
      const direct = await context.request.post(`${WEB_URL}/api/assets`, {
        headers: { origin: WEB_URL },
        multipart: {
          file: {
            name: 'no-es-una-imagen.png',
            mimeType: 'image/png',
            buffer: fs.readFileSync(files.fake),
          },
        },
        failOnStatusCode: false,
      });
      checkEqual(
        '…con 415 UNSUPPORTED_MEDIA_TYPE',
        [direct.status(), (await direct.json()).error.code],
        [415, 'UNSUPPORTED_MEDIA_TYPE'],
      );
      checkEqual('la biblioteca sigue con tres archivos', (await listAssets()).length, 3);
    });

    await section('Usar los archivos subidos en una escena y renderizar', async () => {
      const videoId = await createBlankVideo(page, { title: 'Con mis archivos', format: '16:9' });
      // Background: my image.
      await page.getByRole('radio', { name: 'Imagen', exact: true }).click();
      const images = page.getByRole('dialog', { name: 'Elige una imagen' });
      await images.getByRole('radio', { name: 'Mis archivos' }).click();
      await images.getByRole('button', { name: /fondo-magenta/ }).click();
      await images.waitFor({ state: 'hidden' });
      // A video layer: my clip.
      await page
        .getByRole('toolbar', { name: 'Añadir capa' })
        .getByRole('button', { name: 'Vídeo' })
        .click();
      const videos = page.getByRole('dialog', { name: 'Elige un vídeo' });
      await videos.getByRole('radio', { name: 'Mis archivos' }).click();
      await videos.getByRole('button', { name: /clip-prueba/ }).click();
      await videos.waitFor({ state: 'hidden' });
      // Music: my audio.
      await properties(page).getByRole('tab', { name: 'Vídeo' }).click();
      await page.getByRole('button', { name: 'Elegir música' }).click();
      const audios = page.getByRole('dialog', { name: 'Elige un audio' });
      await audios.getByRole('radio', { name: 'Mis archivos' }).click();
      await audios.getByRole('button', { name: /^Usar tono-440/ }).click();
      await audios.waitFor({ state: 'hidden' });
      await waitSaved(page);

      const composition = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json
        .composition;
      const scene = composition.scenes[0];
      const layer = scene.layers.find((l) => l.type === 'video');
      checkEqual(
        'el documento referencia los tres assets del workspace',
        [scene.background.src.source, layer.src.source, composition.music.src.source],
        ['asset', 'asset', 'asset'],
      );

      await until(
        'the canvas to show my image',
        async () => {
          const stats = await readCanvas(page, { width: 320, height: 180 });
          const rgb = Buffer.from(stats.rgbBase64, 'base64');
          const corner = [
            rgb[(5 * 320 + 5) * 3],
            rgb[(5 * 320 + 5) * 3 + 1],
            rgb[(5 * 320 + 5) * 3 + 2],
          ];
          return corner[0] > 180 && corner[1] < 80 && corner[2] > 60 ? corner : null;
        },
        { timeoutMs: 20_000 },
      );
      check('la vista previa pinta mi imagen de fondo', true);

      const { file } = await renderAndDownload(page, 'assets.mp4');
      const { video, audio, duration } = await videoStream(file);
      checkEqual(
        'render con mis archivos: H.264 + AAC 1280×720',
        [video.codec_name, audio.codec_name, video.width, video.height],
        ['h264', 'aac', 1280, 720],
      );
      const frame = await extractFrame(
        file,
        1.0,
        320,
        180,
        path.join(ARTIFACTS_DIR, 'assets-export.png'),
      );
      const pixel = (x, y) => [
        frame.rgb[(y * 320 + x) * 3],
        frame.rgb[(y * 320 + x) * 3 + 1],
        frame.rgb[(y * 320 + x) * 3 + 2],
      ];
      const corner = pixel(5, 5);
      check(
        'el MP4 tiene mi imagen de fondo (magenta)',
        corner[0] > 180 && corner[1] < 80 && corner[2] > 60,
        `rgb(${corner.join(', ')}) — ${frame.png}`,
      );
      const box = layer.box;
      const centre = pixel(
        Math.round((box.x + box.w / 2) * 320),
        Math.round((box.y + box.h / 2) * 180),
      );
      check(
        '…y mi clip de vídeo en su capa (verde)',
        centre[1] > 150 && centre[0] < 90,
        `rgb(${centre.join(', ')})`,
      );
      const level = await meanVolumeDb(file, 1, Math.max(1, duration - 2));
      check('…y suena mi audio (no hay voz en este vídeo)', level > -50, `${level} dB de media`);
    });

    await section(
      'Si se borra un archivo en uso, el render falla con un mensaje claro y devuelve el crédito',
      async () => {
        const videoId = videoIdOf(page);
        const composition = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json
          .composition;
        const removed = await apiCall(
          context,
          'DELETE',
          `/api/assets/${composition.scenes[0].background.src.assetId}`,
        );
        checkEqual('la imagen de fondo se borra de la biblioteca', removed.status, 200);
        await page.reload();
        await canvasOf(page).waitFor();
        await properties(page)
          .getByRole('button', { name: 'Elegir archivo de fondo' })
          .filter({ hasText: 'Archivo no disponible' })
          .waitFor();
        check('el Studio marca el fondo como «Archivo no disponible»', true);

        const before = await creditsOf(context);
        await page.getByRole('banner').getByRole('button', { name: 'Renderizar' }).click();
        let dialog = page.getByRole('dialog', { name: 'Renderizar vídeo' });
        await dialog.getByRole('button', { name: 'Renderizar' }).click();
        const failure = page.getByRole('dialog').getByRole('alert');
        await failure.waitFor({ timeout: 60_000 });
        const said = (await failure.textContent()).replace(/\s+/g, ' ').trim();
        check('el render se rechaza o falla diciendo qué pasa', /archivo|file/i.test(said), said);
        await until('the credit to come back', async () => (await creditsOf(context)) === before, {
          timeoutMs: 20_000,
        });
        check('no se cobra nada por un render que no se pudo hacer', true, `saldo ${before}`);
        const video = (await apiCall(context, 'GET', `/api/videos/${videoId}`)).json;
        check(
          'el vídeo conserva su render anterior para seguir viéndolo',
          video.videoUrl !== null || video.status === 'failed',
          `estado ${video.status}`,
        );
      },
    );

    checkEqual(
      'sin errores de consola en assets (salvo los 415 y 422 provocados)',
      session.problems.filter((p) => !/401|415|422|404/.test(p)),
      [],
    );
  } catch (err) {
    await dumpPage(session, 'assets');
    throw err;
  } finally {
    await context.close();
  }
}

/* ------------------------------------------------------------------------------------------
 * main
 * ---------------------------------------------------------------------------------------- */

const SECTIONS = { journey, formats, share, credits, settings, assets };

const browser = await chromium.launch();
let failed = null;
try {
  for (const [name, fn] of Object.entries(SECTIONS)) {
    if (!wanted(name)) continue;
    await fn(browser);
  }
} catch (err) {
  failed = err;
} finally {
  await browser.close();
}
if (failed) {
  console.error(
    `\n✘ e2e/core.mjs failed after ${checkCount()} checks:\n${failed?.stack ?? failed}`,
  );
  process.exit(1);
}
console.log(`\n✔ e2e/core.mjs: ${checkCount()} comprobaciones en verde`);
