import { AppError } from '@parlante/shared';
import type { Providers } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import {
  and,
  avatars,
  count,
  eq,
  members,
  translationJobs,
  voices,
  workspaces,
} from '@parlante/db';
import type { Db, DbOrTx, MemberRow, WorkspaceRow } from '@parlante/db';
import { deleteExternalVoice } from '../../lib/person-data';

/* Helpers shared by the identity modules (workspaces, members, api-keys, webhooks, billing). */

/**
 * Lock the workspace row for the rest of the transaction and return it fresh. Every change
 * guarded by a count ("one owner must remain", plan limits such as maxMembers / maxApiKeys)
 * takes this lock first, so two concurrent requests cannot both pass the check.
 */
export async function lockWorkspace(tx: DbOrTx, workspaceId: string): Promise<WorkspaceRow> {
  const [workspace] = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for('update');
  if (!workspace) throw AppError.notFound('Workspace');
  return workspace;
}

export async function countMembers(db: DbOrTx, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(members)
    .where(eq(members.workspaceId, workspaceId));
  return row?.n ?? 0;
}

export async function countOwners(db: DbOrTx, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.role, 'owner')));
  return row?.n ?? 0;
}

/** Membership of a user in a workspace, or null. */
export async function findMembership(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
): Promise<MemberRow | null> {
  const [member] = await db
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
  return member ?? null;
}

/**
 * Delete a workspace and everything in it: voices at external providers, every stored file
 * under its prefix and all its rows. Files go first (see lib/person-data.ts): a failure
 * half-way leaves the workspace in place so the owner can retry, never files without rows.
 */
export async function deleteWorkspaceCascade(
  deps: { db: Db; providers: Pick<Providers, 'storage' | 'voiceClone'> },
  workspaceId: string,
): Promise<void> {
  const { db, providers } = deps;
  const prefix = storageKeys.workspacePrefix(workspaceId);
  const clonedVoices = await db.select().from(voices).where(eq(voices.workspaceId, workspaceId));
  for (const voice of clonedVoices) {
    await deleteExternalVoice(providers, voice);
    // The external voice is gone: drop the row now so a retry does not ask the provider again.
    await db
      .delete(voices)
      .where(and(eq(voices.id, voice.id), eq(voices.workspaceId, workspaceId)));
  }
  await providers.storage.deletePrefix(prefix);
  await db.transaction(async (tx) => {
    // Rows held by RESTRICT foreign keys (consent → avatar / voice, asset → translation) are
    // removed explicitly so the cascade from `workspaces` never trips over their order.
    await tx.delete(translationJobs).where(eq(translationJobs.workspaceId, workspaceId));
    await tx.delete(avatars).where(eq(avatars.workspaceId, workspaceId));
    await tx.delete(voices).where(eq(voices.workspaceId, workspaceId));
    await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
  });
  // Jobs that were running may have written files after the first sweep.
  await providers.storage.deletePrefix(prefix);
}
