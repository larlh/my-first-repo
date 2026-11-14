import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatClock,
  formatDate,
  formatDuration,
  formatNumber,
  formatPercent,
  formatPrice,
  formatRelativeTime,
  formatTimecode,
} from './format';

const nbsp = (text: string) => text.replace(new RegExp('[\\u00a0\\u202f]', 'g'), ' ');

describe('format', () => {
  it('formats media clocks and timecodes', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatTimecode(65_250)).toBe('01:05.250');
    expect(formatTimecode(3_600_000)).toBe('01:00:00.000');
  });

  it('formats human durations with SI symbols', () => {
    expect(formatDuration(65_000, 'es')).toBe('1 min 5 s');
    expect(formatDuration(120_000, 'es')).toBe('2 min');
    expect(formatDuration(3_723_000, 'es')).toBe('1 h 2 min');
    expect(formatDuration(13_000, 'es')).toBe('13 s');
    expect(formatDuration(800, 'es')).toBe('0,8 s');
    expect(formatDuration(800, 'en')).toBe('0.8 s');
    expect(formatDuration(-5, 'es')).toBe('0 s');
  });

  it('formats sizes with binary multiples', () => {
    expect(nbsp(formatBytes(0, 'es'))).toBe('0 B');
    expect(nbsp(formatBytes(1_572_864, 'es'))).toBe('1,5 MB');
    expect(nbsp(formatBytes(1_572_864, 'en'))).toBe('1.5 MB');
    expect(nbsp(formatBytes(1024 ** 3, 'en'))).toBe('1 GB');
    expect(nbsp(formatBytes(150 * 1024 * 1024, 'en'))).toBe('150 MB');
  });

  it('formats numbers, percentages and prices per locale', () => {
    expect(formatNumber(12_345, 'es')).toBe('12.345');
    expect(formatNumber(12_345, 'en')).toBe('12,345');
    expect(nbsp(formatPercent(42.4, 'es'))).toBe('42 %');
    expect(formatPercent(140, 'en')).toBe('100%');
    expect(nbsp(formatPrice(2400, 'es'))).toBe('24 €');
    expect(formatPrice(2400, 'en')).toBe('€24');
  });

  it('formats dates and relative times', () => {
    expect(formatDate('2026-11-14T09:41:00.000Z', 'es')).toMatch(/14 nov 2026/);
    const now = new Date('2026-11-14T12:00:00.000Z');
    expect(formatRelativeTime('2026-11-14T11:57:00.000Z', 'es', now)).toBe('hace 3 minutos');
    expect(formatRelativeTime('2026-11-13T12:00:00.000Z', 'es', now)).toBe('ayer');
    expect(formatRelativeTime('2026-11-14T14:00:00.000Z', 'en', now)).toBe('in 2 hours');
    expect(formatRelativeTime('2026-11-14T11:59:58.000Z', 'en', now)).toBe('now');
  });
});
