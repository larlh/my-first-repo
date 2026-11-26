import { creditsForTranslation } from '@parlante/shared';
import type {
  AsyncJobStatus,
  LanguageCode,
  Provenance,
  StoredError,
  TimedText,
  TranslationStage,
} from '@parlante/shared';
import {
  and,
  eq,
  inArray,
  ne,
  netCharged,
  refundCredits,
  settleCredits,
  translationJobs,
  translationOutputs,
} from '@parlante/db';
import type { TranslationJobRow, TranslationOutputRow } from '@parlante/db';
import type { WorkerContext } from '../../context';

/* -------------------------------------------------------------------------------------------
 * Status of a translation job and of its per-language outputs. Like `lib/render-status.ts`
 * for renders, this file is the ONLY place of the translation job that writes job / output
 * status and settles credits:
 *
 *   job      queued → processing → completed | partial | failed        (canceled: by the API)
 *   output   pending → processing → completed | failed
 *
 * Credits: the API reserved `creditsForTranslation(duration, all targets)` with ledger ref
 * `translationJob`. `finishTranslation` settles it to the languages that actually completed
 * (reason `adjustment`) or refunds everything when none did. Every write is guarded by the
 * non-terminal statuses, so a cancelled / deleted job is never resurrected or charged again
 * and the terminal step is idempotent (handler failure path and `onFinalFailure`).
 * ----------------------------------------------------------------------------------------- */

export interface TranslationRef {
  translationJobId: string;
  workspaceId: string;
}

type Deps = Pick<WorkerContext, 'db'>;

const jobWhere = (ref: TranslationRef) =>
  and(
    eq(translationJobs.id, ref.translationJobId),
    eq(translationJobs.workspaceId, ref.workspaceId),
  );

const outputsWhere = (ref: TranslationRef) =>
  and(
    eq(translationOutputs.jobId, ref.translationJobId),
    eq(translationOutputs.workspaceId, ref.workspaceId),
  );

const outputWhere = (ref: TranslationRef, outputId: string) =>
  and(outputsWhere(ref), eq(translationOutputs.id, outputId));

export interface LoadedTranslation {
  job: TranslationJobRow;
  /** In the order of `job.targetLanguages`. */
  outputs: TranslationOutputRow[];
}

export async function loadTranslation(
  ctx: Deps,
  ref: TranslationRef,
): Promise<LoadedTranslation | null> {
  const [job] = await ctx.db.select().from(translationJobs).where(jobWhere(ref));
  if (!job) return null;
  const rows = await ctx.db.select().from(translationOutputs).where(outputsWhere(ref));
  const order = new Map(job.targetLanguages.map((language, index) => [language, index]));
  const outputs = [...rows].sort(
    (a, b) => (order.get(a.language) ?? 99) - (order.get(b.language) ?? 99),
  );
  return { job, outputs };
}

/** `queued` (or `processing`, after a crash) → `processing`. False = cancelled / finished. */
export async function markTranslationStarted(ctx: Deps, ref: TranslationRef): Promise<boolean> {
  const [row] = await ctx.db
    .update(translationJobs)
    .set({ status: 'processing', stage: 'transcribing', error: null, updatedAt: new Date() })
    .where(and(jobWhere(ref), inArray(translationJobs.status, ['queued', 'processing'])))
    .returning({ id: translationJobs.id });
  return Boolean(row);
}

/** True while the job exists and nobody cancelled it. Checked between stages. */
export async function isTranslationActive(ctx: Deps, ref: TranslationRef): Promise<boolean> {
  const [row] = await ctx.db
    .select({ status: translationJobs.status })
    .from(translationJobs)
    .where(jobWhere(ref));
  return row?.status === 'processing';
}

/** Persist stage and overall progress (capped at 99 until the terminal write). */
export async function reportTranslationProgress(
  ctx: Deps,
  ref: TranslationRef,
  stage: TranslationStage,
  percent: number,
): Promise<void> {
  await ctx.db
    .update(translationJobs)
    .set({
      stage,
      progress: Math.min(99, Math.max(0, Math.round(percent))),
      updatedAt: new Date(),
    })
    .where(and(jobWhere(ref), eq(translationJobs.status, 'processing')));
}

/** Source-language segments produced by the STT stage, kept for retries and for the record. */
export async function saveTranscript(
  ctx: Deps,
  ref: TranslationRef,
  transcript: TimedText[],
): Promise<void> {
  await ctx.db
    .update(translationJobs)
    .set({ transcript, updatedAt: new Date() })
    .where(and(jobWhere(ref), eq(translationJobs.status, 'processing')));
}

/** Merge provider provenance into the row (honesty rule: who transcribed / translated / spoke). */
export async function saveProvenance(
  ctx: Deps,
  ref: TranslationRef,
  providers: Provenance,
): Promise<void> {
  await ctx.db
    .update(translationJobs)
    .set({ providers, updatedAt: new Date() })
    .where(and(jobWhere(ref), eq(translationJobs.status, 'processing')));
}

