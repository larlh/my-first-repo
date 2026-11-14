import { describe, expect, it } from 'vitest';
import {
  SceneRuntimeSchema,
  estimateSpeechTimeline,
  sceneRuntimeFromAudio,
  sceneRuntimeFromTranscript,
  visemesFromAudio,
  wordToVisemes,
} from './index';

function isSorted(times: number[]): boolean {
  return times.every((t, i) => i === 0 || t >= (times[i - 1] ?? 0));
}

describe('estimateSpeechTimeline', () => {
  it('spreads words over the audio, in order and inside its length', () => {
    const text = 'Hola, bienvenidos a Parlante. Hoy vemos tres cosas.';
    const { words, visemes } = estimateSpeechTimeline(text, 4000, 'es');
    expect(words.map((w) => w.text)).toEqual(text.split(' '));
    expect(isSorted(words.map((w) => w.tMs))).toBe(true);
    for (const w of words) {
      expect(w.tMs).toBeGreaterThanOrEqual(0);
      expect(w.tMs + w.durMs).toBeLessThanOrEqual(4000);
    }
    // No overlap between consecutive words.
    words.forEach((w, i) => {
      const next = words[i + 1];
      if (next) expect(w.tMs + w.durMs).toBeLessThanOrEqual(next.tMs + 1);
    });
    expect(visemes[0]).toEqual({ tMs: 0, viseme: 'rest' });
    expect(visemes[visemes.length - 1]?.viseme).toBe('rest');
    expect(isSorted(visemes.map((v) => v.tMs))).toBe(true);
    expect(Math.max(...visemes.map((v) => v.tMs))).toBeLessThanOrEqual(4000);
    // A sentence end closes the mouth before the next sentence.
    const afterFirstSentence = words.find((w) => w.text === 'Hoy');
    const restBefore = visemes.filter(
      (v) => v.viseme === 'rest' && v.tMs > 0 && v.tMs <= (afterFirstSentence?.tMs ?? 0),
    );
    expect(restBefore.length).toBeGreaterThanOrEqual(1);
    expect(SceneRuntimeSchema.parse({ audioDurationMs: 4000, words, visemes })).toBeTruthy();
  });

  it('is deterministic and gives longer words more time', () => {
    const a = estimateSpeechTimeline('sí extraordinariamente', 2000);
    expect(estimateSpeechTimeline('sí extraordinariamente', 2000)).toEqual(a);
    expect(a.words[1]?.durMs ?? 0).toBeGreaterThan((a.words[0]?.durMs ?? 0) * 3);
  });

  it('returns an empty timeline for empty text or no duration', () => {
    expect(estimateSpeechTimeline('   ', 3000)).toEqual({ visemes: [], words: [] });
    expect(estimateSpeechTimeline('hola', 0)).toEqual({ visemes: [], words: [] });
    expect(sceneRuntimeFromTranscript('', 1500)).toEqual({
      audioDurationMs: 1500,
      visemes: [],
      words: [],
    });
  });

  it('maps letters and digraphs to mouth shapes, including non-Latin scripts', () => {
    expect(wordToVisemes('mamá')).toEqual(['MBP', 'A', 'MBP', 'A']);
    expect(wordToVisemes('chico')).toEqual(['CHJ', 'I', 'KG', 'O']);
    expect(wordToVisemes('think')[0]).toBe('TH');
    // Cyrillic / digits still move the mouth (deterministic vowel cycle).
    expect(wordToVisemes('привет').length).toBeGreaterThan(0);
    expect(wordToVisemes('2024').length).toBeGreaterThan(0);
    expect(wordToVisemes('привет')).toEqual(wordToVisemes('привет'));
    expect(wordToVisemes('…')).toEqual([]);
  });
});

describe('visemesFromAudio / sceneRuntimeFromAudio', () => {
  const sampleRate = 16_000;
  /** 1 s: 0.25 s silence, 0.5 s loud tone, 0.25 s silence. */
  function tone(): Float32Array {
    const samples = new Float32Array(sampleRate);
    for (let i = sampleRate / 4; i < (sampleRate * 3) / 4; i += 1) {
      samples[i] = 0.8 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    }
    return samples;
  }

  it('opens the mouth while there is sound and rests in silence', () => {
    const cues = visemesFromAudio(tone(), sampleRate);
    expect(cues[0]).toEqual({ tMs: 0, viseme: 'rest' });
    expect(cues[cues.length - 1]?.viseme).toBe('rest');
    const open = cues.filter((c) => c.viseme !== 'rest');
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open[0]?.tMs).toBeGreaterThanOrEqual(200);
    expect(open[0]?.tMs).toBeLessThanOrEqual(300);
    const closing = cues.find((c) => c.viseme === 'rest' && c.tMs > 300);
    expect(closing?.tMs).toBeGreaterThanOrEqual(700);
    expect(closing?.tMs).toBeLessThanOrEqual(800);
    expect(isSorted(cues.map((c) => c.tMs))).toBe(true);
  });

  it('does not depend materially on the sample rate and ignores silence', () => {
    const at16 = visemesFromAudio(tone(), sampleRate);
    const up = new Float32Array(sampleRate * 3);
    tone().forEach((v, i) => {
      up[i * 3] = v;
      up[i * 3 + 1] = v;
      up[i * 3 + 2] = v;
    });
    const at48 = visemesFromAudio(up, sampleRate * 3);
    expect(at48.map((c) => c.viseme)).toEqual(at16.map((c) => c.viseme));
    at48.forEach((c, i) => expect(Math.abs(c.tMs - (at16[i]?.tMs ?? 0))).toBeLessThanOrEqual(5));
    expect(visemesFromAudio(new Float32Array(sampleRate), sampleRate)).toEqual([]);
    expect(visemesFromAudio(new Float32Array(0), sampleRate)).toEqual([]);
  });

  it('combines transcript words with audio-driven visemes', () => {
    const withAudio = sceneRuntimeFromAudio({
      audioDurationMs: 1000,
      transcript: 'hola mundo',
      samples: tone(),
      sampleRate,
    });
    expect(withAudio.words.map((w) => w.text)).toEqual(['hola', 'mundo']);
    expect(withAudio.visemes).toEqual(visemesFromAudio(tone(), sampleRate));
    const textOnly = sceneRuntimeFromAudio({ audioDurationMs: 1000, transcript: 'hola mundo' });
    expect(textOnly.visemes).toEqual(estimateSpeechTimeline('hola mundo', 1000).visemes);
    const nothing = sceneRuntimeFromAudio({ audioDurationMs: 1000 });
    expect(nothing).toEqual({ audioDurationMs: 1000, words: [], visemes: [] });
    expect(SceneRuntimeSchema.parse(withAudio)).toBeTruthy();
  });
});
