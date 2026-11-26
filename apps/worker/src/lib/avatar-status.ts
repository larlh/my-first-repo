import type { StoredError } from '@parlante/shared';
import { and, avatars, eq, refundCredits } from '@parlante/db';
import type { WorkerContext } from '../context';

/* -------------------------------------------------------------------------------------------
 * Status of a workspace photoreal avatar while the photo-avatar job prepares / generates it
 * (owner of the job: worker-aux). Clients poll `GET /api/avatars/:id`, so progress and the
 * measured time remaining are PERSISTED on the row (§2b: generating on CPU takes minutes and
 * the user must see how long).
 *
 * Credits: the API charged with ledger ref `{ refType: 'avatar', refId: avatarId }`
 * (reason `photo_avatar` / `generated_avatar`); a final failure refunds that ref here.
 * ----------------------------------------------------------------------------------------- */

interface AvatarRef {
  avatarId: string;
  workspaceId: string;
}

const avatarWhere = (ref: AvatarRef) =>
  and(eq(avatars.id, ref.avatarId), eq(avatars.workspaceId, ref.workspaceId));

/**
 * Persist progress (0..100, capped at 99 until the job stores the result) and the estimated
 * seconds remaining. Only touches avatars still `processing`. Wrap it with `throttled()`:
 *
 *   const report = throttled((p: number, eta: number | null) =>
 *     reportAvatarProgress(ctx, ref, p, eta), 1000);
 *   await providers.portrait.generate({ …, onProgress: (e) => void report(e.fraction * 60, e.etaSec ?? null) });
 *   await report.flush();
 */
export async function reportAvatarProgress(
  ctx: Pick<WorkerContext, 'db'>,
  ref: AvatarRef,
  percent: number,
  etaSec: number | null = null,
): Promise<void> {
  await ctx.db
    .update(avatars)
    .set({
      progress: Math.min(99, Math.max(0, Math.round(percent))),
      etaSec: etaSec === null ? null : Math.max(0, Math.round(etaSec)),
      updatedAt: new Date(),
    })
    .where(and(avatarWhere(ref), eq(avatars.status, 'processing')));
}

/**
 * Terminal failure: stores the error and refunds the avatar's credits. Idempotent (acts only
 * while the avatar is `processing`), so it serves both the handler's failure path and the
 * job's `onFinalFailure`. Returns whether it changed anything.
 */
export async function markAvatarFailed(
  ctx: Pick<WorkerContext, 'db'>,
  ref: AvatarRef,
  error: StoredError,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(avatars)
      .set({ status: 'failed', etaSec: null, error, updatedAt: new Date() })
      .where(and(avatarWhere(ref), eq(avatars.status, 'processing')))
      .returning({ id: avatars.id });
    if (!row) return false;
    await refundCredits(tx, {
      workspaceId: ref.workspaceId,
      refType: 'avatar',
      refId: ref.avatarId,
      description: 'Avatar creation failed — credits refunded',
    });
    return true;
  });
}
