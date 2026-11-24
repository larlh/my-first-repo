import fs from 'node:fs/promises';
import {
  AppError,
  SubtitleStyleSchema,
  TranslationOptionsSchema,
  formatSrt,
  formatVtt,
  toStoredError,
} from '@parlante/shared';
import type {
  LanguageCode,
  Provenance,
  SubtitleStyle,
  TimedText,
  TranslationOptions,
  TranslationStage,
} from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, assets, eq } from '@parlante/db';
import type { TranslationJobRow, TranslationOutputRow } from '@parlante/db';
import type { WorkerContext } from '../../context';
import { ffprobe } from '../../lib/ffmpeg';
import { defineJob } from '../../lib/job';
import type { JobHandle } from '../../lib/job';
import { scale, throttled } from '../../lib/progress';
import { withTempDir } from '../../lib/tmp';
import type { TempDir } from '../../lib/tmp';
import { buildDubTrack, dubSegments } from './dub';
import { burnFrameSize, inspectSource, mixDubbedVideo } from './mix';
import type { SourceVideo } from './mix';
import {
  finishTranslation,
  isTranslationActive,
  loadTranslation,
  markOutputCompleted,
  markOutputFailed,
  markOutputProcessing,
  markTranslationStarted,
  reportTranslationProgress,
  saveOutputSegments,
  saveProvenance,
  saveTranscript,
} from './status';
import type { LoadedTranslation, TranslationRef } from './status';
import { dubSubtitleCues, plainCues, renderSubtitleOverlay } from './subtitles';
import { tidySegments, transcribeSource } from './transcript';

/* -------------------------------------------------------------------------------------------
 * Video translation (feature 12). The API validated the request, charged
 * `creditsForTranslation(duration, targets)` (ledger ref `translationJob`) and inserted the
 * job with one output row per target language. This job, per ARCHITECTURE §4:
 *
 *   transcribing  transcript of the user, or audio → `providers.stt` (then moderated)
 *   per target language, one after another (a language that fails does not stop the rest):
 *     translating   `providers.translation.translate` segment by segment (timings kept)
 *     dubbing       `synthesizeCached` per segment, fitted to the slot of the original (./dub)
 *     mixing        dub track + original audio (attenuated, or replaced when the volume is 0)
 *                   over the original picture; subtitles painted with `drawSubtitleCue` when
 *                   `burnSubtitles` (./subtitles, ./mix)
 *     finalizing    video.mp4 + subtitles.srt + subtitles.vtt → `storageKeys.translationOutput`
 *
 * Stage and progress are persisted on the job row, the state of each language on its output
 * row. At the end `finishTranslation` (./status) closes the job as `completed`, `partial`
 * (credits settled to the languages that completed) or `failed` (everything refunded).
 *
 * Idempotent: languages already `completed` are skipped on a re-run and narrations come from
 * the TTS cache. Deleting the job in the API cancels it: the job notices between steps,
 * removes what it wrote and ends quietly.
 * ----------------------------------------------------------------------------------------- */

type Job = JobHandle<'translation'>;

/** Share of the progress bar: transcription, then every language splits the rest evenly. */
const TRANSCRIBE_END = 8;
const LANGUAGE_STAGES = {
  translating: [0, 0.06],
  dubbing: [0.06, 0.5],
  mixing: [0.5, 0.94],
  finalizing: [0.94, 1],
} as const satisfies Record<Exclude<TranslationStage, 'transcribing'>, readonly [number, number]>;

/** How often (in dubbed segments) a long dubbing stage looks for a cancellation. */
const CANCEL_CHECK_EVERY = 8;
/** A dubbed video whose length differs more than this from its source is not published. */
const DURATION_TOLERANCE_MS = 1500;

/** The user deleted (= cancelled) the job while it was running. Not a failure. */
class TranslationCanceled extends Error {
  constructor() {
    super('The translation was cancelled');
    this.name = 'TranslationCanceled';
  }
}

interface Run {
  ctx: WorkerContext;
  job: Job;
  ref: TranslationRef;
  row: TranslationJobRow;
  options: TranslationOptions;
  style: SubtitleStyle;
  tmp: TempDir;
  source: SourceVideo;
  segments: TimedText[];
  provenance: Provenance;
  /** Throws when the worker is shutting down or the job was cancelled. */
  checkpoint(): Promise<void>;
  /**
   * A language enters a stage: written to the row at once (never throttled away), so the
   * stage the user sees is always the one that is running.
   */
  enter(
    stage: Exclude<TranslationStage, 'transcribing'>,
    index: number,
    language: LanguageCode,
  ): Promise<void>;
  /** Progress inside a stage (fraction 0..1), persisted at most once per second. */
  report(
    stage: Exclude<TranslationStage, 'transcribing'>,
    fraction: number,
    index: number,
    language: LanguageCode,
  ): void;
  flush(): Promise<void>;
}

