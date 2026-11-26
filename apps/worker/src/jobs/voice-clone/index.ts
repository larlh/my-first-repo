import fs from 'node:fs/promises';
import { AppError, toStoredError } from '@parlante/shared';
import type { StoredError, VoiceCloneResult } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, assets, eq, refundCredits, voices } from '@parlante/db';
import type { WorkerContext } from '../../context';
import { finalFailure } from '../../lib/errors';
import { ffprobe, runFfmpeg } from '../../lib/ffmpeg';
import { defineJob } from '../../lib/job';
import { withTempDir } from '../../lib/tmp';

/* -------------------------------------------------------------------------------------------
 * Voice cloning (feature 14). The API has already recorded the consent, charged the credits
 * (ledger ref `voice`) and inserted the `voices` row as `processing`; this job
 *
 *   1. normalises the uploaded sample (any audio / video container) to WAV PCM16 mono
 *   2. hands it to `providers.voiceClone.createVoice` (local voice profile or external clone)
 *   3. stores the normalised sample as `sample.wav` under the voice prefix
 *   4. writes provider, TTS provider / voice id and profile on the row → `ready`
 *
 * A final failure stores `{code, message}` on the row and refunds. A voice deleted while the
 * job runs (delete or consent revocation) leaves nothing behind: its files and the voice the
 * external provider may have created are removed again.
 * ----------------------------------------------------------------------------------------- */

interface VoiceRef {
  voiceId: string;
  workspaceId: string;
}

/** Sample rate handed to the cloning providers (enough for pitch and pace analysis). */
export const SAMPLE_RATE = 22_050;
/** Longer samples are cut: nothing is gained past two minutes and uploads stay bounded. */
export const MAX_SAMPLE_SEC = 120;
/** Below this there is not enough speech to measure anything. */
export const MIN_SAMPLE_MS = 1000;

const voiceWhere = (ref: VoiceRef) =>
  and(eq(voices.id, ref.voiceId), eq(voices.workspaceId, ref.workspaceId));

/** Terminal failure, idempotent: only a voice still `processing` is failed and refunded. */
export async function markVoiceFailed(
  ctx: Pick<WorkerContext, 'db'>,
  ref: VoiceRef,
  error: StoredError,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(voices)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(and(voiceWhere(ref), eq(voices.status, 'processing')))
      .returning({ id: voices.id });
    if (!row) return false;
    await refundCredits(tx, {
      workspaceId: ref.workspaceId,
      refType: 'voice',
      refId: ref.voiceId,
      description: 'Voice cloning failed — credits refunded',
    });
    return true;
  });
}

/** Remove what an attempt created outside the database (best effort, never throws). */
async function discardClone(
  ctx: WorkerContext,
  ref: VoiceRef,
  created: VoiceCloneResult | null,
  options: { files: boolean },
): Promise<void> {
  // External services AND the local voice engine keep the voice outside this row; a basic
  // voice profile has nothing to delete (its provider's deleteVoice is a no-op).
  if (created && (!created.provider.local || created.profile === null)) {
    await ctx.providers.voiceClone
      .deleteVoice(created.providerVoiceId)
      .catch((err: unknown) =>
        ctx.logger.warn({ err, voiceId: ref.voiceId }, 'could not delete the external voice'),
      );
  }
  if (options.files) {
    await ctx.providers.storage
      .deletePrefix(storageKeys.voicePrefix(ref.workspaceId, ref.voiceId))
      .catch((err: unknown) =>
        ctx.logger.warn({ err, voiceId: ref.voiceId }, 'could not delete the voice files'),
      );
  }
}

