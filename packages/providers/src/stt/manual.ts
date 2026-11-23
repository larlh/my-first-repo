import { AppError, parseSubtitles, timePlainTranscript } from '@parlante/shared';
import type { ProviderRef, STTProvider, TimedText, TranscriptFormat } from '@parlante/shared';
import { splitPlainText } from '../tts/text';

/* -------------------------------------------------------------------------------------------
 * "Manual" STT — the local mode. Nothing is recognised: the USER supplies the transcript and
 * this module turns it into timed segments, whatever shape it comes in:
 *
 *   srt / vtt   cue times are kept; headers, NOTE blocks, cue settings, voice / style tags and
 *               entities are removed; timestamps without milliseconds are accepted
 *   text        "[00:12] line" / "1:05 line" stamps are honoured when most lines have one;
 *               otherwise sentences are spread over the audio in proportion to their length
 *
 * Afterwards, for every format: sorted, inside the audio, no overlaps, no duplicated rolling
 * captions, no segment too long to dub or subtitle. `providers.stt.transcribe()` itself keeps
 * throwing TRANSCRIPT_REQUIRED (contract): callers check `requiresUserTranscript` and call
 * `parseUserTranscript` with what the user sent.
 * ----------------------------------------------------------------------------------------- */

export const MANUAL_STT_INFO: ProviderRef = {
  id: 'manual',
  name: 'Transcript provided by the user',
  quality: 'basic',
  local: true,
};

export interface UserTranscriptInput {
  content: string;
  /** `auto` (default) detects SRT / VTT by their timing lines, otherwise plain text. */
  format?: TranscriptFormat | 'auto';
  /** Length of the audio. Required for untimed text; trims timed cues when positive. */
  totalDurationMs: number;
}

export interface ParsedTranscript {
  /** The format actually parsed. */
  format: TranscriptFormat;
  segments: TimedText[];
}

/** Longest untimed segment: longer sentences are split at clause boundaries. */
const MAX_TEXT_SEGMENT_CHARS = 160;
/** Reading pace used when a stamped line has no following stamp and no audio length. */
const MS_PER_CHAR = 65;

const ARROW = /-->/;
const UNFRACTIONED_TIMESTAMP = /(?<![\d:.,])((?:\d{1,3}:)?\d{1,2}:\d{2})(?![\d:.,])/g;
const STAMPED_LINE =
  /^\s*[[(]?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?\s*[\])]?\s*[-–—:]?\s*(.*)$/;

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lrm;': '',
  '&rlm;': '',
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|nbsp|quot|apos|lrm|rlm|#39);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

export function detectTranscriptFormat(content: string): TranscriptFormat {
  const text = content.replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT(?:\s|$)/.test(text)) return 'vtt';
  return text.split(/\r?\n/).some((line) => ARROW.test(line) && /\d:\d{2}/.test(line))
    ? 'srt'
    : 'text';
}

function parseTimed(content: string): TimedText[] {
  // `00:01:02 --> 00:01:05` (no milliseconds) is common in hand-made files.
  const normalised = content
    .split(/\r?\n/)
    .map((line) => (ARROW.test(line) ? line.replace(UNFRACTIONED_TIMESTAMP, '$1.000') : line))
    .join('\n');
  return parseSubtitles(normalised)
    .map((cue) => ({ ...cue, text: decodeEntities(cue.text).replace(/\s+/g, ' ').trim() }))
    .filter((cue) => cue.text !== '');
}

function parseStampedText(content: string, totalDurationMs: number): TimedText[] | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const stamped = lines.map((line) => STAMPED_LINE.exec(line));
  const count = stamped.filter(Boolean).length;
  if (count < 2 || count < lines.length * 0.6) return null;
  const entries: { startMs: number; text: string }[] = [];
  lines.forEach((line, index) => {
    const match = stamped[index];
    if (!match) {
      const last = entries[entries.length - 1];
      if (last) last.text = `${last.text} ${line}`.trim();
      return;
    }
    const startMs =
      Number(match[1] ?? 0) * 3_600_000 +
      Number(match[2]) * 60_000 +
      Number(match[3]) * 1000 +
      Number((match[4] ?? '0').padEnd(3, '0'));
    entries.push({ startMs, text: (match[5] ?? '').trim() });
  });
  entries.sort((a, b) => a.startMs - b.startMs);
  return entries
    .map((entry, index) => {
      const next = entries[index + 1];
      const estimated = entry.startMs + Math.max(1000, entry.text.length * MS_PER_CHAR);
      const endMs = next
        ? next.startMs
        : totalDurationMs > entry.startMs
          ? totalDurationMs
          : estimated;
      return { startMs: entry.startMs, endMs, text: entry.text.replace(/\s+/g, ' ') };
    })
    .filter((cue) => cue.text !== '' && cue.endMs > cue.startMs);
}

