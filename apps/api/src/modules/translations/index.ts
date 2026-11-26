import {
  AppError,
  OK,
  api,
  baseLanguage,
  buildPage,
  creditsForTranslation,
  isAppError,
  languageName,
  newId,
  parseTranscript,
} from '@parlante/shared';
import type {
  LanguageCode,
  StoredError,
  TimedText,
  TranslationJob,
  TranslationOutput,
} from '@parlante/shared';
import { sanitizeFilename, storageKeys } from '@parlante/shared/node';
import {
  and,
  assets,
  chargeCredits,
  cursorOrder,
  cursorWhere,
  eq,
  getCreditBalance,
  inArray,
  refundCredits,
  translationJobs,
  translationOutputs,
  users,
} from '@parlante/db';
import type { AssetRow, Db, TranslationJobRow, TranslationOutputRow } from '@parlante/db';
import { enqueueOrCompensate } from '@parlante/jobs';
import type { FileUrlBuilder } from '@parlante/jobs';
import type { FastifyInstance } from 'fastify';
import { defineRoute } from '../../lib/define-route';
import { iso, toUserRef } from '../../lib/dto';
import { assertWithinLimit } from '../../lib/limits';
import { assertContentAllowed } from '../../lib/moderation';
import { defineModule } from '../../lib/modules';
import { deleteAsset } from '../assets/service';
import { getVoice, listVoiceCatalog } from '../voices/catalog';
import type { VoiceCatalogDeps } from '../voices/catalog';
import { assetFromRenderedVideo, findTranslatableVideo } from './source';

/* -------------------------------------------------------------------------------------------
 * Video translation (feature 12): transcript → translation → TTS dub → mix → subtitles, one
 * output per target language. The API validates and prices the job; the `translation` worker
 * job does the work and persists stage, progress and outputs on the rows.
 *
 *   create  source (uploaded asset or an own rendered video) · plan limits (targets, length)
 *           · transcript (required while the STT provider is `manual`) · moderation
 *           · a voice per language · [tx: charge 2 credits/min/language, job + outputs] → queue
 *   get     status, stage, progress and, per language, MP4 / download / SRT / VTT URLs
 *   delete  cancels a job still running (refund), removes outputs, row and the source file
 *           when it was uploaded only to be translated
 * ----------------------------------------------------------------------------------------- */

interface JobBundle {
  job: TranslationJobRow;
  source: Pick<AssetRow, 'storageKey'> | null;
  creator: { id: string; name: string } | null;
  outputs: TranslationOutputRow[];
}

async function toOutputDto(
  fileUrl: FileUrlBuilder,
  job: TranslationJobRow,
  row: TranslationOutputRow,
): Promise<TranslationOutput> {
  const done = row.status === 'completed';
  const downloadName = `${sanitizeFilename(job.name, 'translation')}-${row.language}.mp4`;
  const [videoUrl, downloadUrl, srtUrl, vttUrl] = await Promise.all([
    fileUrl(done ? row.videoKey : null),
    fileUrl(done ? row.videoKey : null, { downloadName }),
    fileUrl(done ? row.srtKey : null),
    fileUrl(done ? row.vttKey : null),
  ]);
  return {
    id: row.id,
    language: row.language,
    voiceId: row.voiceId,
    status: row.status,
    videoUrl,
    downloadUrl,
    srtUrl,
    vttUrl,
    error: row.error,
  };
}

/** Row → DTO in ONE place. Outputs follow the order of `targetLanguages`. */
async function toJobDto(fileUrl: FileUrlBuilder, bundle: JobBundle): Promise<TranslationJob> {
  const { job } = bundle;
  const order = new Map(job.targetLanguages.map((language, index) => [language, index]));
  const outputs = [...bundle.outputs].sort(
    (a, b) => (order.get(a.language) ?? 99) - (order.get(b.language) ?? 99),
  );
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    name: job.name,
    sourceAssetId: job.sourceAssetId,
    sourceUrl: await fileUrl(bundle.source?.storageKey),
    sourceDurationMs: job.sourceDurationMs,
    sourceLanguage: job.sourceLanguage,
    targetLanguages: job.targetLanguages,
    status: job.status,
    stage: job.stage,
    progress: Math.min(100, Math.max(0, job.progress)),
    transcriptSource: job.transcriptSource,
    options: job.options,
    outputs: await Promise.all(outputs.map((row) => toOutputDto(fileUrl, job, row))),
    providers: job.providers,
    creditsCharged: job.creditsCharged,
    error: job.error,
    createdBy: toUserRef(bundle.creator),
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
  };
}

