import { randomInt } from 'node:crypto';
import { AppError, CREDIT_COSTS, OK, api, isAppError, newId } from '@parlante/shared';
import type { EngineStatus, PhotoLandmarks, Providers, StoredError } from '@parlante/shared';
import {
  and,
  assets,
  avatars,
  chargeCredits,
  consentRecords,
  count,
  eq,
  isNull,
  ne,
  refundCredits,
} from '@parlante/db';
import type { AvatarRow, Db, DbOrTx, WorkspaceRow } from '@parlante/db';
import { enqueueOrCompensate } from '@parlante/jobs';
import type { QueueClient } from '@parlante/jobs';
import { consumeConsent } from '../../lib/consent';
import { defineRoute } from '../../lib/define-route';
import { assertWithinLimit } from '../../lib/limits';
import { assertContentAllowed } from '../../lib/moderation';
import { defineModule } from '../../lib/modules';
import { deleteAvatarCascade } from '../../lib/person-data';
import { findAssetUses } from '../assets/service';
import { toWorkspaceAvatarDto } from '../avatars/catalog';
import { lockWorkspace } from '../workspaces/service';

/* -------------------------------------------------------------------------------------------
 * Photorealistic avatars of the workspace (feature 14, master prompt §2b).
 *
 *   create    from a PHOTO OF A REAL PERSON — requires a consent record (master prompt §5):
 *             `consumeConsent` runs inside the transaction that creates the avatar, so
 *             without a valid one nothing is created or charged (CONSENT_REQUIRED).
 *   generate  a SYNTHETIC person from a text description — no consent, but the prompt is
 *             moderated with context `avatar_prompt` (real, identifiable people are blocked).
 * Both are asynchronous: the API checks that the local engine can do the work BEFORE charging,
 * reserves the credits, inserts the row as `processing` and queues the `photoAvatar` job, which
 * persists progress and measured ETA on the row (`GET /api/avatars/:id`, avatars module).
 *   delete    row + storage prefix (portrait, matte, cut-out, cached clips) + source photo.
 * ----------------------------------------------------------------------------------------- */

type EngineOperation = 'generate' | 'prepare';

const OPERATION_LABEL: Record<EngineOperation, string> = {
  generate: 'generate portraits',
  prepare: 'prepare portraits',
};

/**
 * The local engine must be able to do the work right now. Checked BEFORE charging. The
 * engine's own reason ("not running", "weights missing"…) is the message, and its stable code
 * travels in `details.reason` (`engine_unreachable`, `weights_missing`… — the same values as
 * `Capabilities.avatarEngine.reasonCode`) so the UI can say it in the user's language.
 */
async function assertEngineCan(
  providers: Pick<Providers, 'portrait'>,
  operations: EngineOperation[],
): Promise<EngineStatus> {
  let status: EngineStatus;
  try {
    status = await providers.portrait.status();
  } catch (err) {
    if (isAppError(err) && err.code === 'PROVIDER_NOT_CONFIGURED') throw err;
    status = {
      available: false,
      reason: err instanceof Error ? err.message : 'The avatar engine status check failed',
      reasonCode: 'unknown',
      device: null,
      secondsPerVideoSecond: null,
    };
  }
  for (const operation of operations) {
    if (!(status.operations?.[operation] ?? status.available)) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        status.reason ??
          `The local avatar engine cannot ${OPERATION_LABEL[operation]} right now. Nothing was charged`,
        {
          capability: 'portrait',
          operation,
          provider: providers.portrait.info.id,
          // A running engine that cannot do ONE operation is missing that operation's weights.
          reason: status.reasonCode ?? (status.available ? 'weights_missing' : 'unknown'),
        },
      );
    }
  }
  return status;
}

/**
 * Read-only look at the consent BEFORE anything else is checked: a request without a valid
 * consent is refused as such (CONSENT_REQUIRED) whatever the state of the engine. The check
 * that counts is still `consumeConsent`, inside the transaction that creates the avatar.
 */
async function assertConsentAvailable(
  db: DbOrTx,
  input: { consentId: string; workspaceId: string; userId: string },
): Promise<void> {
  const [consent] = await db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.id, input.consentId),
        eq(consentRecords.workspaceId, input.workspaceId),
        eq(consentRecords.userId, input.userId),
        eq(consentRecords.kind, 'photo_avatar'),
        isNull(consentRecords.revokedAt),
        isNull(consentRecords.usedAt),
      ),
    );
  if (!consent) {
    throw new AppError(
      'CONSENT_REQUIRED',
      'A valid, unused consent declaration from you is required for this operation',
      { kind: 'photo_avatar' },
    );
  }
}

