import { AppError, PHONEME_TO_VISEME } from '@parlante/shared';
import type {
  ProviderRef,
  ProviderVoice,
  TTSProvider,
  TTSRequest,
  TTSResult,
  Viseme,
  VisemeCue,
  WordCue,
} from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { ESPEAK_NORMAL_WPM, getEspeakEngine, resetEspeakEngine } from './espeak-engine';
import type { EspeakEngine, EspeakUtterance } from './espeak-engine';
import { ESPEAK_VOICES, espeakLanguageFor, findEspeakVoice } from './espeak-voices';
import { prepareSpeech } from './text';
import type { PreparedSpeech, SpeechSegment } from './text';
import { VisemeTrack } from './timeline';
import { concatPcm, encodeWav, resampleLinear, samplesToMs } from './wav';

export const ESPEAK_INFO: ProviderRef = {
  id: 'espeak',
  name: 'eSpeak NG (local)',
  quality: 'basic',
  local: true,
};

/* -------------------------------------------------------------------------------------------
 * Local TTS: eSpeak NG compiled to WebAssembly. Formant synthesis — intelligible and instant,
 * clearly robotic (hence `quality: 'basic'`). What it gives that no cloud TTS does: the exact
 * time of every phoneme, so lip-sync and word timing are measured, not estimated.
 *
 *   audio     PCM16 mono 22.05 kHz, 40 ms of lead-in and 120 ms of tail silence
 *   visemes   one cue per phoneme event (IPA → viseme), diphthongs split in two shapes
 *   words     one cue per whitespace-separated token of the text, timed by eSpeak word events
 *   speed     words per minute (175 × speed), honoured natively
 *   pitch     eSpeak's pitch parameter covers about -6…+8 semitones (measured, table below);
 *             the rest of the -12…+12 range is reached by resampling, which also shifts the
 *             formants (the voice sounds smaller / larger at the extremes)
 * ----------------------------------------------------------------------------------------- */

const LEAD_MS = 40;
const TAIL_MS = 120;
/** Pauses shorter than this are stop closures, not silences: the mouth does not go to rest. */
const MIN_REST_MS = 50;

/**
 * Measured on the build machine (median F0 of a Spanish sentence, YIN): semitones relative to
 * pitch parameter 50 → parameter value.
 */
const PITCH_TABLE: readonly (readonly [number, number])[] = [
  [-6.91, 0],
  [-5.81, 10],
  [-4.67, 20],
  [-3.18, 30],
  [-1.63, 40],
  [0, 50],
  [1.79, 60],
  [3.56, 70],
  [5.36, 80],
  [7.26, 90],
  [9.03, 99],
];
const NATIVE_MIN_SEMITONES = -6;
const NATIVE_MAX_SEMITONES = 8;
const TOTAL_MIN_SEMITONES = -14;
const TOTAL_MAX_SEMITONES = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Split a pitch shift into eSpeak's own parameter and a resampling factor for the rest. */
export function planPitch(semitones: number): { parameter: number; resample: number } {
  const total = clamp(finiteOr(semitones, 0), TOTAL_MIN_SEMITONES, TOTAL_MAX_SEMITONES);
  const native = clamp(total, NATIVE_MIN_SEMITONES, NATIVE_MAX_SEMITONES);
  let parameter = 50;
  for (let i = 1; i < PITCH_TABLE.length; i += 1) {
    const [s0, p0] = PITCH_TABLE[i - 1] ?? [0, 50];
    const [s1, p1] = PITCH_TABLE[i] ?? [0, 50];
    if (native <= s1) {
      parameter = p0 + ((native - s0) / (s1 - s0)) * (p1 - p0);
      break;
    }
  }
  return { parameter: Math.round(parameter), resample: 2 ** ((total - native) / 12) };
}

/* ---------- phonemes → visemes ---------- */