function summary(loaded: LoadedTranslation) {
  return {
    translationJobId: loaded.job.id,
    completedLanguages: loaded.outputs
      .filter((o) => o.status === 'completed')
      .map((o) => o.language),
    failedLanguages: loaded.outputs.filter((o) => o.status === 'failed').map((o) => o.language),
  };
}

/** Local path of the source video (zero-copy on local storage, downloaded otherwise). */
async function sourcePath(
  ctx: WorkerContext,
  row: TranslationJobRow,
  tmp: TempDir,
): Promise<string> {
  const [asset] = await ctx.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, row.sourceAssetId), eq(assets.workspaceId, row.workspaceId)));
  if (!asset) throw new AppError('UNPROCESSABLE', 'The video to translate no longer exists');
  if (asset.kind !== 'video') {
    throw new AppError('UNPROCESSABLE', 'The file to translate must be a video');
  }
  const local = ctx.providers.storage.localPath(asset.storageKey);
  if (local) return local;
  await ctx.providers.storage.downloadTo(asset.storageKey, tmp.file('source.bin'));
  return tmp.file('source.bin');
}

/** Translate → dub → mix → store ONE language. Throws to fail just this language. */
async function processLanguage(
  run: Run,
  output: TranslationOutputRow,
  index: number,
): Promise<void> {
  const { ctx, job, ref, row, tmp, source } = run;
  const language = output.language;
  const totalMs = source.durationMs;
  const { storage } = ctx.providers;

  /* ---- translating ---- */
  await markOutputProcessing(ctx, ref, output.id);
  await run.enter('translating', index, language);
  const translation = await ctx.providers.translation.translate({
    texts: run.segments.map((segment) => segment.text),
    sourceLanguage: row.sourceLanguage,
    targetLanguage: language,
    context: row.name,
  });
  if (translation.texts.length !== run.segments.length) {
    throw new AppError(
      'PROVIDER_ERROR',
      'The translation provider returned a different number of segments',
      {
        expected: run.segments.length,
        received: translation.texts.length,
      },
    );
  }
  const translated: TimedText[] = run.segments.map((segment, i) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: (translation.texts[i] ?? '').replace(/\s+/g, ' ').trim(),
  }));
  // Moderated AGAIN, in the target language: this is the text that will be spoken and burned
  // in, and a transcript that passed in its own language can become blocked content once it
  // is translated. Failing here fails only this language; nothing of it is stored or dubbed.
  const verdict = await ctx.providers.moderation.check({
    text: translated.map((segment) => segment.text).join('\n'),
    language,
    context: 'translation',
  });
  if (!verdict.allowed) {
    throw new AppError('CONTENT_BLOCKED', 'The translated text was blocked by moderation', {
      field: 'translation',
      language,
      flags: verdict.flags,
    });
  }
  await saveOutputSegments(ctx, ref, output.id, translated);
  run.provenance.translation = translation.provider;
  if (typeof translation.coverage === 'number' && translation.coverage < 0.6) {
    job.log.warn(
      { language, coverage: translation.coverage, provider: translation.provider.id },
      'basic translation left most words untranslated',
    );
  }
  run.report('translating', 1, index, language);
  await run.checkpoint();

  /* ---- dubbing ---- */
  await run.enter('dubbing', index, language);
  let dubbedCount = 0;
  const dub = await dubSegments(ctx, translated, totalMs, {
    workspaceId: ref.workspaceId,
    voiceId: output.voiceId,
    language,
    onProgress: async (fraction) => {
      run.report('dubbing', fraction, index, language);
      dubbedCount += 1;
      if (dubbedCount % CANCEL_CHECK_EVERY === 0) await run.checkpoint();
    },
  });
  if (dub.segments.length === 0) {
    throw new AppError(
      'UNPROCESSABLE',
      'There is nothing to dub: the translated transcript has no speakable text',
    );
  }
  if (dub.provider) run.provenance.tts = dub.provider;
  job.log.info({ language, ...dub.stats }, 'dub fitted');
  await run.checkpoint();

  /* ---- mixing ---- */
  await run.enter('mixing', index, language);
  const dubPath = await buildDubTrack(ctx, tmp, dub.segments, totalMs, {
    signal: job.signal,
    onProgress: (fraction) => run.report('mixing', fraction * 0.15, index, language),
  });
  const frame = run.options.burnSubtitles
    ? burnFrameSize(source)
    : { width: source.width, height: source.height };
  const cues = dubSubtitleCues(dub.segments, run.style, frame, totalMs);
  let overlay: { scriptPath: string; width: number; height: number } | null = null;
  const overlayDir = tmp.file('overlay');
  if (run.options.burnSubtitles) {
    await fs.rm(overlayDir, { recursive: true, force: true });
    await fs.mkdir(overlayDir, { recursive: true });
    const rendered = await renderSubtitleOverlay(overlayDir, cues, run.style, frame, totalMs, {
      onProgress: (fraction) => run.report('mixing', 0.15 + fraction * 0.15, index, language),
    });
    overlay = { scriptPath: rendered.scriptPath, ...frame };
    await run.checkpoint();
  }
  const outputPath = tmp.file('dubbed.mp4');
  await mixDubbedVideo({
    source,
    dubPath,
    outputPath,
    originalAudioVolume: run.options.originalAudioVolume,
    overlay,
    language,
    signal: job.signal,
    onProgress: (fraction) => run.report('mixing', 0.3 + fraction * 0.7, index, language),
  });
  // Never publish a file that is not a playable video of the right length.
  const produced = await ffprobe(outputPath);
  if (
    !produced.hasVideo ||
    !produced.hasAudio ||
    Math.abs((produced.durationMs ?? 0) - totalMs) > DURATION_TOLERANCE_MS
  ) {
    throw new Error(
      `The dubbed video is not valid (video ${String(produced.hasVideo)}, audio ${String(produced.hasAudio)}, ${String(produced.durationMs)} ms for a source of ${totalMs} ms)`,
    );
  }
  await run.checkpoint();

  /* ---- finalizing ---- */
  await run.enter('finalizing', index, language);
  const key = (file: 'video.mp4' | 'subtitles.srt' | 'subtitles.vtt') =>
    storageKeys.translationOutput(ref.workspaceId, ref.translationJobId, language, file);
  const subtitleCues = plainCues(cues);
  const encoder = new TextEncoder();
  await storage.put(key('video.mp4'), { filePath: outputPath }, { contentType: 'video/mp4' });
  await storage.put(key('subtitles.srt'), encoder.encode(formatSrt(subtitleCues)), {
    contentType: 'application/x-subrip; charset=utf-8',
  });
  await storage.put(key('subtitles.vtt'), encoder.encode(formatVtt(subtitleCues)), {
    contentType: 'text/vtt; charset=utf-8',
  });
  await saveProvenance(ctx, ref, run.provenance);
  const stored = await markOutputCompleted(ctx, ref, output.id, {
    videoKey: key('video.mp4'),
    srtKey: key('subtitles.srt'),
    vttKey: key('subtitles.vtt'),
    segments: translated,
  });
  if (!stored) throw new TranslationCanceled();
  run.report('finalizing', 1, index, language);
  // Temp space is bounded by ONE language, however many targets the job has.
  await Promise.all([
    fs.rm(outputPath, { force: true }),
    fs.rm(dubPath, { force: true }),
    fs.rm(overlayDir, { recursive: true, force: true }),
  ]);
}

