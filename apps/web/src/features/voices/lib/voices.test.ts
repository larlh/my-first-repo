import { describe, expect, it } from 'vitest';
import { ELEVEN_PROVIDER, clonedVoice, stockVoice } from '@/features/avatars/kit/testing/fixtures';
import {
  NO_VOICE_FILTERS,
  clampPitch,
  countByKind,
  filterVoices,
  formatPitch,
  formatSpeed,
  groupVoices,
  hasActiveVoiceFilters,
  installCommandFor,
  languageCounts,
  notInstalled,
  previewLanguage,
  providersOf,
  sampleText,
  speaks,
  voiceFiltersFromParams,
  voiceFiltersToParams,
  voiceTier,
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

describe('neural voices in the library', () => {
  const NEURAL = {
    id: 'kokoro',
    name: 'Kokoro (neuronal local)',
    quality: 'premium',
    local: true,
  } as const;
  const missing = (command: string) => ({ reasonCode: 'voice_not_installed' as const, command });
  const dora = stockVoice('es-f1', 'Dora', { id: 'kokoro:ef_dora', provider: NEURAL });
  const sara = stockVoice('it-f1', 'Sara', {
    id: 'kokoro:if_sara',
    provider: NEURAL,
    unavailable: missing('pnpm voices:setup'),
  });
  const kerstin = stockVoice('de-f1', 'Kerstin', {
    id: 'piper:de_DE-kerstin-medium',
    provider: { ...NEURAL, id: 'piper' },
    unavailable: missing('pnpm voices:setup --voices de_DE-kerstin-medium'),
  });
  const thorsten = stockVoice('de-m1', 'Thorsten', {
    id: 'piper:de_DE-thorsten-medium',
    provider: { ...NEURAL, id: 'piper' },
    unavailable: missing('pnpm voices:setup --voices de_DE-thorsten-medium'),
  });
  const hanna = stockVoice('de-f1', 'Hanna');
  const carmen = stockVoice('es-f1', 'Carmen');

  it('ranks usable neural voices, then the ones to install, then the basic ones', () => {
    expect([dora, sara, carmen, multi].map(voiceTier)).toEqual([0, 1, 2, 0]);
    // Whatever order the server used, each language group starts with what sounds best.
    const groups = groupVoices([carmen, hanna, kerstin, dora, thorsten]);
    expect(groups.map((group) => [group.key, group.voices.map((voice) => voice.name)])).toEqual([
      ['es', ['Dora', 'Carmen']],
      ['de', ['Kerstin', 'Thorsten', 'Hanna']],
    ]);
  });

  it('names one command that installs everything that is missing', () => {
    expect(notInstalled([dora, sara, carmen]).map((voice) => voice.name)).toEqual(['Sara']);
    expect(installCommandFor([dora, carmen])).toBeNull();
    expect(installCommandFor([dora, sara])).toBe('pnpm voices:setup');
    expect(installCommandFor([kerstin])).toBe('pnpm voices:setup --voices de_DE-kerstin-medium');
    // Several voices with different commands: ask for their languages.
    expect(installCommandFor([kerstin, thorsten])).toBe('pnpm voices:setup --languages de');
    expect(installCommandFor([sara, kerstin])).toBe('pnpm voices:setup --languages it,de');
  });

  it('keeps a requested pitch inside what the voice can do', () => {
    const limited = { pitchRange: { minSemitones: -4, maxSemitones: 4, resampled: true } };
    expect(clampPitch(limited, 9)).toBe(4);
    expect(clampPitch(limited, -12)).toBe(-4);
    expect(clampPitch(limited, 2)).toBe(2);
    expect(clampPitch({}, 9)).toBe(9);
    expect(clampPitch({}, 40)).toBe(12);
  });
});
