import { describe, expect, it } from 'vitest';
import { PhraseSegmenter } from './segmenter';
import type { SpeechSegment } from './segmenter';
import { blocks, concat, noise, voice } from './testing';

const RATE = 16_000;
const ms = (segment: SpeechSegment) => (segment.samples.length / RATE) * 1000;

function run(
  signal: Float32Array,
  options: Partial<ConstructorParameters<typeof PhraseSegmenter>[0]> = {},
  blockSize = 683,
): { segments: SpeechSegment[]; segmenter: PhraseSegmenter } {
  const segmenter = new PhraseSegmenter({ sampleRate: RATE, maxSegmentMs: 30_000, ...options });
  const segments: SpeechSegment[] = [];
  for (const block of blocks(signal, blockSize)) segments.push(...segmenter.push(block));
  return { segments, segmenter };
}

describe('PhraseSegmenter', () => {
  it('emits nothing for silence or room noise', () => {
    const { segments, segmenter } = run(concat(new Float32Array(RATE), noise(3000)));
    expect(segments).toEqual([]);
    expect(segmenter.flush()).toBeNull();
  });

  it('closes a phrase after a clear pause, keeping a little audio around the speech', () => {
    const { segments } = run(concat(noise(1000), voice(1500), noise(1500)));
    expect(segments).toHaveLength(1);
    const [segment] = segments as [SpeechSegment];
    expect(segment.reason).toBe('pause');
    // 1.5 s of speech + ~0.3 s before + ~0.2 s after.
    expect(ms(segment)).toBeGreaterThan(1850);
    expect(ms(segment)).toBeLessThan(2150);
    // It starts shortly before the speech (pre-roll), not at the start of the stream.
    expect(segment.startMs).toBeGreaterThan(600);
    expect(segment.startMs).toBeLessThanOrEqual(720);
  });

  it('does not cut on a short pause between words', () => {
    const { segments } = run(concat(noise(500), voice(800), noise(400), voice(800), noise(1200)));
    expect(segments).toHaveLength(1);
    expect(ms(segments[0] as SpeechSegment)).toBeGreaterThan(2300);
  });

  it('separates two phrases and reports them in the order they were spoken', () => {
    const { segments } = run(
      concat(noise(400), voice(1000), noise(1000), voice(600, RATE, 0.2, 330), noise(1000)),
    );
    expect(segments.map((segment) => segment.reason)).toEqual(['pause', 'pause']);
    const [first, second] = segments as [SpeechSegment, SpeechSegment];
    expect(first.endMs).toBeLessThanOrEqual(second.startMs);
    expect(ms(first)).toBeGreaterThan(ms(second));
  });

  it('cuts a phrase that reaches the maximum the server accepts and keeps recording', () => {
    const { segments, segmenter } = run(concat(noise(300), voice(7000), noise(1000)), {
      maxSegmentMs: 4000,
      softMaxMs: 4000,
    });
    expect(segments.map((segment) => segment.reason)).toEqual(['max', 'max', 'pause']);
    for (const segment of segments) expect(ms(segment)).toBeLessThanOrEqual(4000);
    // Nothing was lost between the cuts: together they hold all the speech.
    const total = segments.reduce((sum, segment) => sum + ms(segment), 0);
    expect(total).toBeGreaterThan(7000);
    expect(total).toBeLessThan(7700);
    expect(segmenter.speaking).toBe(false);
  });

  it('accepts a shorter pause once the phrase is long', () => {
    const signal = concat(noise(300), voice(2500), noise(400), voice(800), noise(1200));
    expect(run(signal).segments).toHaveLength(1);
    const long = run(signal, { softMaxMs: 2000 });
    expect(long.segments).toHaveLength(2);
  });

  it('drops clicks that are too short to be speech', () => {
    const { segments } = run(concat(noise(500), voice(80), noise(1500)));
    expect(segments).toEqual([]);
  });

  it('hands over the phrase in progress when the stream is stopped', () => {
    const { segments, segmenter } = run(concat(noise(300), voice(1200)));
    expect(segments).toEqual([]);
    expect(segmenter.speaking).toBe(true);
    const last = segmenter.flush();
    expect(last?.reason).toBe('flush');
    expect(ms(last as SpeechSegment)).toBeGreaterThan(1200);
    expect(segmenter.flush()).toBeNull();
  });

  it('adapts to a noisy room: steady noise is not speech, a voice over it is', () => {
    const loudRoom = noise(4000, RATE, 0.02);
    const alone = run(loudRoom);
    expect(alone.segments).toEqual([]);
    expect(alone.segmenter.speaking).toBe(false);
    const { segments } = run(concat(loudRoom, voice(1000, RATE, 0.4), noise(1200, RATE, 0.02)));
    expect(segments).toHaveLength(1);
    expect(ms(segments[0] as SpeechSegment)).toBeLessThan(1700);
  });

  it('recovers when the noise starts later: a fan switching on does not record forever', () => {
    const { segments, segmenter } = run(concat(noise(1000), noise(8000, RATE, 0.02)));
    // The first seconds of the new noise may pass for speech; then the floor catches up.
    expect(segments.length).toBeLessThanOrEqual(1);
    expect(segmenter.speaking).toBe(false);
  });

  it('gives the same phrases whatever the size of the blocks it is fed', () => {
    const signal = concat(noise(400), voice(1000), noise(1000), voice(700), noise(1000));
    const a = run(signal, {}, 128).segments;
    const b = run(signal, {}, 2048).segments;
    expect(a.map((s) => [s.startMs, s.endMs, s.samples.length])).toEqual(
      b.map((s) => [s.startMs, s.endMs, s.samples.length]),
    );
  });
});
