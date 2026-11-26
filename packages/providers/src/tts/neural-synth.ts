import type { ProviderRef, TTSResult, VisemeCue, WordCue } from '@parlante/shared';
import type { EspeakEngine } from './espeak-engine';
import { planChunks, segmentUnits } from './neural-chunks';
import type { ChunkPolicy, ChunkSymbol, TokenUnit, VoiceAlphabet } from './neural-chunks';
import { phonemizeSegment, symbolShapes } from './neural-phonemes';
import { prepareSpeech } from './text';
import type { PreparedSpeech } from './text';
import { VisemeTrack } from './timeline';
import { concatPcm, encodeWav, resampleLinear, samplesToMs } from './wav';

/* -------------------------------------------------------------------------------------------
 * Speech with a local neural voice, whatever the model: text → chunks → one inference per
 * chunk → one WAV with the timeline of what was REALLY said.
 *
 * The timeline does not come from eSpeak and is not estimated: both models predict how long
 * every input symbol lasts before they generate the audio (Kokoro returns it; for Piper the
 * tensor is exposed when the graph is loaded). A symbol is a phoneme, a space or a punctuation
 * mark, and each one belongs to a display word, so:
 *
 *   visemes   the mouth shape of every phoneme at the moment the model pronounces it
 *   words     from the first to the last phoneme of each display word (karaoke subtitles)
 *
 * Measured against the energy of the generated audio: docs/MODELS.md.
 * ----------------------------------------------------------------------------------------- */

/** Audio of one chunk with where each of its symbols is. */
export interface ChunkAudio {
  /** Mono samples, -1..1, at the backend's sample rate. */
  waveform: Float32Array;
  /** Symbol `i` occupies samples [bounds[i], bounds[i + 1]). Length = symbols + 1. */
  bounds: Float64Array;
}

/** One neural voice, ready to speak chunks of its own alphabet. */
export interface VoiceBackend {
  readonly sampleRate: number;
  readonly alphabet: VoiceAlphabet;
  readonly policy: ChunkPolicy;
  speak(symbols: readonly ChunkSymbol[], speed: number, signal?: AbortSignal): Promise<ChunkAudio>;
}

export interface NeuralSpeechRequest {
  text: string;
  /** eSpeak language voice that writes the phonemes. */
  espeakVoice: string;
  /** Rate multiplier (already combined with a voice profile). */
  speed: number;
  /** Pitch shift in semitones (already combined with a voice profile). */
  pitchSemitones: number;
  provider: ProviderRef;
  signal?: AbortSignal;
}

/**
 * Neither model has a pitch parameter. Pitch is changed the only honest way left: the audio
 * is resampled (played faster or slower) and the model is asked to speak slower or faster to
 * keep the tempo. That moves the formants with the pitch — the voice sounds smaller or larger —
 * so the range is kept short and the interface says so (`Voice.pitchRange.resampled`).
 */
export const NEURAL_PITCH_MIN_SEMITONES = -4;
export const NEURAL_PITCH_MAX_SEMITONES = 4;
/** Tempo range the models are asked for (they are trained around 1). */
const MODEL_SPEED_MIN = 0.4;
const MODEL_SPEED_MAX = 2.5;

const LEAD_MS = 40;
const TAIL_MS = 120;
/** Audio kept before the first and after the last phoneme of a chunk. */
const EDGE_LEAD_MS = 12;
const EDGE_TAIL_MS = 70;
const FADE_IN_MS = 4;
const FADE_OUT_MS = 12;
/** Silences shorter than this are stop closures, not pauses: the mouth does not go to rest. */
const MIN_REST_MS = 50;
/**
 * Shortest pause between two sentences spoken in the same inference, at normal speed. The
 * models usually pause longer; when one hurries past a full stop (Kokoro does on short
 * sentences: 120 ms measured) silence is added up to this length.
 */
export const MIN_SENTENCE_PAUSE_MS = 260;
/** Marks that end a sentence in either alphabet. */
const SENTENCE_MARKS = new Set(['.', '!', '?', '…']);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

function emptyResult(sampleRate: number, provider: ProviderRef): TTSResult {
  return {
    audio: encodeWav(new Int16Array(0), sampleRate),
    format: 'wav',
    sampleRate,
    durationMs: 0,
    visemes: [],
    words: [],
    provider,
  };
}

/** Token units of the whole text (phonemes from eSpeak, laid out in the voice's alphabet). */
export async function textUnits(
  espeak: EspeakEngine,
  prepared: PreparedSpeech,
  espeakVoice: string,
  alphabet: VoiceAlphabet,
): Promise<TokenUnit[]> {
  const units: TokenUnit[] = [];
  for (const [index, segment] of prepared.segments.entries()) {
    if (index > 0) await nextTick(); // long scripts must not monopolise the event loop
    const words = phonemizeSegment(espeak, prepared, segment, espeakVoice);
    units.push(...segmentUnits(prepared, words, alphabet, segment.pauseAfterMs));
  }
  return units;
}

