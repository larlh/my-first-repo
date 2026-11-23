import { describe, expect, it } from 'vitest';
import { ELEVEN_PROVIDER, clonedVoice, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import {
  NO_VOICE_FILTERS,
  countByKind,
  filterVoices,
  formatPitch,
  formatSpeed,
  groupVoices,
  hasActiveVoiceFilters,
  languageCounts,
  previewLanguage,
  providersOf,
  sampleText,
  speaks,
  voiceFiltersFromParams,
  voiceFiltersToParams,
} from './voices';

const multi = stockVoice('en-f1', 'Rachel', {
  id: 'elevenlabs:rachel',
  provider: ELEVEN_PROVIDER,
  language: 'en-US',
  multilingual: true,
  languages: ['en', 'es', 'fr'],
});
const voices = [
  stockVoice('es-f1', 'Carmen'),
  stockVoice('es-m1', 'Diego'),
  stockVoice('fr-f1', 'Camille'),
  stockVoice('en-m1', 'James'),
  multi,
  clonedVoice(1),
];

describe('voice filters', () => {
  it('includes multilingual voices in every language, like the API', () => {
    expect(speaks(multi, 'pl')).toBe(true);
    expect(speaks(voices[0]!, 'fr')).toBe(false);
    const french = filterVoices(voices, { ...NO_VOICE_FILTERS, language: 'fr' });
    expect(french.map((voice) => voice.name)).toEqual(['Camille', 'Rachel']);
  });

  it('filters by gender, provider, kind and search', () => {
    expect(
      filterVoices(voices, { ...NO_VOICE_FILTERS, gender: 'male' }).map((voice) => voice.name),
    ).toEqual(['Diego', 'James']);
    expect(
      filterVoices(voices, { ...NO_VOICE_FILTERS, provider: 'elevenlabs' }).map((v) => v.name),
    ).toEqual(['Rachel']);
    expect(filterVoices(voices, { ...NO_VOICE_FILTERS, kind: 'cloned' })).toHaveLength(1);
    // Search matches the language name in both UI languages and the provider.
    expect(filterVoices(voices, { ...NO_VOICE_FILTERS, q: 'français' })).toHaveLength(1);
    expect(filterVoices(voices, { ...NO_VOICE_FILTERS, q: 'spanish' }).length).toBeGreaterThan(1);
    expect(filterVoices(voices, { ...NO_VOICE_FILTERS, q: 'elevenlabs' })).toHaveLength(1);
  });

  it('counts per kind and per language, and lists providers', () => {
    expect(countByKind(voices, NO_VOICE_FILTERS)).toEqual({ all: 6, stock: 5, cloned: 1 });
    const counts = languageCounts(voices);
    // Spanish: Carmen, Diego, the clone and the multilingual voice.
    expect(counts.find((entry) => entry.code === 'es')?.count).toBe(4);
    expect(counts.find((entry) => entry.code === 'pl')?.count).toBe(1);
    expect(providersOf(voices).map((provider) => provider.id)).toEqual([
      'espeak',
      'elevenlabs',
      'voice-profile',
    ]);
    expect(hasActiveVoiceFilters({ ...NO_VOICE_FILTERS, kind: 'stock' })).toBe(false);
  });

  it('groups cloned first, then languages in product order, then multilingual', () => {
    expect(groupVoices(voices).map((group) => group.key)).toEqual([
      'cloned',
      'es',
      'en',
      'fr',
      'multi',
    ]);
  });

  it('round-trips through the URL', () => {
    const filters = {
      kind: 'stock' as const,
      language: 'de' as const,
      gender: 'female' as const,
      provider: 'espeak',
      q: 'hanna',
    };
    const params = voiceFiltersToParams(filters, new URLSearchParams('voice=espeak:de-f1'));
    expect(params.get('voice')).toBe('espeak:de-f1');
    expect(voiceFiltersFromParams(params)).toEqual(filters);
    expect(voiceFiltersFromParams(new URLSearchParams('lang=xx&provider=<script>'))).toEqual(
      NO_VOICE_FILTERS,
    );
  });
});

describe('voice preview settings', () => {
  it('speaks the language being browsed only for multilingual voices', () => {
    expect(previewLanguage(multi, 'fr')).toBe('fr');
    expect(previewLanguage(multi, null)).toBe('en');
    expect(previewLanguage(voices[0]!, 'fr')).toBe('es');
  });

  it('has a sample sentence per language and falls back to Spanish', () => {
    expect(sampleText('fr')).toMatch(/Bonjour/);
    expect(sampleText('pt-BR')).toMatch(/Olá/);
    expect(sampleText('zz')).toMatch(/Hola/);
  });

  it('formats speed and pitch', () => {
    expect(formatSpeed(1.25, 'es')).toBe('1,25×');
    expect(formatSpeed(1, 'en')).toBe('1.00×');
    expect(formatPitch(0)).toBe('0 st');
    expect(formatPitch(2)).toBe('+2 st');
    expect(formatPitch(-3)).toBe('−3 st');
  });
});
