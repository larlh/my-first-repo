import { describe, expect, it } from 'vitest';
import { VOICE_PREVIEW_TEXTS, VoiceProfileSchema } from '@parlante/shared';
import type { TTSRequest, VoiceCloneRequest } from '@parlante/shared';
import { providerEnvSchema } from '../env';
import { createEspeakProvider } from '../tts/espeak';
import { decodeWav, encodeWav } from '../tts/wav';
import { analyzeVoice, semitonesBetween } from './analysis';
import { createLocalVoiceCloneProvider } from './local';

const env = providerEnvSchema.parse({});
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
      name: 'Voice profile (local)',
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