async function translate(ctx: WorkerContext, job: Job, loaded: LoadedTranslation, tmp: TempDir) {
  const ref = job.payload;
  const { job: row, outputs } = loaded;
  const options = TranslationOptionsSchema.parse(row.options ?? {});
  const style = SubtitleStyleSchema.parse(options.subtitleStyle ?? {});
  const total = Math.max(1, outputs.length);

  const persist = throttled(
    (stage: TranslationStage, percent: number) =>
      reportTranslationProgress(ctx, ref, stage, percent),
    1000,
  );
  const publish = (stage: TranslationStage, percent: number, language?: LanguageCode) => {
    void persist(stage, percent);
    void job
      .progress({
        stage,
        percent: Math.min(100, Math.max(0, percent)),
        ...(language ? { language } : {}),
      })
      .catch(() => undefined);
  };
  const checkpoint = async () => {
    if (job.signal.aborted) throw new Error('The worker is shutting down');
    if (!(await isTranslationActive(ctx, ref))) throw new TranslationCanceled();
  };

  /* ---- transcribing ---- */
  publish('transcribing', 1);
  const source = await inspectSource(await sourcePath(ctx, row, tmp), tmp, job.signal);
  const provenance: Provenance = { ...(row.providers ?? {}) };
  let segments = tidySegments(row.transcript ?? [], source.durationMs);
  if (segments.length === 0) {
    if (row.transcript && row.transcript.length > 0) {
      throw new AppError(
        'UNPROCESSABLE',
        'The transcript has no text inside the length of the video',
      );
    }
    const transcript = await transcribeSource(ctx, source, tmp, row.sourceLanguage, job.signal);
    segments = transcript.segments;
    if (transcript.provider) provenance.stt = transcript.provider;
    await saveTranscript(ctx, ref, segments);
    await saveProvenance(ctx, ref, provenance);
  }
  publish('transcribing', TRANSCRIBE_END);
  await checkpoint();

  const run: Run = {
    ctx,
    job,
    ref,
    row,
    options,
    style,
    tmp,
    source,
    segments,
    provenance,
    checkpoint,
    async enter(stage, index, language) {
      const percent = scale((index + LANGUAGE_STAGES[stage][0]) / total, TRANSCRIBE_END, 100);
      // Deliver what the throttle still holds first, so an older update never lands later.
      await persist.flush();
      await reportTranslationProgress(ctx, ref, stage, percent);
      void job.progress({ stage, percent, language }).catch(() => undefined);
    },
    report(stage, fraction, index, language) {
      const [from, to] = LANGUAGE_STAGES[stage];
      const within = from + (to - from) * Math.min(1, Math.max(0, fraction));
      publish(stage, scale((index + within) / total, TRANSCRIBE_END, 100), language);
    },
    flush: () => persist.flush(),
  };

  /* ---- one output per target language ---- */
  for (const [index, output] of outputs.entries()) {
    if (output.status === 'completed' && output.videoKey) continue; // done by an earlier run
    await checkpoint();
    try {
      await processLanguage(run, output, index);
    } catch (err) {
      if (err instanceof TranslationCanceled || job.signal.aborted) throw err;
      // This language failed; the others still get their chance (partial success).
      await markOutputFailed(ctx, ref, output.id, toStoredError(err));
      job.log.error({ err, language: output.language }, 'translation of a language failed');
    }
  }
  await run.flush();
}