export async function markOutputProcessing(
  ctx: Deps,
  ref: TranslationRef,
  outputId: string,
): Promise<void> {
  await ctx.db
    .update(translationOutputs)
    .set({ status: 'processing', error: null, updatedAt: new Date() })
    .where(and(outputWhere(ref, outputId), ne(translationOutputs.status, 'completed')));
}

export async function saveOutputSegments(
  ctx: Deps,
  ref: TranslationRef,
  outputId: string,
  segments: TimedText[],
): Promise<void> {
  await ctx.db
    .update(translationOutputs)
    .set({ segments, updatedAt: new Date() })
    .where(outputWhere(ref, outputId));
}

/**
 * Output → `completed` with its files. Only while the job is still `processing`: returns
 * false when the job was cancelled / deleted meanwhile (the caller then removes the files).
 */
export async function markOutputCompleted(
  ctx: Deps,
  ref: TranslationRef,
  outputId: string,
  files: { videoKey: string; srtKey: string; vttKey: string; segments: TimedText[] },
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .select({ status: translationJobs.status })
      .from(translationJobs)
      .where(jobWhere(ref))
      .for('update');
    if (job?.status !== 'processing') return false;
    const [row] = await tx
      .update(translationOutputs)
      .set({ status: 'completed', ...files, error: null, updatedAt: new Date() })
      .where(outputWhere(ref, outputId))
      .returning({ id: translationOutputs.id });
    return Boolean(row);
  });
}

export async function markOutputFailed(
  ctx: Deps,
  ref: TranslationRef,
  outputId: string,
  error: StoredError,
): Promise<void> {
  await ctx.db
    .update(translationOutputs)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(and(outputWhere(ref, outputId), ne(translationOutputs.status, 'completed')));
}

export interface TranslationOutcome {
  status: Extract<AsyncJobStatus, 'completed' | 'partial' | 'failed'>;
  completedLanguages: LanguageCode[];
  failedLanguages: LanguageCode[];
  /** Net credits charged for the job after settling. */
  creditsCharged: number;
}

/**
 * TERMINAL step, idempotent. Looks at the outputs and closes the job:
 *   every language completed → `completed`   (credits stay as reserved)
 *   some completed           → `partial`     (settled to the completed languages)
 *   none completed           → `failed`      (everything refunded, `error` stored)
 * Outputs that did not complete become `failed` (keeping their own error, else `error`).
 * Returns null when the job is no longer `queued` / `processing` (cancelled, deleted or
 * already closed): nothing is written and nothing is charged or refunded.
 */
export async function finishTranslation(
  ctx: Deps,
  ref: TranslationRef,
  error: StoredError | null = null,
): Promise<TranslationOutcome | null> {
  return ctx.db.transaction(async (tx) => {
    const [job] = await tx.select().from(translationJobs).where(jobWhere(ref)).for('update');
    if (!job || (job.status !== 'queued' && job.status !== 'processing')) return null;

    const fallback: StoredError = error ?? {
      code: 'INTERNAL',
      message: 'This language was not processed',
    };
    const outputs = await tx.select().from(translationOutputs).where(outputsWhere(ref));
    const order = new Map(job.targetLanguages.map((language, index) => [language, index]));
    outputs.sort((a, b) => (order.get(a.language) ?? 99) - (order.get(b.language) ?? 99));
    const completed = outputs.filter((o) => o.status === 'completed');
    const failed = outputs.filter((o) => o.status !== 'completed');
    for (const output of failed) {
      await tx
        .update(translationOutputs)
        .set({ status: 'failed', error: output.error ?? fallback, updatedAt: new Date() })
        .where(outputWhere(ref, output.id));
    }

    const status: TranslationOutcome['status'] =
      failed.length === 0 ? 'completed' : completed.length > 0 ? 'partial' : 'failed';
    const ledgerRef = {
      workspaceId: ref.workspaceId,
      refType: 'translationJob',
      refId: ref.translationJobId,
    };
    if (status === 'failed') {
      await refundCredits(tx, {
        ...ledgerRef,
        description: 'Translation failed — credits refunded',
      });
    } else {
      await settleCredits(tx, {
        ...ledgerRef,
        actualCost: creditsForTranslation(job.sourceDurationMs ?? 0, completed.length),
        reason: 'adjustment',
        description:
          status === 'partial'
            ? `Translation finished for ${completed.length} of ${outputs.length} languages`
            : 'Translation settled to its actual cost',
      });
    }
    const creditsCharged = Math.max(0, await netCharged(tx, ref.workspaceId, ledgerRef));

    // The job error of a total failure: the given one, or what the languages failed with.
    const jobError =
      status === 'failed' ? (error ?? failed.find((o) => o.error)?.error ?? fallback) : null;
    await tx
      .update(translationJobs)
      .set({
        status,
        stage: null,
        progress: status === 'failed' ? job.progress : 100,
        creditsCharged,
        error: jobError,
        updatedAt: new Date(),
      })
      .where(jobWhere(ref));
    return {
      status,
      completedLanguages: completed.map((o) => o.language),
      failedLanguages: failed.map((o) => o.language),
      creditsCharged,
    };
  });
}