/** Image-space sanity of hand-marked landmarks (see `PhotoLandmarksSchema`). */
function assertLandmarksCoherent(landmarks: PhotoLandmarks | undefined): void {
  if (!landmarks) return;
  const eyeY = (landmarks.leftEye.y + landmarks.rightEye.y) / 2;
  const mouthY = (landmarks.mouthLeft.y + landmarks.mouthRight.y) / 2;
  const problems: string[] = [];
  if (landmarks.leftEye.x >= landmarks.rightEye.x) {
    problems.push('leftEye must be to the left of rightEye in the image');
  }
  if (landmarks.mouthLeft.x >= landmarks.mouthRight.x) {
    problems.push('mouthLeft must be to the left of mouthRight in the image');
  }
  if (!(eyeY < mouthY && mouthY < landmarks.chin.y)) {
    problems.push('eyes must be above the mouth and the mouth above the chin');
  }
  if (problems.length > 0) {
    throw AppError.validation(
      'The face landmarks are not coherent',
      problems.map((message) => ({ path: 'body.landmarks', message })),
    );
  }
}

async function findAvatar(db: DbOrTx, workspaceId: string, avatarId: string): Promise<AvatarRow> {
  const [row] = await db
    .select()
    .from(avatars)
    .where(and(eq(avatars.id, avatarId), eq(avatars.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Avatar');
  return row;
}

/** Photo and generated avatars share the plan allowance; failed ones do not count. */
async function assertRoomForAvatar(tx: DbOrTx, workspace: WorkspaceRow): Promise<void> {
  const [existing] = await tx
    .select({ n: count() })
    .from(avatars)
    .where(and(eq(avatars.workspaceId, workspace.id), ne(avatars.status, 'failed')));
  assertWithinLimit(workspace, 'maxPhotoAvatars', (existing?.n ?? 0) + 1);
}

/** Terminal failure before the worker ever saw the job: only an avatar still processing. */
async function failAvatar(db: Db, workspaceId: string, avatarId: string, error: StoredError) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(avatars)
      .set({ status: 'failed', error, etaSec: null, updatedAt: new Date() })
      .where(
        and(
          eq(avatars.id, avatarId),
          eq(avatars.workspaceId, workspaceId),
          eq(avatars.status, 'processing'),
        ),
      )
      .returning({ id: avatars.id });
    if (!row) return;
    await refundCredits(tx, {
      workspaceId,
      refType: 'avatar',
      refId: avatarId,
      description: 'Avatar could not be queued — credits refunded',
    });
  });
}

async function queueAvatarJob(
  deps: { db: Db; queues: QueueClient },
  workspaceId: string,
  avatarId: string,
): Promise<void> {
  await enqueueOrCompensate(
    deps.queues,
    'photoAvatar',
    { avatarId, workspaceId },
    { jobId: avatarId },
    (error) => failAvatar(deps.db, workspaceId, avatarId, error),
  );
}

