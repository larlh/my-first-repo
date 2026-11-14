import { LETTER_TO_VISEME } from './visemes';
import type { Viseme } from './visemes';
import type { SceneRuntime, VisemeCue, WordCue } from './runtime';

/* -------------------------------------------------------------------------------------------
 * Speech timeline ESTIMATION — isomorphic, pure, deterministic.
 *
 * The one implementation of "we have text and/or audio but no phoneme timing":
 *  - TTS adapters without phoneme events (ElevenLabs, OpenAI…)      → estimateSpeechTimeline
 *  - scenes narrated with an uploaded audio (`script.kind: 'audio'`) → sceneRuntimeFromAudio,
 *    called by the Studio in the browser AND by the render job, so preview and export agree
 * Nobody else writes an estimator: a second one would desynchronise preview and export.
 * ----------------------------------------------------------------------------------------- */

const SENTENCE_END = /[.!?…]["')\]»]*$/;
const CLAUSE_END = /[,;:—–]["')\]»]*$/;
/** Relative weights, in "letters": pause after a sentence / clause / plain word gap. */
const SENTENCE_PAUSE = 5;
const CLAUSE_PAUSE = 2.5;
const WORD_GAP = 0.6;
/** Shapes cycled for words written in a script the letter table does not cover. */
const FALLBACK_CYCLE: readonly Viseme[] = ['A', 'E', 'O', 'I', 'U'];

const DIGRAPHS: Readonly<Record<string, Viseme>> = {
  ch: 'CHJ',
  sh: 'CHJ',
  th: 'TH',
  ph: 'FV',
  qu: 'KG',
  ll: 'NL',
  rr: 'R',
  gn: 'NL',
  ng: 'KG',
};

/** Mouth shapes of one written word, in order (consecutive duplicates removed). */
export function wordToVisemes(word: string): Viseme[] {
  const letters = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const out: Viseme[] = [];
  const push = (v: Viseme) => {
    if (out[out.length - 1] !== v) out.push(v);
  };
  let i = 0;
  let unmapped = 0;
  while (i < letters.length) {
    const pair = DIGRAPHS[letters.slice(i, i + 2)];
    if (pair) {
      push(pair);
      i += 2;
      continue;
    }
    const ch = letters[i] ?? '';
    const single = LETTER_TO_VISEME[ch] ?? LETTER_TO_VISEME[ch.normalize('NFD')[0] ?? ''];
    if (single) {
      push(single);
    } else {
      // Digits and non-Latin scripts: keep the mouth moving with a deterministic vowel cycle.
      if (unmapped % 2 === 0) {
        push(FALLBACK_CYCLE[(ch.codePointAt(0) ?? 0) % FALLBACK_CYCLE.length] ?? 'A');
      }
      unmapped += 1;
    }
    i += 1;
  }
  return out;
}

export interface SpeechTimeline {
  visemes: VisemeCue[];
  words: WordCue[];
}

/**
 * Estimate when each word of `text` is spoken inside an audio of `durationMs`, and the mouth
 * shapes that go with it. Words get time in proportion to their length; punctuation adds
 * pauses. Guarantees (same as a real TTS result): cues sorted, inside 0..durationMs, visemes
 * start and end with `rest`. Empty text or non-positive duration ⇒ empty timeline.
 * `language` is reserved for language-specific grapheme rules (today the table is shared).
 */
export function estimateSpeechTimeline(
  text: string,
  durationMs: number,
  _language?: string,
): SpeechTimeline {
  const tokens = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t !== '');
  if (tokens.length === 0 || !(durationMs > 0)) return { visemes: [], words: [] };

  const parts = tokens.map((token, index) => {
    const letters = Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, '').length);
    const last = index === tokens.length - 1;
    const pause = last
      ? 0
      : SENTENCE_END.test(token)
        ? SENTENCE_PAUSE
        : CLAUSE_END.test(token)
          ? CLAUSE_PAUSE
          : WORD_GAP;
    return { token, speak: letters, pause };
  });
  const total = parts.reduce((sum, p) => sum + p.speak + p.pause, 0);
  // Short lead-in / tail of silence, like real recordings (at most 4 % each, capped).
  const lead = Math.min(120, durationMs * 0.04);
  const tail = Math.min(160, durationMs * 0.04);
  const unit = (durationMs - lead - tail) / total;

  const words: WordCue[] = [];
  const visemes: VisemeCue[] = [{ tMs: 0, viseme: 'rest' }];
  const pushViseme = (tMs: number, viseme: Viseme) => {
    const previous = visemes[visemes.length - 1];
    if (previous && previous.viseme === viseme) return;
    const t = Math.round(Math.min(Math.max(tMs, 0), durationMs));
    if (previous && t <= previous.tMs) {
      if (visemes.length > 1) previous.viseme = viseme;
      else visemes.push({ tMs: Math.min(durationMs, previous.tMs + 1), viseme });
      return;
    }
    visemes.push({ tMs: t, viseme });
  };

  let cursor = lead;
  for (const part of parts) {
    const dur = part.speak * unit;
    words.push({ tMs: Math.round(cursor), durMs: Math.max(1, Math.round(dur)), text: part.token });
    const shapes = wordToVisemes(part.token);
    shapes.forEach((shape, i) => pushViseme(cursor + (dur * i) / shapes.length, shape));
    cursor += dur;
    // Close the mouth on real pauses; between plain words the shapes run together.
    if (part.pause * unit >= 90) pushViseme(cursor, 'rest');
    cursor += part.pause * unit;
  }
  pushViseme(Math.min(cursor, durationMs), 'rest');
  return { visemes, words };
}

