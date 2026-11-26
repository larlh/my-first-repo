import { LoginBodySchema, RegisterBodySchema } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  formErrorsFromApi,
  loginSchema,
  passwordStrength,
  registerSchema,
  workspaceSchema,
} from './validation';

/** First message per field — what the form shows. */
function messages(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    const field = String(issue.path[0]);
    if (!(field in out)) out[field] = issue.message;
  }
  return out;
}

describe('login form', () => {
  it('asks for both fields with their own message', () => {
    expect(messages(loginSchema.safeParse({ email: '', password: '' }))).toEqual({
      email: 'errors.emailRequired',
      password: 'errors.passwordRequired',
    });
  });

  it('rejects a malformed e-mail and accepts a padded one', () => {
    expect(messages(loginSchema.safeParse({ email: 'lucia@', password: 'x' }))).toEqual({
      email: 'errors.emailInvalid',
    });
    const ok = loginSchema.safeParse({ email: '  lucia@ejemplo.com ', password: 'x' });
    expect(ok.success && ok.data.email).toBe('lucia@ejemplo.com');
  });

  it('never accepts something the API contract would reject', () => {
    for (const values of [
      { email: 'lucia@ejemplo.com', password: 'correcta-1234' },
      { email: 'a@b.co', password: 'x' },
    ]) {
      expect(loginSchema.safeParse(values).success).toBe(true);
      expect(LoginBodySchema.safeParse(values).success).toBe(true);
    }
  });
});

describe('register form', () => {
  const valid = { name: 'Lucía Ferrer', email: 'lucia@ejemplo.com', password: 'Cabina-2026' };

  it('accepts what the contract accepts', () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
    expect(RegisterBodySchema.safeParse(valid).success).toBe(true);
  });

  it('explains each problem', () => {
    expect(
      messages(registerSchema.safeParse({ name: '  ', email: 'x', password: 'corta' })),
    ).toEqual({
      name: 'errors.nameRequired',
      email: 'errors.emailInvalid',
      password: 'errors.passwordShort',
    });
    expect(messages(registerSchema.safeParse({ ...valid, password: '' }))).toEqual({
      password: 'errors.passwordRequired',
    });
    expect(messages(registerSchema.safeParse({ ...valid, name: 'n'.repeat(81) }))).toEqual({
      name: 'errors.nameLong',
    });
    expect(messages(registerSchema.safeParse({ ...valid, password: 'p'.repeat(129) }))).toEqual({
      password: 'errors.passwordLong',
    });
  });

  it('is at least as strict as the contract about length limits', () => {
    expect(RegisterBodySchema.safeParse({ ...valid, password: '1234567' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, password: '1234567' }).success).toBe(false);
  });
});

describe('workspace form', () => {
  it('needs a name of at most 60 characters', () => {
    expect(messages(workspaceSchema.safeParse({ name: ' ' }))).toEqual({
      name: 'errors.workspaceRequired',
    });
    expect(messages(workspaceSchema.safeParse({ name: 'w'.repeat(61) }))).toEqual({
      name: 'errors.workspaceLong',
    });
    expect(workspaceSchema.safeParse({ name: 'Equipo de marketing' }).success).toBe(true);
  });
});

describe('password strength hint', () => {
  it('grows with length and variety', () => {
    expect(passwordStrength('')).toBe(0);
    expect(passwordStrength('abc')).toBe(1);
    expect(passwordStrength('aaaaaaaaaaaa')).toBe(1);
    expect(passwordStrength('abcdefgh')).toBe(1);
    expect(passwordStrength('abcdefg1')).toBe(2);
    expect(passwordStrength('Abcdefgh12')).toBe(3);
    expect(passwordStrength('Cabina-2026-otoño!')).toBe(4);
  });
});

describe('API errors on a form', () => {
  it('puts EMAIL_TAKEN on the e-mail field', () => {
    const mapped = formErrorsFromApi(new ApiError('EMAIL_TAKEN', 'taken', 409), [
      'name',
      'email',
    ] as const);
    expect(mapped.fields).toEqual({ email: { key: 'errors.emailTaken' } });
    expect(mapped.form).toBeNull();
  });

  it('maps validation issues onto the fields the form has', () => {
    const error = new ApiError('VALIDATION_ERROR', 'Invalid', 400, {
      issues: [
        { path: 'password', message: 'Too small' },
        { path: 'locale', message: 'Invalid option' },
      ],
    });
    const mapped = formErrorsFromApi(error, ['email', 'password'] as const);
    expect(mapped.fields).toEqual({ password: { message: 'Too small' } });
    expect(mapped.form).toBeNull();
  });

  it('keeps everything else as a form-level error', () => {
    const wrong = new ApiError('INVALID_CREDENTIALS', 'nope', 401);
    expect(formErrorsFromApi(wrong, ['email', 'password'] as const)).toEqual({
      fields: {},
      form: wrong,
    });
    // A validation error about a field this form does not have is also form-level.
    const other = new ApiError('VALIDATION_ERROR', 'Invalid', 400, {
      issues: [{ path: 'inviteToken', message: 'Too long' }],
    });
    expect(formErrorsFromApi(other, ['email'] as const).form).toBe(other);
  });
});
