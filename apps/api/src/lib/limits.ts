import { AppError, PLANS } from '@parlante/shared';
import type { PlanLimits } from '@parlante/shared';
import type { WorkspaceRow } from '@parlante/db';

type NumericLimit = {
  [K in keyof PlanLimits]: PlanLimits[K] extends number ? K : never;
}[keyof PlanLimits];

export function planLimits(workspace: Pick<WorkspaceRow, 'plan'>): PlanLimits {
  return PLANS[workspace.plan].limits;
}

/**
 * Throw PLAN_LIMIT_EXCEEDED when `value` is above the plan's numeric limit.
 *   assertWithinLimit(auth.workspace, 'maxScenesPerVideo', composition.scenes.length);
 * For "one more" checks pass the count AFTER the operation (`current + 1`).
 */
export function assertWithinLimit(
  workspace: Pick<WorkspaceRow, 'plan'>,
  limit: NumericLimit,
  value: number,
): void {
  const max = planLimits(workspace)[limit];
  if (value > max) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      `The ${PLANS[workspace.plan].name} plan limit was reached`,
      {
        limit,
        max,
        value,
        plan: workspace.plan,
      },
    );
  }
}
