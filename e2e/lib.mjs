// Shared helpers of the end-to-end scripts (see scripts/e2e.sh). Playwright is used as a
// library — no test runner, no extra dependencies — and nothing intercepts the network: the
// browser talks to the real web app, API and worker that scripts/e2e.sh started.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const run = promisify(execFile);

export const WEB_URL = (process.env.E2E_WEB_URL ?? 'http://127.0.0.1:5211').replace(/\/+$/, '');
export const API_URL = (process.env.E2E_API_URL ?? 'http://127.0.0.1:4211').replace(/\/+$/, '');
export const HOOK_PORT = Number(process.env.E2E_HOOK_PORT ?? 4261);
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
export const ARTIFACTS_DIR = path.resolve(process.env.E2E_ARTIFACTS_DIR ?? 'e2e-artifacts');
export const PASSWORD = 'Cabina-de-prueba-2468';

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

/** Playwright from wherever the machine has it (workspace, NODE_PATH or PLAYWRIGHT_MODULE). */
export function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/opt/node-tools/node_modules/playwright',
  ];
  for (const id of candidates) {
    if (!id) continue;
    try {
      return require(id);
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Playwright is not installed. Set PLAYWRIGHT_MODULE to its directory.');
}

/* ---------- reporting ---------- */

let checks = 0;
const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;

export function log(message) {
  console.log(`[${stamp()}] ${message}`);
}

/** One assertion with a readable line in the output. Throws (and stops the run) when false. */
export function check(name, condition, detail = '') {
  checks += 1;
  if (!condition) {
    console.log(`[${stamp()}]   ✘ ${name}${detail ? ` — ${detail}` : ''}`);
    assert.fail(`${name}${detail ? ` — ${detail}` : ''}`);
  }
  console.log(`[${stamp()}]   ✔ ${name}${detail ? ` — ${detail}` : ''}`);
}

export function checkEqual(name, actual, expected) {
  check(
    name,
    Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)}${Object.is(actual, expected) ? '' : ` (expected ${JSON.stringify(expected)})`}`,
  );
}

export const checkCount = () => checks;

export async function section(title, fn) {
  const t0 = Date.now();
  console.log(`\n[${stamp()}] ━━ ${title}`);
  await fn();
  console.log(`[${stamp()}] ── ${title}: ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

/** Poll until `fn` returns something truthy. */
export async function until(description, fn, { timeoutMs = 30_000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      const why = last instanceof Error ? last.message : JSON.stringify(last);
      assert.fail(`timed out after ${timeoutMs} ms waiting for ${description} (last: ${why})`);
    }
    await sleep(everyMs);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function uniqueEmail(tag = 'user') {
  const random = crypto.randomBytes(5).toString('hex');
  return `e2e-${tag}-${random}@example.test`;
}

/* ---------- browser ---------- */

/**
 * A browser context like a first-time visitor's: Spanish UI, desktop viewport, downloads on.
 * Console errors and failed requests are collected so a run can assert there were none it did
 * not expect.
 */
export async function newSession(browser, { name, viewport = { width: 1440, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport, locale: 'es-ES', acceptDownloads: true });
  // Tap everything the page sends to its speakers, so a test can tell silence from sound.
  await context.addInitScript(() => {
    const taps = [];
    window.__e2eAudioTaps = taps;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function patched(target, ...rest) {
      try {
        if (
          target instanceof AudioDestinationNode &&
          !(target.context instanceof OfflineAudioContext)
        ) {
          let tap = taps.find((t) => t.context === target.context);
          if (!tap) {
            tap = target.context.createAnalyser();
            tap.fftSize = 2048;
            taps.push(tap);
          }
          connect.call(this, tap);
        }
      } catch {
        // Never break the page because of the probe.
      }
      return connect.call(this, target, ...rest);
    };
    window.__e2eAudioLevel = () => {
      let peak = 0;
      for (const tap of taps) {
        const data = new Float32Array(tap.fftSize);
        tap.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        peak = Math.max(peak, Math.sqrt(sum / data.length));
      }
      return peak;
    };
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    problems.push(`console: ${message.text().slice(0, 300)} @ ${message.location().url ?? ''}`);
  });
  page.setDefaultTimeout(20_000);
  return { name: name ?? 'session', context, page, problems };
}

/** Screenshot + accessibility tree of where a session is, for the failure report. */
export async function dumpPage(session, label) {
  try {
    const base = path.join(ARTIFACTS_DIR, `fail-${label}-${session.name}`);
    await session.page.screenshot({ path: `${base}.png` });
    fs.writeFileSync(
      `${base}.txt`,
      `${session.page.url()}\n\n${await session.page.locator('body').ariaSnapshot()}`,
    );
    log(`   saved ${base}.png / .txt`);
  } catch (err) {
    log(`   could not dump the page: ${err instanceof Error ? err.message : err}`);
  }
}

/** Register a brand-new account through the form. Ends on the dashboard. */
export async function registerThroughUi(page, { name, email, path: start = '/register' }) {
  await page.goto(`${WEB_URL}${start}`);
  await page.getByLabel('Nombre').fill(name);
  await page.getByLabel('Correo electrónico').fill(email);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/register'));
}

/** JSON call to the API with the session cookie of a browser context (same origin as the web). */
export async function apiCall(context, method, route, body) {
  const response = await context.request.fetch(`${WEB_URL}${route}`, {
    method,
    headers: {
      origin: WEB_URL,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    data: body === undefined ? undefined : JSON.stringify(body),
    failOnStatusCode: false,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON (files).
  }
  return { status: response.status(), json, text, headers: response.headers() };
}

/** Credits of the active workspace, as the API reports them. */
export async function creditsOf(context) {
  return (await workspaceOf(context)).credits;
}

/** The active workspace of a session (id, plan, role, credits). */
export async function workspaceOf(context) {
  const me = await apiCall(context, 'GET', '/api/auth/me');
  assert.equal(me.status, 200, `GET /api/auth/me → ${me.status}`);
  return me.json.workspaces.find((w) => w.id === me.json.currentWorkspaceId);
}

/* ---------- database fixtures ---------- */

/**
 * The only thing these scripts write to the database directly: leaving a workspace with
 * `leave` credits. There is no product action that burns credits without rendering for
 * minutes, so the "no balance" case is arranged here — through the ledger, like the app does
 * (a manual `adjustment` entry and the matching balance), never by faking an API response.
 */
export async function leaveCredits(workspaceId, leave) {
  if (!DATABASE_URL) throw new Error('E2E_DATABASE_URL is not set (run through scripts/e2e.sh)');
  const dbRequire = createRequire(new URL('../packages/db/package.json', import.meta.url));
  const pg = dbRequire('pg');
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT credits FROM workspaces WHERE id = $1 FOR UPDATE', [
      workspaceId,
    ]);
    assert.equal(rows.length, 1, `workspace ${workspaceId} not found`);
    const delta = leave - rows[0].credits;
    if (delta !== 0) {
      const id = `led_${crypto.randomBytes(8).toString('hex')}`;
      await client.query('UPDATE workspaces SET credits = $2 WHERE id = $1', [workspaceId, leave]);
      await client.query(
        `INSERT INTO credit_ledger (id, workspace_id, delta, balance_after, reason, description)
         VALUES ($1, $2, $3, $4, 'adjustment', 'e2e fixture: balance set for the no-credit case')`,
        [id, workspaceId, delta, leave],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/* ---------- media ---------- */

export async function ffprobe(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(stdout);
}

/** Top-level MP4 boxes in file order (`moov` before `mdat` = faststart). */
export function mp4Boxes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const boxes = [];
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size) {
      fs.readSync(fd, header, 0, 16, offset);
      let length = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      if (length === 0) length = size - offset;
      boxes.push(type);
      if (length < 8) break;
      offset += length;
    }
    return boxes;
  } finally {
    fs.closeSync(fd);
  }
}

/** One video frame at `seconds`, scaled to width×height: { rgb: Buffer, png: path }. */
export async function extractFrame(file, seconds, width, height, pngPath) {
  const args = [
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-ss',
    seconds.toFixed(3),
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:${height}:flags=area`,
  ];
  await run('ffmpeg', [...args, pngPath]);
  const { stdout } = await run(
    'ffmpeg',
    [...args, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return { rgb: stdout, png: pngPath };
}

/** Mean volume (dB) of [startSec, startSec+durationSec) of a media file. */
export async function meanVolumeDb(file, startSec, durationSec) {
  const { stderr } = await run('ffmpeg', [
    '-v',
    'info',
    '-ss',
    String(startSec),
    '-t',
    String(durationSec),
    '-i',
    file,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (!match) throw new Error(`volumedetect gave no result for ${file}`);
  return match[1] === '-inf' ? -Infinity : Number(match[1]);
}

/**
 * Compare two RGB24 buffers of the same size. Returns the mean absolute difference per channel
 * (0–255) and the share of pixels whose largest channel difference exceeds `tolerance`.
 */
export function compareRgb(a, b, tolerance = 40) {
  assert.equal(a.length, b.length, 'frames must have the same size');
  let sum = 0;
  let far = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d0 = Math.abs(a[i] - b[i]);
    const d1 = Math.abs(a[i + 1] - b[i + 1]);
    const d2 = Math.abs(a[i + 2] - b[i + 2]);
    sum += d0 + d1 + d2;
    if (Math.max(d0, d1, d2) > tolerance) far += 1;
  }
  return { meanAbs: sum / a.length, farShare: far / (a.length / 3) };
}

export { assert, fs, path, run };