function jobQuery(db: Db) {
  return db
    .select({
      job: translationJobs,
      source: { storageKey: assets.storageKey },
      creator: { id: users.id, name: users.name },
    })
    .from(translationJobs)
    .leftJoin(
      assets,
      and(
        eq(assets.id, translationJobs.sourceAssetId),
        eq(assets.workspaceId, translationJobs.workspaceId),
      ),
    )
    .leftJoin(users, eq(users.id, translationJobs.createdBy));
}

async function loadOutputs(
  db: Db,
  workspaceId: string,
  jobIds: string[],
): Promise<Map<string, TranslationOutputRow[]>> {
  const byJob = new Map<string, TranslationOutputRow[]>();
  if (jobIds.length === 0) return byJob;
  const rows = await db
    .select()
    .from(translationOutputs)
    .where(
      and(
        eq(translationOutputs.workspaceId, workspaceId),
        inArray(translationOutputs.jobId, jobIds),
      ),
    );
  for (const row of rows) byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row]);
  return byJob;
}

/** A translation job of THIS workspace with everything its DTO needs, or 404. */
async function findJob(db: Db, workspaceId: string, translationId: string): Promise<JobBundle> {
  const [row] = await jobQuery(db).where(
    and(eq(translationJobs.id, translationId), eq(translationJobs.workspaceId, workspaceId)),
  );
  if (!row) throw AppError.notFound('Translation');
  const outputs = await loadOutputs(db, workspaceId, [row.job.id]);
  return { ...row, outputs: outputs.get(row.job.id) ?? [] };
}

/** Timed, non-empty, in-range cues of the transcript the user supplied. */
function userTranscript(
  transcript: { format: 'srt' | 'vtt' | 'text'; content: string },
  durationMs: number,
): TimedText[] {
  let cues: TimedText[];
  try {
    cues = parseTranscript(transcript.format, transcript.content, durationMs);
  } catch {
    cues = [];
  }
  const usable = cues
    .map((cue) => ({ ...cue, text: cue.text.replace(/\s+/g, ' ').trim() }))
    .filter((cue) => cue.text !== '' && cue.startMs < durationMs && cue.endMs > cue.startMs)
    .map((cue) => ({ ...cue, endMs: Math.min(cue.endMs, durationMs) }))
    .sort((a, b) => a.startMs - b.startMs);
  if (usable.length === 0) {
    throw new AppError(
      'UNPROCESSABLE',
      transcript.format === 'text'
        ? 'The transcript has no text'
        : `The transcript has no ${transcript.format.toUpperCase()} cues inside the length of the video. Check its format, or send it as plain text`,
      { format: transcript.format, durationMs },
    );
  }
  return usable;
}

/**
 * The voice that dubs each target language: the one the user chose (it must exist for this
 * workspace, be ready and — stock single-language voices — speak that language) or the first
 * stock voice of the default TTS provider for the language.
 */
async function resolveVoices(
  deps: VoiceCatalogDeps,
  workspaceId: string,
  targets: LanguageCode[],
  chosen: Partial<Record<LanguageCode, string>>,
): Promise<Map<LanguageCode, string>> {
  const result = new Map<LanguageCode, string>();
  for (const language of targets) {
    const voiceId = chosen[language];
    if (voiceId) {
      const voice = await getVoice(deps, workspaceId, voiceId);
      const path = `body.voices.${language}`;
      if (voice.status !== 'ready') {
        throw AppError.validation('This voice is not ready yet', [
          { path, message: `Voice is ${voice.status}` },
        ]);
      }
      if (
        voice.kind === 'stock' &&
        !voice.multilingual &&
        baseLanguage(voice.language) !== language
      ) {
        throw AppError.validation(
          `The voice "${voice.name}" does not speak ${languageName(language, 'en')}`,
          [{ path, message: `Voice language is ${voice.language}` }],
        );
      }
      result.set(language, voice.id);
      continue;
    }
    const candidates = await listVoiceCatalog(deps, workspaceId, { kind: 'stock', language });
    const pick =
      candidates.find((voice) => baseLanguage(voice.language) === language) ?? candidates[0];
    if (!pick) {
      throw new AppError(
        'UNPROCESSABLE',
        `No voice is available for ${languageName(language, 'en')} with the active voice providers`,
        { language },
      );
    }
    result.set(language, pick.id);
  }
  return result;
}

