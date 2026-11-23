import { AppError, CREDIT_COSTS, OK, api, newId } from '@parlante/shared';
import type { StoredError } from '@parlante/shared';
import { and, assets, chargeCredits, count, eq, ne, refundCredits, voices } from '@parlante/db';
import type { Db, DbOrTx, VoiceRow } from '@parlante/db';
import { enqueueOrCompensate } from '@parlante/jobs';
import { consumeConsent } from '../../lib/consent';
import { defineRoute } from '../../lib/define-route';
import { assertWithinLimit } from '../../lib/limits';
import { assertContentAllowed } from '../../lib/moderation';
import { defineModule } from '../../lib/modules';
import { deleteVoiceCascade } from '../../lib/person-data';
import { findAssetUses } from '../assets/service';
import { toClonedVoiceDto } from '../voices/catalog';
import { lockWorkspace } from '../workspaces/service';

/* -------------------------------------------------------------------------------------------
 * Voice cloning (feature 14). Cloning the voice of a real person REQUIRES a consent record
 * (master prompt §5): `consumeConsent` runs inside the transaction that creates the voice, so
 * without a valid, unused consent of the same user nothing is created and nothing is charged.
 *
 *   create  validate sample → [tx: plan limit, consent, charge 10 credits, row] → queue
 *   status  `GET /api/voices/:voiceId` (voices module) — `processing` → `ready` | `failed`
 *   delete  row, sample.wav, source asset and the voice at the external provider
 * ----------------------------------------------------------------------------------------- */

/** "10 s – 5 min of clean speech" (contract of `sampleAssetId`). */
export const VOICE_SAMPLE_MIN_MS = 10_000;
export const VOICE_SAMPLE_MAX_MS = 5 * 60_000;

async function findVoice(db: DbOrTx, workspaceId: string, voiceId: string): Promise<VoiceRow> {
  const [row] = await db
    .select()
    .from(voices)
    .where(and(eq(voices.id, voiceId), eq(voices.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Voice');
  return row;
}

/** Terminal failure before the worker ever saw the job: only a voice still processing. */
async function failVoice(db: Db, workspaceId: string, voiceId: string, error: StoredError) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(voices)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(
        and(
          eq(voices.id, voiceId),
          eq(voices.workspaceId, workspaceId),
          eq(voices.status, 'processing'),
        ),
      )
      .returning({ id: voices.id });
    if (!row) return;
    await refundCredits(tx, {
      workspaceId,
      refType: 'voice',
      refId: voiceId,
      description: 'Voice cloning could not start — credits refunded',
    });
  });
}

