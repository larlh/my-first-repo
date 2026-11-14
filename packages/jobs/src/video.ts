import type { PublicVideo } from '@parlante/shared';
import type { VideoRow } from '@parlante/db';
import type { FileUrlBuilder, FileUrlOptions } from './file-urls';

/**
 * Row → PublicVideo, the representation used by the public API v1 AND inside webhook payloads
 * (both must stay identical, hence this single mapper).
 */
export async function toPublicVideo(
  row: VideoRow,
  fileUrl: FileUrlBuilder,
  urlOptions: FileUrlOptions = {},
): Promise<PublicVideo> {
  const done = row.status === 'completed';
  const [videoUrl, thumbnailUrl, srtUrl, vttUrl] = await Promise.all([
    fileUrl(done ? row.videoKey : null, urlOptions),
    fileUrl(row.thumbnailKey, urlOptions),
    fileUrl(done ? row.srtKey : null, urlOptions),
    fileUrl(done ? row.vttKey : null, urlOptions),
  ]);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    progress: row.progress,
    aspect: row.aspect,
    resolution: row.resolution,
    durationMs: row.durationMs,
    videoUrl,
    thumbnailUrl,
    srtUrl,
    vttUrl,
    providers: row.providers,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    renderedAt: row.renderedAt ? row.renderedAt.toISOString() : null,
  };
}
