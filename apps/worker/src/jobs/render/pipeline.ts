import {
  AI_GENERATED_METADATA,
  AppError,
  applyVariables,
  parseComposition,
  resolutionAllowed,
  resolutionSize,
  usesPhotorealAvatars,
} from '@parlante/shared';
import type { Provenance, Resolution } from '@parlante/shared';
import { eq, workspaces } from '@parlante/db';
import type { RenderJobRow } from '@parlante/db';
import type { RenderRef } from '@parlante/jobs';
import { clearRenderCaches, computeTimeline, frameToMs, locateScene } from '@parlante/renderer';
import { createFrameRenderer } from '@parlante/renderer/node';
import type { WorkerContext } from '../../context';
import { ffprobe } from '../../lib/ffmpeg';
import type { JobHandle } from '../../lib/job';
import type { RenderOutput } from '../../lib/render-status';
import type { TempDir } from '../../lib/tmp';
import { prepareAvatarClips } from './avatars';
import type { AvatarClips } from './avatars';
import { encodeVideo } from './encode';
import { closeSources, prepareMedia } from './media';
import { mixSoundtrack } from './mix';
import { buildNarrations } from './narration';
import { renderThumbnail, subtitleFiles, uploadOutputs } from './outputs';
import { CancelWatch, LocalFiles, RenderCanceledError, StageProgress } from './run';
import type { RenderRun } from './run';

/* -------------------------------------------------------------------------------------------
 * The render pipeline (ARCHITECTURE §3.2 / §3.3): snapshot → MP4 + thumbnail + SRT/VTT.
 *
 *   prepare   files of the snapshot → images, video frame sources, audio paths
 *   audio     narration + runtime per scene (shared TTS cache), timeline, soundtrack mix
 *   avatars   neural clips of photorealistic avatar layers (clip cache → engine)
 *   frames    renderFrame for every frame, piped as RGBA into ffmpeg
 *   encode    ffmpeg closes the MP4 (H.264 yuv420p + AAC, +faststart)
 *   finalize  thumbnail, subtitles, upload
 *
 * It only PRODUCES the outputs; the terminal state of the job (credits, webhooks) is written
 * by the handler through lib/render-status.
 * ----------------------------------------------------------------------------------------- */

export interface RenderStats {
  frames: number;
  /** Seconds of video. */
  videoSec: number;
  /** Wall-clock seconds: whole pipeline / drawing + encoding only. */
  totalSec: number;
  exportSec: number;
  /** Export speed relative to real time (`videoSec / exportSec`). */
  realtime: number;
  clipsAnimated: number;
  clipsCached: number;
}

export interface RenderResult {
  output: RenderOutput;
  stats: RenderStats;
}

/** The plan may have changed since the render was queued: never export above its limit. */
async function effectiveResolution(
  ctx: WorkerContext,
  ref: RenderRef,
  requested: Resolution,
): Promise<Resolution> {
  const [workspace] = await ctx.db
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, ref.workspaceId));
  if (!workspace) throw new AppError('NOT_FOUND', 'Workspace not found');
  return resolutionAllowed(workspace.plan, requested) ? requested : '720p';
}

