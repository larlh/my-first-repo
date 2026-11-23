import { estimateSpeechTimeline } from '@parlante/shared';
import type { Viseme, VisemeCue, WordCue } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * Timeline helpers shared by the TTS adapters. They keep the guarantees of `TTSResult`:
 * cues sorted, strictly increasing in time, inside the audio, visemes starting and ending in
 * `rest`.
 * ----------------------------------------------------------------------------------------- */

/** A gap between two words at least this long closes the mouth (same rule as the estimator). */
const REST_GAP_MS = 90;

/** Viseme cue list under construction: deduplicates and keeps times strictly increasing. */
export class VisemeTrack {
  readonly cues: VisemeCue[] = [{ tMs: 0, viseme: 'rest' }];

  /** `limitMs` is the length of the audio: no cue is placed after it. */
  push(tMs: number, viseme: Viseme, limitMs: number): void {
    const cues = this.cues;
    const previous = cues[cues.length - 1];
    if (!previous || previous.viseme === viseme) return;
    const t = Math.round(Math.min(limitMs, Math.max(0, tMs)));
    if (t > previous.tMs) {
      cues.push({ tMs: t, viseme });
      return;
    }
    if (cues.length === 1) {
      if (previous.tMs + 1 <= limitMs) cues.push({ tMs: previous.tMs + 1, viseme });
      return;
    }
    // Same millisecond as the previous cue: the later shape wins.
    previous.viseme = viseme;
    if (cues[cues.length - 2]?.viseme === viseme) cues.pop();
  }

  /** The finished list (empty when nothing but the initial `rest` was ever pushed). */
  finish(endMs: number, limitMs: number): VisemeCue[] {
    this.push(endMs, 'rest', limitMs);
    return this.cues.length > 1 ? this.cues : [];
  }
}

/**
 * Mouth shapes for words whose times are REAL (reported by the service): each word is given
 * to the shared estimator on its own, inside its own time span, so the shapes follow the
 * measured rhythm instead of being spread evenly over the whole audio.
 */
export function visemesFromWords(
  words: readonly WordCue[],
  durationMs: number,
  language?: string,
): VisemeCue[] {
  if (words.length === 0 || !(durationMs > 0)) return [];
  const track = new VisemeTrack();
  let endMs = 0;
  words.forEach((word, index) => {
    const estimate = estimateSpeechTimeline(word.text, Math.max(1, word.durMs), language);
    for (const cue of estimate.visemes) {
      if (cue.viseme !== 'rest') track.push(word.tMs + cue.tMs, cue.viseme, durationMs);
    }
    endMs = word.tMs + word.durMs;
    const next = words[index + 1];
    if (next && next.tMs - endMs >= REST_GAP_MS) track.push(endMs, 'rest', durationMs);
  });
  return track.finish(endMs, durationMs);
}

/** Shift a timeline by `offsetMs` (joining the pieces of a text synthesised in chunks). */
export function shiftWords(words: readonly WordCue[], offsetMs: number): WordCue[] {
  return words.map((word) => ({ ...word, tMs: Math.round(word.tMs + offsetMs) }));
}

/**
 * Join per-chunk viseme timelines (each relative to its own chunk and starting / ending in
 * `rest`) into one for the concatenated audio.
 */
export function joinVisemes(
  chunks: readonly { offsetMs: number; visemes: readonly VisemeCue[] }[],
  durationMs: number,
): VisemeCue[] {
  const track = new VisemeTrack();
  let endMs = 0;
  for (const chunk of chunks) {
    for (const cue of chunk.visemes) {
      track.push(chunk.offsetMs + cue.tMs, cue.viseme, durationMs);
      endMs = chunk.offsetMs + cue.tMs;
    }
  }
  return track.finish(endMs, durationMs);
}

/** Keep word cues sorted and inside the audio (services occasionally overshoot by a few ms). */
export function clampWords(words: readonly WordCue[], durationMs: number): WordCue[] {
  const out: WordCue[] = [];
  let floor = 0;
  for (const word of words) {
    const tMs = Math.round(Math.min(durationMs, Math.max(floor, word.tMs)));
    const end = Math.round(Math.min(durationMs, Math.max(tMs, word.tMs + word.durMs)));
    out.push({ tMs, durMs: Math.max(0, end - tMs), text: word.text });
    floor = tMs;
  }
  return out;
}
