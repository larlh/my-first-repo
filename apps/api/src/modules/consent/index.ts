import {
  AppError,
  CONSENT_STATEMENT_VERSION,
  api,
  buildPage,
  getConsentStatement,
  newId,
} from '@parlante/shared';
import type { ConsentRecord } from '@parlante/shared';
import {
  and,
  avatars,
  consentRecords,
  cursorOrder,
  cursorWhere,
  eq,
  isNull,
  users,
  voices,
} from '@parlante/db';
import type { ConsentRecordRow, Db } from '@parlante/db';
import { clientIp } from '../../lib/auth';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull, toUserRef } from '../../lib/dto';
import { defineModule } from '../../lib/modules';
import { deleteAvatarCascade, deleteVoiceCascade } from '../../lib/person-data';

/* -------------------------------------------------------------------------------------------
 * Consent records (master prompt §5 — mandatory before a photo avatar or a voice clone).
 *
 * A record states WHO consented (name typed by the user), WHAT they accepted (the exact,
 * versioned statement text), WHEN, which USER recorded it and from which IP. It is consumed
 * once by `consumeConsent` (lib/consent.ts) inside the transaction that creates the avatar or
 * voice. Revoking it deletes everything made with it; the record itself stays, with
 * `revokedAt`, as the audit trail.
 * ----------------------------------------------------------------------------------------- */

/** The IP and user agent are kept for audit but are not part of the DTO. */
function toConsentDto(
  row: ConsentRecordRow,
  user: { id: string; name: string } | null,
): ConsentRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    user: toUserRef(user),
    kind: row.kind,
    subjectName: row.subjectName,
    relationship: row.relationship,
    statementVersion: row.statementVersion,
    statement: row.statement,
    resourceId: row.resourceId,
    revokedAt: isoOrNull(row.revokedAt),
    createdAt: iso(row.createdAt),
  };
}

/** A consent of THIS workspace with the user who recorded it, or 404. */
async function findConsent(db: Db, workspaceId: string, consentId: string) {
  const [row] = await db
    .select({ consent: consentRecords, user: { id: users.id, name: users.name } })
    .from(consentRecords)
    .leftJoin(users, eq(consentRecords.userId, users.id))
    .where(and(eq(consentRecords.id, consentId), eq(consentRecords.workspaceId, workspaceId)));
  if (!row) throw AppError.notFound('Consent record');
  return row;
}

export default defineModule({
  name: 'consent',
  register(app) {
    defineRoute(app, api.consents.create, async ({ auth, body, request, app: { db } }) => {
      // Only the statement in force can be accepted: the text stored is the text shown.
      const statement =
        body.statementVersion === CONSENT_STATEMENT_VERSION
          ? getConsentStatement(body.kind, body.statementVersion)
          : null;
      if (!statement) {
        throw new AppError('VALIDATION_ERROR', 'This consent statement is not the current one', {
          issues: [
            {
              path: 'body.statementVersion',
              message: `Expected version ${CONSENT_STATEMENT_VERSION}`,
            },
          ],
          currentVersion: CONSENT_STATEMENT_VERSION,
        });
      }
      const [row] = await db
        .insert(consentRecords)
        .values({
          id: newId('consent'),
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          kind: body.kind,
          subjectName: body.subjectName,
          relationship: body.relationship,
          statementVersion: body.statementVersion,
          statement: statement[body.locale],
          locale: body.locale,
          ip: clientIp(request),
          userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      return toConsentDto(row, auth.user);
    });

    defineRoute(app, api.consents.list, async ({ auth, query, app: { db } }) => {
      const rows = await db
        .select({ consent: consentRecords, user: { id: users.id, name: users.name } })
        .from(consentRecords)
        .leftJoin(users, eq(consentRecords.userId, users.id))
        .where(
          and(
            eq(consentRecords.workspaceId, auth.workspaceId),
            query.kind ? eq(consentRecords.kind, query.kind) : undefined,
            cursorWhere(consentRecords.createdAt, consentRecords.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(consentRecords.createdAt, consentRecords.id))
        .limit(query.limit + 1);
      const page = buildPage(
        rows.map((row) => ({ ...row, id: row.consent.id, createdAt: row.consent.createdAt })),
        query.limit,
      );
      return {
        items: page.items.map((row) => toConsentDto(row.consent, row.user)),
        nextCursor: page.nextCursor,
      };
    });

    defineRoute(app, api.consents.revoke, async ({ auth, params, app }) => {
      const { db, providers, queues } = app;
      const scope = and(
        eq(consentRecords.id, params.consentId),
        eq(consentRecords.workspaceId, auth.workspaceId),
      );
      await findConsent(db, auth.workspaceId, params.consentId);
      // 1. Revoke first: from here on `consumeConsent` refuses the record, so nothing new
      //    can be created with it while its resources are being removed.
      await db
        .update(consentRecords)
        .set({ revokedAt: new Date() })
        .where(and(scope, isNull(consentRecords.revokedAt)));

      // 2. Delete whatever was made with it. This also runs for a record that was already
      //    revoked, so a revocation interrupted half-way (storage or provider failure) is
      //    completed by simply calling the endpoint again.
      const deps = { db, providers, queues };
      const madeAvatars = await db
        .select({ id: avatars.id })
        .from(avatars)
        .where(
          and(eq(avatars.consentId, params.consentId), eq(avatars.workspaceId, auth.workspaceId)),
        );
      for (const avatar of madeAvatars) {
        await deleteAvatarCascade(deps, auth.workspaceId, avatar.id);
      }
      const madeVoices = await db
        .select({ id: voices.id })
        .from(voices)
        .where(
          and(eq(voices.consentId, params.consentId), eq(voices.workspaceId, auth.workspaceId)),
        );
      for (const voice of madeVoices) {
        await deleteVoiceCascade(deps, auth.workspaceId, voice.id);
      }

      const revoked = await findConsent(db, auth.workspaceId, params.consentId);
      return toConsentDto(revoked.consent, revoked.user);
    });
  },
});
