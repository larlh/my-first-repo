import { AppError, toStoredError } from '@parlante/shared';
import type { Providers } from '@parlante/shared';
import { sha256Hex, storageKeys, workspaceOfStorageKey } from '@parlante/shared/node';
import { and, assets, avatars, eq, voices } from '@parlante/db';
import type { AssetRow, Db, VoiceRow } from '@parlante/db';
import type { QueueClient } from '@parlante/jobs';

/* -------------------------------------------------------------------------------------------
 * Cascade deletion of everything derived from a real person (master prompt §5).
 *
 * ONE implementation for the three places that must remove exactly the same data:
 *   - `POST   /api/consents/:id/revoke`   (consent module)
 *   - `DELETE /api/photo-avatars/:id`     (photo-avatars module)
 *   - `DELETE /api/voice-clones/:id`      (voice-clones module)
 *
 * What goes away: the avatar / voice row, its whole storage prefix (portrait, matte, cut-out,
 * cached neural clips / sample.wav), the voice at the external provider, the SOURCE ASSET
 * (photo / voice sample) with its files, and what the avatar engine cached about the portrait
 * (features derived from the face: `PortraitProvider.forget`).
 *
 * Both functions are idempotent and retriable: files are deleted BEFORE the row, so a failure
 * half-way leaves a row that points the next attempt at what is still to be removed — never
 * orphaned files of a person without a row.
 * ----------------------------------------------------------------------------------------- */

export interface PersonDataDeps {
  db: Db;
  providers: Pick<Providers, 'storage' | 'voiceClone'> & Partial<Pick<Providers, 'portrait'>>;
  queues: QueueClient;
}

/** Remove a pending job of the resource so the worker does not start (best effort). */
async function dropPendingJob(
  queues: QueueClient,
  key: 'photoAvatar' | 'voiceClone',
  jobId: string,
): Promise<void> {
  try {
    await queues.remove(key, jobId);
  } catch {
    // Queue backend down or job already active: the worker finds no row and gives up.
  }
}

/** Delete the files and the row of a source asset (photo / voice sample) of this workspace. */
async function deleteSourceAsset(
  deps: PersonDataDeps,
  workspaceId: string,
  assetId: string | null,
): Promise<void> {
  if (!assetId) return;
  const { db, providers } = deps;
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
  await providers.storage.deletePrefix(storageKeys.assetPrefix(workspaceId, assetId));
  if (!asset) return;
  await deleteStrayAssetFiles(deps, workspaceId, asset);
  await db.delete(assets).where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
}

/** Keys normally live under the asset prefix; remove them explicitly if a row says otherwise. */
async function deleteStrayAssetFiles(
  deps: PersonDataDeps,
  workspaceId: string,
  asset: AssetRow,
): Promise<void> {
  const prefix = storageKeys.assetPrefix(workspaceId, asset.id);
  for (const key of [asset.storageKey, asset.thumbnailKey]) {
    if (!key || key.startsWith(prefix)) continue;
    // Never follow a key into another workspace or into the shared cache.
    if (workspaceOfStorageKey(key) !== workspaceId) continue;
    await deps.providers.storage.delete(key);
  }
}

/**
 * The avatar engine keeps a cache of the features it derives from a prepared portrait, keyed
 * by the hash of the portrait file. Ask the provider to drop it BEFORE the file is deleted
 * (afterwards nobody can tell which entry it was). A failure propagates: the deletion is
 * retried rather than leaving data derived from a person behind.
 */
async function forgetPortrait(
  deps: PersonDataDeps,
  workspaceId: string,
  imageKey: string | null,
): Promise<void> {
  const portrait = deps.providers.portrait;
  if (!portrait?.forget || !imageKey) return;
  if (workspaceOfStorageKey(imageKey) !== workspaceId) return;
  if (!(await deps.providers.storage.exists(imageKey))) return;
  const portraitSha256 = sha256Hex(await deps.providers.storage.get(imageKey));
  await portrait.forget({ portraitSha256 });
}