export async function renderVideo(
  ctx: WorkerContext,
  job: Pick<JobHandle<'render'>, 'payload' | 'signal' | 'log' | 'progress'>,
  row: Pick<RenderJobRow, 'composition' | 'resolution' | 'watermark'>,
  tmp: TempDir,
): Promise<RenderResult> {
  const ref = job.payload;
  const startedAt = performance.now();
  // The snapshot is concrete already (`startRender` applied the variables); applying the
  // declared defaults again guarantees no `{{placeholder}}` can ever reach a frame.
  const composition = applyVariables(parseComposition(row.composition), {});
  const photoreal = usesPhotorealAvatars(composition);
  const resolution = await effectiveResolution(ctx, ref, row.resolution);
  const size = resolutionSize(composition.canvas.aspect, resolution);

  const cancel = new CancelWatch(ctx, ref);
  const run: RenderRun = {
    ctx,
    ref,
    log: job.log,
    tmp,
    files: new LocalFiles(ctx.providers.storage, tmp),
    signal: AbortSignal.any([job.signal, cancel.signal]),
    cancel,
    progress: new StageProgress(ctx, job, ref, photoreal),
  };
  const { progress } = run;
  const closers: (() => Promise<void>)[] = [];
  cancel.start();
  try {
    /* ---- prepare ---- */
    await cancel.check();
    await progress.begin('prepare');
    const media = await prepareMedia(run, composition, size);
    closers.push(() => closeSources(media.sources));

    /* ---- audio ---- */
    await cancel.check();
    await progress.begin('audio');
    const narrations = await buildNarrations(run, composition, media);
    const { runtime } = narrations;
    const timeline = computeTimeline(composition, runtime);
    const soundtrackPath = tmp.file('soundtrack.wav');
    await mixSoundtrack(run, {
      composition,
      timeline,
      narrations: narrations.byScene,
      audio: media.audio,
      video: media.video,
      envelopePath: tmp.file('music-gain.f32'),
      outputPath: soundtrackPath,
    });

    /* ---- avatars (photorealistic only) ---- */
    await cancel.check();
    let clips: AvatarClips | null = null;
    if (photoreal) {
      await progress.begin('avatars');
      clips = await prepareAvatarClips(run, {
        composition,
        timeline,
        runtime,
        narrations: narrations.byScene,
        assets: media.assets,
        size,
      });
      closers.push(clips.close);
    }

    /* ---- frames + encode ---- */
    await cancel.check();
    await progress.begin('frames');
    // Before the sequential pass: afterwards the decoders of the first scene are closed.
    const thumbnail = await renderThumbnail({
      composition,
      runtime,
      assets: media.assets,
      timeline,
      ...size,
      watermark: row.watermark,
    });
    const frames = createFrameRenderer({
      composition,
      runtime,
      assets: media.assets,
      timeline,
      ...size,
      watermark: row.watermark,
    });
    const videoPath = tmp.file('video.mp4');
    const exportStartedAt = performance.now();
    const encoded = await encodeVideo({
      frames,
      soundtrackPath,
      outputPath: videoPath,
      metadata: photoreal ? AI_GENERATED_METADATA : undefined,
      signal: run.signal,
      onFrame: async (done, total) => {
        cancel.throwIfCanceled();
        if (done % 5 !== 0 && done !== total) return;
        if (clips) {
          // A scene is still drawn (frozen) under the transition into the next one.
          const next = locateScene(timeline, frameToMs(done, timeline.fps));
          const inTransition = next.localMs < next.timing.transitionMs;
          await clips.releaseBefore(next.timing.index - (inTransition ? 1 : 0));
        }
        const elapsedSec = (performance.now() - exportStartedAt) / 1000;
        await progress.update('frames', done / total, ((total - done) * elapsedSec) / done + 1);
      },
      onFramesDone: () => progress.begin('encode', 1),
    });
    const info = await ffprobe(videoPath, { signal: run.signal });
    if (!info.hasVideo || !info.hasAudio) {
      throw new AppError('INTERNAL', 'The encoder produced an incomplete video file');
    }

    /* ---- finalize ---- */
    await cancel.check();
    await progress.begin('finalize');
    const subtitles = subtitleFiles(composition, runtime, timeline);
    const keys = await uploadOutputs(ctx, ref, {
      videoPath,
      thumbnail,
      srt: subtitles.srt,
      vtt: subtitles.vtt,
    });

    const providers: Provenance = {};
    if (narrations.ttsProvider) providers.tts = narrations.ttsProvider;
    if (clips?.provider) providers.lipsync = clips.provider;
    const videoSec = timeline.totalMs / 1000;
    const exportSec = encoded.totalMs / 1000;
    return {
      output: { durationMs: Math.round(timeline.totalMs), resolution, ...keys, providers },
      stats: {
        frames: encoded.frames,
        videoSec,
        totalSec: (performance.now() - startedAt) / 1000,
        exportSec,
        realtime: exportSec > 0 ? videoSec / exportSec : 0,
        clipsAnimated: clips?.animated ?? 0,
        clipsCached: clips?.cached ?? 0,
      },
    };
  } catch (err) {
    // Whatever broke while a cancellation was killing ffmpeg / the engine job is not a failure.
    if (cancel.canceled) throw new RenderCanceledError();
    throw err;
  } finally {
    cancel.stop();
    for (const close of closers.reverse()) await close().catch(() => undefined);
    // Decoded images of this video must not outlive it in the renderer's raster cache.
    clearRenderCaches();
  }
}
