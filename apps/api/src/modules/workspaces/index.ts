import { AppError, OK, api } from '@parlante/shared';
import { and, count, createWorkspace, eq, members, workspaces } from '@parlante/db';
import { listMemberships } from '../../lib/auth';
import { defineRoute } from '../../lib/define-route';
import { toWorkspaceDto, toWorkspaceWithRoleDto } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import { deleteWorkspaceCascade } from './service';

/**
 * Workspaces a single user may OWN. Every new workspace starts on the free plan with its
 * welcome credits, so creation is capped to keep that from being an unlimited credit tap.
 */
export const MAX_OWNED_WORKSPACES = 10;

export default defineModule({
  name: 'workspaces',
  register(app) {
    defineRoute(app, api.workspaces.list, async ({ auth, app: { db } }) => {
      const memberships = await listMemberships(db, auth.userId);
      return { items: memberships.map((m) => toWorkspaceWithRoleDto(m.workspace, m.role)) };
    });

    defineRoute(app, api.workspaces.create, async ({ auth, body, app: { db } }) => {
      const [owned] = await db
        .select({ n: count() })
        .from(members)
        .where(and(eq(members.userId, auth.userId), eq(members.role, 'owner')));
      if ((owned?.n ?? 0) >= MAX_OWNED_WORKSPACES) {
        throw new AppError(
          'PLAN_LIMIT_EXCEEDED',
          `You can own at most ${MAX_OWNED_WORKSPACES} workspaces`,
          { limit: 'maxOwnedWorkspaces', max: MAX_OWNED_WORKSPACES, value: (owned?.n ?? 0) + 1 },
        );
      }
      // The session keeps its active workspace: switching is an explicit, separate action.
      const { workspace, member } = await createWorkspace(db, {
        name: body.name,
        ownerId: auth.userId,
      });
      return toWorkspaceWithRoleDto(workspace, member.role);
    });

    defineRoute(app, api.workspaces.current, async ({ auth }) => {
      return toWorkspaceWithRoleDto(auth.workspace, auth.role);
    });

    defineRoute(app, api.workspaces.update, async ({ auth, body, app: { db } }) => {
      const [updated] = await db
        .update(workspaces)
        .set({ name: body.name, updatedAt: new Date() })
        .where(eq(workspaces.id, auth.workspaceId))
        .returning();
      if (!updated) throw AppError.notFound('Workspace');
      return toWorkspaceDto(updated);
    });

    defineRoute(app, api.workspaces.remove, async ({ auth, app: { db, providers } }) => {
      // The caller must keep somewhere to land: their last workspace cannot be deleted.
      const memberships = await listMemberships(db, auth.userId);
      if (memberships.length <= 1) {
        throw AppError.invalidState(
          'This is your only workspace. Create or join another one before deleting it',
        );
      }
      await deleteWorkspaceCascade({ db, providers }, auth.workspaceId);
      // Sessions that pointed at it (of every member) fall back to another membership on
      // their next request (`resolveSession`).
      return OK;
    });
  },
});
