#!/usr/bin/env node
/* End-to-end walk of the libraries and the AI tools against a REAL stack: web + API + worker
 * (+ the local neural engine when E2E_ENGINE is set). Nothing is intercepted: every request the
 * browser makes reaches the real API, and the script only talks to the product through the web
 * origin (the browser and same-origin requests with its session cookie), like a person would.
 *
 * With the runner (starts a fresh database, API, worker and web, and cleans up):
 *
 *   E2E_ALLOW_PRIVATE_URLS=false bash scripts/e2e.sh e2e/ai.mjs
 *   # with the neural engine (`pnpm avatar-engine` running; ~4 more minutes on 4 cores):
 *   E2E_ENGINE=1 E2E_AVATAR_ENGINE_URL=http://127.0.0.1:8090 \
 *     E2E_AVATAR_ENGINE_WORK_DIR="$PWD/data/avatar-engine" AVATAR_PORTRAIT_SIZE=512 \
 *     E2E_ALLOW_PRIVATE_URLS=false bash scripts/e2e.sh e2e/ai.mjs
 *
 * Or against a stack that is already running:  E2E_WEB_URL=http://127.0.0.1:5173 node e2e/ai.mjs
 *
 * Environment:
 *   E2E_WEB_URL        base URL of the web app                      (default http://127.0.0.1:5173)
 *   E2E_ENGINE         set (any value) when the stack reaches a running neural engine: the
 *                      photorealistic steps (photo avatar, generated portrait, photoreal render)
 *                      are executed. Unset: those steps are SKIPPED with a visible notice and
 *                      the "engine off" views are asserted instead.
 *   E2E_SKIP_GENERATE  with E2E_ENGINE: skip the (slow) portrait generated from a description
 *   E2E_AI_ONLY        comma-separated sections to run (see SECTIONS at the end); E2E_ONLY works
 *                      too when it names sections of this script
 *   E2E_OUT            folder for screenshots and evidence (default E2E_ARTIFACTS_DIR/ai, else a
 *                      temporary folder)
 *   E2E_DATABASE_URL   optional: Postgres URL of the stack → row-level checks
 *   E2E_STORAGE_DIR    optional: STORAGE_LOCAL_DIR of the stack → on-disk checks (the runner
 *                      exports STORAGE_LOCAL_DIR, which is used when this one is not set)
 *   E2E_PORTRAIT       optional: path of a (synthetic) portrait to upload as "the photo"
 *   PLAYWRIGHT_MODULE  optional: where Playwright lives when it is not resolvable by name
 *
 * The check that "URL → script" refuses non-public destinations needs the stack to run with
 * ALLOW_PRIVATE_URLS=false (the default of the product); it is skipped, visibly, when the
 * environment says the stack was started with ALLOW_PRIVATE_URLS=true.
 *
 * Exit code 0 only when every executed step passed. */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
for (const id of [
  process.env.PLAYWRIGHT_MODULE,
  'playwright',
  '/opt/node-tools/node_modules/playwright',
]) {
  if (!id || chromium) continue;
  try {
    ({ chromium } = require(id));
  } catch {
    // Try the next location.
  }
}
if (!chromium) {
  console.error(
    'e2e/ai.mjs needs Playwright: set PLAYWRIGHT_MODULE (or NODE_PATH) to where it is installed.',
  );
  process.exit(2);
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = (process.env.E2E_WEB_URL ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
const ENGINE = Boolean(process.env.E2E_ENGINE);
const SECTION_IDS = [
  'avatars',
  'voices',
  'script',
  'clone',
  'interactive',
  'batch',
  'translate',
  'engine',
  'photo',
];
const parseOnly = (value) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => SECTION_IDS.includes(part));
const ONLY = process.env.E2E_AI_ONLY
  ? parseOnly(process.env.E2E_AI_ONLY)
  : parseOnly(process.env.E2E_ONLY);
const OUT =
  process.env.E2E_OUT ??
  (process.env.E2E_ARTIFACTS_DIR
    ? path.join(process.env.E2E_ARTIFACTS_DIR, 'ai')
    : path.join(os.tmpdir(), 'parlante-e2e-ai'));
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const STORAGE_DIR = process.env.E2E_STORAGE_DIR ?? process.env.STORAGE_LOCAL_DIR ?? '';
const PRIVATE_URLS_ALLOWED = /^(true|1|yes|on)$/i.test(process.env.ALLOW_PRIVATE_URLS ?? '');
const PORTRAIT =
  process.env.E2E_PORTRAIT ?? path.join(REPO, 'packages/stock-assets/assets/avatars/carmen.jpg');

/** Version of the consent statement the product shows (packages/shared/src/consent.ts). */
const CONSENT_VERSION = '2026-01';

fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ tiny test harness */

const results = [];
let currentSection = '';

class Skip extends Error {}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** Runs one step; a failure is recorded (with a screenshot) and the walk goes on. */
async function step(name, fn) {
  const started = Date.now();
  const label = `${currentSection} › ${name}`;
  try {
    const note = await fn();
    const ms = Date.now() - started;
    results.push({ label, status: 'pass', ms });
    log(`  ✓ ${name} (${(ms / 1000).toFixed(1)} s)${note ? ` — ${note}` : ''}`);
    return true;
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof Skip) {
      results.push({ label, status: 'skip', ms, detail: err.message });
      log(`  ⚠ SKIPPED ${name} — ${err.message}`);
      return false;
    }
    const file = path.join(OUT, `fail-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`);
    await page?.screenshot({ path: file, fullPage: true }).catch(() => {});
    results.push({ label, status: 'fail', ms, detail: String(err?.message ?? err) });
    log(
      `  ✗ ${name} (${(ms / 1000).toFixed(1)} s)\n      ${String(err?.stack ?? err)
        .split('\n')
        .slice(0, 6)
        .join('\n      ')}\n      screenshot: ${file}`,
    );
    return false;
  }
}

function needsEngine() {
  if (!ENGINE)
    throw new Skip('needs the neural engine (set E2E_ENGINE=1 with `pnpm avatar-engine` running)');
}

/** services/voice-engine (realistic local cloning), shared by every stack on this machine. */
const VOICE_ENGINE = (process.env.VOICE_ENGINE_URL ?? 'http://127.0.0.1:8091').replace(/\/+$/, '');
const API = (process.env.E2E_API_URL ?? WEB).replace(/\/+$/, '');

/** Perth watermark score of a 16-bit WAV, measured by the voice engine's own detector. */
async function engineWatermark(wav) {
  const response = await fetch(`${VOICE_ENGINE}/v1/watermark`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioWav: Buffer.from(wav).toString('base64') }),
  });
  assert(response.ok, `POST /v1/watermark of the voice engine → ${response.status}`);
  return response.json();
}

/** Public API call with an API key (the way another app would call Parlante). */
async function v1(method, pathname, key, body) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `fn` until it returns a truthy value. */
async function until(fn, { timeoutMs = 30_000, everyMs = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ browser + API helpers */

let browser;
let context;
let page;
let workspaceId = '';
const consoleProblems = [];
const user = {
  name: 'Prueba E2E',
  email: `e2e-${Date.now().toString(36)}${randomBytes(3).toString('hex')}@example.test`,
  password: `Cabina-${randomBytes(6).toString('hex')}-2026!`,
};

/** Same-origin API call with the session cookie of the browser context (no interception). */
async function apiCall(method, pathname, { body, multipart, expect: expected } = {}) {
  const response = await context.request.fetch(`${WEB}${pathname}`, {
    method,
    headers: { Origin: WEB },
    ...(multipart ? { multipart } : body !== undefined ? { data: body } : {}),
  });
  const status = response.status();
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (expected !== undefined && status !== expected) {
    throw new Error(
      `${method} ${pathname} → ${status} (expected ${expected}): ${text.slice(0, 400)}`,
    );
  }
  return { status, json, text };
}

const apiGet = async (pathname) => (await apiCall('GET', pathname, { expect: 200 })).json;

/**
 * The voices this stack gives to new content (`Voice.isDefault` of `GET /api/voices`, read the
 * way the web app does): an installed local neural voice when there is one, eSpeak NG
 * otherwise. Every expectation about "who generated the audio" comes from here, so the walk
 * passes on both kinds of machine; the checks that need a neural voice are skipped, visibly,
 * when none is installed.
 */
const stack = { neural: false, voices: [] };
const NEURAL_VOICE_PROVIDERS = ['kokoro', 'piper'];

function defaultVoice(language, gender) {
  const base = language.slice(0, 2);
  const usable = (voice) =>
    voice.kind === 'stock' &&
    voice.status === 'ready' &&
    !voice.unavailable &&
    (voice.multilingual || voice.language.slice(0, 2) === base) &&
    (!gender || voice.gender === gender);
  const voice =
    stack.voices.find((v) => usable(v) && v.isDefault) ?? stack.voices.find((v) => usable(v));
  assert(voice, `a usable ${gender ?? ''} voice for ${language}`);
  return voice;
}

async function readVoiceStack() {
  stack.voices = (await apiGet('/api/voices?limit=200')).items;
  stack.neural = NEURAL_VOICE_PROVIDERS.includes(defaultVoice('es').provider.id);
  return stack;
}

/** New content starts with a default voice of the stack: neural when one is installed. */
function assertDefaultVoice(voiceId, what) {
  const voice = stack.voices.find((candidate) => candidate.id === voiceId);
  assert(voice, `the voice of ${what} (${voiceId}) is in the catalogue`);
  assertEqual(voice.isDefault, true, `${what} starts with a default voice (${voiceId})`);
  if (stack.neural)
    assert(
      NEURAL_VOICE_PROVIDERS.includes(voice.provider.id),
      `${what} starts with a neural voice (got ${voiceId})`,
    );
}

function needsNeuralVoices() {
  if (!stack.neural)
    throw new Skip(
      'needs the local neural voices (`pnpm voices:setup`, and no E2E_TTS_PROVIDER=espeak)',
    );
}

async function credits() {
  const overview = await apiGet('/api/billing');
  return overview.credits;
}

/** Downloads a (signed) file URL through the web origin and returns its bytes. */
async function download(url) {
  const target = new URL(url, WEB);
  const sameOrigin = `${WEB}${target.pathname}${target.search}`;
  const response = await context.request.get(sameOrigin);
  assert(response.ok(), `download ${target.pathname} → ${response.status()}`);
  return Buffer.from(await response.body());
}

/** One-value SQL query against the stack's database (with the `pg` client of packages/db). */
function psql(sql) {
  if (!DATABASE_URL) return null;
  const code = `
    import pg from 'pg';
    const [url, sql] = process.argv.slice(1);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const result = await client.query(sql);
      process.stdout.write(String(Object.values(result.rows[0] ?? {})[0] ?? ''));
    } finally {
      await client.end();
    }`;
  return execFileSync('node', ['--input-type=module', '-e', code, '--', DATABASE_URL, sql], {
    cwd: path.join(REPO, 'packages/db'),
    encoding: 'utf8',
  }).trim();
}

function filesUnder(prefix) {
  if (!STORAGE_DIR) return null;
  const root = path.join(STORAGE_DIR, prefix);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(STORAGE_DIR, full));
    }
  };
  walk(root);
  return out;
}

/** PCM statistics of a RIFF/WAV buffer (16-bit): duration and RMS level. */
function wavStats(buffer) {
  assertEqual(buffer.toString('ascii', 0, 4), 'RIFF', 'audio is a RIFF file');
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      format = {
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bits: buffer.readUInt16LE(offset + 22),
      };
    } else if (id === 'data' && format) {
      const end = Math.min(buffer.length, offset + 8 + size);
      const bytes = format.bits / 8;
      let sum = 0;
      let peak = 0;
      let count = 0;
      for (let at = offset + 8; at + bytes <= end; at += bytes) {
        const sample = buffer.readInt16LE(at) / 32768;
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
        count += 1;
      }
      return {
        ...format,
        durationMs: Math.round((count / format.channels / format.sampleRate) * 1000),
        rms: Math.sqrt(sum / Math.max(1, count)),
        peak,
      };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV without a data chunk');
}

function ffprobe(file) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

