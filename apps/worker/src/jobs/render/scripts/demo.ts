/**
 * Render a demo video through the REAL render job (startRender → job handler → outputs) with
 * the local providers, on a throw-away database and storage, and copy the outputs out.
 * Used to exercise the job by hand and to measure export speed.
 *
 *   pnpm --filter @parlante/worker exec tsx src/jobs/render/scripts/demo.ts \
 *     --out /tmp/demo [--aspect 16:9|9:16|1:1] [--resolution 720p|1080p] [--plan free|creator]
 *     [--avatar stock_lucia|real_…] [--short "text"] [--repeat N] [--no-music]
 *
 * `--short` renders one short scene instead of the three-scene demo (use it with photoreal
 * avatars: the neural engine needs about a second of CPU per frame). `--repeat N` renders the
 * same video N times in a row (the second run shows the caches at work).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { newId } from '@parlante/shared';
import type { AspectRatio, PlanId, Resolution } from '@parlante/shared';
import { creditLedger, eq, getCreditBalance, renderJobs, videos } from '@parlante/db';
import { createTestDatabase, seedAccount } from '@parlante/db/testing';
import { startRender } from '@parlante/jobs';
import { createTestWorker } from '../../../testing/index';
import renderJob from '../index';
import { demoComposition, shortComposition } from '../testing/fixtures';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const outDir = path.resolve(option('out') ?? path.join(os.tmpdir(), 'parlante-render-demo'));
  const aspect = (option('aspect') ?? '16:9') as AspectRatio;
  const resolution = (option('resolution') ?? '720p') as Resolution;
  const plan = (option('plan') ?? 'free') as PlanId;
  const avatarId = option('avatar') ?? 'stock_lucia';
  const short = option('short');
  const repeat = Math.max(1, Number(option('repeat') ?? 1));
  const music = process.argv.includes('--no-music') ? null : undefined;
  await fs.mkdir(outDir, { recursive: true });

  const database = await createTestDatabase();
  process.env.DATABASE_URL = database.url;
  process.env.PARLANTE_TEST_DATABASE = database.name;
  const t = await createTestWorker({ LOG_LEVEL: 'silent' });
  // The job logs its measured speed ("render completed"): capture it for the report below.
  const completed: Record<string, unknown>[] = [];
  t.ctx.logger = pino(
    { level: 'info' },
    {
      write(line: string) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.msg === 'render completed') completed.push(entry);
      },
    },
  );
  try {
    const { workspace, user } = await seedAccount(t.ctx.db, { plan, credits: 100 });
    const composition =
      short !== undefined
        ? shortComposition({ aspect, avatarId, text: short })
        : demoComposition({ aspect, avatarId, music });
    for (let round = 1; round <= repeat; round += 1) {
      const videoId = newId('video');
      await t.ctx.db.insert(videos).values({
        id: videoId,
        workspaceId: workspace.id,
        title: 'Demo',
        composition,
        aspect,
        createdBy: user.id,
      });
      const started = await startRender(
        { db: t.ctx.db, queues: t.queues, providers: t.ctx.providers },
        { workspaceId: workspace.id, videoId, resolution, createdBy: user.id },
      );
      const ref = { renderJobId: started.renderJob.id, videoId, workspaceId: workspace.id };
      const load = os.loadavg();
      const cpu = process.cpuUsage();
      const t0 = performance.now();
      const stages: string[] = [];
      const poll = setInterval(() => {
        void t.ctx.db
          .select({
            stage: renderJobs.stage,
            progress: renderJobs.progress,
            etaSec: renderJobs.etaSec,
          })
          .from(renderJobs)
          .where(eq(renderJobs.id, ref.renderJobId))
          .then(([row]) => {
            if (row) stages.push(`${row.stage ?? '-'}:${row.progress}%/eta ${row.etaSec ?? '-'}`);
          })
          .catch(() => undefined);
      }, 1000);
      let result;
      try {
        ({ result } = await t.run(renderJob, ref));
      } finally {
        clearInterval(poll);
      }
      const wallSec = (performance.now() - t0) / 1000;
      const used = process.cpuUsage(cpu);
      if ('canceled' in result) throw new Error('The render was cancelled');
      const tag = `${aspect.replace(':', 'x')}-${result.resolution}${repeat > 1 ? `-r${round}` : ''}`;
      for (const [key, name] of [
        [result.videoKey, `${tag}.mp4`],
        [result.thumbnailKey, `${tag}.jpg`],
        [result.srtKey, `${tag}.srt`],
        [result.vttKey, `${tag}.vtt`],
      ] as const) {
        await fs.writeFile(path.join(outDir, name), await t.ctx.providers.storage.get(key));
      }
      const [row] = await t.ctx.db
        .select()
        .from(renderJobs)
        .where(eq(renderJobs.id, ref.renderJobId));
      const ledger = await t.ctx.db
        .select({ delta: creditLedger.delta, reason: creditLedger.reason })
        .from(creditLedger)
        .where(eq(creditLedger.refId, ref.renderJobId));
      const videoSec = result.durationMs / 1000;
      console.log(
        JSON.stringify(
          {
            round,
            out: path.join(outDir, `${tag}.mp4`),
            resolution: result.resolution,
            videoSec,
            wallSec: Number(wallSec.toFixed(2)),
            realtimeOverall: Number((videoSec / wallSec).toFixed(2)),
            nodeCpuSec: Number(((used.user + used.system) / 1e6).toFixed(2)),
            peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
            loadAvgBefore: load.map((v) => Number(v.toFixed(2))),
            loadAvgAfter: os.loadavg().map((v) => Number(v.toFixed(2))),
            measuredByJob: (({ frames, exportSec, realtime, clipsAnimated, clipsCached }) => ({
              frames,
              exportSec,
              realtime,
              clipsAnimated,
              clipsCached,
            }))(completed.at(-1) ?? {}),
            providers: result.providers,
            job: { status: row?.status, progress: row?.progress, credits: row?.creditsCharged },
            ledger,
            balance: await getCreditBalance(t.ctx.db, workspace.id),
            webhookDeliveriesQueued: t.queues.jobs('webhookDelivery').length,
            progressSeen: stages,
          },
          null,
          1,
        ),
      );
    }
  } finally {
    await t.close();
    await database.drop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
