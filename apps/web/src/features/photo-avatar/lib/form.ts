import { GenderSchema } from '@parlante/shared';
import type { Avatar, Gender } from '@parlante/shared';

/* Forms of "create a photorealistic avatar": validation that mirrors the API contract
 * (`CreatePhotoAvatarBodySchema`, `GenerateAvatarBodySchema`) so the person is told what is
 * missing before anything is uploaded, and the mapping from API errors to what to do next. */

export const AVATAR_MODES = ['photo', 'generate'] as const;
export type AvatarMode = (typeof AVATAR_MODES)[number];

export function modeFromParam(value: string | null): AvatarMode {
  return value === 'generate' ? 'generate' : 'photo';
}

/** Image types the engine can prepare (animated GIFs are not portraits). */
export const PHOTO_ACCEPT = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const NAME_MAX = 60;
export const PROMPT_MIN = 10;
export const PROMPT_MAX = 500;
export const SEED_MAX = 2_147_483_647;

export const GENDERS: readonly Gender[] = GenderSchema.options;

export type NameProblem = 'nameRequired' | 'nameTooLong';

export function nameProblem(name: string): NameProblem | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'nameRequired';
  if (trimmed.length > NAME_MAX) return 'nameTooLong';
  return null;
}

/** "ana-garcia_foto.JPG" → "Ana garcia foto" (a starting point for the avatar name). */
export function nameFromFile(fileName: string): string {
  const base = fileName
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (base === '') return '';
  return (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, NAME_MAX);
}

export type PromptProblem = 'promptRequired' | 'promptTooShort' | 'promptTooLong';

export function promptProblem(prompt: string): PromptProblem | null {
  const trimmed = prompt.trim();
  if (trimmed === '') return 'promptRequired';
  if (trimmed.length < PROMPT_MIN) return 'promptTooShort';
  if (trimmed.length > PROMPT_MAX) return 'promptTooLong';
  return null;
}

/**
 * The optional seed field: empty = random (undefined), a whole number in range = that seed,
 * anything else is invalid.
 */
export function parseSeed(text: string): { seed: number | undefined; valid: boolean } {
  const trimmed = text.trim();
  if (trimmed === '') return { seed: undefined, valid: true };
  if (!/^\d{1,10}$/.test(trimmed)) return { seed: undefined, valid: false };
  const seed = Number(trimmed);
  return seed <= SEED_MAX ? { seed, valid: true } : { seed: undefined, valid: false };
}

/** Own avatars that count towards the plan allowance (failed ones do not). */
export function countOwnAvatars(avatars: readonly Pick<Avatar, 'kind' | 'status'>[]): number {
  return avatars.filter((avatar) => avatar.kind !== 'stock' && avatar.status !== 'failed').length;
}

export interface Allowance {
  used: number;
  max: number;
  /** One more avatar fits in the plan. */
  room: boolean;
}

export function allowance(used: number, max: number): Allowance {
  return { used, max, room: used < max };
}
