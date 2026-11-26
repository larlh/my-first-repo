import { PLANS, SIGNUP_CREDITS, newId } from '@parlante/shared';
import type { PlanId, Role, UiLocale } from '@parlante/shared';
import type { Db, DbOrTx } from './client';
import { grantCredits } from './credits';
import { members, users, workspaces } from './schema';
import type { MemberRow, UserRow, WorkspaceRow } from './schema';

export interface NewWorkspaceInput {
  name: string;
  ownerId: string;
  plan?: PlanId;
  /** Initial grant; defaults to the plan's monthly credits (free plan = SIGNUP_CREDITS). */
  credits?: number;
}

/** Create a workspace with its owner membership and the initial credit grant (one transaction). */
export async function createWorkspace(
  db: DbOrTx,
  input: NewWorkspaceInput,
): Promise<{ workspace: WorkspaceRow; member: MemberRow }> {
  return (db as Db).transaction(async (tx) => {
    const plan = input.plan ?? 'free';
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        id: newId('workspace'),
        name: input.name,
        plan,
        credits: 0,
        createdBy: input.ownerId,
      })
      .returning();
    if (!workspace) throw new Error('Failed to create workspace');
    const [member] = await tx
      .insert(members)
      .values({
        id: newId('member'),
        workspaceId: workspace.id,
        userId: input.ownerId,
        role: 'owner' satisfies Role,
      })
      .returning();
    if (!member) throw new Error('Failed to create member');
    const amount = input.credits ?? (plan === 'free' ? SIGNUP_CREDITS : PLANS[plan].monthlyCredits);
    const entry = await grantCredits(tx, {
      workspaceId: workspace.id,
      amount,
      reason: plan === 'free' ? 'signup_grant' : 'plan_grant',
      description: plan === 'free' ? 'Welcome credits' : `${PLANS[plan].name} plan credits`,
      createdBy: input.ownerId,
    });
    return { workspace: { ...workspace, credits: entry?.balanceAfter ?? 0 }, member };
  });
}

export interface NewUserInput {
  email: string;
  name: string;
  /** Already hashed with `hashPassword` from @parlante/shared/node. */
  passwordHash: string;
  locale?: UiLocale;
  workspaceName?: string;
  plan?: PlanId;
  credits?: number;
}

/**
 * Create a user together with a personal workspace (owner) — the registration unit of work.
 * The caller is responsible for checking that the e-mail is free (unique constraint otherwise).
 */
export async function createUserWithWorkspace(
  db: DbOrTx,
  input: NewUserInput,
): Promise<{ user: UserRow; workspace: WorkspaceRow; member: MemberRow }> {
  return (db as Db).transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        id: newId('user'),
        email: input.email.trim().toLowerCase(),
        name: input.name,
        passwordHash: input.passwordHash,
        locale: input.locale ?? 'es',
      })
      .returning();
    if (!user) throw new Error('Failed to create user');
    const { workspace, member } = await createWorkspace(tx, {
      name: input.workspaceName ?? defaultWorkspaceName(input.name, input.locale ?? 'es'),
      ownerId: user.id,
      plan: input.plan,
      credits: input.credits,
    });
    return { user, workspace, member };
  });
}

export function defaultWorkspaceName(userName: string, locale: UiLocale): string {
  const first = userName.trim().split(/\s+/)[0] ?? userName;
  return locale === 'en' ? `${first}'s workspace` : `Espacio de ${first}`;
}
