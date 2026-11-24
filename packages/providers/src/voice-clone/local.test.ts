import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_PREVIEW_TEXTS, VoiceProfileSchema } from '@parlante/shared';
import type { ProviderVoice, TTSProvider, TTSRequest, VoiceCloneRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createEspeakProvider } from '../tts/espeak';
import { decodeWav, encodeWav } from '../tts/wav';
import { analyzeVoice, semitonesBetween } from './analysis';
import { createLocalVoiceCloneProvider } from './local';

// Hermetic: no neural voice is installed in this folder, whatever ./data/models holds, so the
// profile is built on the eSpeak voices (the neural base has its own tests below, with doubles).
const env = providerEnvSchema.parse({
  VOICE_MODEL_DIR: path.join(os.tmpdir(), `parlante-no-voices-${process.pid}`),
});
const tts = createEspeakProvider(env);
const clone = createLocalVoiceCloneProvider(env);

const SAMPLE_TEXT =
  'Esta es una muestra de mi voz para Parlante. Hablo con naturalidad durante unos segundos, sin música de fondo.';

async function speak(overrides: Partial<TTSRequest> = {}) {
  return tts.synthesize({
    text: SAMPLE_TEXT,
    providerVoiceId: 'es-m1',
    language: 'es',
    speed: 1,
    pitch: 0,
    ...overrides,
  });
}

function f0Of(wav: Uint8Array): number {
  const pcm = decodeWav(wav);
  return analyzeVoice(pcm.samples, pcm.sampleRate).medianF0Hz ?? 0;
}

const request = (
  sample: Uint8Array,
  overrides: Partial<VoiceCloneRequest> = {},
): VoiceCloneRequest => ({
  name: 'Mi voz',
  sample,
  sampleRate: 22_050,
  language: 'es',
  consentId: 'cns_0123456789abcdef',
  ...overrides,
});

/** A synthetic "speaker": harmonic tone with syllable-like bursts. */
function syntheticVoice(
  hz: number,
  seconds: number,
  sampleRate: number,
  syllablesPerSec = 4.5,
): Int16Array {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / sampleRate;
    const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * syllablesPerSec * t);
    let value = 0;
    for (let h = 1; h <= 6; h += 1) value += Math.sin(2 * Math.PI * h * hz * t) / h;
    samples[i] = Math.round(6000 * envelope * value);
  }
  return samples;
}

