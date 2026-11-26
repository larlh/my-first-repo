import { CONSENT_STATEMENT_VERSION, getConsentStatement } from '@parlante/shared';
import type { ConsentKind, ConsentRelationship, UiLocale } from '@parlante/shared';

/* Consent declaration (master prompt §5): a photo avatar or a voice clone can only be created
 * after the person ticks the box and writes the name of who consents. The API stores the
 * record with date, user and IP and rejects the operation without it; these helpers only keep
 * the form honest before the request is sent. */

export interface ConsentDraft {
  /** Full name of the person giving consent. */
  subjectName: string;
  /** `self`: the uploader is the person; `authorized`: holds their explicit permission. */
  relationship: ConsentRelationship;
  /** The checkbox. */
  accepted: boolean;
}

export const EMPTY_CONSENT: ConsentDraft = {
  subjectName: '',
  relationship: 'self',
  accepted: false,
};

export const CONSENT_NAME_MIN = 2;
export const CONSENT_NAME_MAX = 120;

export type ConsentProblem = 'nameRequired' | 'nameTooShort' | 'nameTooLong' | 'notAccepted';

export interface ConsentProblems {
  subjectName?: Exclude<ConsentProblem, 'notAccepted'>;
  accepted?: 'notAccepted';
}

/** What is missing before the declaration can be recorded (empty object = complete). */
export function consentProblems(draft: ConsentDraft): ConsentProblems {
  const problems: ConsentProblems = {};
  const name = draft.subjectName.trim();
  if (name === '') problems.subjectName = 'nameRequired';
  else if (name.length < CONSENT_NAME_MIN) problems.subjectName = 'nameTooShort';
  else if (name.length > CONSENT_NAME_MAX) problems.subjectName = 'nameTooLong';
  if (!draft.accepted) problems.accepted = 'notAccepted';
  return problems;
}

export function isConsentComplete(draft: ConsentDraft): boolean {
  return Object.keys(consentProblems(draft)).length === 0;
}

/** The exact statement the person accepts, in the language it is shown in. */
export function consentStatement(kind: ConsentKind, locale: UiLocale): string {
  const statement = getConsentStatement(kind);
  if (!statement) throw new Error(`No consent statement for ${kind}`);
  return statement[locale];
}

/** Body of `POST /api/consents` for a complete draft. */
export function consentBody(kind: ConsentKind, draft: ConsentDraft, locale: UiLocale) {
  return {
    kind,
    subjectName: draft.subjectName.trim(),
    relationship: draft.relationship,
    statementVersion: CONSENT_STATEMENT_VERSION,
    locale,
    accepted: true as const,
  };
}

/**
 * Identity of a declaration. A consent record that was created but not consumed (the
 * operation after it failed) is reused only while the declaration is literally the same.
 */
export function consentKey(kind: ConsentKind, draft: ConsentDraft, locale: UiLocale): string {
  return [kind, locale, draft.relationship, draft.subjectName.trim()].join('|');
}