export default defineJob({
  queue: 'voiceClone',
  async handler(ctx, job) {
    const ref = job.payload;
    const [voice] = await ctx.db.select().from(voices).where(voiceWhere(ref));
    if (!voice) throw new AppError('NOT_FOUND', 'Voice not found');
    // Idempotency: the job may run again after a crash or a duplicate delivery.
    if (voice.status === 'ready') {
      return { voiceId: voice.id, provider: voice.provider?.id ?? 'unknown' };
    }
    if (voice.status === 'failed') {
      throw new AppError('INVALID_STATE', 'This voice already failed; create it again');
    }

    let created: VoiceCloneResult | null = null;
    try {
      const [sample] = voice.sampleAssetId
        ? await ctx.db
            .select()
            .from(assets)
            .where(and(eq(assets.id, voice.sampleAssetId), eq(assets.workspaceId, ref.workspaceId)))
        : [];
      if (!sample) throw new AppError('UNPROCESSABLE', 'The voice sample is missing');
      if (sample.kind !== 'audio' && sample.kind !== 'video') {
        throw new AppError('UNPROCESSABLE', 'The voice sample must be an audio recording');
      }
      await job.progress({ percent: 5 });

      const sampleKey = storageKeys.voiceSample(ref.workspaceId, ref.voiceId);
      created = await withTempDir(ctx, 'voice-clone', async (tmp) => {
        await ctx.providers.storage.downloadTo(sample.storageKey, tmp.file('sample.bin'));
        try {
          await runFfmpeg(
            [
              '-i',
              tmp.file('sample.bin'),
              '-vn',
              '-t',
              String(MAX_SAMPLE_SEC),
              '-ac',
              '1',
              '-ar',
              String(SAMPLE_RATE),
              '-c:a',
              'pcm_s16le',
              tmp.file('sample.wav'),
            ],
            { signal: job.signal, timeoutMs: 120_000 },
          );
        } catch (err) {
          if (job.signal.aborted) throw err;
          throw new AppError(
            'UNPROCESSABLE',
            'The voice sample could not be read as audio',
            undefined,
            { cause: err },
          );
        }
        const info = await ffprobe(tmp.file('sample.wav'));
        if (!info.hasAudio || (info.durationMs ?? 0) < MIN_SAMPLE_MS) {
          throw new AppError(
            'UNPROCESSABLE',
            'The voice sample is too short: record at least a few seconds of speech',
            { durationMs: info.durationMs ?? 0 },
          );
        }
        await job.progress({ percent: 35 });

        const bytes = await fs.readFile(tmp.file('sample.wav'));
        const result = await ctx.providers.voiceClone.createVoice({
          name: voice.name,
          sample: bytes,
          sampleRate: SAMPLE_RATE,
          language: voice.language,
          gender: voice.gender,
          consentId: voice.consentId,
        });
        created = result;
        await job.progress({ percent: 80 });
        await ctx.providers.storage.put(
          sampleKey,
          { filePath: tmp.file('sample.wav') },
          { contentType: 'audio/wav' },
        );
        return result;
      });

      // Persist the result (clients poll the REST resource). Only a voice still `processing`:
      // a voice deleted meanwhile must not come back, nor keep files or an external clone.
      const [updated] = await ctx.db
        .update(voices)
        .set({
          status: 'ready',
          ttsProviderId: created.ttsProviderId,
          providerVoiceId: created.providerVoiceId,
          profile: created.profile,
          provider: created.provider, // honesty rule: who did the work
          error: null,
          updatedAt: new Date(),
        })
        .where(and(voiceWhere(ref), eq(voices.status, 'processing')))
        .returning({ id: voices.id });
      if (!updated) {
        const [current] = await ctx.db
          .select({ status: voices.status, provider: voices.provider })
          .from(voices)
          .where(voiceWhere(ref));
        const duplicate = created;
        created = null;
        if (current?.status === 'ready') {
          // Another run of this job finished first: keep its result, drop this one's clone.
          await discardClone(ctx, ref, duplicate, { files: false });
          return { voiceId: voice.id, provider: current.provider?.id ?? 'unknown' };
        }
        await discardClone(ctx, ref, duplicate, { files: true });
        throw new AppError(
          current ? 'INVALID_STATE' : 'NOT_FOUND',
          current ? `The voice is ${current.status}` : 'The voice was deleted while it was cloned',
        );
      }
      await job.progress({ percent: 100 });
      return { voiceId: voice.id, provider: created.provider.id };
    } catch (err) {
      const final = finalFailure(err, job);
      // An external voice created by an attempt that did not finish is never left behind
      // (a retry creates a new one). Files are kept for the retry and removed on final failure.
      await discardClone(ctx, ref, created, { files: final });
      if (final) await markVoiceFailed(ctx, ref, toStoredError(err));
      throw err;
    }
  },
  // Safety net for a worker that died mid-job (the handler never reached its catch).
  onFinalFailure: async (ctx, payload, error) => {
    await markVoiceFailed(ctx, payload, error);
  },
});
