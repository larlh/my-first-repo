import type {
  Session,
  SessionInfo,
  User,
  UserRef,
  Workspace,
  WorkspaceWithRole,
} from '@parlante/shared';
import type { Role } from '@parlante/shared';
import type { SessionRow, UserRow, WorkspaceRow } from '@parlante/db';

/* Row → DTO mappers shared by several modules. Module-specific mappers live in the module. */

export const iso = (date: Date): string => date.toISOString();
export const isoOrNull = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;

export function toUserDto(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    createdAt: iso(row.createdAt),
  };
}

export function toUserRef(row: { id: string; name: string } | null | undefined): UserRef | null {
  return row ? { id: row.id, name: row.name } : null;
}

export function toWorkspaceDto(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    plan: row.plan,
    credits: row.credits,
    createdAt: iso(row.createdAt),
  };
}

export function toWorkspaceWithRoleDto(row: WorkspaceRow, role: Role): WorkspaceWithRole {
  return { ...toWorkspaceDto(row), role };
}

export function toSessionDto(row: SessionRow): Session {
  return { id: row.id, expiresAt: iso(row.expiresAt), createdAt: iso(row.createdAt) };
}

export function toSessionInfoDto(input: {
  user: UserRow;
  session: SessionRow;
  workspaces: { workspace: WorkspaceRow; role: Role }[];
  currentWorkspaceId: string;
}): SessionInfo {
  return {
    user: toUserDto(input.user),
    session: toSessionDto(input.session),
    workspaces: input.workspaces.map((w) => toWorkspaceWithRoleDto(w.workspace, w.role)),
    currentWorkspaceId: input.currentWorkspaceId,
  };
}