/** Split segments that are too long to subtitle, sharing their time by length. */
function splitLongSegments(segments: readonly TimedText[]): TimedText[] {
  const out: TimedText[] = [];
  for (const segment of segments) {
    if (segment.text.length <= MAX_TEXT_SEGMENT_CHARS) {
      out.push(segment);
      continue;
    }
    const pieces = splitPlainText(segment.text, MAX_TEXT_SEGMENT_CHARS);
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    let cursor = segment.startMs;
    pieces.forEach((piece, index) => {
      const last = index === pieces.length - 1;
      const end = last
        ? segment.endMs
        : cursor + ((segment.endMs - segment.startMs) * piece.length) / total;
      out.push({ startMs: Math.round(cursor), endMs: Math.round(end), text: piece });
      cursor = end;
    });
  }
  return out;
}

/** Sort, trim to the audio, merge rolling duplicates and remove overlaps. */
function tidy(cues: readonly TimedText[], totalDurationMs: number): TimedText[] {
  const sorted = [...cues]
    .map((cue) => ({
      startMs: Math.max(0, Math.round(cue.startMs)),
      endMs: Math.round(cue.endMs),
      text: cue.text,
    }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: TimedText[] = [];
  for (const cue of sorted) {
    if (totalDurationMs > 0) {
      if (cue.startMs >= totalDurationMs) continue;
      cue.endMs = Math.min(cue.endMs, totalDurationMs);
    }
    const previous = out[out.length - 1];
    if (previous) {
      if (previous.text === cue.text && cue.startMs <= previous.endMs + 50) {
        previous.endMs = Math.max(previous.endMs, cue.endMs); // rolling caption repeated
        continue;
      }
      if (cue.startMs <= previous.startMs) {
        // Two cues at the same instant (two speakers): one segment.
        previous.text = `${previous.text} ${cue.text}`;
        previous.endMs = Math.max(previous.endMs, cue.endMs);
        continue;
      }
      if (previous.endMs > cue.startMs) previous.endMs = cue.startMs;
    }
    if (cue.endMs > cue.startMs) out.push(cue);
  }
  return out;
}

/**
 * Turn a transcript supplied by the user into timed segments. Throws `VALIDATION_ERROR` when
 * it contains no usable text, or when untimed text comes without the length of the audio.
 */
export function parseUserTranscript(input: UserTranscriptInput): ParsedTranscript {
  const content = input.content.replace(/^\uFEFF/, '');
  const totalDurationMs = Math.max(0, Math.round(input.totalDurationMs));
  const requested = input.format ?? 'auto';
  const detected = detectTranscriptFormat(content);
  // A file sent as "text" that is really SRT / VTT (or the reverse) is parsed as what it is.
  const format: TranscriptFormat =
    requested === 'auto'
      ? detected
      : requested === 'text' || detected === 'text'
        ? detected
        : requested;

  let segments: TimedText[];
  if (format === 'text') {
    const stamped = parseStampedText(content, totalDurationMs);
    if (stamped) {
      segments = stamped;
    } else {
      if (totalDurationMs <= 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          'A plain-text transcript needs the length of the audio to be timed',
        );
      }
      segments = timePlainTranscript(content, totalDurationMs);
    }
    segments = splitLongSegments(segments);
  } else {
    segments = parseTimed(content);
  }
  segments = tidy(segments, totalDurationMs);
  if (segments.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'The transcript contains no usable text', { format });
  }
  return { format, segments };
}

/**
 * Local "manual" STT: cannot transcribe. The user supplies the transcript (SRT / VTT / text)
 * and callers parse it with `parseUserTranscript`. This behaviour is final, not a stub.
 */
export function createManualSttProvider(): STTProvider {
  return {
    info: MANUAL_STT_INFO,
    requiresUserTranscript: true,
    transcribe: async () => {
      throw new AppError(
        'TRANSCRIPT_REQUIRED',
        'Automatic transcription is not available in local mode: provide the transcript (SRT, VTT or text)',
      );
    },
  };
}
