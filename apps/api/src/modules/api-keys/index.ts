import { AppError, OK, api } from '@parlante/shared';
import type { ApiKey } from '@parlante/shared';
import { and, apiKeys, desc, eq, isNull, users } from '@parlante/db';
import type { ApiKeyRow, Db } from '@parlante/db';
import { createApiKey } from '../../lib/auth';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull, toUserRef } from '../../lib/dto';
import { assertWithinLimit } from '../../lib/limits';
import { defineModule } from '../../lib/modules';
import { lockWorkspace } from '../workspaces/service';

/**
 * Row → DTO. The row holds only the SHA-256 of the key (`keyHash`), and this mapper does not
 * read it: the plain key exists in exactly one response, the one that creates it.
 */
function toApiKeyDto(row: ApiKeyRow, creator: { id: string; name: string } | null): ApiKey {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    createdBy: toUserRef(creator),
    lastUsedAt: isoOrNull(row.lastUsedAt),
    revokedAt: isoOrNull(row.revokedAt),
    createdAt: iso(row.createdAt),
  };
}

export default defineModule({
  name: 'api-keys',
  register(app) {
    defineRoute(app, api.apiKeys.list, async ({ auth, app: { db } }) => {
      // Revoked keys stay listed (with `revokedAt`) as the audit trail of the workspace.
      const rows = await db
        .select({ apiKey: apiKeys, creator: { id: users.id, name: users.name } })
        .from(apiKeys)
        .leftJoin(users, eq(apiKeys.createdBy, users.id))
        .where(eq(apiKeys.workspaceId, auth.workspaceId))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
      return { items: rows.map((row) => toApiKeyDto(row.apiKey, row.creator)) };
    });

    defineRoute(app, api.apiKeys.create, async ({ auth, body, app: { db } }) => {
      const { row, key } = await db.transaction(async (tx) => {
        // Count and insert under the workspace lock: concurrent requests cannot both take
        // the last slot of the plan. Only keys that still work count.
        const workspace = await lockWorkspace(tx, auth.workspaceId);
        const active = await tx.$count(
          apiKeys,
          and(eq(apiKeys.workspaceId, auth.workspaceId), isNull(apiKeys.revokedAt)),
        );
        assertWithinLimit(workspace, 'maxApiKeys', active + 1);
        // `createApiKey` only inserts, which a transaction handle does exactly like `Db`.
        return createApiKey(tx as unknown as Db, {
          workspaceId: auth.workspaceId,
          name: body.name,
          createdBy: auth.userId,
        });
      });
      return { ...toApiKeyDto(row, auth.user), key };
    });

    defineRoute(app, api.apiKeys.revoke, async ({ auth, params, app: { db } }) => {
      const scope = and(eq(apiKeys.id, params.apiKeyId), eq(apiKeys.workspaceId, auth.workspaceId));
      const [existing] = await db.select({ id: apiKeys.id }).from(apiKeys).where(scope);
      if (!existing) throw AppError.notFound('API key');
      // Idempotent: revoking twice keeps the first revocation date.
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(scope, isNull(apiKeys.revokedAt)));
      return OK;
    });
  },
});
