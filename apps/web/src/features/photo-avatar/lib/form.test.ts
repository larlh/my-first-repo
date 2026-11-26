import { GenerateAvatarBodySchema } from '@parlante/shared';
import { describe, expect, it } from 'vitest';
import { ownAvatar, stockAvatars } from '@/features/avatars/kit/testing/fixtures';
import {
  PROMPT_MAX,
  SEED_MAX,
  allowance,
  countOwnAvatars,
  modeFromParam,
  nameFromFile,
  nameProblem,
  parseSeed,
  promptProblem,
} from './form';

describe('photo avatar forms', () => {
  it('reads the mode from the URL', () => {
    expect(modeFromParam(null)).toBe('photo');
    expect(modeFromParam('generate')).toBe('generate');
    expect(modeFromParam('whatever')).toBe('photo');
  });

  it('validates the name like the API', () => {
    expect(nameProblem('  ')).toBe('nameRequired');
    expect(nameProblem('x'.repeat(61))).toBe('nameTooLong');
    expect(nameProblem('Ana')).toBeNull();
  });

  it('proposes a name from the file name', () => {
    expect(nameFromFile('ana-garcia_foto.JPG')).toBe('Ana garcia foto');
    expect(nameFromFile('.png')).toBe('');
    expect(nameFromFile(`${'a'.repeat(80)}.webp`)).toHaveLength(60);
  });

  it('validates the prompt with the limits of the contract', () => {
    expect(promptProblem('')).toBe('promptRequired');
    expect(promptProblem('mujer')).toBe('promptTooShort');
    expect(promptProblem('x'.repeat(PROMPT_MAX + 1))).toBe('promptTooLong');
    const prompt = 'mujer de unos 40 años, pelo corto';
    expect(promptProblem(prompt)).toBeNull();
    expect(GenerateAvatarBodySchema.safeParse({ name: 'Ana', prompt }).success).toBe(true);
    expect(GenerateAvatarBodySchema.safeParse({ name: 'Ana', prompt: 'mujer' }).success).toBe(
      false,
    );
  });

  it('parses the optional seed', () => {
    expect(parseSeed('')).toEqual({ seed: undefined, valid: true });
    expect(parseSeed(' 42 ')).toEqual({ seed: 42, valid: true });
    expect(parseSeed(String(SEED_MAX))).toEqual({ seed: SEED_MAX, valid: true });
    expect(parseSeed(String(SEED_MAX + 1)).valid).toBe(false);
    expect(parseSeed('-1').valid).toBe(false);
    expect(parseSeed('1.5').valid).toBe(false);
    expect(parseSeed('abc').valid).toBe(false);
  });

  it('counts own avatars against the plan, ignoring failed ones and stock', () => {
    const avatars = [
      ...stockAvatars(),
      ownAvatar(1),
      ownAvatar(2, { status: 'processing' }),
      ownAvatar(3, { status: 'failed' }),
    ];
    expect(countOwnAvatars(avatars)).toBe(2);
    expect(allowance(2, 10)).toEqual({ used: 2, max: 10, room: true });
    expect(allowance(1, 1).room).toBe(false);
  });
});