export default defineModule({
  name: 'voice-clones',
  register(app) {
    defineRoute(app, api.voiceClones.create, async ({ auth, body, app: instance }) => {
      const { db, providers, queues } = instance;
      await assertContentAllowed(providers, { text: body.name, context: 'name', field: 'name' });

      const voiceId = newId('voice');
      const row = await db.transaction(async (tx) => {
        // Serialises "one more voice" checks of the workspace (plan limit below).
        const workspace = await lockWorkspace(tx, auth.workspaceId);

        const [sample] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.id, body.sampleAssetId), eq(assets.workspaceId, auth.workspaceId)))
          .for('update');
        if (!sample) throw AppError.notFound('Voice sample');
        if (sample.kind !== 'audio') {
          throw AppError.validation('The voice sample must be an audio file', [
            { path: 'body.sampleAssetId', message: `This file is ${sample.kind}, not audio` },
          ]);
        }
        const durationMs = sample.durationMs ?? 0;
        if (durationMs < VOICE_SAMPLE_MIN_MS || durationMs > VOICE_SAMPLE_MAX_MS) {
          throw new AppError(
            'VALIDATION_ERROR',
            'The voice sample must last between 10 seconds and 5 minutes',
            {
              issues: [{ path: 'body.sampleAssetId', message: 'Sample length out of range' }],
              durationMs,
              minMs: VOICE_SAMPLE_MIN_MS,
              maxMs: VOICE_SAMPLE_MAX_MS,
            },
          );
        }
        // The sample is deleted with its voice: it cannot also be the source of something else.
        const usedBy = await findAssetUses(tx, auth.workspaceId, sample.id);
        if (usedBy.length > 0) {
          throw new AppError('CONFLICT', 'This file is already the source of another resource', {
            usedBy,
          });
        }

        const [existing] = await tx
          .select({ n: count() })
          .from(voices)
          .where(and(eq(voices.workspaceId, auth.workspaceId), ne(voices.status, 'failed')));
        assertWithinLimit(workspace, 'maxClonedVoices', (existing?.n ?? 0) + 1);

        // Master prompt §5: no valid consent record → CONSENT_REQUIRED, nothing is created.
        await consumeConsent(tx, {
          consentId: body.consentId,
          kind: 'voice_clone',
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          resourceId: voiceId,
        });
        await chargeCredits(tx, {
          workspaceId: auth.workspaceId,
          amount: CREDIT_COSTS.voiceClone,
          reason: 'voice_clone',
          refType: 'voice',
          refId: voiceId,
          description: `Voice clone "${body.name}"`,
          createdBy: auth.userId,
        });
        const [created] = await tx
          .insert(voices)
          .values({
            id: voiceId,
            workspaceId: auth.workspaceId,
            name: body.name,
            language: body.language,
            gender: body.gender,
            status: 'processing',
            // Who is going to do the cloning; the job confirms it with who actually did.
            provider: providers.voiceClone.info,
            sampleAssetId: sample.id,
            consentId: body.consentId,
            createdBy: auth.userId,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        if (sample.purpose !== 'voice_sample') {
          await tx
            .update(assets)
            .set({ purpose: 'voice_sample' })
            .where(and(eq(assets.id, sample.id), eq(assets.workspaceId, auth.workspaceId)));
        }
        return created;
      });

      await enqueueOrCompensate(
        queues,
        'voiceClone',
        { voiceId, workspaceId: auth.workspaceId },
        { jobId: voiceId },
        (error) => failVoice(db, auth.workspaceId, voiceId, error),
      );
      return toClonedVoiceDto(providers, row);
    });

    defineRoute(app, api.voiceClones.update, async ({ auth, params, body, app: instance }) => {
      const { db, providers } = instance;
      await findVoice(db, auth.workspaceId, params.voiceId);
      await assertContentAllowed(providers, { text: body.name, context: 'name', field: 'name' });
      const [updated] = await db
        .update(voices)
        .set({ name: body.name, updatedAt: new Date() })
        .where(and(eq(voices.id, params.voiceId), eq(voices.workspaceId, auth.workspaceId)))
        .returning();
      if (!updated) throw AppError.notFound('Voice');
      return toClonedVoiceDto(providers, updated);
    });

    defineRoute(app, api.voiceClones.remove, async ({ auth, params, app: instance }) => {
      const { db, providers, queues } = instance;
      const voice = await findVoice(db, auth.workspaceId, params.voiceId);
      // Row, sample.wav, source asset and the voice at the external provider (lib/person-data:
      // the same cascade a consent revocation runs). A provider failure keeps the row as
      // `failed` and is reported, so the deletion can be retried.
      const deleted = await deleteVoiceCascade(
        { db, providers, queues },
        auth.workspaceId,
        voice.id,
      );
      if (!deleted) throw AppError.notFound('Voice');
      // Deleted before the job finished: what was reserved goes back (no-op otherwise).
      if (voice.status === 'processing') {
        await refundCredits(db, {
          workspaceId: auth.workspaceId,
          refType: 'voice',
          refId: voice.id,
          description: 'Voice deleted before it was ready — credits refunded',
        });
      }
      return OK;
    });
  },
});