/** Mean volume (dB) of the whole audio track of a media file. */
function ffmpegVolume(file) {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'info', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(result.stderr ?? '');
  if (!match) throw new Error(`volumedetect gave no result for ${file}`);
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Mean absolute luma difference (0..255) of one region between two videos at the same instant. */
function regionDiffBetween(fileA, fileB, seconds, crop) {
  const grab = (file) =>
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(seconds),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `crop=${crop},format=gray`,
        '-f',
        'rawvideo',
        '-',
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
  const a = grab(fileA);
  const b = grab(fileB);
  assert(a.length > 0 && a.length === b.length, `frames at ${seconds} s could be decoded`);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Media elements the page started (`new Audio()` ones included): see the init script. */
async function mediaStates() {
  return page.evaluate(() =>
    (window.__e2eMedia ?? []).map((el) => ({
      src: el.currentSrc || el.getAttribute('src') || '',
      paused: el.paused,
      ended: el.ended,
      currentTime: el.currentTime,
      duration: el.duration,
      connected: el.isConnected,
    })),
  );
}

async function goto(pathname) {
  await page.goto(`${WEB}${pathname}`, { waitUntil: 'domcontentloaded' });
}

/**
 * `page.waitForResponse`, safe to create BEFORE the action that triggers the request: if that
 * action throws, the abandoned wait must not become an unhandled rejection that kills the run.
 */
function expectResponse(predicate) {
  const waiting = page.waitForResponse(predicate);
  waiting.catch(() => {});
  return waiting;
}

/**
 * Text of a region once it shows everything in `patterns` (React may still be committing the
 * answer of a request the step has just seen). After 10 s the text is returned as it is, so the
 * assertion that follows fails with its own message.
 */
async function settledText(locator, patterns) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await locator.innerText().catch(() => '');
    if (patterns.every((pattern) => pattern.test(value)) || Date.now() > deadline) return value;
    await sleep(150);
  }
}

/** Waits for a toast / inline text and returns its locator. */
function text(value, options) {
  return page.getByText(value, options);
}

/** Picks an option of a design-system select (a combobox button + a listbox popover). */
async function choose(combobox, option) {
  await combobox.click();
  await page.getByRole('option', { name: option }).first().click();
}

async function pollVideo(videoId, { timeoutMs, what }) {
  return until(
    async () => {
      const video = await apiGet(`/api/videos/${videoId}`);
      if (video.status === 'failed')
        throw new Error(`${what} failed: ${JSON.stringify(video.error)}`);
      return video.status === 'completed' ? video : null;
    },
    { timeoutMs, everyMs: 1500, what },
  );
}

/* ------------------------------------------------------------------ sections */

const shared = {
  /** A completed 2D video of the workspace (source of the translation). */
  renderedVideoId: null,
};

async function sectionAvatars() {
  let catalog;
  await step('la API lista 10 avatares 2D y 11 fotorrealistas de stock', async () => {
    catalog = await apiGet('/api/avatars?limit=100');
    const instant = catalog.items.filter((a) => a.id.startsWith('stock_'));
    const photoreal = catalog.items.filter((a) => a.id.startsWith('real_'));
    assertEqual(instant.length, 10, 'instant 2D stock avatars');
    assertEqual(photoreal.length, 11, 'photoreal stock avatars');
    assert(catalog.engine !== null, 'the catalogue reports the neural engine status');
    assertEqual(catalog.engine.available, ENGINE, 'engine availability matches E2E_ENGINE');
  });

  await step('la biblioteca muestra los 21 con sus miniaturas', async () => {
    await goto('/avatars');
    const instantShelf = page.locator('section[aria-labelledby="shelf-instant"]');
    const stockShelf = page.locator('section[aria-labelledby="shelf-stockPhotoreal"]');
    await instantShelf.locator('li').first().waitFor();
    assertEqual(await instantShelf.locator('li').count(), 10, '2D cards');
    assertEqual(await stockShelf.locator('li').count(), 11, 'photoreal cards');

    // 2D cards are drawn live on a canvas: every one must have painted an actual character.
    await until(
      async () => {
        const painted = await instantShelf.locator('canvas').evaluateAll((nodes) =>
          nodes.map((canvas) => {
            const ctx = canvas.getContext('2d');
            if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const colours = new Set();
            for (let i = 0; i < data.length; i += 4 * 97) {
              if (data[i + 3] > 200)
                colours.add(
                  (data[i] >> 3) | ((data[i + 1] >> 3) << 5) | ((data[i + 2] >> 3) << 10),
                );
            }
            return colours.size;
          }),
        );
        return painted.length === 10 && painted.every((n) => n >= 8) ? painted : null;
      },
      { timeoutMs: 20_000, what: 'the ten 2D canvases to be painted' },
    );

    // Photoreal cards are images served by the API: all must decode.
    await stockShelf.locator('li').last().scrollIntoViewIfNeeded();
    const images = await until(
      async () => {
        for (const li of await stockShelf.locator('li').all()) await li.scrollIntoViewIfNeeded();
        const sizes = await stockShelf
          .locator('img')
          .evaluateAll((nodes) => nodes.map((img) => (img.complete ? img.naturalWidth : 0)));
        return sizes.length === 11 && sizes.every((w) => w >= 64) ? sizes : null;
      },
      { timeoutMs: 20_000, what: 'the eleven photoreal thumbnails to load' },
    );
    return `miniaturas fotorrealistas de ${Math.min(...images)}–${Math.max(...images)} px`;
  });

  await step('las pestañas filtran por tipo', async () => {
    await page.getByRole('tab', { name: /Fotorrealistas/ }).click();
    await until(
      async () =>
        (await page.locator('section li button[aria-label^="Abrir la ficha"]').count()) === 11,
      {
        what: 'only the 11 photoreal avatars',
      },
    );
    await page.getByRole('tab', { name: /Instantáneos 2D/ }).click();
    await until(
      async () =>
        (await page.locator('section li button[aria-label^="Abrir la ficha"]').count()) === 10,
      {
        what: 'only the 10 instant avatars',
      },
    );
    await page.getByRole('tab', { name: /Todos/ }).click();
  });

  await step('«Usar en un vídeo» crea el borrador y abre el Studio real', async () => {
    await goto('/avatars');
    await page.getByRole('button', { name: 'Abrir la ficha de Mateo' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Usar en un vídeo' }).click();
    await page.waitForURL(/\/studio\/vid_[a-z0-9]+/, { timeout: 20_000 });
    const videoId = page.url().match(/vid_[a-z0-9]+/)[0];
    const video = await apiGet(`/api/videos/${videoId}`);
    assertEqual(video.status, 'draft', 'the new video is a draft');
    const layer = video.composition.scenes[0].layers.find((l) => l.type === 'avatar');
    assertEqual(layer?.avatarId, 'stock_mateo', 'the draft uses the chosen avatar');
    assertDefaultVoice(video.composition.scenes[0].script.voiceId, 'the avatar draft');
    // The real Studio: its preview canvas and the script of the scene.
    await studioShowsScript(video.composition.scenes[0].script.text);
    return `borrador ${videoId}`;
  });
}

/** Asserts the Studio is open on a draft whose first scene narrates `scriptText`. */
async function studioShowsScript(scriptText) {
  await page.locator('canvas').first().waitFor({ timeout: 20_000 });
  const needle = scriptText.slice(0, 40);
  await until(
    async () =>
      page.evaluate((wanted) => {
        const fields = [...document.querySelectorAll('textarea, [contenteditable="true"]')];
        return fields.some((el) => (el.value ?? el.textContent ?? '').includes(wanted));
      }, needle),
    { timeoutMs: 20_000, what: `the Studio to show the script «${needle}…»` },
  );
}

async function sectionVoices() {
  let voices;
  await step('la API lista voces locales en 8 idiomas o más', async () => {
    voices = (await apiGet('/api/voices?limit=200')).items;
    const languages = new Set(voices.map((v) => v.language.split('-')[0]));
    assert(languages.size >= 8, `voices in ≥ 8 languages (got ${languages.size})`);
    assert(
      voices.every((v) => v.provider && typeof v.provider.name === 'string'),
      'every voice names its provider',
    );
    return `${voices.length} voces, ${languages.size} idiomas`;
  });

  await step('el listado agrupa por idioma e indica proveedor y modo básico', async () => {
    await goto('/voices');
    await page.getByRole('heading', { name: 'Español', exact: true }).waitFor();
    for (const language of ['Español', 'English', 'Français', 'Deutsch', 'Italiano', 'Português']) {
      assert(
        (await page.getByRole('heading', { name: language, exact: true }).count()) === 1,
        `group «${language}» is listed`,
      );
    }
    const spanish = page.locator('section[aria-labelledby="voices-es"]');
    const rows = await spanish.locator('li').count();
    assert(rows >= 2, `Spanish has several voices (got ${rows})`);
    // The first voice of a language is the default of the stack: a local neural voice when
    // one is installed, the basic eSpeak voice otherwise. Each row says which.
    const first = defaultVoice('es');
    const tier = stack.neural ? /Neuronal local/ : /Modo básico/;
    await settledText(spanish.locator('li').first(), [/Neuronal local|Modo básico|Sin instalar/]);
    const all = await spanish.locator('li').allTextContents();
    // The first voice that can be used is the default one (neural voices that are not
    // installed are listed before the basic ones, switched off and marked as such).
    const usable = all.filter((row) => !/Sin instalar/.test(row));
    assert(usable[0].includes(first.name), `the first usable Spanish voice is ${first.name}`);
    assert(tier.test(usable[0]), `its row is labelled «${tier.source}»`);
    if (!stack.neural) {
      const missing = all.filter((row) => /Sin instalar/.test(row));
      assert(missing.length > 0, 'the neural voices that are not installed are listed as such');
      const hint = await settledText(page.getByRole('note').filter({ hasText: 'sin instalar' }), [
        /pnpm voices:setup/,
      ]);
      assert(/pnpm voices:setup/.test(hint), 'the page says which command installs them');
      const play = spanish.getByRole('button', { name: /^Escuchar a / }).first();
      assert(await play.isDisabled(), 'a voice that is not installed cannot be played');
    }
    // eSpeak NG stays in the list, as the reserve, and is never dressed up as anything else.
    const reserve = all.filter((row) => /Carmen|Diego/.test(row));
    assert(reserve.length >= 2, 'the eSpeak voices are still listed');
    assert(
      reserve.every((row) => /Modo básico/.test(row)),
      'eSpeak rows are labelled «Modo básico»',
    );

    // Filtering by language leaves only that group.
    await choose(page.getByRole('combobox', { name: 'Idioma', exact: true }), 'Français');
    await until(
      async () => (await page.getByRole('heading', { name: 'Español', exact: true }).count()) === 0,
      {
        what: 'the language filter to apply',
      },
    );
    assertEqual(
      await page.getByRole('heading', { name: 'Français', exact: true }).count(),
      1,
      'French group stays',
    );
    await choose(page.getByRole('combobox', { name: 'Idioma', exact: true }), 'Todos los idiomas');
  });

  await step('la vista previa suena de verdad y dice quién la generó', async () => {
    const expected = defaultVoice('es').provider;
    await goto('/voices');
    const spanish = page.locator('section[aria-labelledby="voices-es"]');
    await spanish.locator('li').first().waitFor();
    const synthesis = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/tts/synthesize' && r.request().method() === 'POST',
    );
    await spanish
      .getByRole('button', { name: `Escuchar a ${defaultVoice('es').name}`, exact: true })
      .click();
    const response = await synthesis;
    assertEqual(response.status(), 200, 'POST /api/tts/synthesize');
    const speech = await response.json();
    assertEqual(speech.provider.id, expected.id, 'the audio was produced by the default voice');
    assertEqual(speech.provider.quality, expected.quality, 'its quality tier is reported');
    assertEqual(speech.provider.local, true, 'it was generated on this machine');
    assert(speech.runtime.visemes.length > 5, 'the synthesis carries a viseme timeline');

    // The WAV the browser plays has real signal…
    const stats = wavStats(await download(speech.audioUrl));
    assert(stats.durationMs > 800, `audio lasts (${stats.durationMs} ms)`);
    assert(stats.rms > 0.01, `audio is not silence (rms ${stats.rms.toFixed(4)})`);
    // …and the element is really playing it: its clock advances.
    const first = await until(
      async () => (await mediaStates()).find((m) => !m.paused && m.currentTime > 0.05) ?? null,
      { timeoutMs: 10_000, everyMs: 100, what: 'the preview audio to start' },
    );
    await sleep(400);
    const later = (await mediaStates()).find((m) => m.src === first.src);
    assert(later.currentTime > first.currentTime || later.ended, 'the audio clock advances');

    const consolePanel = page.getByRole('region', { name: /^Preescucha de / });
    const tier = stack.neural ? /Neuronal local/ : /Modo básico/;
    const panelText = await settledText(consolePanel, [/Este audio lo generó/, tier]);
    assert(/Este audio lo generó/.test(panelText), 'the console says who generated the audio');
    assert(panelText.includes(expected.name), `the console names ${expected.name}`);
    assert(tier.test(panelText), `the console says «${tier.source}»`);
    return `${expected.name}: WAV de ${stats.durationMs} ms, rms ${stats.rms.toFixed(3)}, ${speech.runtime.visemes.length} visemas`;
  });

  await step(
    'voz neuronal: suena en los idiomas instalados y eSpeak sigue de reserva',
    async () => {
      needsNeuralVoices();
      const samples = {
        es: 'Buenos días. Esta es una prueba de la voz neuronal local.',
        en: 'Good morning. This is a test of the local neural voice.',
      };
      const notes = [];
      for (const [language, sample] of Object.entries(samples)) {
        for (const gender of ['female', 'male']) {
          const voice = defaultVoice(language, gender);
          assert(
            NEURAL_VOICE_PROVIDERS.includes(voice.provider.id),
            `the default ${gender} ${language} voice is neural (got ${voice.id})`,
          );
          const speech = (
            await apiCall('POST', '/api/tts/synthesize', {
              expect: 200,
              body: { voiceId: voice.id, language, text: sample },
            })
          ).json;
          assertEqual(speech.provider.id, voice.provider.id, `${voice.id} names its provider`);
          const wav = wavStats(await download(speech.audioUrl));
          assert(wav.rms > 0.02, `${voice.id} has speech-level signal (rms ${wav.rms.toFixed(4)})`);
          assert(
            wav.durationMs > 2000 && wav.durationMs < 9000,
            `${voice.id}: ${wav.durationMs} ms`,
          );
          const words = speech.runtime.words;
          // Cues together spell the whole text (a word the model does not pronounce on its
          // own, like an English "of the" run together, shares the cue of its neighbour).
          assertEqual(
            words.map((word) => word.text).join(' '),
            sample,
            `${voice.id}: the word cues spell the text`,
          );
          assert(words.length >= 8, `${voice.id}: a cue for nearly every word (${words.length})`);
          assert(
            words.every((word, i) => i === 0 || word.tMs >= words[i - 1].tMs),
            `${voice.id}: word cues in order`,
          );
          notes.push(`${voice.id} ${wav.durationMs} ms rms ${wav.rms.toFixed(3)}`);
        }
      }
      // The reserve voice still answers when it is asked for by name.
      const reserve = (
        await apiCall('POST', '/api/tts/synthesize', {
          expect: 200,
          body: { voiceId: 'espeak:es-f1', language: 'es', text: samples.es },
        })
      ).json;
      assertEqual(reserve.provider.id, 'espeak', 'eSpeak NG answers when chosen');
      assertEqual(reserve.provider.quality, 'basic', 'and is reported as basic quality');
      assert(wavStats(await download(reserve.audioUrl)).rms > 0.01, 'the reserve voice sounds');
      return notes.join(' · ');
    },
  );

  await step('velocidad y texto propio cambian el audio', async () => {
    const consolePanel = page.getByRole('region', { name: /^Preescucha de / });
    await consolePanel
      .getByLabel('Texto de prueba')
      .fill('Probando la voz con un texto escrito por mí, uno, dos y tres.');
    const synthesis = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/tts/synthesize' && r.request().method() === 'POST',
    );
    await consolePanel.getByRole('button', { name: /con este texto$/ }).click();
    const response = await synthesis;
    assertEqual(response.status(), 200, 'synthesis with custom text');
    const body = response.request().postDataJSON();
    assert(body.text.startsWith('Probando la voz'), 'the custom text was sent');
    const speech = await response.json();
    const words = speech.runtime.words.map((w) => w.text).join(' ');
    assert(/Probando/.test(words), 'the word timeline follows the custom text');
    await consolePanel
      .getByRole('button', { name: 'Parar' })
      .click()
      .catch(() => {});
  });
}