/** SceneRuntime of a narration known only by its transcript and length (no audio analysis). */
export function sceneRuntimeFromTranscript(
  transcript: string,
  audioDurationMs: number,
  language?: string,
): SceneRuntime {
  const duration = Math.max(0, audioDurationMs);
  return { audioDurationMs: duration, ...estimateSpeechTimeline(transcript, duration, language) };
}

export interface AudioVisemeOptions {
  /** Analysis window (ms). Default 45. */
  windowMs?: number;
}

/**
 * Mouth movement from the loudness envelope of an audio signal — used when there is audio
 * but no (reliable) text: `samples` are MONO PCM in -1..1 (Float32Array from WebAudio's
 * `decodeAudioData`, or Int16 / 32768 from ffmpeg in the worker). Windows are time-based, so
 * the result does not depend materially on the sample rate. Louder ⇒ more open
 * (rest → I → E → A); the level is normalised to the loud parts of the clip itself.
 */
export function visemesFromAudio(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: AudioVisemeOptions = {},
): VisemeCue[] {
  const windowMs = options.windowMs ?? 45;
  const size = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  const count = Math.floor(samples.length / size);
  if (count === 0 || !(sampleRate > 0)) return [];
  const levels: number[] = [];
  for (let w = 0; w < count; w += 1) {
    let sum = 0;
    const start = w * size;
    for (let i = start; i < start + size; i += 1) {
      const v = samples[i] ?? 0;
      sum += v * v;
    }
    levels.push(Math.sqrt(sum / size));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  if (reference < 1e-4) return [];
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const cues: VisemeCue[] = [{ tMs: 0, viseme: 'rest' }];
  levels.forEach((level, w) => {
    const n = level / reference;
    const viseme: Viseme = n < 0.12 ? 'rest' : n < 0.38 ? 'I' : n < 0.7 ? 'E' : 'A';
    const previous = cues[cues.length - 1];
    if (previous && previous.viseme === viseme) return;
    const tMs = Math.round((w * size * 1000) / sampleRate);
    if (previous && tMs <= previous.tMs) previous.viseme = viseme;
    else cues.push({ tMs, viseme });
  });
  const last = cues[cues.length - 1];
  if (last && last.viseme !== 'rest') {
    cues.push({ tMs: Math.max(last.tMs + 1, durationMs), viseme: 'rest' });
  }
  return cues.length > 1 ? cues : [];
}

export interface AudioNarrationInput {
  /** Length of the uploaded audio (`Asset.durationMs`). */
  audioDurationMs: number;
  /** `AudioScript.transcript` (may be empty). */
  transcript?: string;
  language?: string;
  /** Decoded MONO PCM in -1..1 and its sample rate, when available. */
  samples?: ArrayLike<number>;
  sampleRate?: number;
}

/**
 * THE runtime of a scene narrated with an uploaded audio (`script.kind: 'audio'`):
 *  - words (subtitles): from the transcript, spread by `estimateSpeechTimeline`
 *  - visemes (mouth):   from the audio envelope when PCM is given (it follows the real
 *                       voice), otherwise estimated from the transcript; none when neither
 * Studio (browser) and render job (worker) both call this — with PCM in both places.
 */
export function sceneRuntimeFromAudio(input: AudioNarrationInput): SceneRuntime {
  const audioDurationMs = Math.max(0, input.audioDurationMs);
  const fromText = estimateSpeechTimeline(input.transcript ?? '', audioDurationMs, input.language);
  const fromAudio =
    input.samples && input.sampleRate
      ? visemesFromAudio(input.samples, input.sampleRate).map((cue) => ({
          ...cue,
          tMs: Math.min(cue.tMs, audioDurationMs),
        }))
      : [];
  return {
    audioDurationMs,
    words: fromText.words,
    visemes: fromAudio.length > 0 ? fromAudio : fromText.visemes,
  };
}
