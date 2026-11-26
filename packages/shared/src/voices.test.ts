import { describe, expect, it } from 'vitest';
import {
  VoiceSchema,
  api,
  defaultVoiceId,
  isNeuralTtsProvider,
  isVoiceUsable,
  pickDefaultVoice,
  pickDefaultVoiceId,
} from './index';
import type { DefaultVoiceCandidate, Voice } from './index';

const voice = (
  id: string,
  language: string,
  gender: 'female' | 'male',
  extra: Partial<DefaultVoiceCandidate> = {},
): DefaultVoiceCandidate => ({
  id,
  kind: 'stock',
  language,
  gender,
  status: 'ready',
  ...extra,
});

/** A catalogue in the order the server lists it: neural first, eSpeak last. */
const catalogue: DefaultVoiceCandidate[] = [
  voice('kokoro:ef_dora', 'es', 'female', { isDefault: true }),
  voice('kokoro:em_alex', 'es', 'male', { isDefault: true }),
  voice('kokoro:pf_dora', 'pt-BR', 'female', { isDefault: true }),
  voice('piper:ru_RU-denis-medium', 'ru', 'male', { isDefault: true }),
  voice('espeak:es-f1', 'es', 'female'),
  voice('espeak:es-m1', 'es', 'male'),
  voice('espeak:ru-f1', 'ru', 'female', { isDefault: true }),
  voice('espeak:ru-m1', 'ru', 'male'),
  voice('espeak:de-f1', 'de', 'female', { isDefault: true }),
  voice('espeak:de-m1', 'de', 'male', { isDefault: true }),
];

describe('default voice of new content', () => {
  it('takes the voice the server marked, for the language and the gender asked', () => {
    expect(pickDefaultVoice(catalogue, 'es')?.id).toBe('kokoro:ef_dora');
    expect(pickDefaultVoice(catalogue, 'es', 'male')?.id).toBe('kokoro:em_alex');
    expect(pickDefaultVoice(catalogue, 'es-MX', 'female')?.id).toBe('kokoro:ef_dora');
    expect(pickDefaultVoice(catalogue, 'pt')?.id).toBe('kokoro:pf_dora');
    expect(pickDefaultVoice(catalogue, 'DE', 'male')?.id).toBe('espeak:de-m1');
  });

  it('without a gender follows the order of the server (its preferred provider first)', () => {
    // Russian: the neural voice is male, the basic female one comes later in the list.
    expect(pickDefaultVoice(catalogue, 'ru')?.id).toBe('piper:ru_RU-denis-medium');
    // With a gender the match is exact, even if that means the basic voice.
    expect(pickDefaultVoice(catalogue, 'ru', 'female')?.id).toBe('espeak:ru-f1');
  });

  it('lets a multilingual default speak every language', () => {
    const cloud = [
      voice('acme:nova', 'en-US', 'female', { isDefault: true, multilingual: true }),
      ...catalogue,
    ];
    expect(pickDefaultVoice(cloud, 'es')?.id).toBe('acme:nova');
    expect(pickDefaultVoice(cloud, 'el', 'female')?.id).toBe('acme:nova');
    expect(pickDefaultVoice(cloud, 'es', 'male')?.id).toBe('kokoro:em_alex');
  });

  it('never picks a voice that cannot speak now', () => {
    const list = [
      voice('kokoro:ef_dora', 'es', 'female', {
        isDefault: true,
        unavailable: { reasonCode: 'voice_not_installed', command: 'pnpm voices:setup' },
      }),
      voice('acme:slow', 'es', 'female', { isDefault: true, status: 'processing' }),
      voice('vcl_0001abcdefgh1234', 'es', 'female', { isDefault: true, kind: 'cloned' }),
      voice('espeak:es-f1', 'es', 'female', { isDefault: true }),
    ];
    expect(pickDefaultVoice(list, 'es')?.id).toBe('espeak:es-f1');
    expect(isVoiceUsable(list[0] as DefaultVoiceCandidate)).toBe(false);
    expect(isVoiceUsable(list[1] as DefaultVoiceCandidate)).toBe(false);
    expect(isVoiceUsable(list[3] as DefaultVoiceCandidate)).toBe(true);
  });

  it('falls back to the frozen local voice when the catalogue has no default', () => {
    expect(pickDefaultVoice([], 'es')).toBeNull();
    expect(pickDefaultVoice(catalogue, 'el')).toBeNull();
    expect(pickDefaultVoiceId([], 'es')).toBe(defaultVoiceId('es'));
    expect(pickDefaultVoiceId(catalogue, 'el', 'male')).toBe('espeak:el-m1');
    // A server that predates the flag: nothing is marked.
    const old = catalogue.map(({ isDefault: _flag, ...rest }) => rest);
    expect(pickDefaultVoiceId(old, 'es')).toBe('espeak:es-f1');
    expect(pickDefaultVoiceId(catalogue, 'es')).toBe('kokoro:ef_dora');
  });

  it('knows which providers are local neural ones', () => {
    expect(isNeuralTtsProvider('kokoro')).toBe(true);
    expect(isNeuralTtsProvider('piper')).toBe(true);
    expect(isNeuralTtsProvider('espeak')).toBe(false);
    expect(isNeuralTtsProvider('elevenlabs')).toBe(false);
  });
});

describe('voice contract additions (additive)', () => {
  const base = {
    id: 'kokoro:ef_dora',
    kind: 'stock',
    name: 'Dora',
    provider: { id: 'kokoro', name: 'Kokoro (neuronal local)', quality: 'premium', local: true },
    language: 'es',
    gender: 'female',
    description: 'Voz neuronal local (Kokoro) · español · femenina',
    tags: ['local', 'neuronal'],
    status: 'ready',
    workspaceId: null,
    consentId: null,
    profile: null,
    error: null,
    createdAt: null,
  };

  it('still accepts a voice without the new fields and leaves them undefined', () => {
    const parsed: Voice = VoiceSchema.parse(base);
    expect(parsed.unavailable).toBeUndefined();
    expect(parsed.isDefault).toBeUndefined();
    expect(parsed.pitchRange).toBeUndefined();
  });

  it('carries why a voice is not installed, the default mark and the pitch range', () => {
    const parsed = VoiceSchema.parse({
      ...base,
      unavailable: { reasonCode: 'voice_incomplete', command: 'pnpm voices:setup' },
      isDefault: false,
      pitchRange: { minSemitones: -4, maxSemitones: 4, resampled: true },
    });
    expect(parsed.unavailable).toEqual({
      reasonCode: 'voice_incomplete',
      command: 'pnpm voices:setup',
    });
    expect(parsed.pitchRange?.resampled).toBe(true);
    expect(
      VoiceSchema.safeParse({ ...base, unavailable: { reasonCode: 'because', command: 'x' } })
        .success,
    ).toBe(false);
    expect(
      VoiceSchema.safeParse({
        ...base,
        pitchRange: { minSemitones: 2, maxSemitones: 4, resampled: true },
      }).success,
    ).toBe(false);
  });

  it('lets the voice listing ask for voices that are not installed', () => {
    const query = api.voices.list.query;
    expect(query?.parse({})).toEqual({});
    expect(query?.parse({ availability: 'all' })).toEqual({ availability: 'all' });
    expect(query?.safeParse({ availability: 'everything' }).success).toBe(false);
  });
});
