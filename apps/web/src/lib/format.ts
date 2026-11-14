import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from './i18n';

/* Locale-aware formatting. Every function takes the locale last (default: current UI
 * language). In components prefer `useFormat()`: it re-renders when the language changes. */

type DateInput = Date | string | number;

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}

/** "14 nov 2026" */
export function formatDate(value: DateInput, locale: string = currentLocale()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(toDate(value));
}

/** "14 nov 2026, 9:41" */
export function formatDateTime(value: DateInput, locale: string = currentLocale()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    toDate(value),
  );
}

const RELATIVE_STEPS: [limit: number, divisor: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [604_800, 86_400, 'day'],
  [2_629_800, 604_800, 'week'],
  [31_557_600, 2_629_800, 'month'],
  [Number.POSITIVE_INFINITY, 31_557_600, 'year'],
];

/** "hace 3 minutos", "ayer", "dentro de 2 horas". */
export function formatRelativeTime(
  value: DateInput,
  locale: string = currentLocale(),
  now: DateInput = Date.now(),
): string {
  const diffSec = (toDate(value).getTime() - toDate(now).getTime()) / 1000;
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 10) return rtf.format(0, 'second');
  for (const [limit, divisor, unit] of RELATIVE_STEPS) {
    if (abs < limit) return rtf.format(Math.round(diffSec / divisor), unit);
  }
  return rtf.format(Math.round(diffSec / 31_557_600), 'year');
}

/** Media clock: 65_000 → "1:05", 3_723_000 → "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Editor timecode with milliseconds: 65_250 → "01:05.250". */
export function formatTimecode(ms: number): string {
  const t = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
  return h > 0 ? `${String(h).padStart(2, '0')}:${base}` : base;
}

/** Human duration with SI symbols: 65_000 → "1 min 5 s", 3_723_000 → "1 h 2 min", 800 → "0,8 s". */
export function formatDuration(ms: number, locale: string = currentLocale()): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (safe < 10_000 && safe % 1000 !== 0) {
    const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(safe / 1000);
    return `${seconds} s`;
  }
  const total = Math.round(safe / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** 1_572_864 → "1,5 MB" (binary multiples, the way the plan limits are defined). */
export function formatBytes(bytes: number, locale: string = currentLocale()): string {
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let index = 0;
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[index],
    unitDisplay: 'short',
    maximumFractionDigits: index === 0 || value >= 100 ? 0 : 1,
  }).format(value);
}

/** 12345.6 → "12.346" */
export function formatNumber(
  value: number,
  locale: string = currentLocale(),
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...options }).format(value);
}

/** 0..100 → "42 %" */
export function formatPercent(value: number, locale: string = currentLocale()): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    Math.min(100, Math.max(0, value)) / 100,
  );
}

/** Price in cents → "24 €" / "€24" (display only: payments are simulated). */
export function formatPrice(
  cents: number,
  locale: string = currentLocale(),
  currency = 'EUR',
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export interface Formatters {
  locale: string;
  date: (value: DateInput) => string;
  dateTime: (value: DateInput) => string;
  relative: (value: DateInput, now?: DateInput) => string;
  duration: (ms: number) => string;
  clock: (ms: number) => string;
  timecode: (ms: number) => string;
  bytes: (bytes: number) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  percent: (value: number) => string;
  price: (cents: number, currency?: string) => string;
}

/** Formatters bound to the current UI language; stable until the language changes. */
export function useFormat(): Formatters {
  const { i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language ?? 'es').slice(0, 2);
  return useMemo(
    () => ({
      locale,
      date: (value) => formatDate(value, locale),
      dateTime: (value) => formatDateTime(value, locale),
      relative: (value, now) => formatRelativeTime(value, locale, now),
      duration: (ms) => formatDuration(ms, locale),
      clock: formatClock,
      timecode: formatTimecode,
      bytes: (bytes) => formatBytes(bytes, locale),
      number: (value, options) => formatNumber(value, locale, options),
      percent: (value) => formatPercent(value, locale),
      price: (cents, currency) => formatPrice(cents, locale, currency),
    }),
    [locale],
  );
}
