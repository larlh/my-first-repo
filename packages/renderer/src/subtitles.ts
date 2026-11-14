import type {
  Composition,
  RenderRuntime,
  SubtitleCue,
  SubtitleStyle,
  WordCue,
} from '@parlante/shared';
import type { Timeline } from './timeline';

/** A subtitle cue that remembers its words (for karaoke highlighting). */
export interface WordedCue extends SubtitleCue {
  words: WordCue[];
}

const MAX_GAP_MS = 700;
const MIN_CUE_MS = 400;
const LINGER_MS = 250;

/**
 * Group spoken words into subtitle cues. Times stay relative to the narration audio.
 * A cue closes when adding the next word would exceed `maxCharsPerLine × maxLines`, after
 * sentence-ending punctuation, or when the speaker pauses.
 *
 * Baseline implementation by the architect — owner: renderer-core. The SAME cues must feed the
 * burned-in subtitles and the SRT/VTT export (use `compositionSubtitleCues`).
 */
export function buildSubtitleCues(words: readonly WordCue[], style: SubtitleStyle): WordedCue[] {
  const maxChars = style.maxCharsPerLine * style.maxLines;
  const cues: WordedCue[] = [];
  let current: WordCue[] = [];
  let length = 0;

  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const text = current.map((w) => w.text).join(' ');
    cues.push({
      startMs: first.tMs,
      endMs: Math.max(last.tMs + last.durMs, first.tMs + MIN_CUE_MS),
      text: style.uppercase ? text.toUpperCase() : text,
      words: current,
    });
    current = [];
    length = 0;
  };

  for (const word of words) {
    const text = word.text.trim();
    if (text === '') continue;
    const previous = current[current.length - 1];
    const gap = previous ? word.tMs - (previous.tMs + previous.durMs) : 0;
    if (previous && (length + 1 + text.length > maxChars || gap > MAX_GAP_MS)) flush();
    current.push({ ...word, text });
    length += (length > 0 ? 1 : 0) + text.length;
    if (/[.!?…]["')\]]?$/.test(text)) flush();
  }
  flush();

  // Let each cue linger briefly, without overlapping the next one.
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (!cue) continue;
    const limit = next ? next.startMs : cue.endMs + LINGER_MS;
    cue.endMs = Math.min(cue.endMs + LINGER_MS, Math.max(cue.endMs, limit));
  }
  return cues;
}

/** Cue visible at `speechMs` (time since narration start), or null. */
export function cueAt(cues: readonly WordedCue[], speechMs: number): WordedCue | null {
  for (const cue of cues) {
    if (speechMs >= cue.startMs && speechMs < cue.endMs) return cue;
    if (cue.startMs > speechMs) break;
  }
  return null;
}

/**
 * Subtitle cues of the whole video on the VIDEO clock (absolute ms), clipped to their scene.
 * Feed the result to `formatSrt` / `formatVtt` from @parlante/shared.
 */
export function compositionSubtitleCues(
  composition: Composition,
  runtime: RenderRuntime,
  timeline: Timeline,
): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const timing of timeline.scenes) {
    const sceneRuntime = runtime.scenes[timing.sceneId];
    if (!sceneRuntime) continue;
    for (const cue of buildSubtitleCues(sceneRuntime.words, composition.subtitles)) {
      const startMs = timing.speechStartMs + cue.startMs;
      const endMs = Math.min(timing.speechStartMs + cue.endMs, timing.endMs);
      if (endMs > startMs) {
        out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text: cue.text });
      }
    }
  }
  return out;
}
