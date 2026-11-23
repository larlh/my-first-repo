import { describe, expect, it } from 'vitest';
import { ownAvatar, photorealStock, stockAvatars } from '../kit/testing/fixtures';
import {
  NO_FILTERS,
  avatarOrigin,
  countByView,
  filterAvatars,
  filtersFromParams,
  filtersToParams,
  hasActiveFilters,
  matchesSearch,
  shelvesOf,
} from './filters';

const catalogue = [
  ...stockAvatars(),
  photorealStock('lucia', 'Lucía'),
  photorealStock('samuel', 'Samuel', { gender: 'male', ageGroup: 'senior' }),
  ownAvatar(1),
  ownAvatar(2, { kind: 'generated', name: 'Divulgador' }),
];

describe('avatar filters', () => {
  it('tells the four origins apart', () => {
    expect(avatarOrigin(catalogue[0]!)).toBe('instant');
    expect(avatarOrigin(photorealStock('x', 'X'))).toBe('stockPhotoreal');
    expect(avatarOrigin(ownAvatar(1))).toBe('photo');
    expect(avatarOrigin(ownAvatar(1, { kind: 'generated' }))).toBe('generated');
  });

  it('narrows by shelf', () => {
    const instant = filterAvatars(catalogue, { ...NO_FILTERS, view: 'instant' });
    expect(instant.length).toBeGreaterThanOrEqual(8);
    expect(instant.every((avatar) => avatar.rendering === 'instant')).toBe(true);
    const photoreal = filterAvatars(catalogue, { ...NO_FILTERS, view: 'photoreal' });
    expect(photoreal.map((avatar) => avatar.id)).toHaveLength(4);
    const mine = filterAvatars(catalogue, { ...NO_FILTERS, view: 'mine' });
    expect(mine.map((avatar) => avatar.name)).toEqual(['Avatar 1', 'Divulgador']);
  });

  it('searches without accents or case, across name, tags, description and prompt', () => {
    const lucia = catalogue.find((avatar) => avatar.id === 'stock_lucia')!;
    expect(matchesSearch(lucia, 'LUCIA')).toBe(true);
    expect(matchesSearch(lucia, 'lucia blazer')).toBe(true);
    expect(matchesSearch(lucia, 'lucia sudadera')).toBe(false);
    const byPrompt = filterAvatars(catalogue, { ...NO_FILTERS, q: 'jersey verde' });
    expect(byPrompt.map((avatar) => avatar.name)).toEqual(['Divulgador']);
  });

  it('combines traits and keeps counts per shelf for the current filters', () => {
    const filters = { ...NO_FILTERS, gender: 'male' as const, ageGroup: 'senior' as const };
    const shown = filterAvatars(catalogue, filters);
    expect(shown.every((avatar) => avatar.gender === 'male' && avatar.ageGroup === 'senior')).toBe(
      true,
    );
    const counts = countByView(catalogue, filters);
    expect(counts.all).toBe(shown.length);
    expect(counts.instant + counts.photoreal).toBe(counts.all);
    expect(counts.mine).toBe(0);
    expect(hasActiveFilters(filters)).toBe(true);
    expect(hasActiveFilters({ ...NO_FILTERS, view: 'mine' })).toBe(false);
  });

  it('groups own avatars first, then instant, then stock photoreal', () => {
    const shelves = shelvesOf(catalogue);
    expect(shelves.map((shelf) => shelf.origin)).toEqual(['mine', 'instant', 'stockPhotoreal']);
    expect(shelvesOf(stockAvatars()).map((shelf) => shelf.origin)).toEqual(['instant']);
  });

  it('round-trips through the URL and ignores junk', () => {
    const filters = {
      view: 'photoreal' as const,
      gender: 'female' as const,
      ageGroup: null,
      style: 'casual' as const,
      q: 'pelo rizado',
    };
    const params = filtersToParams(filters, new URLSearchParams('avatar=stock_lucia'));
    expect(params.get('avatar')).toBe('stock_lucia');
    expect(filtersFromParams(params)).toEqual(filters);
    expect(filtersToParams(NO_FILTERS, params).toString()).toBe('avatar=stock_lucia');
    expect(filtersFromParams(new URLSearchParams('view=nope&gender=robot&age=old'))).toEqual(
      NO_FILTERS,
    );
  });
});
