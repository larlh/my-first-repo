import { AppError, OK, api, newId, usesPhotorealAvatars } from '@parlante/shared';
import type { PublicShare, ShareLink } from '@parlante/shared';
import { randomToken } from '@parlante/shared/node';
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  or,
  renderJobs,
  shareLinks,
  sql,
  videos,
  workspaces,
} from '@parlante/db';
import type { ShareLinkRow } from '@parlante/db';
import { videoDownloadName } from '@parlante/jobs';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import { findVideo } from '../videos/service';

/**
 * Length of the public token: 24 characters of [a-z0-9] from the CSPRNG ≈ 124 bits, far
 * beyond guessing; the token is the only thing that grants access to the public page.
 */
const TOKEN_LENGTH = 24;

/** Row → DTO in ONE place. Dates as ISO strings; URLs built by the server. */
function toShareDto(row: ShareLinkRow, publicWebUrl: string): ShareLink {
  return {
    id: row.id,
    videoId: row.videoId,
    token: row.token,
    url: `${publicWebUrl.replace(/\/+$/, '')}/s/${row.token}`,
    enabled: row.enabled,
    allowDownload: row.allowDownload,
    viewCount: row.viewCount,
    expiresAt: isoOrNull(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

export default defineModule({
  name: 'share',
  register(app) {
    defineRoute(app, api.share.get, async ({ auth, params, app: { db, config } }) => {
      await findVideo(db, auth.workspaceId, params.videoId);
      const [row] = await db
        .select()
        .from(shareLinks)
        .where(
          and(eq(shareLinks.videoId, params.videoId), eq(shareLinks.workspaceId, auth.workspaceId)),
        );
      return { share: row ? toShareDto(row, config.PUBLIC_WEB_URL) : null };
    });

    defineRoute(app, api.share.upsert, async ({ auth, params, body, app: { db, config } }) => {
      const video = await findVideo(db, auth.workspaceId, params.videoId);
      const [existing] = await db
        .select({ id: shareLinks.id })
        .from(shareLinks)
        .where(and(eq(shareLinks.videoId, video.id), eq(shareLinks.workspaceId, auth.workspaceId)));
      // A link is created for a finished video. Once it exists it shows the current output,
      // so it can still be paused or changed while a newer render is in progress.
      if (!video.videoKey || (!existing && video.status !== 'completed')) {
        throw AppError.invalidState('Only completed videos can be shared');
      }
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw AppError.validation('The expiry date must be in the future', [
          { path: 'expiresAt', message: 'Must be in the future' },
        ]);
      }
      const values = {
        enabled: body.enabled,
        allowDownload: body.allowDownload,
        expiresAt,
        updatedAt: new Date(),
      };
      // One link per video (unique index): the token is created once and survives updates,
      // so pausing and resuming a link does not break URLs already handed out. Deleting the
      // link is what revokes the token for good.
      const [row] = await db
        .insert(shareLinks)
        .values({
          id: newId('shareLink'),
          workspaceId: auth.workspaceId,
          videoId: video.id,
          token: randomToken(TOKEN_LENGTH),
          createdBy: auth.userId,
          ...values,
        })
        .onConflictDoUpdate({
          target: shareLinks.videoId,
          set: values,
          // Never touch a row of another workspace (cannot happen: the video is ours).
          setWhere: eq(shareLinks.workspaceId, auth.workspaceId),
        })
        .returning();
      if (!row) throw new Error('Upsert returned no row');
      return toShareDto(row, config.PUBLIC_WEB_URL);
    });

    defineRoute(app, api.share.remove, async ({ auth, params, app: { db } }) => {
      await findVideo(db, auth.workspaceId, params.videoId);
      // The workspace filter is repeated on every write: never update/delete by id alone.
      await db
        .delete(shareLinks)
        .where(
          and(eq(shareLinks.videoId, params.videoId), eq(shareLinks.workspaceId, auth.workspaceId)),
        );
      return OK;
    });

    /**
     * The public page. No session: the token is the credential. A token that does not exist,
     * a link that is paused or expired and a video without output all answer the same 404,
     * so nothing can be learnt by probing. Only what the page shows leaves the workspace.
     */
    defineRoute(
      app,
      api.share.public,
      async ({ params, app: { db, fileUrl } }): Promise<PublicShare> => {
        const now = new Date();
        // Counting the view and reading the link are one statement: concurrent visitors are all
        // counted and a link disabled a moment ago is not served.
        const [link] = await db
          .update(shareLinks)
          .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
          .where(
            and(
              eq(shareLinks.token, params.token),
              eq(shareLinks.enabled, true),
              or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
            ),
          )
          .returning();
        if (!link) throw AppError.notFound('Shared video');
        const [found] = await db
          .select({ video: videos, workspaceName: workspaces.name })
          .from(videos)
          .innerJoin(workspaces, eq(workspaces.id, videos.workspaceId))
          .where(and(eq(videos.id, link.videoId), eq(videos.workspaceId, link.workspaceId)));
        if (!found?.video.videoKey) throw AppError.notFound('Shared video');
        const { video } = found;
        // The label describes the file being shown, i.e. the document that was rendered — the
        // video may have been edited since (and not rendered again).
        const [rendered] = await db
          .select({ composition: renderJobs.composition })
          .from(renderJobs)
          .where(
            and(
              eq(renderJobs.videoId, video.id),
              eq(renderJobs.workspaceId, video.workspaceId),
              eq(renderJobs.status, 'completed'),
            ),
          )
          .orderBy(desc(renderJobs.finishedAt), desc(renderJobs.id))
          .limit(1);
        const [videoUrl, thumbnailUrl, vttUrl, downloadUrl] = await Promise.all([
          fileUrl(found.video.videoKey),
          fileUrl(video.thumbnailKey),
          fileUrl(video.vttKey),
          link.allowDownload
            ? fileUrl(found.video.videoKey, { downloadName: videoDownloadName(video) })
            : null,
        ]);
        return {
          title: video.title,
          aspect: video.aspect,
          durationMs: video.durationMs,
          videoUrl,
          thumbnailUrl,
          vttUrl,
          downloadUrl,
          workspaceName: found.workspaceName,
          providers: video.providers,
          aiGenerated: usesPhotorealAvatars(rendered?.composition ?? video.composition),
          createdAt: iso(video.createdAt),
        };
      },
    );
  },
});
