import { AppError } from '@parlante/shared';
import type { ConsentKind } from '@parlante/shared';
import { and, consentRecords, eq, isNull } from '@parlante/db';
import type { ConsentRecordRow, DbOrTx } from '@parlante/db';

/**
 * Consent gate for photo avatars and voice cloning (master prompt §5 — not negotiable).
 * The operation is rejected with CONSENT_REQUIRED unless the consent record:
 *   exists in this workspace · was given by this same user · is of the right kind ·
 *   has not been revoked · has not been used for another resource.
 *
 * Call `consumeConsent` INSIDE the transaction that creates the avatar / voice so a consent
 * can never back two resources.
 */
export async function consumeConsent(
  db: DbOrTx,
  input: {
    consentId: string;
    kind: ConsentKind;
    workspaceId: string;
    userId: string;
    /** Id of the avatar / voice being created. */
    resourceId: string;
  },
): Promise<ConsentRecordRow> {
  const [updated] = await db
    .update(consentRecords)
    .set({ resourceId: input.resourceId, usedAt: new Date() })
    .where(
      and(
        eq(consentRecords.id, input.consentId),
        eq(consentRecords.workspaceId, input.workspaceId),
        eq(consentRecords.userId, input.userId),
        eq(consentRecords.kind, input.kind),
        isNull(consentRecords.revokedAt),
        isNull(consentRecords.usedAt),
      ),
    )
    .returning();
  if (!updated) {
    throw new AppError(
      'CONSENT_REQUIRED',
      'A valid, unused consent declaration from you is required for this operation',
      { kind: input.kind },
    );
  }
  return updated;
}
