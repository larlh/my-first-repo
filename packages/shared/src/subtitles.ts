import { z } from 'zod';

/** A timed piece of text: subtitle cue, transcript segment or translated segment. */
export const TimedTextSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  text: z.string(),
});
export type TimedText = z.infer<typeof TimedTextSchema>;
export type SubtitleCue = TimedText;
export type TranscriptSegment = TimedText;

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

function formatTimestamp(ms: number, msSeparator: ',' | '.'): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSeparator}${pad(t % 1000, 3)}`;
}

/** Serialise cues as SubRip (.srt). */
export function formatSrt(cues: readonly TimedText[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTimestamp(cue.startMs, ',')} --> ${formatTimestamp(cue.endMs, ',')}\n${cue.text.trim()}\n`,
    )
    .join('\n');
}

/** Serialise cues as WebVTT (.vtt). */
export function formatVtt(cues: readonly TimedText[]): string {
  const body = cues
    .map(
      (cue) =>
        `${formatTimestamp(cue.startMs, '.')} --> ${formatTimestamp(cue.endMs, '.')}\n${cue.text.trim()}\n`,
    )
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

const TIMESTAMP = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const TIMING_LINE = new RegExp(`^\\s*${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}`);

function toMs(h: string | undefined, m: string, s: string, frac: string): number {
  return (
    Number(h ?? 0) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(frac.padEnd(3, '0'))
  );
}

/**
 * Parse SRT or WebVTT text (auto-detected; both use `start --> end` timing lines).
 * Formatting tags (`<i>`, `{\an8}`) are stripped. Returns cues sorted by start time.
 */
export function parseSubtitles(content: string): TimedText[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues: TimedText[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = TIMING_LINE.exec(lines[i] ?? '');
    if (!match) {
      i += 1;
      continue;
    }
    const startMs = toMs(match[1], match[2] ?? '0', match[3] ?? '0', match[4] ?? '0');
    const endMs = toMs(match[5], match[6] ?? '0', match[7] ?? '0', match[8] ?? '0');
    i += 1;
    const textLines: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      textLines.push((lines[i] ?? '').trim());
      i += 1;
    }
    const text = textLines
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]+\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text !== '' && endMs > startMs) cues.push({ startMs, endMs, text });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** Split plain text into sentences (keeps terminal punctuation). */
export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised === '') return [];
  const parts = normalised.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [normalised];
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * Turn an untimed transcript into timed segments by spreading its sentences over
 * `totalDurationMs` proportionally to their length. Used when the user provides plain text
 * instead of SRT/VTT.
 */
export function timePlainTranscript(text: string, totalDurationMs: number): TimedText[] {
  const sentences = splitSentences(text);
  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
  if (totalChars === 0 || totalDurationMs <= 0) return [];
  const out: TimedText[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const dur = (sentence.length / totalChars) * totalDurationMs;
    out.push({ startMs: Math.round(cursor), endMs: Math.round(cursor + dur), text: sentence });
    cursor += dur;
  }
  return out;
}

export const TranscriptFormatSchema = z.enum(['srt', 'vtt', 'text']);
export type TranscriptFormat = z.infer<typeof TranscriptFormatSchema>;

/**
 * Parse a user-provided transcript in any supported format.
 * `totalDurationMs` is required for `text` (and ignored otherwise).
 */
export function parseTranscript(
  format: TranscriptFormat,
  content: string,
  totalDurationMs = 0,
): TimedText[] {
  return format === 'text'
    ? timePlainTranscript(content, totalDurationMs)
    : parseSubtitles(content);
}