async function sectionScriptWriter() {
  const topic = 'Cómo reservar cita en una clínica dental con la app Sonrisa y evitar llamadas';
  let script;

  await step('el panel de inicio enlaza al guionista y a las plantillas reales', async () => {
    await goto('/');
    const main = page.locator('main');
    await main.locator('a[href="/script-writer"]').first().waitFor();
    assert(
      (await main.locator('a[href="/templates"]').count()) > 0,
      'the dashboard links to /templates',
    );
    await goto('/templates');
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    assert(
      /Saludo personalizado/.test(
        await settledText(page.locator('main'), [/Saludo personalizado/]),
      ),
      'the template gallery lists the built-in templates',
    );
    await goto('/');
    await page.locator('main a[href="/script-writer"]').first().click();
    await page.waitForURL(/\/script-writer$/);
    await page.getByRole('heading', { name: 'De una idea a una escaleta' }).waitFor();
  });

  await step('tema → guion por escenas, con el proveedor a la vista', async () => {
    await goto('/script-writer');
    await page.getByLabel('Tema').fill(topic);
    const generation = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/script-writer/generate',
    );
    await page.getByRole('button', { name: 'Escribir el guion' }).click();
    const response = await generation;
    assertEqual(response.status(), 200, 'POST /api/script-writer/generate');
    script = await response.json();
    assert(script.scenes.length >= 2, `the script has several scenes (${script.scenes.length})`);
    assert(
      script.scenes.every((scene) => scene.text.trim().length > 0),
      'every scene has narration',
    );
    assertEqual(script.basicMode, true, 'without keys the script is written in basic mode');

    const region = page.getByRole('region', { name: 'Guion' });
    await region.waitFor();
    const narrations = region.getByLabel('Narración');
    await narrations.first().waitFor();
    assertEqual(await narrations.count(), script.scenes.length, 'one narration field per scene');
    assertEqual(
      await narrations.first().inputValue(),
      script.scenes[0].text,
      'first scene text is shown',
    );
    const regionText = await settledText(region, [/Escrito en modo básico/]);
    assert(/Escrito en modo básico/.test(regionText), 'the result is labelled as basic mode');
    assert(
      regionText.includes(script.provider.name),
      `the provider «${script.provider.name}» is named`,
    );
    return `${script.scenes.length} escenas · ${script.provider.name}`;
  });

  await step('«Crear vídeo con este guion» abre el Studio con ese guion', async () => {
    assert(script, 'a script was generated');
    const region = page.getByRole('region', { name: 'Guion' });
    // An edit made here must travel to the Studio.
    const edited = `${script.scenes[0].text} Editado en la prueba.`;
    await region.getByLabel('Narración').first().fill(edited);
    await region.getByRole('button', { name: 'Crear vídeo con este guion' }).click();
    const dialog = page.getByRole('dialog', { name: 'Crear vídeo con este guion' });
    await dialog.waitFor();
    const creation = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/videos' && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Crear el vídeo' }).click();
    const created = await creation;
    assertEqual(created.status(), 201, 'POST /api/videos');
    const video = await created.json();
    await page.waitForURL(new RegExp(`/studio/${video.id}`), { timeout: 20_000 });
    const stored = await apiGet(`/api/videos/${video.id}`);
    assertEqual(
      stored.composition.scenes.length,
      script.scenes.length,
      'one Studio scene per script scene',
    );
    assertDefaultVoice(stored.composition.scenes[0].script.voiceId, 'the script draft');
    assertEqual(
      stored.composition.scenes[0].script.text,
      edited,
      'the draft carries the edited narration',
    );
    await studioShowsScript(edited);
    return `borrador ${video.id} con ${stored.composition.scenes.length} escenas`;
  });

  await step('desde URL: los destinos no públicos se rechazan y se explica', async () => {
    if (PRIVATE_URLS_ALLOWED) {
      throw new Skip(
        'the stack runs with ALLOW_PRIVATE_URLS=true (run with E2E_ALLOW_PRIVATE_URLS=false to check the SSRF guard)',
      );
    }
    await goto('/script-writer');
    // The script of the previous step survives in this tab (by design): discard it first.
    const previous = page.getByRole('region', { name: 'Guion' });
    await previous.getByLabel('Narración').first().waitFor();
    await page.getByRole('button', { name: 'Descartar' }).click();
    await page
      .getByRole('alertdialog')
      .or(page.getByRole('dialog'))
      .getByRole('button', { name: 'Descartar' })
      .click();
    await previous.getByLabel('Narración').first().waitFor({ state: 'detached' });
    await page.getByText('Una página web', { exact: true }).click();
    for (const target of [
      'http://127.0.0.1:4000/health',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.8/interno',
    ]) {
      await page.getByLabel('Dirección de la página').fill(target);
      const generation = expectResponse(
        (r) => new URL(r.url()).pathname === '/api/script-writer/generate',
      );
      await page.getByRole('button', { name: /Escribir el guion|Escribirlo de nuevo/ }).click();
      const response = await generation;
      assertEqual(response.status(), 422, `${target} is rejected`);
      assertEqual((await response.json()).error.code, 'UNSAFE_URL', `${target} → UNSAFE_URL`);
      await text(/Esa dirección no está permitida/)
        .first()
        .waitFor({ timeout: 5000 });
    }
    assertEqual(
      await previous.getByLabel('Narración').count(),
      0,
      'no script is shown for a blocked URL',
    );
  });
}

/** Fills the shared consent block (name + checkbox). */
async function fillConsent(subjectName, { accept }) {
  await page.getByLabel('Nombre completo de quien consiente').fill(subjectName);
  const box = page.getByRole('checkbox', { name: 'He leído la declaración y la acepto' });
  if (accept) await box.check();
  else await box.uncheck();
}