/** Float samples → PCM16 with short fades at both ends (a cut is never a click). */
export function toPcm16(samples: Float32Array, sampleRate: number): Int16Array {
  const out = new Int16Array(samples.length);
  const fadeIn = Math.min(samples.length, Math.round((FADE_IN_MS * sampleRate) / 1000));
  const fadeOut = Math.min(samples.length, Math.round((FADE_OUT_MS * sampleRate) / 1000));
  for (let i = 0; i < samples.length; i += 1) {
    let gain = 1;
    if (i < fadeIn) gain = i / fadeIn;
    const fromEnd = samples.length - 1 - i;
    if (fromEnd < fadeOut) gain = Math.min(gain, fromEnd / fadeOut);
    const value = clamp((samples[i] ?? 0) * gain, -1, 1);
    out[i] = Math.round(value * 32767);
  }
  return out;
}

/** Leading silence of a word longer than this is not a stop closure: the model is waiting. */
const MAX_CLOSURE_MS = 70;
/** How long before the sound the mouth may start to move (closures, anticipation). */
const ANTICIPATION_MS = 40;

/**
 * Put the start of each word, and the end of the last one, where the SOUND is.
 *
 * A model without a silence symbol (Piper has none) hides the silence it makes at the start
 * of a sentence, or after a comma, inside the first phoneme of the next word: the predicted
 * durations then say the word starts up to 150 ms before anything is heard (measured). The
 * energy of the audio settles it: when a word begins with more silence than a stop closure
 * takes, its start moves to just before the first sound, and the silence goes to the pause
 * before it. Nothing changes where the model was already right.
 */
export function snapWordsToSound(
  audio: ChunkAudio,
  symbols: readonly ChunkSymbol[],
  sampleRate: number,
): ChunkAudio {
  const { waveform } = audio;
  const first = symbols.findIndex((symbol) => symbol.role === 'speech');
  const last = symbols.findLastIndex((symbol) => symbol.role === 'speech');
  if (first < 0) return audio;
  const frame = Math.max(1, Math.round(sampleRate * 0.005));
  const frames = Math.floor(waveform.length / frame);
  if (frames < 4) return audio;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    for (let k = f * frame; k < (f + 1) * frame; k += 1) sum += (waveform[k] ?? 0) ** 2;
    rms[f] = Math.sqrt(sum / frame);
  }
  const sorted = Float32Array.from(rms).sort();
  const loud = sorted[Math.floor(frames * 0.95)] ?? 0;
  if (!(loud > 0)) return audio;
  const threshold = loud * 0.06;
  const closure = Math.round((MAX_CLOSURE_MS * sampleRate) / 1000);
  const anticipation = Math.round((ANTICIPATION_MS * sampleRate) / 1000);
  const bounds = Float64Array.from(audio.bounds);
  let changed = false;

  for (let i = first; i <= last; i += 1) {
    const symbol = symbols[i];
    if (symbol?.role !== 'speech') continue;
    const wordStart = i === first || symbols[i - 1]?.role === 'silent';
    if (!wordStart) continue;
    // Where this word ends: the bound after its last speech symbol.
    let end = i;
    while (end + 1 <= last && symbols[end + 1]?.role === 'speech') end += 1;
    const from = bounds[i] ?? 0;
    const limit = bounds[end + 1] ?? waveform.length;
    let onset = -1;
    for (let f = Math.floor(from / frame); f < frames && f * frame < limit; f += 1) {
      if ((rms[f] ?? 0) >= threshold) {
        onset = f * frame;
        break;
      }
    }
    if (onset < 0 || onset - from <= closure) continue;
    const start = Math.max(from, onset - anticipation);
    for (let b = i; b <= end && (bounds[b] ?? 0) < start; b += 1) bounds[b] = start;
    changed = true;
  }

  // The last word ends where its sound ends, not where a silent tail does.
  const from = bounds[last] ?? 0;
  const to = bounds[last + 1] ?? waveform.length;
  let offset = -1;
  for (
    let f = Math.min(frames - 1, Math.ceil(to / frame) - 1);
    f >= 0 && f * frame >= from;
    f -= 1
  ) {
    if ((rms[f] ?? 0) >= threshold) {
      offset = (f + 1) * frame;
      break;
    }
  }
  if (offset >= 0 && to - offset > closure) {
    bounds[last + 1] = Math.min(to, offset + anticipation);
    changed = true;
  }
  return changed ? { waveform, bounds } : audio;
}