/** Terminal failure before the worker ever saw the job: only a job still queued. */
async function failJob(db: Db, workspaceId: string, jobId: string, error: StoredError) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(translationJobs)
      .set({ status: 'failed', error, creditsCharged: 0, updatedAt: new Date() })
      .where(
        and(
          eq(translationJobs.id, jobId),
          eq(translationJobs.workspaceId, workspaceId),
          inArray(translationJobs.status, ['queued', 'processing']),
        ),
      )
      .returning({ id: translationJobs.id });
    if (!row) return;
    await tx
      .update(translationOutputs)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(
        and(eq(translationOutputs.jobId, jobId), eq(translationOutputs.workspaceId, workspaceId)),
      );
    await refundCredits(tx, {
      workspaceId,
      refType: 'translationJob',
      refId: jobId,
      description: 'Translation could not be queued — credits refunded',
    });
  });
}

function voiceDeps(app: FastifyInstance): VoiceCatalogDeps {
  return { db: app.db, providers: app.providers };
}

export default defineModule({
  name: 'translations',
  register(app) {
    defineRoute(app, api.translations.list, async ({ auth, query, app: { db, fileUrl } }) => {
      const rows = await jobQuery(db)
        .where(
          and(
            eq(translationJobs.workspaceId, auth.workspaceId),
            cursorWhere(translationJobs.createdAt, translationJobs.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(translationJobs.createdAt, translationJobs.id))
        .limit(query.limit + 1);
      const page = buildPage(
        rows.map((row) => ({ ...row, id: row.job.id, createdAt: row.job.createdAt })),
        query.limit,
      );
      const outputs = await loadOutputs(
        db,
        auth.workspaceId,
        page.items.map((row) => row.job.id),
      );
      return {
        items: await Promise.all(
          page.items.map((row) =>
            toJobDto(fileUrl, { ...row, outputs: outputs.get(row.job.id) ?? [] }),
          ),
        ),
        nextCursor: page.nextCursor,
      };
    });

    defineRoute(app, api.translations.create, async ({ auth, body, app: instance }) => {
      const { db, providers, queues, fileUrl } = instance;
      const workspaceId = auth.workspaceId;

      /* ---- source: an uploaded video asset or an own rendered video ---- */
      let sourceAsset: AssetRow | null = null;
      const sourceVideo = body.sourceVideoId
        ? await findTranslatableVideo(db, workspaceId, body.sourceVideoId)
        : null;
      if (!sourceVideo) {
        const [asset] = body.sourceAssetId
          ? await db
              .select()
              .from(assets)
              .where(and(eq(assets.id, body.sourceAssetId), eq(assets.workspaceId, workspaceId)))
          : [];
        if (!asset) throw AppError.notFound('Source video');
        if (asset.kind !== 'video') {
          throw new AppError('UNPROCESSABLE', 'The file to translate must be a video', {
            assetId: asset.id,
            kind: asset.kind,
          });
        }
        if (!asset.durationMs) {
          throw new AppError('UNPROCESSABLE', 'The length of this video could not be read', {
            assetId: asset.id,
          });
        }
        sourceAsset = asset;
      }
      const durationMs = sourceVideo?.durationMs ?? sourceAsset?.durationMs ?? 0;
      const sourceName = sourceVideo?.title ?? sourceAsset?.name.replace(/\.[A-Za-z0-9]{1,5}$/, '');

      /* ---- targets and plan limits ---- */
      const targets = [...new Set(body.targetLanguages)];
      if (targets.includes(body.sourceLanguage)) {
        throw AppError.validation('A target language cannot be the language of the video', [
          {
            path: 'body.targetLanguages',
            message: `${body.sourceLanguage} is the source language`,
          },
        ]);
      }
      assertWithinLimit(auth.workspace, 'maxTranslationTargets', targets.length);
      assertWithinLimit(auth.workspace, 'maxTranslationSourceSec', Math.ceil(durationMs / 1000));

      /* ---- transcript: the user's, or the STT provider's when it can transcribe ---- */
      if (!body.transcript && providers.stt.requiresUserTranscript) {
        throw new AppError(
          'TRANSCRIPT_REQUIRED',
          'Automatic transcription is not configured on this server: provide the transcript of the video (SRT, VTT or plain text)',
          { sttProvider: providers.stt.info.id },
        );
      }
      const transcript = body.transcript ? userTranscript(body.transcript, durationMs) : null;
      const name = (body.name ?? sourceName ?? 'Translation').slice(0, 120);
      await assertContentAllowed(providers, [
        { text: body.name, context: 'name', field: 'name' },
        {
          text: transcript?.map((cue) => cue.text).join('\n'),
          context: 'translation',
          language: body.sourceLanguage,
          field: 'transcript',
        },
      ]);

      const voices = await resolveVoices(voiceDeps(instance), workspaceId, targets, body.voices);

      /* ---- price; an early 402 avoids copying a file that cannot be paid for ---- */
      const cost = creditsForTranslation(durationMs, targets.length);
      const balance = await getCreditBalance(db, workspaceId);
      if (balance < cost) {
        throw new AppError('INSUFFICIENT_CREDITS', 'Not enough credits for this operation', {
          required: cost,
          available: balance,
        });
      }

      const copied = sourceVideo
        ? await assetFromRenderedVideo(
            { db, providers },
            { workspace: auth.workspace, userId: auth.userId, video: sourceVideo },
          )
        : null;
      const source = copied ?? sourceAsset;
      if (!source) throw AppError.notFound('Source video');

      const jobId = newId('translationJob');
      let bundle: JobBundle;
      try {
        bundle = await db.transaction(async (tx) => {
          await chargeCredits(tx, {
            workspaceId,
            amount: cost,
            reason: 'translation',
            refType: 'translationJob',
            refId: jobId,
            description: `Translation "${name}" → ${targets.join(', ')}`,
            createdBy: auth.userId,
          });
          const [job] = await tx
            .insert(translationJobs)
            .values({
              id: jobId,
              workspaceId,
              name,
              sourceAssetId: source.id,
              sourceDurationMs: durationMs,
              sourceLanguage: body.sourceLanguage,
              targetLanguages: targets,
              status: 'queued',
              progress: 0,
              transcriptSource: transcript ? 'user' : 'stt',
              transcript,
              options: body.options,
              creditsCharged: cost,
              createdBy: auth.userId,
            })
            .returning();
          if (!job) throw new Error('Insert returned no row');
          const outputs = await tx
            .insert(translationOutputs)
            .values(
              targets.map((language) => ({
                id: newId('translationOutput'),
                workspaceId,
                jobId,
                language,
                voiceId: voices.get(language) ?? '',
                status: 'pending' as const,
              })),
            )
            .returning();
          return { job, source, creator: auth.user, outputs };
        });
      } catch (err) {
        // The copy of an own video exists only for this job.
        if (copied)
          await deleteAsset({ db, providers }, workspaceId, copied.id).catch(() => undefined);
        throw err;
      }

      await enqueueOrCompensate(
        queues,
        'translation',
        { translationJobId: jobId, workspaceId },
        { jobId },
        (error) => failJob(db, workspaceId, jobId, error),
      );
      return toJobDto(fileUrl, bundle);
    });

    defineRoute(app, api.translations.get, async ({ auth, params, app: { db, fileUrl } }) =>
      toJobDto(fileUrl, await findJob(db, auth.workspaceId, params.translationId)),
    );

    defineRoute(app, api.translations.remove, async ({ auth, params, app: instance }) => {
      const { db, providers, queues } = instance;
      const workspaceId = auth.workspaceId;
      const { job } = await findJob(db, workspaceId, params.translationId);
      const scope = and(
        eq(translationJobs.id, job.id),
        eq(translationJobs.workspaceId, workspaceId),
      );

      // 1. Still running: cancel it — flag the row (the worker stops at its next check),
      //    give back what was reserved and withdraw a job that has not started.
      await db.transaction(async (tx) => {
        const [canceled] = await tx
          .update(translationJobs)
          .set({ status: 'canceled', creditsCharged: 0, updatedAt: new Date() })
          .where(and(scope, inArray(translationJobs.status, ['queued', 'processing'])))
          .returning({ id: translationJobs.id });
        if (!canceled) return;
        await refundCredits(tx, {
          workspaceId,
          refType: 'translationJob',
          refId: job.id,
          description: 'Translation cancelled — credits refunded',
        });
      });
      await queues.remove('translation', job.id).catch(() => false);

      // 2. Outputs first, then the row (its outputs go with it); a storage failure keeps the
      //    row so the deletion can be retried.
      const prefix = storageKeys.translationPrefix(workspaceId, job.id);
      await providers.storage.deletePrefix(prefix);
      await db.delete(translationJobs).where(scope);
      // A job that was running may have written files after the first sweep.
      await providers.storage.deletePrefix(prefix);

      // 3. A file uploaded (or copied) only to be translated is hidden from the library: it
      //    goes too, unless another translation still uses it.
      const [source] = await db
        .select({ id: assets.id, purpose: assets.purpose })
        .from(assets)
        .where(and(eq(assets.id, job.sourceAssetId), eq(assets.workspaceId, workspaceId)));
      if (source?.purpose === 'translation_source') {
        await deleteAsset({ db, providers }, workspaceId, source.id).catch((err: unknown) => {
          if (isAppError(err) && (err.code === 'CONFLICT' || err.code === 'NOT_FOUND')) return;
          throw err;
        });
      }
      return OK;
    });
  },
});
