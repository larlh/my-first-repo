import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { SubtitleStyle, TimedText, WordCue } from '@parlante/shared';
import { buildSubtitleCues, drawSubtitleCue } from '@parlante/renderer';
import type { WordedCue } from '@parlante/renderer';
import {
  canvasToPng,
  canvasToRgba,
  createNodeCanvas,
  registerNodeFonts,
} from '@parlante/renderer/node';
import type { DubbedSegment } from './dub';

/* -------------------------------------------------------------------------------------------
 * Subtitles of a dubbed video.
 *
 *  - CUES come from the words of the dub (`buildSubtitleCues`, the routine Studio videos use),
 *    so they follow the translated voice, respect the style's characters per line / lines and
 *    are the same for the burned-in picture and for the SRT / VTT files.
 *  - BURNED-IN subtitles are painted with `drawSubtitleCue` (the one look of the product) on a
 *    transparent canvas the size of the picture. A cue only changes at the start of a word
 *    (karaoke highlight, paging of long cues), so each distinct picture is stored ONCE as a
 *    PNG and an ffmpeg concat script says how long each one stays: ffmpeg overlays a handful
 *    of images instead of a second full-rate video stream.
 * ----------------------------------------------------------------------------------------- */

/** Words for a sentence the voice provider did not time: spread by length over its span. */
export function estimateWords(text: string, startMs: number, durationMs: number): WordCue[] {
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  const total = tokens.reduce((sum, token) => sum + token.length + 1, 0);
  if (total === 0 || durationMs <= 0) return [];
  let cursor = startMs;
  return tokens.map((token) => {
    const durMs = (durationMs * (token.length + 1)) / total;
    const word = { tMs: cursor, durMs, text: token };
    cursor += durMs;
    return word;
  });
}

/**
 * Cues of the whole video from its dubbed segments: sorted, inside the video, never
 * overlapping, times rounded to milliseconds.
 */
export function dubSubtitleCues(
  segments: readonly DubbedSegment[],
  style: SubtitleStyle,
  frame: { width: number; height: number },
  totalMs: number,
): WordedCue[] {
  const cues: WordedCue[] = [];
  for (const segment of segments) {
    const words =
      segment.words.length > 0
        ? segment.words
        : estimateWords(segment.text, segment.startMs, segment.spokenMs);
    cues.push(...buildSubtitleCues(words, style, frame));
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  const out: WordedCue[] = [];
  for (const [index, cue] of cues.entries()) {
    const next = cues[index + 1];
    const startMs = Math.round(Math.max(0, cue.startMs));
    const endMs = Math.round(Math.min(cue.endMs, next ? next.startMs : totalMs, totalMs));
    if (endMs - startMs < 50 || cue.text.trim() === '') continue;
    out.push({ ...cue, startMs, endMs });
  }
  return out;
}

/** Plain cues for the SRT / VTT files. */
export function plainCues(cues: readonly WordedCue[]): TimedText[] {
  return cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
}

export interface OverlayState {
  /** File name inside the overlay directory. */
  file: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleOverlay {
  /** Path of the ffmpeg concat script (input with `-f concat -safe 0`). */
  scriptPath: string;
  /** Pictures on the timeline, gaps included (as the blank image). */
  states: OverlayState[];
  /** Distinct subtitle pictures written. */
  images: number;
}

const BLANK = 'blank.png';

/** Instants at which the picture of a cue may change: its start and the start of each word. */
function changePoints(cue: WordedCue): number[] {
  const points = new Set<number>([cue.startMs]);
  for (const word of cue.words) {
    // Rounded UP: at the rounded instant the word must already have started.
    const t = Math.ceil(word.tMs);
    if (t > cue.startMs && t < cue.endMs) points.add(t);
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * Paint every state of every cue and write the concat script that plays them. `dir` must be
 * an empty, server-generated directory.
 */
export async function renderSubtitleOverlay(
  dir: string,
  cues: readonly WordedCue[],
  style: SubtitleStyle,
  frame: { width: number; height: number },
  totalMs: number,
  options: { onProgress?: (fraction: number) => Promise<void> | void } = {},
): Promise<SubtitleOverlay> {
  registerNodeFonts();
  const { width, height } = frame;
  const { canvas, ctx } = createNodeCanvas(width, height);
  ctx.clearRect(0, 0, width, height);
  await fs.writeFile(path.join(dir, BLANK), canvasToPng(canvas));

  const states: OverlayState[] = [];
  const push = (file: string, startMs: number, endMs: number) => {
    if (endMs <= startMs) return;
    const last = states[states.length - 1];
    if (last && last.file === file && last.endMs === startMs) last.endMs = endMs;
    else states.push({ file, startMs, endMs });
  };

  let images = 0;
  let cursor = 0;
  for (const [index, cue] of cues.entries()) {
    const startMs = Math.max(cue.startMs, cursor);
    if (cue.endMs <= startMs) continue;
    push(BLANK, cursor, startMs);
    const points = changePoints({ ...cue, startMs });
    let previousHash = '';
    let previousFile = BLANK;
    for (const [p, at] of points.entries()) {
      const until = points[p + 1] ?? cue.endMs;
      ctx.clearRect(0, 0, width, height);
      drawSubtitleCue(ctx, cue, style, width, height, at);
      const hash = createHash('sha1').update(canvasToRgba(canvas)).digest('hex');
      if (hash !== previousHash) {
        images += 1;
        previousFile = `s${String(images).padStart(6, '0')}.png`;
        previousHash = hash;
        await fs.writeFile(path.join(dir, previousFile), canvasToPng(canvas));
      }
      push(previousFile, at, until);
      // Canvas pixel buffers are native memory released when the event loop turns.
      await nextTurn();
    }
    cursor = cue.endMs;
    await options.onProgress?.((index + 1) / cues.length);
  }
  push(BLANK, cursor, Math.max(totalMs, cursor + 1));

  // The concat demuxer needs the last picture listed twice for its duration to count.
  const lines = ['ffconcat version 1.0'];
  for (const state of states) {
    lines.push(
      `file ${state.file}`,
      `duration ${((state.endMs - state.startMs) / 1000).toFixed(3)}`,
    );
  }
  lines.push(`file ${states[states.length - 1]?.file ?? BLANK}`);
  const scriptPath = path.join(dir, 'overlay.ffconcat');
  await fs.writeFile(scriptPath, `${lines.join('\n')}\n`);
  return { scriptPath, states, images };
}
