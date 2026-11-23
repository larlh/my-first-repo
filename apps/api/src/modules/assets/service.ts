import { AppError, newId } from '@parlante/shared';
import type { Asset, AssetKind, AssetPurpose, Providers, UserRef } from '@parlante/shared';
import { storageKeys } from '@parlante/shared/node';
import { and, assets, avatars, eq, sum, translationJobs, voices } from '@parlante/db';
import type { AssetRow, Db, DbOrTx, WorkspaceRow } from '@parlante/db';
import type { FileUrlBuilder } from '@parlante/jobs';
import { iso } from '../../lib/dto';
import { assertWithinLimit } from '../../lib/limits';
import type { ReceivedUpload } from '../../lib/uploads';
import { lockWorkspace } from '../workspaces/service';
import { inspectMedia } from './media';

/* -------------------------------------------------------------------------------------------
 * Asset storage shared by `POST /api/assets` and any other upload entry point of the API
 * (the public `POST /v1/assets` stores files in exactly the same way): inspection, plan quota,
 * storage layout and row. Routes only receive the upload and map the row to a DTO.
 * ----------------------------------------------------------------------------------------- */

export interface AssetDeps {
  db: Db;
  providers: Pick<Providers, 'storage'>;
}

/** The kind of file each upload purpose needs (`library` takes any). */
const KIND_FOR_PURPOSE: Partial<Record<AssetPurpose, AssetKind>> = {
  avatar_source: 'image',
  voice_sample: 'audio',
  translation_source: 'video',
};

/** Row → DTO in ONE place: files only as signed URLs, never storage keys. */
export async function toAssetDto(
  fileUrl: FileUrlBuilder,
  row: AssetRow,
  creator: UserRef | null,
): Promise<Asset> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    purpose: row.purpose,
    name: row.name,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    url: await fileUrl(row.storageKey),
    thumbnailUrl: await fileUrl(row.thumbnailKey),
    createdBy: creator ? { id: creator.id, name: creator.name } : null,
    createdAt: iso(row.createdAt),
  };
}

/** Bytes the workspace stores as assets (the figure the billing overview reports as usage). */
export async function storageBytesUsed(db: DbOrTx, workspaceId: string): Promise<number> {
  const [row] = await db
    .select({ bytes: sum(assets.sizeBytes) })
    .from(assets)
    .where(eq(assets.workspaceId, workspaceId));
  return Number(row?.bytes ?? 0);
}

export interface StoreUploadInput {
  /** The authenticated workspace (`auth.workspace`). */
  workspace: Pick<WorkspaceRow, 'id' | 'plan'>;
  /** null for API-key requests. */
  userId: string | null;
  upload: ReceivedUpload;
  /** Display name; defaults to the sanitised file name. */
  name?: string | undefined;
  purpose?: AssetPurpose | undefined;
}

/**
 * Turn a received upload into a stored asset of the workspace:
 *  1. read the file (real dimensions / duration, preview) — unreadable media is rejected
 *  2. check that it suits its purpose (a face photo is an image, a voice sample is audio…)
 *  3. plan storage quota, checked again under the workspace lock next to the insert, so
 *     concurrent uploads cannot both take the last bytes
 *  4. files under `storageKeys.assetPrefix`, then the row; files are removed if the row fails
 * The caller owns `upload.cleanup()`.
 */