async function sectionVoiceClone() {
  const voiceName = `Voz de prueba ${Date.now().toString(36)}`;
  const samplePath = path.join(OUT, 'voice-sample.wav');
  let voice;
  let sampleAssetId;
  let consentId;
  const before = await credits();
  // Who clones on this stack: the local voice engine (Chatterbox es-ES) while it answers,
  // otherwise the basic voice profile. Each step expects what the page promises for it.
  const cloner = (await apiGet('/api/capabilities')).active.voiceClone;
  const engineClones = cloner.id === 'chatterbox';
  let engineVoiceId = null;

  await step('se prepara una muestra de voz sintética de más de 10 s', async () => {
    const speech = (
      await apiCall('POST', '/api/tts/synthesize', {
        expect: 200,
        body: {
          voiceId: 'espeak:es-m1',
          language: 'es',
          speed: 1,
          pitch: 0,
          text: 'Hola, esta es mi voz. La grabo con calma, en un sitio tranquilo, para usarla en mis vídeos. Hablo a un ritmo natural, ni muy rápido ni muy despacio, y pronuncio cada frase con claridad, como si se lo contara a alguien que tengo delante.',
        },
      })
    ).json;
    const wav = await download(speech.audioUrl);
    fs.writeFileSync(samplePath, wav);
    const stats = wavStats(wav);
    assert(stats.durationMs >= 10_000, `the sample lasts ≥ 10 s (${stats.durationMs} ms)`);
    return `${(stats.durationMs / 1000).toFixed(1)} s`;
  });

  await step('sin consentimiento la interfaz no deja continuar y la API lo rechaza', async () => {
    await goto('/voices/clone');
    await page.locator('input[type="file"]').setInputFiles(samplePath);
    await page.locator('section[aria-labelledby="clone-step-2"] input').first().fill(voiceName);
    await fillConsent('Persona Sintética de Prueba', { accept: false });
    let posted = false;
    const spy = (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && /^\/api\/(assets|consents|voice-clones)/.test(pathname))
        posted = true;
    };
    page.on('request', spy);
    const submit = page.getByRole('button', { name: 'Clonar voz', exact: true });
    if (await submit.isEnabled()) await submit.click();
    await sleep(800);
    page.off('request', spy);
    assert(!posted, 'nothing is uploaded or created without the accepted declaration');
    await text('Marca la casilla para continuar.').first().waitFor({ timeout: 3000 });

    // The API refuses the operation on its own, whatever the client does.
    const upload = await apiCall('POST', '/api/assets', {
      expect: 201,
      multipart: {
        purpose: 'voice_sample',
        file: { name: 'muestra.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(samplePath) },
      },
    });
    const body = {
      name: 'Sin permiso',
      sampleAssetId: upload.json.id,
      language: 'es',
      gender: 'male',
    };
    const missing = await apiCall('POST', '/api/voice-clones', { body });
    assert(
      missing.status === 400 || missing.status === 403,
      `no consentId → rejected (got ${missing.status})`,
    );
    const bogus = await apiCall('POST', '/api/voice-clones', {
      body: { ...body, consentId: 'cns_0000000000000000' },
    });
    assertEqual(bogus.status, 403, 'unknown consent → 403');
    assertEqual(bogus.json.error.code, 'CONSENT_REQUIRED', 'unknown consent → CONSENT_REQUIRED');
    const wrongKind = await apiCall('POST', '/api/consents', {
      expect: 201,
      body: {
        kind: 'photo_avatar',
        subjectName: 'Persona Sintética de Prueba',
        relationship: 'self',
        statementVersion: CONSENT_VERSION,
        accepted: true,
      },
    });
    const crossed = await apiCall('POST', '/api/voice-clones', {
      body: { ...body, consentId: wrongKind.json.id },
    });
    assertEqual(crossed.status, 403, 'a photo consent cannot authorise a voice clone');
    assertEqual(
      (await apiGet('/api/voices?kind=cloned')).items.length,
      0,
      'no cloned voice was created',
    );
    assertEqual(await credits(), before, 'nothing was charged');
    await apiCall('DELETE', `/api/assets/${upload.json.id}`);
  });

  await step('muestra + consentimiento → voz clonada en este equipo', async () => {
    const panel = await settledText(page.getByRole('region', { name: 'Cómo se clona aquí' }), [
      engineClones ? /Clonado neuronal local/ : /Modo básico local/,
    ]);
    if (engineClones) {
      assert(/Clonado neuronal local/.test(panel), 'the page names the local neural cloning');
      assert(/Chatterbox/.test(panel) && /acento de España/.test(panel), 'and says which engine');
      assert(!/Modo básico local/.test(panel), 'it no longer says "modo básico"');
    } else assert(/Modo básico local/.test(panel), 'the page says it clones in basic mode');
    await fillConsent('Persona Sintética de Prueba', { accept: true });
    const creation = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/voice-clones' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Clonar voz', exact: true }).click();
    const response = await creation;
    assertEqual(response.status(), 202, 'POST /api/voice-clones');
    const requestBody = response.request().postDataJSON();
    sampleAssetId = requestBody.sampleAssetId;
    consentId = requestBody.consentId;
    voice = await response.json();
    assert(/^vcl_/.test(voice.id), 'the cloned voice has a vcl_ id');
    await text('Voz lista').first().waitFor({ timeout: 60_000 });
    voice = await apiGet(`/api/voices/${voice.id}`);
    assertEqual(voice.status, 'ready', 'the voice is ready');
    assertEqual(voice.provider.local, true, 'it was cloned on this machine');
    if (engineClones) {
      assertEqual(voice.provider.id, 'chatterbox', 'the local voice engine cloned it');
      assertEqual(voice.provider.quality, 'premium', 'a realistic clone is not labelled basic');
      const main = await settledText(page.locator('main'), [/Clonada en este equipo/]);
      assert(/Clonada en este equipo/.test(main), 'the result says it was cloned on this machine');
      assert(/marca de agua/.test(main), 'and that its audio carries a watermark');
      // "modo básico" appears only as the fallback for other languages, never as what happened.
      assert(!/Clonada en modo básico|Modo básico local/.test(main), 'not presented as basic mode');
      if (DATABASE_URL) {
        engineVoiceId = psql(`select provider_voice_id from voices where id = '${voice.id}'`);
        assert(/^cbx_/.test(engineVoiceId ?? ''), 'the engine holds the voice under a cbx_ id');
      }
    } else {
      assertEqual(voice.provider.quality, 'basic', 'local cloning is basic quality');
      const main = await settledText(page.locator('main'), [
        /Clonada en modo básico/,
        /No reproduce tu timbre/,
      ]);
      assert(/Clonada en modo básico/.test(main), 'the result says it was cloned in basic mode');
      assert(/No reproduce tu timbre/.test(main), 'the page is honest about the timbre');
    }
    assertEqual(await credits(), before - 10, 'cloning cost 10 credits');
    return `${voice.id} · ${voice.provider.name}`;
  });

  await step('la voz clonada se usa en una síntesis', async () => {
    assert(voice?.status === 'ready', 'a cloned voice exists');
    await goto('/voices');
    await page.getByRole('heading', { name: 'Español', exact: true }).waitFor();
    const clonedTab = page.getByRole('tab', { name: /Clonadas/ });
    await clonedTab.click();
    await until(async () => (await clonedTab.getAttribute('aria-selected')) === 'true', {
      timeoutMs: 5000,
      what: 'the «Clonadas» tab to be selected',
    });
    await until(
      async () => (await page.getByRole('heading', { name: 'Español', exact: true }).count()) === 0,
      { timeoutMs: 5000, what: 'only the cloned voices to be listed' },
    );
    const synthesis = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/tts/synthesize' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: `Escuchar a ${voiceName}`, exact: true }).click();
    const response = await synthesis;
    assertEqual(response.status(), 200, 'synthesis with the cloned voice');
    assertEqual(
      response.request().postDataJSON().voiceId,
      voice.id,
      'the cloned voice id was sent',
    );
    const speech = await response.json();
    const wav = await download(speech.audioUrl);
    const stats = wavStats(wav);
    assert(stats.durationMs > 800 && stats.rms > 0.01, 'the cloned voice produces audible speech');
    const consolePanel = page.getByRole('region', { name: /^Preescucha de / });
    const label = engineClones
      ? /Clonada en este equipo con un modelo neuronal/
      : /Clonado en modo básico/;
    assert(
      label.test(await settledText(consolePanel, [label])),
      'the console labels the clone for what it is',
    );
    if (engineClones) {
      assertEqual(speech.provider.id, 'chatterbox', 'the voice engine speaks the cloned voice');
      const mark = await engineWatermark(wav);
      assert(mark.detected, `the audio carries the Perth watermark (score ${mark.watermark})`);
    }
    await consolePanel
      .getByRole('button', { name: 'Parar' })
      .click({ timeout: 1000 })
      .catch(() => {});
    return `WAV de ${stats.durationMs} ms con ${speech.provider.name}`;
  });

  await step('la voz clonada habla por la API pública /v1: síntesis y vídeo', async () => {
    if (!engineClones) throw new Skip('the local voice engine is not cloning on this stack');
    const created = await apiCall('POST', '/api/api-keys', {
      expect: 201,
      body: { name: 'Otra app (clonado e2e)' },
    });
    const key = created.json.key;
    const listed = await v1('GET', '/v1/voices?language=es', key);
    assert(
      listed.json.items.some((item) => item.id === voice.id && item.kind === 'cloned'),
      'GET /v1/voices lists the cloned voice',
    );
    const said = await v1('POST', '/v1/speech', key, {
      text: 'Hola, os hablo con mi voz clonada desde la API pública de Parlante.',
      voiceId: voice.id,
      language: 'es',
    });
    assertEqual(
      said.status,
      200,
      `POST /v1/speech with the cloned voice (${said.text.slice(0, 200)})`,
    );
    assertEqual(said.json.provider.id, 'chatterbox', 'spoken by the local voice engine');
    assert(said.json.runtime.words.length >= 10, 'with word timings for subtitles and lips');
    const wav = await download(said.json.audioUrl);
    const mark = await engineWatermark(wav);
    assert(mark.detected, `the /v1 audio carries the Perth watermark (score ${mark.watermark})`);

    const avatars = (await v1('GET', '/v1/avatars', key)).json.items;
    const avatar = avatars.find((item) => item.rendering === 'instant') ?? avatars[0];
    assert(avatar, 'there is an avatar to present the video');
    const video = await v1('POST', '/v1/videos', key, {
      title: 'Vídeo con voz clonada (e2e)',
      input: {
        type: 'script',
        text: 'Este vídeo lo narra una voz clonada en este equipo, con consentimiento y marca de agua.',
        avatarId: avatar.id,
        voiceId: voice.id,
        language: 'es',
      },
      resolution: '720p',
    });
    assertEqual(
      video.status,
      202,
      `POST /v1/videos with the cloned voice (${video.text.slice(0, 200)})`,
    );
    let done = video.json;
    const deadline = Date.now() + 10 * 60_000;
    while (!['completed', 'failed'].includes(done.status) && Date.now() < deadline) {
      await sleep(2000);
      done = (await v1('GET', `/v1/videos/${video.json.id}`, key)).json;
    }
    assertEqual(done.status, 'completed', `the video renders (${JSON.stringify(done.error)})`);
    assertEqual(
      done.providers?.tts?.id,
      'chatterbox',
      'the video names the voice engine as its voice',
    );
    const mp4 = path.join(OUT, 'cloned-voice-video.mp4');
    fs.writeFileSync(mp4, await download(done.videoUrl));
    const extracted = path.join(OUT, 'cloned-voice-video.wav');
    execFileSync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-i',
      mp4,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '24000',
      '-c:a',
      'pcm_s16le',
      extracted,
    ]);
    const sound = wavStats(fs.readFileSync(extracted));
    assert(sound.durationMs > 3000 && sound.rms > 0.01, 'the MP4 carries the cloned voice');
    const videoMark = await engineWatermark(fs.readFileSync(extracted));
    return `/v1/speech ${(wav.length / 1024).toFixed(0)} KB, marca ${mark.watermark} · vídeo ${(done.durationMs / 1000).toFixed(1)} s (${avatar.name}), marca tras AAC ${videoMark.watermark}`;
  });

  await step('revocar el consentimiento lo borra todo en cascada (API, BD y disco)', async () => {
    assert(voice && consentId && sampleAssetId, 'a cloned voice with its consent exists');
    const voiceFilesBefore = filesUnder(`ws/${workspaceId}/voices/${voice.id}`);
    const assetFilesBefore = filesUnder(`ws/${workspaceId}/assets/${sampleAssetId}`);
    if (voiceFilesBefore)
      assert(voiceFilesBefore.length > 0, 'the voice has files on disk before revoking');
    if (assetFilesBefore)
      assert(assetFilesBefore.length > 0, 'the sample asset is on disk before revoking');

    await goto('/settings/consents');
    // The card names the voice (not its id); the id is on the card for scripts like this one.
    const record = page.locator(`li[data-resource-id="${voice.id}"]`);
    await record.getByText(voice.name, { exact: true }).waitFor();
    await record.getByRole('button', { name: /Revocar/ }).click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    const revocation = expectResponse((r) =>
      /\/api\/consents\/[^/]+\/revoke$/.test(new URL(r.url()).pathname),
    );
    await dialog.getByRole('button', { name: 'Revocar y borrar' }).click();
    assertEqual((await revocation).status(), 200, 'POST /api/consents/:id/revoke');

    assertEqual((await apiCall('GET', `/api/voices/${voice.id}`)).status, 404, 'the voice is gone');
    assertEqual(
      (await apiCall('GET', `/api/assets/${sampleAssetId}`)).status,
      404,
      'the source asset is gone',
    );
    assertEqual(
      (await apiGet('/api/voices?kind=cloned')).items.length,
      0,
      'no cloned voices are listed',
    );
    const stillSpeaks = await apiCall('POST', '/api/tts/synthesize', {
      body: {
        voiceId: voice.id,
        language: 'es',
        speed: 1,
        pitch: 0,
        text: 'Ya no debería poder hablar.',
      },
    });
    assert(
      stillSpeaks.status >= 400,
      `the revoked voice cannot synthesise (got ${stillSpeaks.status})`,
    );

    const notes = [];
    if (DATABASE_URL) {
      assertEqual(
        psql(`select count(*) from voices where id = '${voice.id}'`),
        '0',
        'voices row deleted',
      );
      assertEqual(
        psql(`select count(*) from assets where id = '${sampleAssetId}'`),
        '0',
        'assets row deleted',
      );
      assertEqual(
        psql(
          `select count(*) from consent_records where id = '${consentId}' and revoked_at is not null`,
        ),
        '1',
        'consent kept, marked revoked',
      );
      notes.push('BD: 0 filas en voices y assets, consentimiento con revoked_at');
    } else notes.push('BD no comprobada (E2E_DATABASE_URL sin definir)');
    if (STORAGE_DIR) {
      assertEqual(
        filesUnder(`ws/${workspaceId}/voices/${voice.id}`).length,
        0,
        'voice files deleted from disk',
      );
      assertEqual(
        filesUnder(`ws/${workspaceId}/assets/${sampleAssetId}`).length,
        0,
        'sample asset deleted from disk',
      );
      notes.push(
        `disco: borrados ${voiceFilesBefore.length} + ${assetFilesBefore.length} archivos`,
      );
    } else notes.push('disco no comprobado (E2E_STORAGE_DIR sin definir)');
    if (engineVoiceId) {
      const left = await fetch(`${VOICE_ENGINE}/v1/voices/${engineVoiceId}`);
      assertEqual(left.status, 404, 'the voice engine no longer holds the voice');
      notes.push(`motor de voz: ${engineVoiceId} borrado`);
    }
    return notes.join(' · ');
  });
}

