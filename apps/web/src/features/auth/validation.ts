import { z } from 'zod';
import type { ApiError } from '@/lib/api';

/* Client-side validation of the account forms. The rules mirror the API contract
 * (`LoginBodySchema` / `RegisterBodySchema` in @parlante/shared) but every message is an i18n
 * key of the `auth` namespace, so errors read naturally in both languages. The API validates
 * again; its field errors are mapped back onto the form by `formErrorsFromApi`. */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const WORKSPACE_NAME_MAX = 60;

const email = z
  .string()
  .trim()
  .min(1, 'errors.emailRequired')
  .max(EMAIL_MAX, 'errors.emailInvalid')
  .refine((value) => z.email().safeParse(value).success, 'errors.emailInvalid');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'errors.passwordRequired').max(PASSWORD_MAX, 'errors.passwordLong'),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'errors.nameRequired').max(NAME_MAX, 'errors.nameLong'),
  email,
  password: z
    .string()
    .min(1, 'errors.passwordRequired')
    .min(PASSWORD_MIN, 'errors.passwordShort')
    .max(PASSWORD_MAX, 'errors.passwordLong'),
});
export type RegisterValues = z.infer<typeof registerSchema>;

export const workspaceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'errors.workspaceRequired')
    .max(WORKSPACE_NAME_MAX, 'errors.workspaceLong'),
});
export type WorkspaceValues = z.infer<typeof workspaceSchema>;

/** 0 (empty) … 4 (strong). A hint for the person typing, not a gate: the gate is the minimum length. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length === 0) return 0;
  if (password.length < PASSWORD_MIN) return 1;
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/\d/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  const repeated = /^(.)\1+$/.test(password);
  if (repeated) return 1;
  let score = 1;
  if (classes >= 2) score += 1;
  if (classes >= 3 && password.length >= 10) score += 1;
  if (password.length >= 14 && classes >= 2) score += 1;
  return Math.min(4, score) as 1 | 2 | 3 | 4;
}

export interface FormErrors<Field extends string> {
  /** Message keys (auth namespace) or server messages per field. */
  fields: Partial<Record<Field, { key?: string; message?: string }>>;
  /** Error that belongs to the whole form (wrong credentials, network, rate limit). */
  form: ApiError | null;
}

/**
 * Split an API error into field errors and a form-level error:
 *  - EMAIL_TAKEN            → on the e-mail field
 *  - VALIDATION_ERROR       → server issues on the fields this form has
 *  - anything else          → form-level (shown as an alert above the button)
 */
export function formErrorsFromApi<Field extends string>(
  error: ApiError,
  fields: readonly Field[],
): FormErrors<Field> {
  const out: FormErrors<Field> = { fields: {}, form: null };
  if (error.code === 'EMAIL_TAKEN' && (fields as readonly string[]).includes('email')) {
    out.fields['email' as Field] = { key: 'errors.emailTaken' };
    return out;
  }
  if (error.code === 'VALIDATION_ERROR') {
    const issues = error.fieldErrors;
    for (const field of fields) {
      const message = issues[field];
      if (message) out.fields[field] = { message };
    }
    if (Object.keys(out.fields).length > 0) return out;
  }
  out.form = error;
  return out;
}