/** Symbols eSpeak emits that the shared table does not know (or maps through a bad prefix). */
const LOCAL_PHONEMES: Readonly<Record<string, Viseme>> = {
  ᵻ: 'I',
  ɯ: 'I',
  ɵ: 'O',
  ʋ: 'FV',
  ɟ: 'KG',
  c: 'KG',
  ɭ: 'NL',
  ɬ: 'NL',
  ɮ: 'NL',
  ɳ: 'NL',
  ʂ: 'CHJ',
  ʐ: 'CHJ',
  ɤ: 'O',
  ɘ: 'E',
  ɞ: 'E',
  ɶ: 'A',
};
/** Affricates and similar: one articulation, one shape. */
const ATOMIC_PHONEMES: Readonly<Record<string, Viseme>> = {
  tʃ: 'CHJ',
  dʒ: 'CHJ',
  tɕ: 'CHJ',
  dʑ: 'CHJ',
  tʂ: 'CHJ',
  dʐ: 'CHJ',
  ts: 'SZ',
  dz: 'SZ',
};
const IGNORED_MARKS = /[ˈˌːˑ'ʲʰʷ‿|.\-!,;]|\p{M}/gu;

function symbolViseme(symbol: string): Viseme | null {
  return LOCAL_PHONEMES[symbol] ?? PHONEME_TO_VISEME[symbol] ?? null;
}

/**
 * Mouth shapes of one eSpeak phoneme event (IPA): none for markers, one for plain phonemes,
 * two for diphthongs and clusters (first and last distinct shape).
 */
export function phonemeShapes(ipa: string): Viseme[] {
  if (ipa === '') return ['rest'];
  if (ipa.startsWith('(')) return []; // language-switch marker such as "(en)"
  const clean = ipa.replace(IGNORED_MARKS, '');
  if (clean === '') return [];
  const atomic = ATOMIC_PHONEMES[clean];
  if (atomic) return [atomic];
  const shapes: Viseme[] = [];
  const symbols = [...clean];
  let i = 0;
  while (i < symbols.length) {
    const pair = ATOMIC_PHONEMES[`${symbols[i] ?? ''}${symbols[i + 1] ?? ''}`];
    const shape = pair ?? symbolViseme(symbols[i] ?? '');
    i += pair ? 2 : 1;
    if (shape && shape !== 'rest' && shapes[shapes.length - 1] !== shape) shapes.push(shape);
  }
  if (shapes.length <= 2) return shapes;
  const first = shapes[0];
  const last = shapes[shapes.length - 1];
  return first && last ? [first, last] : shapes.slice(0, 2);
}

/* ---------- timeline assembly ---------- */

interface TimedPhoneme {
  tMs: number;
  endMs: number;
  ipa: string;
}

interface WordHit {
  tMs: number;
  token: number;
}

/** Index of the token that contains display position `index` (or the next one after it). */
export function tokenAt(prepared: PreparedSpeech, index: number): number {
  const tokens = prepared.tokens;
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((tokens[mid]?.end ?? 0) <= index) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Display position a word event of eSpeak refers to, or -1 when it is inside markup only. */
export function displayIndex(segment: SpeechSegment, textIndex: number): number {
  const map = segment.map;
  for (let i = Math.min(textIndex, map.length - 1); i < map.length; i += 1) {
    const value = map[i] ?? -1;
    if (value >= 0) return value;
  }
  for (let i = Math.min(textIndex, map.length - 1); i >= 0; i -= 1) {
    const value = map[i] ?? -1;
    if (value >= 0) return value;
  }
  return -1;
}

function buildWords(
  prepared: PreparedSpeech,
  hits: readonly WordHit[],
  phonemes: readonly TimedPhoneme[],
  speechEndMs: number,
): WordCue[] {
  // First event of every spoken token, in time order; tokens never go backwards. A token
  // whose event shares its millisecond with the next one took no time (eSpeak reports
  // punctuation-only "words" that way): it is not a cue of its own, its text joins a neighbour.
  const starts: WordHit[] = [];
  for (const hit of hits) {
    const last = starts[starts.length - 1];
    if (last && hit.token <= last.token) continue;
    if (last && Math.round(hit.tMs) <= Math.round(last.tMs)) starts.pop();
    starts.push(hit);
  }
  return cuesOf(prepared, silentTokensRemoved(starts, phonemes), phonemes, speechEndMs);
}

const isSpeech = (phoneme: TimedPhoneme) => phoneme.ipa !== '' && !phoneme.ipa.startsWith('(');

/** Drop the word events during which nothing is pronounced ("……", a lone dash). */
function silentTokensRemoved(
  starts: readonly WordHit[],
  phonemes: readonly TimedPhoneme[],
): WordHit[] {
  let cursor = 0;
  return starts.filter((start, i) => {
    const limit = starts[i + 1]?.tMs ?? Infinity;
    while (cursor < phonemes.length && (phonemes[cursor]?.tMs ?? 0) < start.tMs) cursor += 1;
    for (let p = cursor; p < phonemes.length; p += 1) {
      const phoneme = phonemes[p];
      if (!phoneme || phoneme.tMs >= limit) break;
      if (isSpeech(phoneme)) return true;
    }
    return false;
  });
}

function cuesOf(
  prepared: PreparedSpeech,
  starts: readonly WordHit[],
  phonemes: readonly TimedPhoneme[],
  speechEndMs: number,
): WordCue[] {
  const words: WordCue[] = [];
  let cursor = 0; // phoneme cursor
  starts.forEach((start, i) => {
    const next = starts[i + 1];
    const limit = next ? next.tMs : speechEndMs;
    // The word ends where its trailing silence begins (or where the next word starts).
    let end = limit;
    while (cursor < phonemes.length && (phonemes[cursor]?.tMs ?? 0) < start.tMs) cursor += 1;
    let spoke = false;
    for (let p = cursor; p < phonemes.length; p += 1) {
      const phoneme = phonemes[p];
      if (!phoneme || phoneme.tMs >= limit) break;
      if (phoneme.ipa === '') {
        if (spoke && end === limit) end = phoneme.tMs;
      } else if (isSpeech(phoneme)) {
        spoke = true;
        end = limit;
      }
    }
    // Text: this token plus the unspoken ones around it (punctuation, emoji), so the cues
    // together always spell the whole text.
    const from = i === 0 ? 0 : start.token;
    const to = next ? next.token : prepared.tokens.length;
    const text = prepared.tokens
      .slice(from, to)
      .map((token) => token.text)
      .join(' ');
    const tMs = Math.round(start.tMs);
    words.push({ tMs, durMs: Math.max(1, Math.round(Math.max(end, start.tMs + 1)) - tMs), text });
  });
  return words;
}

function buildVisemes(
  phonemes: readonly TimedPhoneme[],
  speechEndMs: number,
  durationMs: number,
): VisemeCue[] {
  const track = new VisemeTrack();
  for (const phoneme of phonemes) {
    const duration = phoneme.endMs - phoneme.tMs;
    if (phoneme.ipa === '') {
      if (duration >= MIN_REST_MS) track.push(phoneme.tMs, 'rest', durationMs);
      continue;
    }
    const shapes = phonemeShapes(phoneme.ipa);
    const first = shapes[0];
    const second = shapes[1];
    if (first) track.push(phoneme.tMs, first, durationMs);
    if (second) track.push(phoneme.tMs + Math.min(duration, 400) * 0.5, second, durationMs);
  }
  return track.finish(speechEndMs, durationMs);
}

function emptyResult(sampleRate: number): TTSResult {
  return {
    audio: encodeWav(new Int16Array(0), sampleRate),
    format: 'wav',
    sampleRate,
    durationMs: 0,
    visemes: [],
    words: [],
    provider: ESPEAK_INFO,
  };
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

function runEngine(
  engine: EspeakEngine,
  markup: string,
  voice: string,
  wpm: number,
  pitch: number,
) {
  try {
    return engine.synthesize(markup, { voice, rateWpm: wpm, pitch });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // An abort inside the WebAssembly module leaves it unusable: load a fresh one next time.
    resetEspeakEngine();
    throw new AppError('PROVIDER_ERROR', 'The local speech engine (eSpeak NG) failed', {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

async function synthesize(request: TTSRequest): Promise<TTSResult> {
  const def =
    findEspeakVoice(request.profile?.baseVoiceId ?? request.providerVoiceId) ??
    findEspeakVoice(request.providerVoiceId);
  if (!def) {
    throw new AppError('NOT_FOUND', 'Voice not found', {
      provider: ESPEAK_INFO.id,
      providerVoiceId: request.providerVoiceId,
    });
  }
  const engine = await getEspeakEngine();
  const prepared = prepareSpeech(request.text);
  if (prepared.tokens.length === 0) return emptyResult(engine.sampleRate);

  const speed =
    clamp(finiteOr(request.speed, 1), 0.5, 2) *
    clamp(finiteOr(request.profile?.speed ?? 1, 1), 0.5, 2) *
    def.rate;
  const pitch = planPitch(
    def.pitchSemitones +
      clamp(finiteOr(request.pitch, 0), -12, 12) +
      clamp(finiteOr(request.profile?.pitchSemitones ?? 0, 0), -12, 12),
  );
  const language = espeakLanguageFor(def, request.language);
  const voice = def.variant ? `${language}+${def.variant}` : language;
  // Resampling by 1/k raises the pitch by k and shortens the audio by k: synthesise k× slower.
  const wpm = (ESPEAK_NORMAL_WPM * speed) / pitch.resample;
  const timeScale = 1 / pitch.resample;
  const sampleRate = engine.sampleRate;
  const toMs = (samples: number) => (samples * 1000) / sampleRate;
  const toSamples = (ms: number) => Math.round((ms * sampleRate) / 1000);

  const blocks: Int16Array[] = [new Int16Array(toSamples(LEAD_MS))];
  let offsetSamples = blocks[0]?.length ?? 0;
  const phonemes: TimedPhoneme[] = [];
  const hits: WordHit[] = [];
  let speechEndMs = toMs(offsetSamples);

  for (const [index, segment] of prepared.segments.entries()) {
    if (index > 0) await nextTick(); // long scripts must not monopolise the event loop
    const utterance: EspeakUtterance = runEngine(
      engine,
      segment.markup,
      voice,
      wpm,
      pitch.parameter,
    );
    const samples =
      pitch.resample === 1 ? utterance.samples : resampleLinear(utterance.samples, timeScale);
    const offsetMs = toMs(offsetSamples);
    const segmentEndMs = offsetMs + toMs(samples.length);
    const firstPhoneme = phonemes.length;
    for (const event of utterance.events) {
      const tMs = Math.min(segmentEndMs, offsetMs + event.tMs * timeScale);
      if (event.type === 'phoneme') {
        const previous = phonemes[phonemes.length - 1];
        if (previous && phonemes.length > firstPhoneme) previous.endMs = tMs;
        phonemes.push({ tMs, endMs: segmentEndMs, ipa: event.phoneme });
      } else if (event.type === 'word') {
        const at = displayIndex(segment, event.textIndex);
        if (at >= 0) hits.push({ tMs, token: tokenAt(prepared, at) });
      }
    }
    if (samples.length > 0) {
      blocks.push(samples);
      offsetSamples += samples.length;
      speechEndMs = segmentEndMs;
    }
    if (segment.pauseAfterMs > 0) {
      const pause = new Int16Array(toSamples(segment.pauseAfterMs / speed));
      blocks.push(pause);
      offsetSamples += pause.length;
    }
  }
  const words = buildWords(prepared, hits, phonemes, speechEndMs);
  if (words.length === 0) return emptyResult(sampleRate); // nothing pronounceable ("…", "—")

  blocks.push(new Int16Array(toSamples(TAIL_MS)));
  const pcm = concatPcm(blocks);
  const durationMs = samplesToMs(pcm.length, sampleRate);
  return {
    audio: encodeWav(pcm, sampleRate),
    format: 'wav',
    sampleRate,
    durationMs,
    visemes: buildVisemes(phonemes, speechEndMs, durationMs),
    words,
    provider: ESPEAK_INFO,
  };
}

function publicVoice(def: (typeof ESPEAK_VOICES)[number]): ProviderVoice {
  return {
    providerVoiceId: def.providerVoiceId,
    name: def.name,
    language: def.language,
    gender: def.gender,
    description: def.description,
    tags: [...def.tags],
  };
}

/**
 * Local TTS provider (always active): eSpeak NG compiled to WASM
 * (`@echogarden/espeak-ng-emscripten`). Voices in the 13 product languages, speed, pitch,
 * local voice profiles, long texts, numbers and sanitised basic SSML; returns WAV PCM16 mono
 * plus measured viseme and word timelines.
 */
export function createEspeakProvider(_env: ProviderEnv): TTSProvider {
  return {
    info: ESPEAK_INFO,
    listVoices: async () => ESPEAK_VOICES.map(publicVoice),
    synthesize,
  };
}