describe('local voice cloning (voice profile — basic mode)', () => {
  it('is honest about what it is', () => {
    expect(clone.info).toEqual({
      id: 'local',
      name: 'Perfil de voz (local)',
      quality: 'basic',
      local: true,
    });
  });

  it('measures the pitch of the sample and reproduces it with the local voice', async () => {
    // A "person" who speaks 4 semitones above the male base voice.
    const sample = await speak({ pitch: 4 });
    const sampleF0 = f0Of(sample.audio);
    const result = await clone.createVoice(request(sample.audio));

    expect(result.provider).toEqual(clone.info);
    expect(result.ttsProviderId).toBe('espeak');
    expect(result.providerVoiceId).toBe('es-m1');
    const profile = VoiceProfileSchema.parse(result.profile);
    expect(profile.baseVoiceId).toBe('es-m1');
    expect(profile.pitchSemitones).toBeGreaterThan(3.3);
    expect(profile.pitchSemitones).toBeLessThan(4.7);
    expect(Math.abs((profile.meanF0Hz ?? 0) - sampleF0)).toBeLessThan(0.11);
    expect(profile.speed).toBeGreaterThanOrEqual(0.8);
    expect(profile.speed).toBeLessThanOrEqual(1.25);

    // Speaking with the profile lands on the pitch of the sample (within a semitone).
    const spoken = await speak({
      providerVoiceId: result.providerVoiceId,
      profile: result.profile,
    });
    expect(Math.abs(semitonesBetween(sampleF0, f0Of(spoken.audio)))).toBeLessThan(1);
  });

  it('chooses the base timbre from the pitch, unless the gender is given', async () => {
    const high = await speak({ providerVoiceId: 'es-f1', pitch: -1 });
    const fromPitch = await clone.createVoice(request(high.audio));
    expect(fromPitch.providerVoiceId).toBe('es-f1');
    expect(Math.abs((fromPitch.profile?.pitchSemitones ?? 99) + 1)).toBeLessThan(0.7);

    const forcedMale = await clone.createVoice(request(high.audio, { gender: 'male' }));
    expect(forcedMale.providerVoiceId).toBe('es-m1');
    expect(forcedMale.profile?.baseVoiceId).toBe('es-m1');
    // The same measured pitch, now a long way above the male base voice.
    expect(forcedMale.profile?.pitchSemitones).toBeGreaterThan(8);
    expect(forcedMale.profile?.meanF0Hz).toBe(fromPitch.profile?.meanF0Hz);

    const low = await speak({ providerVoiceId: 'es-m1' });
    expect(
      (await clone.createVoice(request(low.audio, { gender: 'neutral' }))).providerVoiceId,
    ).toBe('es-m1');
    expect(
      (await clone.createVoice(request(low.audio, { gender: 'female' }))).providerVoiceId,
    ).toBe('es-f1');
  });

  it('uses a voice of the requested language', async () => {
    const text = VOICE_PREVIEW_TEXTS.de ?? '';
    const german = await tts.synthesize({
      text: `${text} ${text}`,
      providerVoiceId: 'de-f1',
      language: 'de',
      speed: 1,
      pitch: 2,
    });
    const result = await clone.createVoice(request(german.audio, { language: 'de' }));
    expect(result.providerVoiceId).toBe('de-f1');
    expect(Math.abs((result.profile?.pitchSemitones ?? 99) - 2)).toBeLessThan(0.7);
  });

  it('profiles a synthetic speaker from its fundamental frequency', async () => {
    for (const [hz, base] of [
      [118, 'es-m1'],
      [215, 'es-f1'],
    ] as const) {
      const sampleRate = 16_000;
      const wav = encodeWav(syntheticVoice(hz, 6, sampleRate), sampleRate);
      const result = await clone.createVoice(request(wav, { sampleRate }));
      expect(result.providerVoiceId).toBe(base);
      expect(Math.abs((result.profile?.meanF0Hz ?? 0) - hz)).toBeLessThan(hz * 0.01);
      // The profile closes the gap between the base voice and the speaker.
      const baseSpeech = await speak({ providerVoiceId: base });
      const expected = semitonesBetween(f0Of(baseSpeech.audio), hz);
      expect(Math.abs((result.profile?.pitchSemitones ?? 99) - expected)).toBeLessThan(0.8);
      const spoken = await speak({ providerVoiceId: base, profile: result.profile });
      expect(Math.abs(semitonesBetween(hz, f0Of(spoken.audio)))).toBeLessThan(1);
    }
  });

  it('accepts raw PCM16 with the declared sample rate as well as WAV', async () => {
    const sampleRate = 16_000;
    const samples = syntheticVoice(130, 5, sampleRate);
    const raw = new Uint8Array(samples.buffer.slice(0));
    const fromRaw = await clone.createVoice(request(raw, { sampleRate }));
    const fromWav = await clone.createVoice(
      request(encodeWav(samples, sampleRate), { sampleRate: 99 }),
    );
    expect(fromRaw.profile).toEqual(fromWav.profile);
  });

  it('nudges the pace only inside a narrow range', async () => {
    const slow = await clone.createVoice(request((await speak({ speed: 0.6 })).audio));
    const normal = await clone.createVoice(request((await speak()).audio));
    const fast = await clone.createVoice(request((await speak({ speed: 1.7 })).audio));
    for (const result of [slow, normal, fast]) {
      expect(result.profile?.speed).toBeGreaterThanOrEqual(0.8);
      expect(result.profile?.speed).toBeLessThanOrEqual(1.25);
    }
    expect(slow.profile?.speed).toBeLessThan(normal.profile?.speed ?? 0);
    expect(fast.profile?.speed).toBeGreaterThanOrEqual(normal.profile?.speed ?? 9);
    expect(slow.profile?.speed).toBeLessThan(0.95);
  });

  it('refuses samples it cannot measure, saying why', async () => {
    const tooShort = encodeWav(syntheticVoice(150, 1.2, 16_000), 16_000);
    await expect(clone.createVoice(request(tooShort))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      status: 422,
      message: expect.stringMatching(/too short/) as unknown,
    });
    const silence = encodeWav(new Int16Array(16_000 * 5), 16_000);
    await expect(clone.createVoice(request(silence))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      message: expect.stringMatching(/No voice could be detected/) as unknown,
    });
    const noise = new Int16Array(16_000 * 5);
    let state = 7;
    for (let i = 0; i < noise.length; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      noise[i] = (state >>> 16) - 32768;
    }
    await expect(clone.createVoice(request(encodeWav(noise, 16_000)))).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
    await expect(
      clone.createVoice(request(new TextEncoder().encode('RIFFxxxxWAVEgarbage-not-a-wave'))),
    ).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
  });

  it('deleting a local voice is a no-op', async () => {
    await expect(clone.deleteVoice('es-m1')).resolves.toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------
 * The base of a profile when local NEURAL voices are installed. The neural providers are
 * doubles: each of their voices "speaks" as a synthetic speaker of a known pitch, so the choice
 * can be checked exactly. (The real models are exercised by tts/neural.real.test.ts.)
 * ------------------------------------------------------------------------------------------- */

interface FakeNeuralVoice extends ProviderVoice {
  /** Pitch this voice speaks at. */
  hz: number;
}

function fakeNeural(id: string, voices: FakeNeuralVoice[], failing: string[] = []): TTSProvider {
  const info = { id, name: `${id} (neuronal local)`, quality: 'premium' as const, local: true };
  return {
    info,
    volatileVoices: true,
    listVoices: () => Promise.resolve(voices),
    synthesize(request) {
      if (failing.includes(request.providerVoiceId)) {
        return Promise.reject(new Error('the model could not be loaded'));
      }
      const voice = voices.find((v) => v.providerVoiceId === request.providerVoiceId);
      const sampleRate = 16_000;
      const samples = syntheticVoice(voice?.hz ?? 100, 6, sampleRate);
      return Promise.resolve({
        audio: encodeWav(samples, sampleRate),
        format: 'wav',
        sampleRate,
        durationMs: 6000,
        visemes: [],
        words: [],
        provider: info,
      });
    },
  };
}

const neuralVoice = (
  providerVoiceId: string,
  language: string,
  gender: 'female' | 'male',
  hz: number,
  extra: Partial<ProviderVoice> = {},
): FakeNeuralVoice => ({
  providerVoiceId,
  name: providerVoiceId,
  language,
  gender,
  description: '',
  tags: [],
  pitchRange: { minSemitones: -4, maxSemitones: 4, resampled: true },
  hz,
  ...extra,
});

describe('local voice profile on top of a neural voice', () => {
  const kokoro = () =>
    fakeNeural('kokoro', [
      neuralVoice('ef_dora', 'es', 'female', 200),
      neuralVoice('em_alex', 'es', 'male', 105),
      neuralVoice('em_low', 'es', 'male', 85),
      neuralVoice('af_heart', 'en', 'female', 195),
      neuralVoice('if_sara', 'it', 'female', 190, {
        unavailable: { reasonCode: 'voice_not_installed', command: 'pnpm voices:setup' },
      }),
    ]);
  const piper = () => fakeNeural('piper', [neuralVoice('es_ES-davefx-medium', 'es', 'male', 125)]);
  const sampleOf = (hz: number) => encodeWav(syntheticVoice(hz, 6, 16_000), 16_000);
  const cloneWith = (...neural: TTSProvider[]) => createLocalVoiceCloneProvider(env, { neural });

  it('picks the installed neural voice of that language and gender closest in pitch', async () => {
    const clone2 = cloneWith(kokoro(), piper());
    // A man at 120 Hz: Piper's 125 Hz voice is nearer than Kokoro's 105 Hz and 85 Hz ones.
    const man = await clone2.createVoice(request(sampleOf(120), { sampleRate: 16_000 }));
    expect(man).toMatchObject({ ttsProviderId: 'piper', providerVoiceId: 'es_ES-davefx-medium' });
    expect(man.profile?.baseVoiceId).toBe('es_ES-davefx-medium');
    expect(Math.abs((man.profile?.pitchSemitones ?? 99) - semitonesBetween(125, 120))).toBeLessThan(
      0.3,
    );
    // A deeper man: the lowest Kokoro voice.
    const deep = await clone2.createVoice(request(sampleOf(88), { sampleRate: 16_000 }));
    expect(deep).toMatchObject({ ttsProviderId: 'kokoro', providerVoiceId: 'em_low' });
    // A woman: the only Spanish female neural voice, moved up to her pitch.
    const woman = await clone2.createVoice(request(sampleOf(220), { sampleRate: 16_000 }));
    expect(woman).toMatchObject({ ttsProviderId: 'kokoro', providerVoiceId: 'ef_dora' });
    expect(woman.profile?.pitchSemitones).toBeCloseTo(semitonesBetween(200, 220), 0);
    expect(woman.profile?.meanF0Hz).toBeCloseTo(220, -1);
    // It is still a basic profile and says so: the timbre is the base voice's, not the person's.
    expect(woman.provider).toEqual({
      id: 'local',
      name: 'Perfil de voz (local)',
      quality: 'basic',
      local: true,
    });
  });

  it('respects the declared gender over the measured pitch', async () => {
    const clone2 = cloneWith(kokoro());
    const result = await clone2.createVoice(
      request(sampleOf(210), { sampleRate: 16_000, gender: 'male' }),
    );
    expect(result.providerVoiceId).toBe('em_alex');
  });

  it('never asks a neural voice for more pitch change than it can do', async () => {
    const clone2 = cloneWith(kokoro());
    // 300 Hz is 7 semitones above the 200 Hz voice: the profile stops at its +4.
    const high = await clone2.createVoice(request(sampleOf(300), { sampleRate: 16_000 }));
    expect(high.providerVoiceId).toBe('ef_dora');
    expect(high.profile?.pitchSemitones).toBe(4);
    const low = await clone2.createVoice(
      request(sampleOf(62), { sampleRate: 16_000, gender: 'male' }),
    );
    expect(low.providerVoiceId).toBe('em_low');
    expect(low.profile?.pitchSemitones).toBe(-4);
  });

  it('falls back to eSpeak when no neural voice is installed for the language and gender', async () => {
    const clone2 = cloneWith(kokoro());
    // Italian: the only neural voice is not installed.
    const italian = await clone2.createVoice(
      request(sampleOf(200), { sampleRate: 16_000, language: 'it' }),
    );
    expect(italian).toMatchObject({ ttsProviderId: 'espeak', providerVoiceId: 'it-f1' });
    // English male: Kokoro only has a female English voice in this catalogue.
    const english = await clone2.createVoice(
      request(sampleOf(110), { sampleRate: 16_000, language: 'en' }),
    );
    expect(english).toMatchObject({ ttsProviderId: 'espeak', providerVoiceId: 'en-m1' });
    // eSpeak's own pitch range is the whole one.
    expect(english.profile?.baseVoiceId).toBe('en-m1');
  });

  it('skips a neural voice that cannot speak right now instead of failing the clone', async () => {
    const broken = fakeNeural(
      'kokoro',
      [neuralVoice('em_alex', 'es', 'male', 105), neuralVoice('em_low', 'es', 'male', 85)],
      ['em_alex'],
    );
    const result = await cloneWith(broken).createVoice(
      request(sampleOf(108), { sampleRate: 16_000 }),
    );
    expect(result.providerVoiceId).toBe('em_low');
    // Every neural candidate down: the eSpeak voice.
    const allDown = fakeNeural('kokoro', [neuralVoice('em_alex', 'es', 'male', 105)], ['em_alex']);
    const fallback = await cloneWith(allDown).createVoice(
      request(sampleOf(108), { sampleRate: 16_000 }),
    );
    expect(fallback).toMatchObject({ ttsProviderId: 'espeak', providerVoiceId: 'es-m1' });
  });
});