/**
 * Delete a workspace avatar with its images, cached clips and (photo avatars) the source photo.
 * Returns false when there was no such avatar in the workspace (its prefix is cleaned anyway).
 */
export async function deleteAvatarCascade(
  deps: PersonDataDeps,
  workspaceId: string,
  avatarId: string,
): Promise<boolean> {
  const { db, providers, queues } = deps;
  const prefix = storageKeys.avatarPrefix(workspaceId, avatarId);
  const [avatar] = await db
    .select({
      id: avatars.id,
      origin: avatars.origin,
      sourceAssetId: avatars.sourceAssetId,
      imageKey: avatars.imageKey,
    })
    .from(avatars)
    .where(and(eq(avatars.id, avatarId), eq(avatars.workspaceId, workspaceId)));
  if (avatar) await forgetPortrait(deps, workspaceId, avatar.imageKey);
  // The prefix carries the workspace id, so sweeping it is safe even without a row; the job
  // id does not, so the job is only withdrawn for an avatar that belongs to this workspace.
  await providers.storage.deletePrefix(prefix);
  if (!avatar) return false;

  await dropPendingJob(queues, 'photoAvatar', avatarId);
  await deleteSourceAsset(deps, workspaceId, avatar.sourceAssetId);
  await db
    .delete(avatars)
    .where(and(eq(avatars.id, avatarId), eq(avatars.workspaceId, workspaceId)));
  // A job that was already running may have written files after the first sweep.
  await providers.storage.deletePrefix(prefix);
  return true;
}

/**
 * Remove a cloned voice from the external service that hosts it. Local voice profiles have
 * nothing outside this machine. Throws when the voice cannot be removed there:
 *  - PROVIDER_NOT_CONFIGURED: it was created with a provider that is not the active one;
 *  - PROVIDER_ERROR: the provider refused or could not be reached.
 */
export async function deleteExternalVoice(
  providers: Pick<Providers, 'voiceClone'>,
  voice: Pick<VoiceRow, 'provider' | 'providerVoiceId'>,
): Promise<void> {
  if (!voice.provider || voice.provider.local || !voice.providerVoiceId) return;
  const active = providers.voiceClone;
  if (active.info.id !== voice.provider.id) {
    throw new AppError(
      'PROVIDER_NOT_CONFIGURED',
      `This voice is stored at ${voice.provider.name}, which is not configured now. Configure it and try again to delete the voice there`,
      { provider: voice.provider.id },
    );
  }
  try {
    await active.deleteVoice(voice.providerVoiceId);
  } catch (err) {
    throw new AppError(
      'PROVIDER_ERROR',
      `${voice.provider.name} could not delete the voice. Try again`,
      { provider: voice.provider.id },
      { cause: err },
    );
  }
}

/**
 * Delete a cloned voice with its sample, its source asset and the voice at the external
 * provider. Returns false when there was no such voice in the workspace.
 *
 * When the external provider cannot delete the voice, everything local is already gone and
 * the row is kept as `failed` (unusable for synthesis) so that a retry can finish the job;
 * the provider error is rethrown.
 */
export async function deleteVoiceCascade(
  deps: PersonDataDeps,
  workspaceId: string,
  voiceId: string,
): Promise<boolean> {
  const { db, providers, queues } = deps;
  const prefix = storageKeys.voicePrefix(workspaceId, voiceId);
  const scope = and(eq(voices.id, voiceId), eq(voices.workspaceId, workspaceId));
  const [voice] = await db.select().from(voices).where(scope);
  await providers.storage.deletePrefix(prefix);
  if (!voice) return false;

  await dropPendingJob(queues, 'voiceClone', voiceId);
  await deleteSourceAsset(deps, workspaceId, voice.sampleAssetId);
  try {
    await deleteExternalVoice(providers, voice);
  } catch (err) {
    await db
      .update(voices)
      .set({ status: 'failed', error: toStoredError(err), updatedAt: new Date() })
      .where(scope);
    throw err;
  }
  await db.delete(voices).where(scope);
  await providers.storage.deletePrefix(prefix);
  return true;
}