/**
 * Give every sentence boundary INSIDE a chunk at least `minSamples` of pause. The boundary is
 * the run of silent symbols that holds a sentence mark; the extra silence goes in at its
 * quietest point, and only if that point really is quiet (never in the middle of a sound).
 * Returns the audio and the symbol positions after the insertions.
 */
export function stretchSentencePauses(
  audio: ChunkAudio,
  symbols: readonly ChunkSymbol[],
  minSamples: number,
  sampleRate: number,
): ChunkAudio {
  const { waveform, bounds } = audio;
  const first = symbols.findIndex((symbol) => symbol.role === 'speech');
  const last = symbols.findLastIndex((symbol) => symbol.role === 'speech');
  if (first < 0 || !(minSamples > 0)) return audio;
  let peak = 0;
  for (const sample of waveform) peak = Math.max(peak, Math.abs(sample));
  const frame = Math.max(1, Math.round(sampleRate * 0.005));
  const insertions: { at: number; samples: number; symbol: number }[] = [];
  let i = first;
  while (i < last) {
    if (symbols[i]?.role !== 'silent') {
      i += 1;
      continue;
    }
    let end = i;
    let sentence = false;
    while (end < last && symbols[end]?.role === 'silent') {
      sentence ||= SENTENCE_MARKS.has(symbols[end]?.text ?? '');
      end += 1;
    }
    const from = Math.round(bounds[i] ?? 0);
    const to = Math.round(bounds[end] ?? from);
    const missing = Math.round(minSamples - (to - from));
    if (sentence && missing > 0 && to - from >= frame) {
      // The quietest 5 ms of the run.
      let quietest = Infinity;
      let at = from;
      for (let start = from; start + frame <= to; start += frame) {
        let sum = 0;
        for (let k = start; k < start + frame; k += 1) sum += (waveform[k] ?? 0) ** 2;
        const rms = Math.sqrt(sum / frame);
        if (rms < quietest) {
          quietest = rms;
          at = start + Math.floor(frame / 2);
        }
      }
      if (quietest <= peak * 0.03) insertions.push({ at, samples: missing, symbol: i });
    }
    i = end;
  }
  if (insertions.length === 0) return audio;
  const added = insertions.reduce((sum, insertion) => sum + insertion.samples, 0);
  const out = new Float32Array(waveform.length + added);
  const shifted = Float64Array.from(bounds);
  let read = 0;
  let write = 0;
  for (const insertion of insertions) {
    out.set(waveform.subarray(read, insertion.at), write);
    write += insertion.at - read + insertion.samples; // the gap stays zero
    read = insertion.at;
    // Everything after the run it was put in moves; the run itself grows.
    for (let b = insertion.symbol + 1; b < shifted.length; b += 1) {
      if ((bounds[b] ?? 0) >= insertion.at) shifted[b] = (shifted[b] ?? 0) + insertion.samples;
    }
  }
  out.set(waveform.subarray(read), write);
  return { waveform: out, bounds: shifted };
}

interface WordSpan {
  token: number;
  startMs: number;
  endMs: number;
}

/** Word cues whose texts together spell the whole script (unspoken tokens join a neighbour). */
export function wordCues(prepared: PreparedSpeech, spans: readonly WordSpan[]): WordCue[] {
  return spans.map((span, i) => {
    const next = spans[i + 1];
    const from = i === 0 ? 0 : span.token;
    const to = next ? next.token : prepared.tokens.length;
    const text = prepared.tokens
      .slice(from, to)
      .map((token) => token.text)
      .join(' ');
    const tMs = Math.round(span.startMs);
    const limit = next ? Math.round(next.startMs) : Infinity;
    const end = Math.min(limit, Math.max(tMs + 1, Math.round(span.endMs)));
    return { tMs, durMs: Math.max(1, end - tMs), text };
  });
}