/** Samples the stage canvas for `ms`: luminance of the mouth box and of a control box. */
async function sampleStage(ms) {
  return page.evaluate(async (duration) => {
    const canvas = document.querySelector('[data-talk-phase] canvas');
    const audio = document.querySelector('audio');
    const ctx = canvas.getContext('2d');
    const boxes = { mouth: [0.42, 0.42, 0.16, 0.14], forehead: [0.42, 0.2, 0.16, 0.08] };
    const lum = (name) => {
      const [x, y, w, h] = boxes[name];
      const { data } = ctx.getImageData(
        Math.round(x * canvas.width),
        Math.round(y * canvas.height),
        Math.round(w * canvas.width),
        Math.round(h * canvas.height),
      );
      const out = new Float32Array(data.length / 4);
      for (let i = 0; i < out.length; i += 1) {
        out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      }
      return out;
    };
    const frames = [];
    const end = performance.now() + duration;
    while (performance.now() < end) {
      frames.push({
        mouth: lum('mouth'),
        forehead: lum('forehead'),
        audio: audio && !audio.paused && audio.getAttribute('src') ? audio.currentTime : null,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const energy = (name) => {
      let sum = 0;
      let count = 0;
      for (let f = 1; f < frames.length; f += 1) {
        for (let i = 0; i < frames[f][name].length; i += 1) {
          sum += Math.abs(frames[f][name][i] - frames[f - 1][name][i]);
          count += 1;
        }
      }
      return count ? sum / count : 0;
    };
    // Two instants: the first frame against the one that differs most from it.
    let best = { changed: 0, at: 0 };
    for (let f = 1; f < frames.length; f += 1) {
      let changed = 0;
      for (let i = 0; i < frames[0].mouth.length; i += 1) {
        if (Math.abs(frames[0].mouth[i] - frames[f].mouth[i]) > 24) changed += 1;
      }
      if (changed > best.changed) best = { changed, at: f };
    }
    return {
      frames: frames.length,
      mouthPixels: frames[0].mouth.length,
      mouthEnergy: energy('mouth'),
      foreheadEnergy: energy('forehead'),
      changedPixels: best.changed,
      audioA: frames[0].audio,
      audioB: frames[best.at].audio,
    };
  }, ms);
}

async function sectionInteractive() {
  const before = await credits();
  let sessionId;
  const stage = () => page.locator('[data-talk-phase]');
  const audioState = () =>
    page.evaluate(() => {
      const audio = document.querySelector('audio');
      return audio
        ? {
            paused: audio.paused,
            hasSrc: Boolean(audio.getAttribute('src')),
            time: audio.currentTime,
          }
        : null;
    });

  await step('la preparación dice quién contesta y que el modo básico es gratis', async () => {
    await goto('/interactive');
    await page.getByRole('button', { name: 'Empezar a hablar' }).waitFor();
    const main = await settledText(page.locator('main'), [
      /Contestará la heurística local/,
      /Es gratis/,
    ]);
    assert(
      /Contestará la heurística local/.test(main),
      'the page says the local heuristic will answer',
    );
    assert(/Heurística local/.test(main), 'the LLM provider is named');
    assert(/Es gratis/.test(main), 'basic mode is shown as free');
    await page
      .getByLabel(/^Conocimiento/)
      .fill(
        '¿Cuál es el horario? Abrimos de lunes a viernes de nueve de la mañana a ocho de la tarde, y los sábados por la mañana de diez a dos.\n¿Dónde estáis? Estamos en la calle Mayor, número doce, junto a la plaza del mercado.',
      );
    const creation = expectResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/interactive/sessions' &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Empezar a hablar' }).click();
    const response = await creation;
    assertEqual(response.status(), 201, 'POST /api/interactive/sessions');
    sessionId = (await response.json()).id;
    await page.waitForURL(new RegExp(`/interactive/${sessionId}`));
    assertEqual(await credits(), before, 'a basic-mode session is free');
  });

  let idle;
  await step(
    'un mensaje recibe respuesta con texto y audio, y la boca se mueve en el lienzo',
    async () => {
      assert(sessionId, 'a session was started');
      await stage().locator('canvas[data-rig-status="ready"]').waitFor({ timeout: 20_000 });
      idle = await sampleStage(700);

      const box = page.getByRole('textbox', { name: /^Mensaje para / });
      await box.fill('¿Cuál es el horario?');
      const reply = expectResponse(
        (r) =>
          /\/api\/interactive\/sessions\/[^/]+\/messages$/.test(new URL(r.url()).pathname) &&
          r.request().method() === 'POST',
      );
      await box.press('Enter');
      const response = await reply;
      assert(response.ok(), `POST messages → ${response.status()}`);
      const exchange = await response.json();
      const answer = exchange.assistantMessage;
      assert(answer?.text?.length > 10, 'the reply has text');
      assert(/lunes a viernes/.test(answer.text), 'the reply comes from the knowledge given');
      assert(
        !/Dónde estáis/.test(answer.text),
        'the reply is the answer, not the neighbouring question',
      );
      assert(exchange.speech?.audioUrl, 'the reply has audio');
      // The session speaks with the default voice of the stack (neural when installed).
      const { session } = await apiGet(`/api/interactive/sessions/${sessionId}`);
      const sessionVoice = stack.voices.find((voice) => voice.id === session.voiceId);
      assert(sessionVoice, `the voice of the session (${session.voiceId}) is in the catalogue`);
      assertEqual(sessionVoice.isDefault, true, 'the session started with a default voice');
      assertEqual(
        exchange.speech.provider.id,
        sessionVoice.provider.id,
        'the audio was synthesised by the provider of the session voice',
      );
      if (stack.neural)
        assert(
          NEURAL_VOICE_PROVIDERS.includes(exchange.speech.provider.id),
          `the interactive avatar answers with a neural voice (got ${exchange.speech.provider.id})`,
        );
      const stats = wavStats(await download(exchange.speech.audioUrl));
      assert(stats.rms > 0.01 && stats.durationMs > 1500, 'the reply audio has real signal');

      await page.locator('[data-talk-phase="speaking"]').waitFor({ timeout: 10_000 });
      await text(answer.text.slice(0, 30)).first().waitFor();
      const speaking = await sampleStage(1200);
      assert(
        speaking.audioA !== null && speaking.audioB > speaking.audioA,
        'the audio clock advances between the two instants',
      );
      assert(
        speaking.changedPixels > 0.03 * speaking.mouthPixels,
        `mouth pixels differ between two instants (${speaking.changedPixels} of ${speaking.mouthPixels})`,
      );
      assert(
        speaking.mouthEnergy > 4 * Math.max(idle.mouthEnergy, 0.05),
        `the mouth moves much more speaking (${speaking.mouthEnergy.toFixed(3)}) than idle (${idle.mouthEnergy.toFixed(3)})`,
      );
      assert(
        speaking.mouthEnergy > 2 * speaking.foreheadEnergy,
        'the mouth moves more than the forehead',
      );
      const main = await settledText(page.locator('main'), [/Modo básico/]);
      assert(/Modo básico/.test(main), 'the conversation is labelled as basic mode');
      return `voz ${exchange.speech.provider.name} · ${speaking.changedPixels} de ${speaking.mouthPixels} px de la boca cambian (audio ${speaking.audioA.toFixed(2)} s → ${speaking.audioB.toFixed(2)} s); energía ${speaking.mouthEnergy.toFixed(2)} hablando / ${idle.mouthEnergy.toFixed(2)} en reposo`;
    },
  );

  await step('el audio se detiene al enviar otro mensaje', async () => {
    assert(sessionId, 'a session was started');
    const playing = await audioState();
    assert(playing && !playing.paused && playing.hasSrc, 'the first reply is still sounding');
    const box = page.getByRole('textbox', { name: /^Mensaje para / });
    await box.fill('¿Dónde estáis?');
    // The reply can arrive in a few ms, so the page itself records what happens (no
    // interception): every phase change of the stage with the state of the audio at that
    // instant, and every `pause` of the element.
    await page.evaluate(() => {
      const audio = document.querySelector('audio');
      const stageNode = document.querySelector('[data-talk-phase]');
      const log = [];
      window.__e2eTalkLog = log;
      const snapshot = (event) =>
        log.push({
          event,
          paused: audio.paused,
          hasSrc: Boolean(audio.getAttribute('src')),
          time: audio.currentTime,
        });
      audio.addEventListener('playing', () => snapshot('playing'));
      new MutationObserver(() =>
        snapshot(`phase:${stageNode.getAttribute('data-talk-phase')}`),
      ).observe(stageNode, {
        attributes: true,
        attributeFilter: ['data-talk-phase'],
      });
    });
    await box.press('Enter');
    const log = await until(
      async () => {
        const entries = await page.evaluate(() => window.__e2eTalkLog);
        return entries.some((entry) => entry.event === 'phase:speaking') ? entries : null;
      },
      { timeoutMs: 15_000, everyMs: 50, what: 'the second reply to start' },
    );
    const thinking = log.find((entry) => entry.event === 'phase:thinking');
    assert(
      thinking,
      `the stage went through «thinking» (${log.map((entry) => entry.event).join(', ')})`,
    );
    assert(
      thinking.paused && !thinking.hasSrc,
      'while thinking, the previous audio is paused and unloaded',
    );
    // The new reply then sounds.
    await until(
      async () => {
        const state = await audioState();
        return state && !state.paused && state.hasSrc && state.time > 0.05;
      },
      { timeoutMs: 15_000, everyMs: 100, what: 'the second reply to sound' },
    );
    await text(/calle Mayor/)
      .first()
      .waitFor();
  });

  await step('el audio se detiene al salir de la página', async () => {
    assert(sessionId, 'a session was started');
    const playing = await audioState();
    assert(playing && !playing.paused, 'a reply is sounding when leaving');
    await page.getByRole('link', { name: 'Avatares', exact: true }).first().click();
    await page.waitForURL(/\/avatars$/);
    await sleep(300);
    const media = (await mediaStates()).filter((m) => /\/api\/files\//.test(m.src) || m.src === '');
    assert(media.length > 0, 'the page had started audio');
    assert(
      media.every((m) => m.paused),
      'every audio element is paused after leaving',
    );
    assertEqual(await page.locator('audio').count(), 0, 'the audio element left the DOM');
    assertEqual(await credits(), before, 'the whole basic conversation was free');
  });
}

async function sectionBatch() {
  const rows = [
    { nombre: 'Alba', mensaje: 'Gracias por tu primer año con nosotros.' },
    { nombre: 'Bruno', mensaje: 'Enhorabuena por cerrar el proyecto a tiempo.' },
    { nombre: 'Carla', mensaje: 'Bienvenida al equipo de diseño.' },
  ];
  const csv = ['nombre,mensaje', ...rows.map((row) => `${row.nombre},${row.mensaje}`)].join('\n');
  const before = await credits();
  let batchId;
  let detail;

  await step('plantilla con variables + CSV de 3 filas → lote lanzado', async () => {
    await goto('/batch/new');
    await page.getByRole('tab', { name: 'Plantillas' }).click();
    await page.getByText('Saludo personalizado', { exact: true }).first().click();
    await text(/Esta plantilla usa 4 variables/).waitFor();
    await page.getByRole('button', { name: 'Crear el borrador y usarlo' }).click();
    await text(/Usa 4 variables\./).waitFor();
    await page.getByLabel('O pega aquí los datos').fill(csv);
    await text(/3 filas y 2 columnas leídas/).waitFor();
    // Columns named like the variables are mapped on their own; the other two keep their default.
    await until(async () => (await page.getByText('Asignada', { exact: true }).count()) === 2, {
      what: 'the two CSV columns to be mapped',
    });
    assertEqual(
      await page.getByText('Valor por defecto', { exact: true }).count(),
      2,
      'two variables use their default',
    );
    const main = await settledText(page.locator('main'), [/Alba/, /Bruno/, /Carla/]);
    assert(
      /Alba/.test(main) && /Bruno/.test(main) && /Carla/.test(main),
      'the three rows are previewed',
    );
    await text(/Coste estimado: \d+ créditos?/).waitFor({ timeout: 20_000 });

    const creation = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/batches' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Lanzar 3 vídeos' }).click();
    const response = await creation;
    assertEqual(response.status(), 202, 'POST /api/batches');
    batchId = (await response.json()).id;
    await page.waitForURL(new RegExp(`/batch/${batchId}`));
    return `lote ${batchId}`;
  });

  await step('los 3 vídeos se renderizan de verdad (MP4 con su texto personalizado)', async () => {
    assert(batchId, 'a batch was launched');
    detail = await until(
      async () => {
        const current = await apiGet(`/api/batches/${batchId}`);
        if (current.status === 'failed')
          throw new Error(
            `batch failed: ${JSON.stringify(current.error)} ${JSON.stringify(current.items.map((i) => i.error))}`,
          );
        return current.status === 'completed' || current.status === 'partial' ? current : null;
      },
      { timeoutMs: 8 * 60_000, everyMs: 2000, what: 'the batch to finish rendering' },
    );
    assertEqual(detail.status, 'completed', 'batch status');
    assertEqual(detail.completed, 3, 'completed videos');
    assertEqual(detail.items.length, 3, 'batch items');
    const durations = [];
    for (const item of detail.items) {
      const row = rows[item.index];
      assertEqual(item.status, 'completed', `row ${item.index + 1} status`);
      const video = await apiGet(`/api/videos/${item.videoId}`);
      assertEqual(video.status, 'completed', `video of row ${item.index + 1}`);
      const file = path.join(OUT, `batch-${item.index + 1}.mp4`);
      fs.writeFileSync(file, await download(video.videoUrl));
      const probe = ffprobe(file);
      const codecs = probe.streams
        .map((stream) => stream.codec_name)
        .sort()
        .join('+');
      assertEqual(codecs, 'aac+h264', `row ${item.index + 1} is H.264 + AAC`);
      // A video made from a built-in template speaks with the default voices of the stack.
      const spoken = video.composition.scenes.find((scene) => scene.script.kind === 'tts');
      const rowVoice = stack.voices.find((voice) => voice.id === spoken?.script.voiceId);
      assert(rowVoice, `the voice of row ${item.index + 1} is in the catalogue`);
      assertEqual(rowVoice.isDefault, true, `row ${item.index + 1} uses a default voice`);
      assertEqual(
        video.providers?.tts?.id,
        rowVoice.provider.id,
        `row ${item.index + 1} says who voiced it`,
      );
      if (stack.neural)
        assert(
          NEURAL_VOICE_PROVIDERS.includes(video.providers.tts.id),
          `row ${item.index + 1} was voiced by a neural voice (got ${video.providers.tts.id})`,
        );
      const seconds = Number(probe.format.duration);
      assert(seconds > 5, `row ${item.index + 1} lasts (${seconds} s)`);
      durations.push(seconds.toFixed(1));
      const srt = (await download(video.srtUrl)).toString('utf8');
      assert(srt.includes(row.nombre), `the subtitles of row ${item.index + 1} name ${row.nombre}`);
      assert(
        srt.includes(row.mensaje.slice(0, 20)),
        `the subtitles of row ${item.index + 1} carry its message`,
      );
      assert(!/\{\{/.test(srt), 'no unresolved {{variable}} is spoken');
      for (const other of rows) {
        if (other !== row)
          assert(
            !srt.includes(other.nombre),
            `row ${item.index + 1} does not mention ${other.nombre}`,
          );
      }
      if (item.index === 0) shared.renderedVideoId = item.videoId;
    }
    const after = await credits();
    assertEqual(
      before - after,
      detail.creditsCharged,
      'the balance fell by what the batch reports',
    );
    assert(
      detail.creditsCharged >= 3,
      `each render was charged (${detail.creditsCharged} credits)`,
    );
    // The page reflects it without reloading.
    await until(
      async () =>
        (await page.locator('main table tbody tr').filter({ hasText: 'Completado' }).count()) === 3,
      {
        timeoutMs: 20_000,
        what: 'the page to show the three rows as completed',
      },
    );
    return `MP4 de ${durations.join(' s, ')} s · ${detail.creditsCharged} créditos`;
  });

  await step('«Ver sus vídeos» abre el listado filtrado por lote', async () => {
    assert(detail, 'the batch finished');
    await page.getByRole('link', { name: 'Ver sus vídeos' }).click();
    await page.waitForURL(new RegExp(`/videos\\?.*batchJobId=${batchId}`));
    const listed = await apiGet(`/api/videos?batchJobId=${batchId}&limit=50`);
    assertEqual(listed.items.length, 3, 'the API filter returns the 3 videos of the batch');
    const cards = page.locator('main a[href^="/videos/vid_"]');
    await until(
      async () =>
        new Set(await cards.evaluateAll((nodes) => nodes.map((a) => a.getAttribute('href'))))
          .size === 3,
      {
        what: 'exactly the 3 videos of the batch in the list',
      },
    );
    const hrefs = new Set(
      await cards.evaluateAll((nodes) => nodes.map((a) => a.getAttribute('href'))),
    );
    for (const item of detail.items)
      assert(hrefs.has(`/videos/${item.videoId}`), `video of row ${item.index + 1} is listed`);
  });
}

/** A completed 2D video of this workspace with Spanish narration (rendered here if needed). */
async function ensureRenderedVideo() {
  if (shared.renderedVideoId) return apiGet(`/api/videos/${shared.renderedVideoId}`);
  const draft = (
    await apiCall('POST', '/api/templates/builtin_greeting/use', {
      expect: 201,
      body: { title: 'Saludo para traducir' },
    })
  ).json;
  await apiCall('POST', `/api/videos/${draft.id}/render`, {
    expect: 202,
    body: { resolution: '720p' },
  });
  const video = await pollVideo(draft.id, {
    timeoutMs: 4 * 60_000,
    what: 'the source video to render',
  });
  shared.renderedVideoId = video.id;
  return video;
}

async function sectionTranslate() {
  let source;
  let sourceSrt;
  let job;

  await step('hay un vídeo renderizado con su transcripción', async () => {
    source = await ensureRenderedVideo();
    assertEqual(source.status, 'completed', 'source video status');
    sourceSrt = (await download(source.srtUrl)).toString('utf8');
    assert(/-->/.test(sourceSrt), 'the source video has an SRT transcript');
    return `${source.id} · ${(source.durationMs / 1000).toFixed(1)} s`;
  });

  const openForm = async (srt) => {
    await goto('/translate/new');
    await page.getByRole('tab', { name: 'Mis vídeos' }).click();
    await page.locator(`input[type="radio"][value="${source.id}"]`).check({ force: true });
    await page.getByRole('checkbox', { name: /English/ }).check({ force: true });
    await page.getByLabel('Transcripción del vídeo original').fill(srt);
  };

  await step('vídeo + transcripción → un idioma destino, con coste a la vista', async () => {
    assert(source, 'a rendered source video exists');
    await openForm(sourceSrt);
    await text(/fragmentos? reconocidos?/)
      .first()
      .waitFor();
    await page.getByRole('switch', { name: 'Incrustar los subtítulos traducidos' }).check();
    const main = await settledText(page.locator('main'), [
      /Traducción en modo básico/,
      /Cuesta 2 créditos/,
    ]);
    assert(/Traducción en modo básico/.test(main), 'the page warns that translation is basic mode');
    assert(
      /Cuesta 2 créditos/.test(main),
      'the cost (2 credits: 1 started minute × 1 language) is shown',
    );
    const before = await credits();
    const creation = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/translations' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Traducir a 1 idioma' }).click();
    const response = await creation;
    assertEqual(response.status(), 202, 'POST /api/translations');
    job = await response.json();
    await page.waitForURL(new RegExp(`/translate/${job.id}`));
    assertEqual(await credits(), before - 2, '2 credits were reserved');
    job.creditsBefore = before;
  });

  await step('el resultado se reproduce con subtítulos y los créditos cuadran', async () => {
    assert(job, 'a translation was launched');
    const done = await until(
      async () => {
        const current = await apiGet(`/api/translations/${job.id}`);
        if (current.status === 'failed')
          throw new Error(`translation failed: ${JSON.stringify(current.error)}`);
        return current.status === 'completed' ? current : null;
      },
      { timeoutMs: 4 * 60_000, everyMs: 1500, what: 'the translation to finish' },
    );
    const output = done.outputs.find((o) => o.language === 'en');
    assertEqual(output?.status, 'completed', 'English output');
    assertEqual(done.creditsCharged, 2, 'credits charged by the job');
    assertEqual(await credits(), job.creditsBefore - 2, 'the balance matches the charge');
    assertEqual(done.transcriptSource, 'user', 'the transcript is the one the user supplied');
    assert(
      done.providers?.translation && done.providers?.tts,
      'the job says who translated and who voiced',
    );
    // Dubbed with the default English voice of the stack: neural when it is installed.
    const dubVoice = stack.voices.find((voice) => voice.id === output.voiceId);
    assert(dubVoice, `the dubbing voice (${output.voiceId}) is in the catalogue`);
    assertEqual(dubVoice.id, defaultVoice('en').id, 'the default English voice dubs');
    assertEqual(done.providers.tts.id, dubVoice.provider.id, 'the job names the voice provider');

    const file = path.join(OUT, 'translated-en.mp4');
    fs.writeFileSync(file, await download(output.videoUrl));
    const probe = ffprobe(file);
    assertEqual(
      probe.streams
        .map((st) => st.codec_name)
        .sort()
        .join('+'),
      'aac+h264',
      'dubbed file is H.264 + AAC',
    );
    const seconds = Number(probe.format.duration);
    assert(
      Math.abs(seconds * 1000 - source.durationMs) < 500,
      `same length as the source (${seconds} s vs ${source.durationMs} ms)`,
    );
    const srt = (await download(output.srtUrl)).toString('utf8');
    const vtt = (await download(output.vttUrl)).toString('utf8');
    assert(/-->/.test(srt) && /^WEBVTT/.test(vtt), 'SRT and VTT were produced');
    assert(srt !== sourceSrt, 'the subtitles are not the source transcript');

    // In the page: the dubbed video plays and its subtitle cues are loaded.
    const card = page.locator('article[data-language="en"][data-status="completed"]');
    await card.waitFor({ timeout: 20_000 });
    const video = card.locator('video');
    await video.waitFor();
    const played = await video.evaluate(async (el) => {
      el.muted = true;
      await el.play();
      const start = el.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const result = {
        advanced: el.currentTime - start,
        width: el.videoWidth,
        duration: el.duration,
      };
      el.pause();
      return result;
    });
    assert(
      played.advanced > 0.5,
      `the dubbed video plays in the page (advanced ${played.advanced.toFixed(2)} s)`,
    );
    assert(played.width > 0, 'the dubbed video has a picture');
    const main = await settledText(page.locator('main'), [
      /Aportada por ti/,
      /Incrustados \+ SRT\/VTT/,
    ]);
    assert(/Aportada por ti/.test(main), 'the detail says the transcript was supplied by the user');
    assert(/Incrustados \+ SRT\/VTT/.test(main), 'the detail says subtitles are burned in');

    // Burned-in subtitles: against the source at the same instant, the picture only changes
    // where the translated subtitle is painted (the lower band), not in the upper half.
    const firstCue = /(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/.exec(srt);
    const cueStart = Number(firstCue[2]) * 60 + Number(firstCue[3]) + Number(firstCue[4]) / 1000;
    const cueEnd = Number(firstCue[6]) * 60 + Number(firstCue[7]) + Number(firstCue[8]) / 1000;
    const cueMid = (cueStart + cueEnd) / 2;
    const sourceFile = path.join(OUT, 'translation-source.mp4');
    fs.writeFileSync(sourceFile, await download(source.videoUrl));
    const lowerBand = regionDiffBetween(sourceFile, file, cueMid, 'iw:ih*0.3:0:ih*0.7');
    const upperHalf = regionDiffBetween(sourceFile, file, cueMid, 'iw:ih*0.5:0:0');
    assert(
      lowerBand > 3 * Math.max(upperHalf, 0.3),
      `the translated subtitle is painted on the picture (lower band ${lowerBand.toFixed(2)} vs upper half ${upperHalf.toFixed(2)})`,
    );
    ffmpeg([
      '-ss',
      String(cueMid),
      '-i',
      file,
      '-frames:v',
      '1',
      path.join(OUT, 'translated-en-frame.png'),
    ]);
    return `MP4 de ${seconds.toFixed(1)} s · ${srt.split('-->').length - 1} subtítulos · ${done.providers.translation.name} + ${done.providers.tts.name}`;
  });

  await step('una traducción que falla devuelve los créditos y lo dice', async () => {
    assert(source, 'a rendered source video exists');
    const before = await credits();
    // A transcript whose only cue has nothing speakable: the job cannot dub anything.
    const created = await apiCall('POST', '/api/translations', {
      body: {
        name: 'Traducción que falla',
        sourceVideoId: source.id,
        sourceLanguage: 'es',
        targetLanguages: ['en'],
        transcript: { format: 'srt', content: '1\n00:00:01,000 --> 00:00:03,000\n♪ ♪ ♪\n' },
      },
    });
    assertEqual(created.status, 202, `the API accepts the job (${created.text.slice(0, 200)})`);
    assertEqual(await credits(), before - 2, 'credits are reserved when the job is queued');
    await goto(`/translate/${created.json.id}`);
    const failed = await until(
      async () => {
        const current = await apiGet(`/api/translations/${created.json.id}`);
        return current.status === 'failed'
          ? current
          : current.status === 'completed'
            ? (() => {
                throw new Error('the broken translation completed');
              })()
            : null;
      },
      { timeoutMs: 2 * 60_000, everyMs: 1000, what: 'the broken translation to fail' },
    );
    assert(failed.error?.message, 'the failure carries a reason');
    assertEqual(failed.creditsCharged, 0, 'nothing stays charged');
    assertEqual(await credits(), before, 'the reserved credits were refunded');
    const ledger = await apiGet('/api/billing/ledger?limit=10');
    assert(
      ledger.items.some((entry) => entry.reason === 'refund' && entry.delta === 2),
      'the ledger shows the refund',
    );
    await page.getByRole('alert').first().waitFor({ timeout: 20_000 });
    await apiCall('DELETE', `/api/translations/${created.json.id}`);
    return `motivo: ${failed.error.message}`;
  });
}

/**
 * Where the mouth and the forehead of a photoreal avatar fall in the rendered frame, from the
 * avatar's own landmarks and its layer. Mirrors `photoAvatarPlacement` of @parlante/renderer
 * (bust: eye line → chin is 20 % of the layer box; closeup 32 %; half: contained), on purpose
 * written again here: the test must not trust the code it checks.
 */
function faceRegions(rig, layer, frameW, frameH) {
  const box = {
    x: layer.box.x * frameW,
    y: layer.box.y * frameH,
    w: layer.box.w * frameW,
    h: layer.box.h * frameH,
  };
  const { imageWidth: iw, imageHeight: ih, landmarks: lm } = rig;
  const eyeY = ((lm.leftEye.y + lm.rightEye.y) / 2) * ih;
  const faceCx = ((lm.leftEye.x + lm.rightEye.x) / 2) * iw;
  const faceH = lm.chin.y * ih - eyeY;
  const contain = Math.min(box.w / iw, box.h / ih);
  const share = { bust: 0.2, closeup: 0.32 }[layer.framing];
  const scale = share ? Math.max(contain, (share * box.h) / faceH) : contain;
  const x0 = share ? box.x + box.w / 2 - faceCx * scale : box.x + (box.w - iw * scale) / 2;
  let y0 = box.y + box.h - ih * scale;
  if (layer.framing === 'closeup') y0 = Math.max(y0, box.y + 0.4 * box.h - eyeY * scale);
  const toFrame = (px, py) => ({ x: x0 + px * scale, y: y0 + py * scale });
  const mouth = toFrame(
    ((lm.mouthLeft.x + lm.mouthRight.x) / 2) * iw,
    ((lm.mouthLeft.y + lm.mouthRight.y) / 2) * ih,
  );
  const forehead = toFrame(faceCx, eyeY - 0.55 * faceH);
  const w = Math.round(faceH * scale * 0.7);
  const h = Math.round(faceH * scale * 0.45);
  const region = (c) => ({
    w,
    h,
    x: Math.max(0, Math.min(frameW - w, Math.round(c.x - w / 2))),
    y: Math.max(0, Math.min(frameH - h, Math.round(c.y - h / 2))),
  });
  return { mouth: region(mouth), forehead: region(forehead) };
}

/** Largest mean change (gray levels) of a region against its first frame, at 10 fps. */
function regionChange(file, region) {
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `fps=10,crop=${region.w}:${region.h}:${region.x}:${region.y},format=gray`,
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  const size = region.w * region.h;
  const frames = Math.floor(raw.length / size);
  let best = 0;
  for (let f = 1; f < frames; f += 1) {
    let sum = 0;
    for (let i = 0; i < size; i += 1) sum += Math.abs(raw[f * size + i] - raw[i]);
    best = Math.max(best, sum / size);
  }
  return { frames, change: best };
}

async function sectionPhotoAvatar() {
  const stamp = Date.now().toString(36);
  const photoName = `Carmen e2e ${stamp}`;
  const before = await credits();
  let photoAvatar = null;
  let generated = null;

  await step('sin consentimiento la API rechaza crear un avatar desde una foto', async () => {
    const upload = await apiCall('POST', '/api/assets', {
      expect: 201,
      multipart: {
        purpose: 'avatar_source',
        file: {
          name: path.basename(PORTRAIT),
          mimeType: /\.png$/i.test(PORTRAIT) ? 'image/png' : 'image/jpeg',
          buffer: fs.readFileSync(PORTRAIT),
        },
      },
    });
    const body = { name: 'Sin permiso', imageAssetId: upload.json.id, gender: 'female' };
    const missing = await apiCall('POST', '/api/photo-avatars', { body });
    assert(
      missing.status === 400 || missing.status === 403,
      `no consentId → rejected (got ${missing.status})`,
    );
    const bogus = await apiCall('POST', '/api/photo-avatars', {
      body: { ...body, consentId: 'cns_0000000000000000' },
    });
    assertEqual(bogus.status, 403, 'unknown consent → 403');
    assertEqual(bogus.json.error.code, 'CONSENT_REQUIRED', 'unknown consent → CONSENT_REQUIRED');
    const voiceConsent = await apiCall('POST', '/api/consents', {
      expect: 201,
      body: {
        kind: 'voice_clone',
        subjectName: 'Persona Sintética de Prueba',
        relationship: 'self',
        statementVersion: CONSENT_VERSION,
        accepted: true,
      },
    });
    const crossed = await apiCall('POST', '/api/photo-avatars', {
      body: { ...body, consentId: voiceConsent.json.id },
    });
    assertEqual(crossed.status, 403, 'a voice consent cannot authorise a photo avatar');
    assertEqual(
      (await apiGet('/api/avatars?limit=100')).items.filter((a) => a.id.startsWith('avt_')).length,
      0,
      'no avatar was created',
    );
    assertEqual(await credits(), before, 'nothing was charged');
    await apiCall('DELETE', `/api/assets/${upload.json.id}`);
  });

  await step('sin consentimiento la interfaz no deja continuar', async () => {
    needsEngine();
    await goto('/avatars/new');
    await page.locator('input[type="file"]').setInputFiles(PORTRAIT);
    await page.locator('section[aria-labelledby="photo-step-2"] input').first().fill(photoName);
    await fillConsent('Persona Sintética de Prueba', { accept: false });
    let posted = false;
    const spy = (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && /^\/api\/(assets|consents|photo-avatars)/.test(pathname))
        posted = true;
    };
    page.on('request', spy);
    const submit = page.getByRole('button', { name: 'Crear avatar', exact: true });
    if (await submit.isEnabled()) await submit.click();
    await sleep(800);
    page.off('request', spy);
    assert(!posted, 'nothing is uploaded or created without the accepted declaration');
    await text('Marca la casilla para continuar.').first().waitFor({ timeout: 3000 });
  });

  await step('foto sintética + consentimiento → progreso → avatar listo (motor real)', async () => {
    needsEngine();
    await fillConsent('Persona Sintética de Prueba', { accept: true });
    const creation = expectResponse(
      (r) => new URL(r.url()).pathname === '/api/photo-avatars' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Crear avatar', exact: true }).click();
    const response = await creation;
    assertEqual(response.status(), 202, 'POST /api/photo-avatars');
    const created = await response.json();
    assert(/^avt_/.test(created.id), 'the avatar has an avt_ id');
    assertEqual(await credits(), before - 5, 'a photo avatar reserves 5 credits');
    // The job view shows progress while the engine works.
    await page.getByRole('progressbar').first().waitFor({ timeout: 10_000 });
    const seen = new Set();
    await until(
      async () => {
        const current = await apiGet(`/api/avatars/${created.id}`);
        seen.add(`${current.status}:${Math.round(current.progress)}`);
        if (current.status === 'failed')
          throw new Error(`avatar failed: ${JSON.stringify(current.error)}`);
        return current.status === 'ready';
      },
      { timeoutMs: 4 * 60_000, everyMs: 1000, what: 'the photo avatar to be ready' },
    );
    await text('Avatar listo').first().waitFor({ timeout: 20_000 });
    photoAvatar = await apiGet(`/api/avatars/${created.id}`);
    for (const key of ['thumbnailUrl', 'imageUrl', 'cutoutUrl']) {
      assert(photoAvatar[key], `the ready avatar exposes ${key}`);
      assert((await download(photoAvatar[key])).length > 2000, `${key} is a real file`);
    }
    fs.writeFileSync(
      path.join(OUT, 'photo-avatar-cutout.png'),
      await download(photoAvatar.cutoutUrl),
    );
    const shown = await page.locator('main').evaluate((main) => {
      const image = [...main.querySelectorAll('img')].some(
        (img) => img.complete && img.naturalWidth >= 64,
      );
      const canvas = [...main.querySelectorAll('canvas')].some((node) => {
        const ctx = node.getContext('2d');
        if (!ctx || node.width < 64) return false;
        const { data } = ctx.getImageData(0, 0, node.width, node.height);
        const colours = new Set();
        for (let i = 0; i < data.length; i += 4 * 101)
          if (data[i + 3] > 200)
            colours.add((data[i] >> 3) | ((data[i + 1] >> 3) << 5) | ((data[i + 2] >> 3) << 10));
        return colours.size >= 8;
      });
      return image || canvas;
    });
    assert(shown, 'the page shows the prepared portrait');
    assertEqual(await credits(), before - 5, 'the avatar cost 5 credits');
    return `${created.id} · estados vistos: ${[...seen].join(' → ')}`;
  });

  let videoFile = null;
  await step(
    'se usa en un vídeo de 2 s y se renderiza: MP4 con los labios en movimiento',
    async () => {
      needsEngine();
      assert(photoAvatar, 'a photo avatar is ready');
      const priorCredits = await credits();
      await page.getByRole('button', { name: 'Usar en un vídeo' }).click();
      await page.waitForURL(/\/studio\/vid_[a-z0-9]+/, { timeout: 20_000 });
      const videoId = page.url().match(/vid_[a-z0-9]+/)[0];
      let draft = await apiGet(`/api/videos/${videoId}`);
      const layer = draft.composition.scenes[0].layers.find((l) => l.type === 'avatar');
      assertEqual(layer?.avatarId, photoAvatar.id, 'the draft uses the new avatar');
      const narratorId = draft.composition.scenes[0].script.voiceId;
      assertDefaultVoice(narratorId, 'the photo-avatar draft');
      await studioShowsScript(draft.composition.scenes[0].script.text);
      // Leave the Studio (its autosave would race the edit) and cut the script down to ~2 s.
      await goto('/avatars');
      draft = await apiGet(`/api/videos/${videoId}`);
      const composition = structuredClone(draft.composition);
      composition.scenes[0].script.text = 'Hola, soy Carmen.';
      composition.scenes[0].paddingStartMs = 200;
      composition.scenes[0].paddingEndMs = 200;
      composition.subtitles.enabled = false;
      await apiCall('PATCH', `/api/videos/${videoId}`, {
        expect: 200,
        body: { composition, baseRevision: draft.revision },
      });
      const started = await apiCall('POST', `/api/videos/${videoId}/render`, {
        expect: 202,
        body: { resolution: '720p' },
      });
      assert(started.json.renderJob.id, 'a render job was queued');
      // The video page shows progress and the time left while the engine animates.
      await goto(`/videos/${videoId}`);
      let sawEta = false;
      const stages = new Set();
      const video = await until(
        async () => {
          const current = await apiGet(`/api/videos/${videoId}`);
          if (current.renderStage) stages.add(current.renderStage);
          if (typeof current.renderEtaSec === 'number') sawEta = true;
          if (current.status === 'failed')
            throw new Error(`render failed: ${JSON.stringify(current.error)}`);
          return current.status === 'completed' ? current : null;
        },
        { timeoutMs: 10 * 60_000, everyMs: 2000, what: 'the photoreal render to finish' },
      );
      assert(
        stages.has('avatars'),
        `the render went through the neural stage (${[...stages].join(', ')})`,
      );
      assert(sawEta, 'the API reported a time estimate while rendering');
      videoFile = path.join(OUT, 'photoreal.mp4');
      fs.writeFileSync(videoFile, await download(video.videoUrl));
      const probe = ffprobe(videoFile);
      assertEqual(
        probe.streams
          .map((st) => st.codec_name)
          .sort()
          .join('+'),
        'aac+h264',
        'H.264 + AAC',
      );
      const seconds = Number(probe.format.duration);
      assert(seconds >= 1 && seconds <= 3.5, `the clip lasts about 2 s (${seconds} s)`);
      const tags = JSON.stringify(probe.format.tags ?? {}).toLowerCase();
      assert(
        /ai_generated/.test(tags),
        `the MP4 is marked as AI-generated (${tags.slice(0, 200)})`,
      );
      // Lips: the mouth region (located with the avatar's own landmarks) changes while she speaks.
      const stream = probe.streams.find((st) => st.codec_type === 'video');
      const regions = faceRegions(photoAvatar.rig, layer, stream.width, stream.height);
      const mouth = regionChange(videoFile, regions.mouth);
      const forehead = regionChange(videoFile, regions.forehead);
      // (Measured with real renders: ~35 gray levels when the lips open; a still mouth that only
      // follows the head stays in single digits. The forehead figure is reported for reference:
      // its hair edge makes it a noisy control, so it is not asserted.)
      assert(
        mouth.change > 12,
        `the mouth region changes while she speaks (${mouth.change.toFixed(1)} gray levels)`,
      );
      // Evidence to look at: the frames, and the mouth enlarged frame by frame.
      ffmpeg([
        '-i',
        videoFile,
        '-vf',
        'fps=4,scale=480:-2,tile=4x2',
        '-frames:v',
        '1',
        path.join(OUT, 'photoreal-sheet.png'),
      ]);
      const m = regions.mouth;
      ffmpeg([
        '-i',
        videoFile,
        '-vf',
        `fps=6,crop=${m.w}:${m.h}:${m.x}:${m.y},scale=240:-2,tile=6x2`,
        '-frames:v',
        '1',
        path.join(OUT, 'photoreal-mouth.png'),
      ]);
      const charged = priorCredits - (await credits());
      assertEqual(charged, 2, 'a photoreal render of < 30 s costs 2 credits');
      await page.locator('video').first().waitFor({ timeout: 20_000 });
      // Who made it: the voice of the draft and the engine, with the driver that moved the lips.
      const narrator = stack.voices.find((voice) => voice.id === narratorId);
      assertEqual(video.providers?.tts?.id, narrator.provider.id, 'the video names its voice');
      assertEqual(video.providers?.lipsync?.id, 'local-neural', 'the engine animated the avatar');
      const driver = video.providers.lipsync.mode;
      assert(
        ['audio', 'visemes'].includes(driver),
        `the video says which driver moved the lips (got ${JSON.stringify(driver)})`,
      );
      const driverLine = await settledText(page.getByTestId('lip-driver'), [/Labios guiados/]);
      assert(
        driver === 'audio' ? /por el audio/.test(driverLine) : /por los fonemas/.test(driverLine),
        `the video page says how the lips were driven («${driverLine}»)`,
      );
      // The voice is in the file: speech-level sound between the paddings.
      const level = ffmpegVolume(videoFile);
      assert(level > -40, `the MP4 carries the voice (mean ${level} dB)`);
      return `voz ${narrator.provider.name} (${level} dB) · labios: ${driver} · ${seconds.toFixed(2)} s · ${mouth.frames} fotogramas medidos · etapas ${[...stages].join(' → ')} · cambio en la boca ${mouth.change.toFixed(1)} frente a ${forehead.change.toFixed(1)} en la frente`;
    },
  );

  await step('retrato generado desde una descripción (un retrato)', async () => {
    needsEngine();
    if (process.env.E2E_SKIP_GENERATE) throw new Skip('E2E_SKIP_GENERATE is set');
    const priorCredits = await credits();
    await goto('/avatars/new');
    await page.getByText('Desde una descripción', { exact: true }).click();
    await page
      .getByLabel(/^Descripción/)
      .fill(
        'Mujer de unos 35 años, melena castaña por los hombros, chaqueta azul marino, sonrisa suave, fondo gris neutro de estudio',
      );
    await page
      .getByLabel(/^Nombre/)
      .first()
      .fill(`Generada e2e ${stamp}`);
    const creation = expectResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/photo-avatars/generate' &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Generar avatar', exact: true }).click();
    const response = await creation;
    assertEqual(response.status(), 202, 'POST /api/photo-avatars/generate');
    const created = await response.json();
    assertEqual(await credits(), priorCredits - 8, 'a generated avatar reserves 8 credits');
    await page.getByRole('progressbar').first().waitFor({ timeout: 10_000 });
    let sawEta = false;
    await until(
      async () => {
        const current = await apiGet(`/api/avatars/${created.id}`);
        if (typeof current.etaSec === 'number') sawEta = true;
        if (current.status === 'failed')
          throw new Error(`generation failed: ${JSON.stringify(current.error)}`);
        return current.status === 'ready';
      },
      { timeoutMs: 12 * 60_000, everyMs: 2000, what: 'the generated avatar to be ready' },
    );
    await text('Avatar listo').first().waitFor({ timeout: 20_000 });
    generated = await apiGet(`/api/avatars/${created.id}`);
    assert(
      generated.imageUrl && generated.cutoutUrl,
      'the generated avatar has its portrait and cut-out',
    );
    fs.writeFileSync(path.join(OUT, 'generated-portrait.png'), await download(generated.imageUrl));
    assert(generated.model, 'the avatar says which model generated it');
    assert(sawEta, 'a time estimate was reported while generating');
    assertEqual(await credits(), priorCredits - 8, 'the generated avatar cost 8 credits');
    return `${created.id} · modelo ${generated.model} · calidad ${JSON.stringify(generated.quality)}`;
  });

  await step(
    'los avatares creados aparecen en «Propios» y se pueden borrar sin dejar rastro',
    async () => {
      needsEngine();
      const mine = [photoAvatar, generated].filter(Boolean);
      assert(mine.length > 0, 'at least one avatar was created');
      await goto('/avatars');
      await page.getByRole('tab', { name: /Propios/ }).click();
      for (const avatar of mine) {
        await page.getByRole('button', { name: `Abrir la ficha de ${avatar.name}` }).waitFor();
      }
      for (const avatar of mine) {
        await apiCall('DELETE', `/api/photo-avatars/${avatar.id}`, { expect: 200 });
        assertEqual(
          (await apiCall('GET', `/api/avatars/${avatar.id}`)).status,
          404,
          `${avatar.id} is gone`,
        );
        const left = filesUnder(`ws/${workspaceId}/avatars/${avatar.id}`);
        if (left) assertEqual(left.length, 0, `no files of ${avatar.id} stay on disk`);
        if (DATABASE_URL)
          assertEqual(
            psql(`select count(*) from avatars where id = '${avatar.id}'`),
            '0',
            'avatars row deleted',
          );
      }
    },
  );
}