export async function storeUploadedAsset(
  deps: AssetDeps,
  input: StoreUploadInput,
): Promise<AssetRow> {
  const { db, providers } = deps;
  const { upload } = input;
  const workspaceId = input.workspace.id;
  const purpose = input.purpose ?? 'library';
  const media = await inspectMedia({
    path: upload.tmpPath,
    kind: upload.kind,
    mimeType: upload.mimeType,
  });

  const expectedKind = KIND_FOR_PURPOSE[purpose];
  if (expectedKind && media.kind !== expectedKind) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `A file uploaded as ${purpose} must be ${expectedKind}, but this one is ${media.kind}`,
      { purpose, expected: expectedKind, detected: media.mimeType },
    );
  }

  // Cheap early answer before copying a large file; the binding check is the locked one below.
  assertWithinLimit(
    input.workspace,
    'maxStorageBytes',
    (await storageBytesUsed(db, workspaceId)) + upload.sizeBytes,
  );

  const id = newId('asset');
  const storageKey = storageKeys.asset(workspaceId, id, upload.ext);
  const thumbnailKey = media.thumbnail ? storageKeys.assetThumb(workspaceId, id) : null;
  const name = input.name?.trim() || upload.filename;
  try {
    await providers.storage.put(
      storageKey,
      { filePath: upload.tmpPath },
      { contentType: media.mimeType },
    );
    if (media.thumbnail && thumbnailKey) {
      await providers.storage.put(thumbnailKey, media.thumbnail, { contentType: 'image/jpeg' });
    }
    return await db.transaction(async (tx) => {
      const locked = await lockWorkspace(tx, workspaceId);
      assertWithinLimit(
        locked,
        'maxStorageBytes',
        (await storageBytesUsed(tx, workspaceId)) + upload.sizeBytes,
      );
      const [row] = await tx
        .insert(assets)
        .values({
          id,
          workspaceId,
          kind: media.kind,
          purpose,
          name: name.slice(0, 120),
          mimeType: media.mimeType,
          sizeBytes: upload.sizeBytes,
          width: media.width,
          height: media.height,
          durationMs: media.durationMs,
          storageKey,
          thumbnailKey,
          createdBy: input.userId,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    });
  } catch (err) {
    await providers.storage.deletePrefix(storageKeys.assetPrefix(workspaceId, id)).catch(() => {
      // Best effort: the original error is the one worth reporting.
    });
    throw err;
  }
}

export interface AssetUse {
  type: 'translationJob' | 'avatar' | 'voice';
  id: string;
}

/** Resources that were created FROM this asset and still need it (they block its deletion). */
export async function findAssetUses(
  db: DbOrTx,
  workspaceId: string,
  assetId: string,
): Promise<AssetUse[]> {
  // One after another: inside a transaction all three run on the same connection.
  const jobs = await db
    .select({ id: translationJobs.id })
    .from(translationJobs)
    .where(
      and(eq(translationJobs.sourceAssetId, assetId), eq(translationJobs.workspaceId, workspaceId)),
    );
  const sourcedAvatars = await db
    .select({ id: avatars.id })
    .from(avatars)
    .where(and(eq(avatars.sourceAssetId, assetId), eq(avatars.workspaceId, workspaceId)));
  const sampledVoices = await db
    .select({ id: voices.id })
    .from(voices)
    .where(and(eq(voices.sampleAssetId, assetId), eq(voices.workspaceId, workspaceId)));
  return [
    ...jobs.map((row) => ({ type: 'translationJob' as const, id: row.id })),
    ...sourcedAvatars.map((row) => ({ type: 'avatar' as const, id: row.id })),
    ...sampledVoices.map((row) => ({ type: 'voice' as const, id: row.id })),
  ];
}

/**
 * Delete an asset of the workspace with every file under its prefix. Throws NOT_FOUND for a
 * missing / foreign asset and CONFLICT (`details.usedBy`) while a translation job, photo
 * avatar or cloned voice uses it as its source.
 *
 * The row is locked for the whole operation, so a resource cannot start referencing the asset
 * half-way; files go before the row inside the transaction, so a storage failure keeps the
 * row (retry removes the rest) and there are never files left without a row.
 */
export async function deleteAsset(
  deps: AssetDeps,
  workspaceId: string,
  assetId: string,
): Promise<void> {
  const scope = and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId));
  await deps.db.transaction(async (tx) => {
    const [asset] = await tx.select().from(assets).where(scope).for('update');
    if (!asset) throw AppError.notFound('Asset');
    const usedBy = await findAssetUses(tx, workspaceId, assetId);
    if (usedBy.length > 0) {
      throw new AppError(
        'CONFLICT',
        'This file is the source of another resource. Delete that resource first',
        { usedBy },
      );
    }
    await deps.providers.storage.deletePrefix(storageKeys.assetPrefix(workspaceId, assetId));
    await tx.delete(assets).where(scope);
  });
}
