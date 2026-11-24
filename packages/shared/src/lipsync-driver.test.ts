import { describe, expect, it } from 'vitest';
import { EngineAnimateRequestSchema, EngineHealthSchema, EngineJobResultSchema } from './index';

/* Additive contract of the lip-sync driver choice (audio-driven lips). Requests and engines
 * that do not know the fields keep working exactly as before. */

const REQUEST = {
  portraitPath: '/work/j/portrait.png',
  audioPath: '/work/j/audio.wav',
  outputDir: '/work/j',
};

describe('lip-sync driver contract additions', () => {
  it('an animation request may name its driver; without the field nothing changes', () => {
    const legacy = EngineAnimateRequestSchema.parse(REQUEST);
    expect(legacy).not.toHaveProperty('driver');
    expect(legacy).toMatchObject({ maskPath: null, fps: 30, maxSize: 512 });
    for (const driver of ['auto', 'visemes', 'audio'] as const) {
      expect(EngineAnimateRequestSchema.parse({ ...REQUEST, driver }).driver).toBe(driver);
    }
    expect(EngineAnimateRequestSchema.safeParse({ ...REQUEST, driver: 'magic' }).success).toBe(
      false,
    );
    // Word timeline hint next to the viseme timeline.
    const words = [{ tMs: 0, durMs: 180, text: 'Hola' }];
    expect(EngineAnimateRequestSchema.parse({ ...REQUEST, words }).words).toEqual(words);
  });

  it('an animation result may say which driver ran; older engines omit it', () => {
    const base = {
      kind: 'animate' as const,
      videoPath: '/work/j/avatar.mp4',
      alpha: 'mask-video' as const,
      maskPath: '/work/j/avatar-matte.mp4',
      width: 512,
      height: 512,
      fps: 30,
      frameCount: 90,
      model: 'liveportrait-onnx+ditto-audio2motion',
    };
    expect(EngineJobResultSchema.parse(base)).not.toHaveProperty('driver');
    expect(EngineJobResultSchema.parse({ ...base, driver: 'audio' })).toMatchObject({
      driver: 'audio',
    });
    expect(EngineJobResultSchema.safeParse({ ...base, driver: 'auto' }).success).toBe(false);
  });

  it('health may announce what `auto` resolves to and a key for clip caches', () => {
    const health = {
      status: 'ok' as const,
      version: '1.1.0',
      device: 'cpu' as const,
      capabilities: { generate: false, prepare: true, animate: true },
      models: [],
      secondsPerVideoSecond: 33.2,
    };
    expect(EngineHealthSchema.parse(health)).not.toHaveProperty('animation');
    const parsed = EngineHealthSchema.parse({
      ...health,
      drivers: { visemes: true, audio: true },
      animation: { autoDriver: 'audio', key: 'audio-lips.v1' },
    });
    expect(parsed.animation).toEqual({ autoDriver: 'audio', key: 'audio-lips.v1' });
  });
});