/** Synthesize `request.text` with a neural voice. */
export async function synthesizeNeural(
  request: NeuralSpeechRequest,
  backend: VoiceBackend,
  espeak: EspeakEngine,
): Promise<TTSResult> {
  const { sampleRate } = backend;
  const prepared = prepareSpeech(request.text);
  if (prepared.tokens.length === 0) return emptyResult(sampleRate, request.provider);
  const units = await textUnits(espeak, prepared, request.espeakVoice, backend.alphabet);
  const chunks = planChunks(units, backend.alphabet, backend.policy);
  if (chunks.length === 0) return emptyResult(sampleRate, request.provider); // "…", "—"

  const speed = clamp(finiteOr(request.speed, 1), 0.25, 4);
  const semitones = clamp(
    finiteOr(request.pitchSemitones, 0),
    NEURAL_PITCH_MIN_SEMITONES,
    NEURAL_PITCH_MAX_SEMITONES,
  );
  // Resampling by 1/k raises the pitch by k and shortens the audio by k: speak k× slower.
  const k = 2 ** (semitones / 12);
  const modelSpeed = clamp(speed / k, MODEL_SPEED_MIN, MODEL_SPEED_MAX);
  const toSamples = (ms: number) => Math.round((ms * sampleRate) / 1000);
  const toMs = (samples: number) => (samples * 1000) / sampleRate;

  const blocks: Int16Array[] = [new Int16Array(toSamples(LEAD_MS))];
  let offsetSamples = blocks[0]?.length ?? 0;
  const spans: WordSpan[] = [];
  /** Mouth events in time order: a shape, or `rest`. */
  const shapes: { tMs: number; viseme: VisemeCue['viseme'] }[] = [];
  let speechEndMs = toMs(offsetSamples);

  for (const chunk of chunks) {
    request.signal?.throwIfAborted();
    const symbols = chunk.symbols;
    const audio = stretchSentencePauses(
      snapWordsToSound(
        await backend.speak(symbols, modelSpeed, request.signal),
        symbols,
        sampleRate,
      ),
      symbols,
      // In the model's own time: what is added is shortened again by the pitch resampling.
      toSamples((MIN_SENTENCE_PAUSE_MS / speed) * k),
      sampleRate,
    );
    const first = symbols.findIndex((symbol) => symbol.role === 'speech');
    const last = symbols.findLastIndex((symbol) => symbol.role === 'speech');
    if (first < 0 || last < 0) continue;
    const length = audio.waveform.length;
    const bound = (i: number) => clamp(audio.bounds[i] ?? length, 0, length);
    const cutStart = Math.max(0, Math.floor(bound(first) - toSamples(EDGE_LEAD_MS)));
    const cutEnd = Math.min(length, Math.ceil(bound(last + 1) + toSamples(EDGE_TAIL_MS)));
    const pcm = toPcm16(audio.waveform.subarray(cutStart, cutEnd), sampleRate);
    const samples = k === 1 ? pcm : resampleLinear(pcm, 1 / k);
    const chunkStartMs = toMs(offsetSamples);
    /** Time of a position of the model's audio inside the final audio. */
    const at = (position: number) =>
      chunkStartMs + toMs(clamp(position - cutStart, 0, cutEnd - cutStart)) / k;

    let silentFrom: number | null = null;
    symbols.forEach((symbol, i) => {
      if (i < first || i > last) return;
      const startMs = at(bound(i));
      const endMs = at(bound(i + 1));
      if (symbol.role === 'silent') {
        silentFrom ??= startMs;
        return;
      }
      if (silentFrom !== null) {
        // A run of spaces / marks: a pause only when it lasts.
        if (startMs - silentFrom >= MIN_REST_MS) shapes.push({ tMs: silentFrom, viseme: 'rest' });
        silentFrom = null;
      }
      const [firstShape, secondShape] = symbolShapes(symbol.text);
      if (firstShape) shapes.push({ tMs: startMs, viseme: firstShape });
      if (secondShape) {
        shapes.push({ tMs: startMs + Math.min(endMs - startMs, 400) * 0.5, viseme: secondShape });
      }
      const span = spans[spans.length - 1];
      if (span && span.token === symbol.token) span.endMs = endMs;
      else spans.push({ token: symbol.token, startMs, endMs });
    });
    speechEndMs = at(bound(last + 1));
    shapes.push({ tMs: speechEndMs, viseme: 'rest' });

    blocks.push(samples);
    offsetSamples += samples.length;
    if (chunk.pauseAfterMs > 0) {
      const pauseMs = chunk.pauseScales ? chunk.pauseAfterMs / speed : chunk.pauseAfterMs;
      const pause = new Int16Array(toSamples(pauseMs));
      blocks.push(pause);
      offsetSamples += pause.length;
    }
  }
  if (spans.length === 0) return emptyResult(sampleRate, request.provider);

  blocks.push(new Int16Array(toSamples(TAIL_MS)));
  const pcm = concatPcm(blocks);
  const durationMs = samplesToMs(pcm.length, sampleRate);
  const track = new VisemeTrack();
  for (const shape of shapes) track.push(shape.tMs, shape.viseme, durationMs);
  return {
    audio: encodeWav(pcm, sampleRate),
    format: 'wav',
    sampleRate,
    durationMs,
    visemes: track.finish(speechEndMs, durationMs),
    words: wordCues(prepared, spans),
    provider: request.provider,
  };
}