export default defineJob({
  queue: 'translation',
  async handler(ctx, job) {
    const ref = job.payload;
    const loaded = await loadTranslation(ctx, ref);
    if (!loaded) throw new AppError('NOT_FOUND', 'Translation not found');
    // Idempotency: a finished (or cancelled) job is never processed or charged again.
    if (loaded.job.status !== 'queued' && loaded.job.status !== 'processing')
      return summary(loaded);
    const canceled = {
      translationJobId: ref.translationJobId,
      completedLanguages: [],
      failedLanguages: [],
    };
    if (!(await markTranslationStarted(ctx, ref))) return canceled;

    /**
     * The job stopped being `processing` under this run. Cancelled or deleted by the API (which
     * already refunded and removed the files): whatever this run wrote afterwards goes too.
     * Closed by another run of the same job: its result stands.
     */
    const stopQuietly = async () => {
      const current = await loadTranslation(ctx, ref);
      if (current && current.job.status !== 'canceled') return summary(current);
      await ctx.providers.storage
        .deletePrefix(storageKeys.translationPrefix(ref.workspaceId, ref.translationJobId))
        .catch((cleanupError: unknown) =>
          job.log.warn(
            { err: cleanupError },
            'could not delete the files of a cancelled translation',
          ),
        );
      return canceled;
    };

    let failure: unknown = null;
    try {
      await withTempDir(ctx, 'translation', (tmp) => translate(ctx, job, loaded, tmp));
    } catch (err) {
      if (err instanceof TranslationCanceled) return stopQuietly();
      failure = err;
    }

    // Terminal state from the outputs: completed / partial (settled) / failed (refunded).
    const outcome = await finishTranslation(ctx, ref, failure ? toStoredError(failure) : null);
    if (!outcome) return stopQuietly(); // not ours to close any more
    if (outcome.status === 'failed') {
      if (failure) throw failure;
      const [first] = (await loadTranslation(ctx, ref))?.outputs.filter((o) => o.error) ?? [];
      throw new AppError(
        first?.error?.code ?? 'INTERNAL',
        first?.error?.message ?? 'The translation failed for every language',
      );
    }
    await job.progress({ stage: 'finalizing', percent: 100 });
    return {
      translationJobId: ref.translationJobId,
      completedLanguages: outcome.completedLanguages,
      failedLanguages: outcome.failedLanguages,
    };
  },
  // Safety net for a worker that died mid-job: languages already stored are kept (`partial`,
  // settled to them); otherwise the job fails and everything is refunded. Idempotent.
  onFinalFailure: async (ctx, payload, error) => {
    await finishTranslation(ctx, payload, error);
  },
});