async function sectionEngineViews() {
  const status = (await apiGet('/api/avatars?limit=1')).engine;

  if (ENGINE) {
    await step('con el motor en marcha las vistas lo dicen y dan cifras medidas', async () => {
      assertEqual(status.available, true, 'the API reports the engine as available');
      await goto('/avatars');
      await text(/Motor neuronal local:/)
        .first()
        .waitFor();
      const strip = await settledText(page.locator('main'), [/en marcha/]);
      assert(/en marcha/.test(strip), 'the library says the engine is running');
      await goto('/avatars/new');
      await text('En marcha').first().waitFor();
      await until(
        async () => page.getByRole('button', { name: 'Crear avatar', exact: true }).count(),
        { what: 'the form' },
      );
      assertEqual(
        await text('El motor no puede preparar fotos ahora').count(),
        0,
        'no engine warning on the form',
      );
    });
    return;
  }

  await step('motor parado: la biblioteca y «crear avatar» lo dicen con claridad', async () => {
    assertEqual(status.available, false, 'the API reports the engine as unavailable');
    assert(status.reasonCode, 'the API gives a stable reason code');
    await goto('/avatars');
    await text(/apagado — los fotorrealistas no se pueden crear ni exportar/)
      .first()
      .waitFor();
    await goto('/avatars/new');
    await text('Apagado', { exact: true }).first().waitFor();
    const reason = page.locator(`[data-engine-reason="${status.reasonCode}"]`);
    await reason.waitFor();
    assert(
      /no hay nada escuchando|no contesta|no tiene configurado|faltan pesos|error interno|no entiende|no ha dicho/.test(
        await reason.innerText(),
      ),
      'the reason is explained in Spanish',
    );
    await text('El motor no puede preparar fotos ahora').first().waitFor();
    const photoSubmit = page.getByRole('button', { name: 'Crear avatar', exact: true });
    assert(await photoSubmit.isDisabled(), 'the photo form cannot be sent');
    await page.getByText('Desde una descripción', { exact: true }).click();
    await text('El motor no puede generar retratos ahora').first().waitFor();
    assert(
      await page.getByRole('button', { name: 'Generar avatar', exact: true }).isDisabled(),
      'the generate form cannot be sent',
    );
    assert(
      /pnpm avatar-engine/.test(await settledText(page.locator('main'), [/pnpm avatar-engine/])),
      'the page says how to start the engine',
    );
  });

  await step('motor parado: la API responde 503 sin cobrar ni dejar nada colgado', async () => {
    const before = await credits();
    const generation = await apiCall('POST', '/api/photo-avatars/generate', {
      body: {
        name: 'No debería crearse',
        prompt: 'Mujer de unos 35 años, melena castaña, chaqueta azul, fondo gris de estudio',
        gender: 'female',
      },
    });
    assertEqual(generation.status, 503, 'generate → 503');
    assertEqual(
      generation.json.error.code,
      'SERVICE_UNAVAILABLE',
      'generate → SERVICE_UNAVAILABLE',
    );
    assert(generation.json.error.details?.reason, 'the 503 carries details.reason');
    const mine = (await apiGet('/api/avatars?limit=100')).items.filter((a) =>
      a.id.startsWith('avt_'),
    );
    assertEqual(
      mine.filter((a) => a.status === 'processing').length,
      0,
      'no avatar is left processing',
    );
    assertEqual(await credits(), before, 'nothing was charged');
    return `details.reason = ${generation.json.error.details.reason}`;
  });

  await step(
    'motor parado: un vídeo con avatar fotorrealista no se encola y la ficha lo avisa',
    async () => {
      const before = await credits();
      await goto('/avatars');
      await page.getByRole('tab', { name: /Fotorrealistas/ }).click();
      await page.getByRole('button', { name: 'Abrir la ficha de Diego' }).click();
      const sheet = page.getByRole('dialog');
      await sheet
        .getByText(/los vídeos con este avatar no se pueden exportar hasta que lo arranques/)
        .waitFor();
      await sheet.getByRole('button', { name: 'Usar en un vídeo' }).click();
      await page.waitForURL(/\/studio\/vid_[a-z0-9]+/, { timeout: 20_000 });
      const videoId = page.url().match(/vid_[a-z0-9]+/)[0];
      await page.locator('canvas').first().waitFor();
      await goto('/avatars');
      const render = await apiCall('POST', `/api/videos/${videoId}/render`, {
        body: { resolution: '720p' },
      });
      assertEqual(render.status, 503, 'render → 503');
      assert(render.json.error.details?.reason, 'the 503 carries details.reason');
      const video = await apiGet(`/api/videos/${videoId}`);
      assertEqual(video.status, 'draft', 'the video stays a draft (no job hanging)');
      assertEqual(await credits(), before, 'nothing was charged');
    },
  );
}

