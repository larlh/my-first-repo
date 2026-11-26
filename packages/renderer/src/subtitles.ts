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
const SENTENCE_END = /[.!?…]["')\]»]?$/;
const MIN_CUE_MS = 400;
const LINGER_MS = 250;

/** Size of the frame the subtitles are burned into (only its proportions matter). */
export interface SubtitleCanvas {
  width: number;
  height: number;
}

/** Subtitles never get closer than 5 % of the width to the left / right edges. */
export const SUBTITLE_SAFE_WIDTH = 0.9;
/** The `minimal` preset draws its text at this fraction of the style's font size. */
export const SUBTITLE_MINIMAL_SCALE = 0.8;
/** Average advance of a character (letters and spaces) in em, used to budget characters. */
const AVERAGE_CHAR_EM = 0.52;
const AVERAGE_UPPERCASE_CHAR_EM = 0.64;

/**
 * Characters that fit on one subtitle line: the style's `maxCharsPerLine`, lowered when the
 * frame is too narrow for them at the style's font size (a 9:16 video fits about half as many
 * as a 16:9 one). Cue building budgets with this number, so the same cues work burned in and
 * as SRT / VTT; the painter still measures real glyphs and never leaves the safe area.
 */
export function subtitleCharsPerLine(style: SubtitleStyle, canvas?: SubtitleCanvas): number {
  if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) return style.maxCharsPerLine;
  const scale = style.preset === 'minimal' ? SUBTITLE_MINIMAL_SCALE : 1;
  const charPx =
    style.fontSize *
    scale *
    canvas.height *
    (style.uppercase ? AVERAGE_UPPERCASE_CHAR_EM : AVERAGE_CHAR_EM);
  // Boxed presets spend about one em of the safe width on their horizontal padding.
  const usable = SUBTITLE_SAFE_WIDTH * canvas.width - style.fontSize * scale * canvas.height * 1.1;
  const fit = Math.floor(usable / charPx);
  return Math.max(8, Math.min(style.maxCharsPerLine, fit));
}

/**
 * Group spoken words into subtitle cues. Times stay relative to the narration audio.
 * A cue closes when adding the next word would exceed the character budget
 * (`subtitleCharsPerLine × maxLines`), after sentence-ending punctuation, at a clause break
 * once the cue is reasonably full, or when the speaker pauses.
 *
 * Pass the `canvas` the cues are for (`composition.canvas`): the budget then follows the
 * aspect ratio. The SAME cues feed the burned-in subtitles and the SRT/VTT export
 * (`compositionSubtitleCues`).
 */
export function buildSubtitleCues(
  words: readonly WordCue[],
  style: SubtitleStyle,
  canvas?: SubtitleCanvas,
): WordedCue[] {
  const maxChars = subtitleCharsPerLine(style, canvas) * style.maxLines;
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
    if (previous && (length + 1 + text.length > maxChars || gap > MAX_GAP_MS)) {
      // Do not strand the last word of a sentence alone on its own cue: it takes the
      // previous word along.
      const carried =
        gap <= MAX_GAP_MS && current.length >= 3 && SENTENCE_END.test(text)
          ? current.pop()
          : undefined;
      if (carried) length -= carried.text.length + 1;
      flush();
      if (carried) {
        current.push(carried);
        length = carried.text.length;
      }
    }
    current.push({ ...word, text });
    length += (length > 0 ? 1 : 0) + text.length;
    if (SENTENCE_END.test(text)) flush();
    else if (/[,;:]$/.test(text) && length > maxChars * 0.5) flush();
  }
  flush();

  // Let each cue linger briefly, without overlapping the next one.
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (!cue) continue;
    // (A very short cue is stretched to MIN_CUE_MS above; the next cue still wins.)
    cue.endMs = next
      ? Math.max(cue.startMs + 1, Math.min(cue.endMs + LINGER_MS, next.startMs))
      : cue.endMs + LINGER_MS;
  }
  return cues;
}

const cueMemo = new WeakMap<readonly WordCue[], Map<string, WordedCue[]>>();

/**
 * `buildSubtitleCues` memoised on the identity of `words` (a scene runtime is immutable while
 * it is rendered): `renderFrame` asks for the cues of the current scene on every frame.
 */
export function cachedSubtitleCues(
  words: readonly WordCue[],
  style: SubtitleStyle,
  canvas?: SubtitleCanvas,
): WordedCue[] {
  let byStyle = cueMemo.get(words);
  if (!byStyle) {
    byStyle = new Map();
    cueMemo.set(words, byStyle);
  }
  const key = `${subtitleCharsPerLine(style, canvas)}|${style.maxLines}|${style.uppercase ? 1 : 0}|${words.length}`;
  let cues = byStyle.get(key);
  if (!cues) {
    cues = buildSubtitleCues(words, style, canvas);
    if (byStyle.size > 16) byStyle.clear();
    byStyle.set(key, cues);
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
    for (const cue of buildSubtitleCues(
      sceneRuntime.words,
      composition.subtitles,
      composition.canvas,
    )) {
      const startMs = timing.speechStartMs + cue.startMs;
      const endMs = Math.min(timing.speechStartMs + cue.endMs, timing.endMs);
      if (endMs > startMs) {
        out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text: cue.text });
      }
    }
  }
  return out;
}