export default defineModule({
  name: 'photo-avatars',
  register(app) {
    defineRoute(app, api.photoAvatars.create, async ({ auth, body, app: instance }) => {
      const { db, providers, queues, fileUrl } = instance;
      assertLandmarksCoherent(body.landmarks);
      await assertConsentAvailable(db, {
        consentId: body.consentId,
        workspaceId: auth.workspaceId,
        userId: auth.userId,
      });
      await assertContentAllowed(providers, { text: body.name, context: 'name', field: 'name' });
      await assertEngineCan(providers, ['prepare']);

      const avatarId = newId('avatar');
      const row = await db.transaction(async (tx) => {
        const workspace = await lockWorkspace(tx, auth.workspaceId);

        const [photo] = await tx
          .select()
          .from(assets)
          .where(and(eq(assets.id, body.imageAssetId), eq(assets.workspaceId, auth.workspaceId)))
          .for('update');
        if (!photo) throw AppError.notFound('Photo');
        if (photo.kind !== 'image') {
          throw AppError.validation('The avatar photo must be an image', [
            { path: 'body.imageAssetId', message: `This file is ${photo.kind}, not an image` },
          ]);
        }
        // The photo is deleted with its avatar: it cannot also be the source of something else.
        const usedBy = await findAssetUses(tx, auth.workspaceId, photo.id);
        if (usedBy.length > 0) {
          throw new AppError('CONFLICT', 'This file is already the source of another resource', {
            usedBy,
          });
        }
        await assertRoomForAvatar(tx, workspace);

        // Master prompt §5: no valid consent record → CONSENT_REQUIRED, nothing is created.
        await consumeConsent(tx, {
          consentId: body.consentId,
          kind: 'photo_avatar',
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          resourceId: avatarId,
        });
        await chargeCredits(tx, {
          workspaceId: auth.workspaceId,
          amount: CREDIT_COSTS.photoAvatar,
          reason: 'photo_avatar',
          refType: 'avatar',
          refId: avatarId,
          description: `Photo avatar "${body.name}"`,
          createdBy: auth.userId,
        });
        const [created] = await tx
          .insert(avatars)
          .values({
            id: avatarId,
            workspaceId: auth.workspaceId,
            name: body.name,
            gender: body.gender,
            status: 'processing',
            progress: 0,
            origin: 'photo',
            sourceAssetId: photo.id,
            requestedLandmarks: body.landmarks ?? null,
            // The engine that will do the work; the job confirms it.
            provider: providers.portrait.info,
            consentId: body.consentId,
            createdBy: auth.userId,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        if (photo.purpose !== 'avatar_source') {
          await tx
            .update(assets)
            .set({ purpose: 'avatar_source' })
            .where(and(eq(assets.id, photo.id), eq(assets.workspaceId, auth.workspaceId)));
        }
        return created;
      });

      await queueAvatarJob({ db, queues }, auth.workspaceId, avatarId);
      return toWorkspaceAvatarDto({ providers, fileUrl }, row);
    });

    defineRoute(app, api.photoAvatars.generate, async ({ auth, body, app: instance }) => {
      const { db, providers, queues, fileUrl } = instance;
      await assertContentAllowed(providers, [
        { text: body.name, context: 'name', field: 'name' },
        // `avatar_prompt` also rejects descriptions of real, identifiable people and minors.
        { text: body.prompt, context: 'avatar_prompt', field: 'prompt' },
      ]);
      const engine = await assertEngineCan(providers, ['generate', 'prepare']);

      const avatarId = newId('avatar');
      const row = await db.transaction(async (tx) => {
        const workspace = await lockWorkspace(tx, auth.workspaceId);
        await assertRoomForAvatar(tx, workspace);
        await chargeCredits(tx, {
          workspaceId: auth.workspaceId,
          amount: CREDIT_COSTS.generatedAvatar,
          reason: 'generated_avatar',
          refType: 'avatar',
          refId: avatarId,
          description: `Generated avatar "${body.name}"`,
          createdBy: auth.userId,
        });
        const [created] = await tx
          .insert(avatars)
          .values({
            id: avatarId,
            workspaceId: auth.workspaceId,
            name: body.name,
            gender: body.gender,
            status: 'processing',
            progress: 0,
            // First estimate = the engine's MEASURED time per portrait; the job refines it.
            etaSec:
              typeof engine.secondsPerPortrait === 'number' &&
              Number.isFinite(engine.secondsPerPortrait)
                ? Math.max(0, Math.round(engine.secondsPerPortrait))
                : null,
            origin: 'generated',
            prompt: body.prompt,
            seed: body.seed ?? randomInt(0, 2_147_483_647),
            provider: providers.portrait.info,
            consentId: null,
            createdBy: auth.userId,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        return created;
      });

      await queueAvatarJob({ db, queues }, auth.workspaceId, avatarId);
      return toWorkspaceAvatarDto({ providers, fileUrl }, row);
    });

    defineRoute(app, api.photoAvatars.update, async ({ auth, params, body, app: instance }) => {
      const { db, providers, fileUrl } = instance;
      const current = await findAvatar(db, auth.workspaceId, params.avatarId);
      assertLandmarksCoherent(body.landmarks);
      if (body.name !== undefined) {
        await assertContentAllowed(providers, { text: body.name, context: 'name', field: 'name' });
      }
      if (body.landmarks && (current.status !== 'ready' || !current.rig)) {
        throw AppError.invalidState(
          'Landmarks can be adjusted once the avatar is ready (they are relative to its prepared portrait)',
        );
      }
      const [updated] = await db
        .update(avatars)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          // Relative to the prepared portrait; the preparation is NOT run again.
          ...(body.landmarks && current.rig
            ? { rig: { ...current.rig, landmarks: body.landmarks, landmarksSource: 'user' } }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(avatars.id, current.id), eq(avatars.workspaceId, auth.workspaceId)))
        .returning();
      if (!updated) throw AppError.notFound('Avatar');
      return toWorkspaceAvatarDto({ providers, fileUrl }, updated);
    });

    defineRoute(app, api.photoAvatars.remove, async ({ auth, params, app: instance }) => {
      const { db, providers, queues } = instance;
      const avatar = await findAvatar(db, auth.workspaceId, params.avatarId);
      // Row, storage prefix (portrait, matte, cut-out, cached clips) and, for photo avatars,
      // the source photo — the same cascade a consent revocation runs (lib/person-data).
      const deleted = await deleteAvatarCascade(
        { db, providers, queues },
        auth.workspaceId,
        avatar.id,
      );
      if (!deleted) throw AppError.notFound('Avatar');
      // Deleted before the job finished: what was reserved goes back (no-op otherwise).
      if (avatar.status === 'processing') {
        await refundCredits(db, {
          workspaceId: auth.workspaceId,
          refType: 'avatar',
          refId: avatar.id,
          description: 'Avatar deleted before it was ready — credits refunded',
        });
      }
      return OK;
    });
  },
});