const SECTIONS = [
  ['avatars', 'Biblioteca de avatares', sectionAvatars],
  ['voices', 'Biblioteca de voces', sectionVoices],
  ['script', 'Guionista IA', sectionScriptWriter],
  ['clone', 'Clonado de voz', sectionVoiceClone],
  ['interactive', 'Avatar interactivo', sectionInteractive],
  ['batch', 'Vídeos en lote', sectionBatch],
  ['translate', 'Traducción de vídeo', sectionTranslate],
  ['engine', 'Motor neuronal: estado en las vistas', sectionEngineViews],
  ['photo', 'Avatar fotorrealista (foto y descripción)', sectionPhotoAvatar],
];

/* ------------------------------------------------------------------ main */

// A stray rejection must be reported as a failed run, not kill it half-way (the runner would
// stop the servers under whatever job is still rendering).
process.on('unhandledRejection', (reason) => {
  results.push({
    label: `${currentSection} › (promesa sin atender)`,
    status: 'fail',
    ms: 0,
    detail: String(reason?.message ?? reason),
  });
  log(`  ✗ promesa rechazada sin atender: ${String(reason?.stack ?? reason)}`);
});

async function main() {
  log(
    `Parlante e2e · IA y bibliotecas\n  web:    ${WEB}\n  motor:  ${ENGINE ? 'sí (E2E_ENGINE)' : 'NO — los pasos fotorrealistas se saltan'}\n  salida: ${OUT}`,
  );
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-ES' });
  await context.addInitScript(() => {
    window.__e2eMedia = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function patchedPlay(...args) {
      if (!window.__e2eMedia.includes(this)) window.__e2eMedia.push(this);
      return play.apply(this, args);
    };
  });

  const health = await context.request.get(`${WEB}/health`).catch(() => null);
  if (!health?.ok()) {
    console.error(`The stack does not answer at ${WEB}/health — start web + API + worker first.`);
    process.exit(2);
  }
  const registered = await apiCall('POST', '/api/auth/register', { body: user, expect: 201 });
  workspaceId = registered.json.workspaces[0].id;
  // The walk spends more than the Free plan grants (photo avatar, clone, renders…): switch to
  // Creator through the product's own simulated checkout.
  await apiCall('POST', '/api/billing/change-plan', { body: { planId: 'creator' }, expect: 200 });
  await readVoiceStack();
  const narrator = defaultVoice('es');
  log(
    `  usuario: ${user.email} (plan Creator, ${await credits()} créditos)\n  voz:     ${narrator.name} · ${narrator.provider.name}\n`,
  );
  if (!stack.neural) {
    const lines = [
      'VOCES NEURONALES NO DISPONIBLES en esta pila: se usa la voz de reserva (eSpeak NG).',
      'Las comprobaciones de la voz neuronal SE SALTAN.',
      'Para cubrirlas: `pnpm voices:setup` y no fijar E2E_TTS_PROVIDER (o `auto`).',
    ];
    const width = Math.max(...lines.map((line) => line.length));
    log(`  ╔${'═'.repeat(width + 2)}╗`);
    for (const line of lines) log(`  ║ ${line.padEnd(width)} ║`);
    log(`  ╚${'═'.repeat(width + 2)}╝\n`);
  }

  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource/.test(message.text())) return;
    consoleProblems.push(`[${currentSection}] ${message.text().slice(0, 300)}`);
  });
  page.on('pageerror', (error) =>
    consoleProblems.push(`[${currentSection}] pageerror: ${error.message}`),
  );

  for (const [id, title, run] of SECTIONS) {
    if (ONLY.length > 0 && !ONLY.includes(id)) continue;
    currentSection = id;
    log(`■ ${title}`);
    try {
      await run();
    } catch (err) {
      results.push({
        label: `${id} › (sección)`,
        status: 'fail',
        ms: 0,
        detail: String(err?.message ?? err),
      });
      log(`  ✗ la sección se interrumpió: ${String(err?.stack ?? err)}`);
    }
  }

  currentSection = 'final';
  await step('la consola del navegador no registró errores', async () => {
    assert(
      consoleProblems.length === 0,
      `console errors:\n        ${consoleProblems.join('\n        ')}`,
    );
  });

  await browser.close();
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  log(
    `\nResultado: ${passed} pasos correctos, ${failed.length} fallidos, ${skipped.length} saltados`,
  );
  for (const r of skipped) log(`  ⚠ saltado: ${r.label} — ${r.detail}`);
  for (const r of failed) log(`  ✗ ${r.label}: ${r.detail.split('\n')[0]}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await browser?.close().catch(() => {});
  process.exit(1);
});
