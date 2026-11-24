// Render performance on the real stack: how long a 30 s video with a 2D avatar takes at 720p
// and 1080p, and the peak memory of the worker while it renders.
//
//   bash scripts/e2e.sh e2e/perf.mjs
//
// It talks to the API only (no browser): the thing measured is the worker. The video is the
// built-in "explainer" template (4 scenes: avatar, texts, shapes, image backgrounds, music,
// transitions, burnt-in subtitles) with every scene fixed to 7.5 s. Memory is the resident set
// of the worker process tree, sampled from /proc every 200 ms: the Node process alone, and
// Node + its ffmpeg children.
import fs from 'node:fs';
import os from 'node:os';
import {
  API_URL,
  WEB_URL,
  PASSWORD,
  assert,
  ffprobe,
  loadPlaywright,
  log,
  path,
  sleep,
  uniqueEmail,
  ARTIFACTS_DIR,
} from './lib.mjs';

const WORKER_PID = Number(process.env.E2E_WORKER_PID ?? 0);
const TARGET_SECONDS = 30;

/** Resident memory (kB) of every process in the worker's session: { node, total }. */
function workerMemory() {
  let node = 0;
  let total = 0;
  if (!WORKER_PID) return { node, total };
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // pid (comm) state ppid pgrp session …
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[3]) !== WORKER_PID) continue; // session id = pid of the setsid leader
      const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8');
      const rss = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0);
      const comm = /^Name:\s+(.+)$/m.exec(status)?.[1] ?? '';
      total += rss;
      if (/^(node|tsx|MainThread)/.test(comm)) node += rss;
    } catch {
      // The process ended between the listing and the read.
    }
  }
  return { node, total };
}

const { request } = loadPlaywright();
const api = await request.newContext({ baseURL: WEB_URL, extraHTTPHeaders: { origin: WEB_URL } });

async function call(method, route, data) {
  const response = await api.fetch(route, { method, data, failOnStatusCode: false });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  assert.ok(
    response.status() < 400,
    `${method} ${route} → ${response.status()} ${text.slice(0, 300)}`,
  );
  return json;
}

async function renderOnce(videoId, resolution, label) {
  const loadBefore = os.loadavg()[0];
  const peak = { node: 0, total: 0 };
  const idle = workerMemory();
  const started = Date.now();
  await call('POST', `/api/videos/${videoId}/render`, { resolution });
  let video;
  for (;;) {
    const now = workerMemory();
    peak.node = Math.max(peak.node, now.node);
    peak.total = Math.max(peak.total, now.total);
    if ((Date.now() - started) % 1000 < 200) {
      video = await call('GET', `/api/videos/${videoId}`);
      if (video.status === 'completed') break;
      assert.notEqual(video.status, 'failed', `render failed: ${JSON.stringify(video.error)}`);
    }
    await sleep(200);
  }
  const wallMs = Date.now() - started;
  const jobs = (await call('GET', `/api/videos/${videoId}/render-jobs`)).items;
  const job = jobs.find((j) => j.status === 'completed' && j.resolution === resolution) ?? jobs[0];
  const jobMs =
    job.startedAt && job.finishedAt ? new Date(job.finishedAt) - new Date(job.startedAt) : null;
  const file = path.join(ARTIFACTS_DIR, `perf-${label}.mp4`);
  const mp4 = await api.get(video.videoUrl.replace(API_URL, WEB_URL));
  fs.writeFileSync(file, await mp4.body());
  const probe = await ffprobe(file);
  const stream = probe.streams.find((s) => s.codec_type === 'video');
  const seconds = Number(probe.format.duration);
  fs.rmSync(file);
  return {
    label,
    resolution: `${stream.width}×${stream.height}`,
    seconds,
    wallMs,
    jobMs,
    speed: seconds / ((jobMs ?? wallMs) / 1000),
    idleNodeMb: idle.node / 1024,
    peakNodeMb: peak.node / 1024,
    peakTotalMb: peak.total / 1024,
    load: `${loadBefore.toFixed(1)}→${os.loadavg()[0].toFixed(1)}`,
    credits: job.creditsCharged,
  };
}

await call('POST', '/api/auth/register', {
  name: 'Rita Rendimiento',
  email: uniqueEmail('perf'),
  password: PASSWORD,
});
await call('POST', '/api/billing/change-plan', { planId: 'creator' });
const created = await call('POST', '/api/videos', {
  title: 'Rendimiento 30 s',
  templateId: 'builtin_explainer',
});
const composition = created.composition;
const perScene = TARGET_SECONDS / composition.scenes.length;
for (const scene of composition.scenes) scene.duration = { mode: 'fixed', seconds: perScene };
const saved = await call('PATCH', `/api/videos/${created.id}`, {
  composition,
  baseRevision: created.revision,
});
log(
  `vídeo ${saved.id}: ${composition.scenes.length} escenas × ${perScene} s, avatar ${composition.scenes[0].layers.find((l) => l.type === 'avatar')?.avatarId}, música ${composition.music?.src?.stockId}, subtítulos ${composition.subtitles.enabled}`,
);
log(
  `máquina: ${os.cpus().length} núcleos, carga ${os
    .loadavg()
    .map((n) => n.toFixed(2))
    .join(' ')}, worker pid ${WORKER_PID || '(desconocido: sin medida de memoria)'}`,
);

const results = [];
results.push(await renderOnce(saved.id, '720p', '720p-frio'));
results.push(await renderOnce(saved.id, '720p', '720p'));
results.push(await renderOnce(saved.id, '1080p', '1080p'));
results.push(await renderOnce(saved.id, '1080p', '1080p-2'));

console.log(
  '\nrender                 vídeo    pared    job      × real   RSS node (reposo→pico)   RSS node+ffmpeg   carga      créditos',
);
for (const r of results) {
  console.log(
    `${r.label.padEnd(10)} ${r.resolution.padEnd(10)} ${r.seconds.toFixed(2).padStart(6)} s ${(r.wallMs / 1000).toFixed(1).padStart(6)} s ${(r.jobMs === null ? '—' : (r.jobMs / 1000).toFixed(1)).padStart(6)} s ${r.speed.toFixed(2).padStart(6)}×   ${r.idleNodeMb.toFixed(0).padStart(5)} → ${r.peakNodeMb.toFixed(0).padStart(5)} MB        ${r.peakTotalMb.toFixed(0).padStart(6)} MB        ${r.load.padEnd(10)} ${r.credits}`,
  );
}
for (const r of results) {
  assert.ok(
    Math.abs(r.seconds - TARGET_SECONDS) < 0.2,
    `${r.label}: the video should last ${TARGET_SECONDS} s, got ${r.seconds}`,
  );
}
await api.dispose();
console.log('\n✔ e2e/perf.mjs');
