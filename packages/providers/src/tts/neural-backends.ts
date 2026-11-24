import fs from 'node:fs/promises';
import { AppError } from '@parlante/shared';
import type { ChunkSymbol, VoiceAlphabet } from './neural-chunks';
import type { NeuralEngine, NeuralModelSpec, NeuralOutput } from './neural-engine';
import { closingPause, kokoroMarks, kokoroPhonemes, piperSymbols } from './neural-phonemes';
import type { KokoroDialect } from './neural-phonemes';
import type { ChunkAudio, VoiceBackend } from './neural-synth';
import { nodeOutputsByOp, withGraphOutput } from './onnx-graph';

/* -------------------------------------------------------------------------------------------
 * The two neural models behind `VoiceBackend`: how a chunk of symbols becomes tensors, and
 * how the tensors that come back become audio plus the position of every symbol.
 * ----------------------------------------------------------------------------------------- */

/** Symbol positions from per-id durations (in frames) and the length of the audio. */
function boundsFromDurations(
  durations: Float32Array,
  audioSamples: number,
  /** For each symbol: index of its first id and how many ids it spans. */
  spans: readonly { from: number; count: number }[],
): Float64Array {
  let total = 0;
  for (const frames of durations) total += Math.max(0, frames);
  const samplesPerFrame = total > 0 ? audioSamples / total : 0;
  const starts = new Float64Array(durations.length + 1);
  for (let i = 0; i < durations.length; i += 1) {
    starts[i + 1] = (starts[i] ?? 0) + Math.max(0, durations[i] ?? 0) * samplesPerFrame;
  }
  const bounds = new Float64Array(spans.length + 1);
  spans.forEach((span, i) => {
    bounds[i] = starts[span.from] ?? audioSamples;
    bounds[i + 1] = starts[span.from + span.count] ?? audioSamples;
  });
  return bounds;
}

function tensor(outputs: Record<string, NeuralOutput>, name: string): Float32Array {
  const output = outputs[name];
  if (!output) throw new AppError('PROVIDER_ERROR', `The voice model returned no "${name}"`);
  return output.data;
}

/* ---------- Kokoro ---------- */

/** Kokoro's context is 512 ids including the two pads around the text. */
export const KOKORO_MAX_SYMBOLS = 510;
const KOKORO_STYLE_DIM = 256;
export const KOKORO_SAMPLE_RATE = 24_000;
/**
 * How much earlier than the sum of the predicted durations a symbol is actually heard: three
 * frames of 25 ms. The vocoder answers before the frame count says, so a timeline built from
 * the raw sums runs behind the sound — measured on the audio (mouth opening implied by the
 * visemes against the loudness envelope): 50–80 ms late without the correction, between 20 ms
 * early and 10 ms late with it (eSpeak, whose timeline is exact, gives +10 ms on the same
 * measure). The figures are in docs/MODELS.md.
 */
export const KOKORO_TIMELINE_LEAD_MS = 75;

/** `model.vocab` of Kokoro's tokenizer.json: symbol → id. */
export async function readKokoroVocab(tokenizerPath: string): Promise<Map<string, number>> {
  const parsed = JSON.parse(await fs.readFile(tokenizerPath, 'utf8')) as {
    model?: { vocab?: Record<string, unknown> };
  };
  const vocab = new Map<string, number>();
  for (const [symbol, id] of Object.entries(parsed.model?.vocab ?? {})) {
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) vocab.set(symbol, id);
  }
  if (vocab.size === 0) throw new Error(`${tokenizerPath} holds no vocabulary`);
  return vocab;
}

/** A Kokoro voice file: float32 [510, 1, 256], the style for each text length. */
export async function readKokoroStyles(voicePath: string): Promise<Float32Array> {
  const bytes = await fs.readFile(voicePath);
  if (bytes.byteLength % (KOKORO_STYLE_DIM * 4) !== 0 || bytes.byteLength === 0) {
    throw new Error(`${voicePath} is not a Kokoro voice (unexpected size ${bytes.byteLength})`);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

export interface KokoroBackendOptions {
  engine: Pick<NeuralEngine, 'run'>;
  model: NeuralModelSpec;
  vocab: ReadonlyMap<string, number>;
  styles: Float32Array;
  dialect: KokoroDialect;
}

export function kokoroAlphabet(
  vocab: ReadonlyMap<string, number>,
  dialect: KokoroDialect,
): VoiceAlphabet {
  const known = (text: string) => [...text].filter((symbol) => vocab.has(symbol));
  return {
    word: (phonemes) => known(kokoroPhonemes(phonemes, dialect)),
    marks: (marks) => known(kokoroMarks(marks)),
    space: ' ',
  };
}

export function createKokoroBackend(options: KokoroBackendOptions): VoiceBackend {
  const { engine, model, vocab, styles } = options;
  const rows = styles.length / KOKORO_STYLE_DIM;
  return {
    sampleRate: KOKORO_SAMPLE_RATE,
    alphabet: kokoroAlphabet(vocab, options.dialect),
    // Best between 100 and 200 symbols; it rushes when close to its limit.
    policy: { targetSymbols: 220, maxSymbols: 400 },
    async speak(symbols: readonly ChunkSymbol[], speed: number, signal): Promise<ChunkAudio> {
      const ids = new BigInt64Array(symbols.length + 2); // pad id 0 at both ends
      symbols.forEach((symbol, i) => {
        ids[i + 1] = BigInt(vocab.get(symbol.text) ?? 0);
      });
      // The style of a voice depends on the length of the text.
      const row = Math.min(rows - 1, symbols.length);
      const style = styles.slice(row * KOKORO_STYLE_DIM, (row + 1) * KOKORO_STYLE_DIM);
      const outputs = await engine.run({
        model,
        feeds: {
          input_ids: { type: 'int64', data: ids, dims: [1, ids.length] },
          style: { type: 'float32', data: style, dims: [1, KOKORO_STYLE_DIM] },
          speed: { type: 'float32', data: Float32Array.of(speed), dims: [1] },
        },
        outputs: ['waveform', 'durations'],
        ...(signal ? { signal } : {}),
      });
      const waveform = tensor(outputs, 'waveform');
      const durations = tensor(outputs, 'durations');
      const spans = symbols.map((_, i) => ({ from: i + 1, count: 1 }));
      const bounds = boundsFromDurations(durations, waveform.length, spans);
      // Every symbol starts earlier than the durations add up to (see KOKORO_TIMELINE_LEAD_MS).
      // The end of the last spoken symbol and what follows stay where they are: that bound
      // decides where the audio is cut, and nothing of the last word may be lost.
      const lead = (KOKORO_TIMELINE_LEAD_MS * KOKORO_SAMPLE_RATE) / 1000;
      const lastSpoken = symbols.findLastIndex((symbol) => symbol.role === 'speech');
      for (let i = 0; i <= lastSpoken; i += 1) bounds[i] = Math.max(0, (bounds[i] ?? 0) - lead);
      return { waveform, bounds };
    },
  };
}

/* ---------- Piper ---------- */

/** The part of a Piper `<voice>.onnx.json` the backend reads. */
export interface PiperConfig {
  audio: { sample_rate: number };
  espeak?: { voice?: string };
  num_speakers?: number;
  inference?: { noise_scale?: number; length_scale?: number; noise_w?: number };
  phoneme_id_map: Record<string, number[]>;
}

export async function readPiperConfig(configPath: string): Promise<PiperConfig> {
  const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Partial<PiperConfig>;
  if (
    typeof parsed.audio?.sample_rate !== 'number' ||
    typeof parsed.phoneme_id_map !== 'object' ||
    parsed.phoneme_id_map === null
  ) {
    throw new Error(`${configPath} is not a Piper voice configuration`);
  }
  return parsed as PiperConfig;
}

const PIPER_BOS = '^';
const PIPER_EOS = '$';
const PIPER_PAD = '_';

/**
 * Name of the tensor with the predicted durations (frames per input id) of a Piper graph: the
 * output of its only `Ceil` node (`w_ceil` in VITS). Found once per graph, when it is loaded.
 */
const piperDurationOutputs = new Map<string, string>();

/** The model spec of a Piper voice: its graph is given one more output, the durations. */
export function piperModelSpec(key: string, modelPath: string): NeuralModelSpec {
  return {
    key,
    path: modelPath,
    prepare(bytes) {
      const candidates = nodeOutputsByOp(bytes, 'Ceil');
      const name = candidates[0];
      if (candidates.length !== 1 || name === undefined) {
        throw new Error(
          `Unexpected Piper graph (${candidates.length} Ceil nodes): its phoneme durations cannot be read`,
        );
      }
      piperDurationOutputs.set(key, name);
      return withGraphOutput(bytes, name);
    },
  };
}

export interface PiperBackendOptions {
  engine: Pick<NeuralEngine, 'run'>;
  model: NeuralModelSpec;
  config: PiperConfig;
  /** Speaker index of a multi-speaker voice. */
  speaker: number | null;
}

export function piperAlphabet(config: PiperConfig): VoiceAlphabet {
  const known = new Set(Object.keys(config.phoneme_id_map));
  for (const control of [PIPER_BOS, PIPER_EOS, PIPER_PAD]) known.delete(control);
  let longest = 1;
  for (const symbol of known) longest = Math.max(longest, [...symbol].length);
  const mark = (text: string) => (known.has(text) ? [text] : []);
  return {
    word: (phonemes) =>
      // A space inside a phoneme would be a word break; punctuation is added by `marks`.
      phonemes.flatMap((ipa) => piperSymbols(ipa, known, longest)).filter((s) => s !== ' '),
    marks(marks, position) {
      // Piper is trained on eSpeak clauses: only the mark that ENDS a clause is a symbol.
      if (position === 'leading') return [];
      const closing = closingPause(marks);
      if (closing === '') return [];
      if (closing === '…') return mark('.');
      if (closing === '—') return mark(',');
      return mark(closing);
    },
    space: ' ',
  };
}

export function createPiperBackend(options: PiperBackendOptions): VoiceBackend {
  const { engine, model, config } = options;
  const map = config.phoneme_id_map;
  const idsOf = (symbol: string): number[] => map[symbol] ?? [];
  const pad = idsOf(PIPER_PAD);
  const noiseScale = config.inference?.noise_scale ?? 0.667;
  const lengthScale = config.inference?.length_scale ?? 1;
  const noiseW = config.inference?.noise_w ?? 0.8;
  const multiSpeaker = (config.num_speakers ?? 1) > 1;
  return {
    sampleRate: config.audio.sample_rate,
    alphabet: piperAlphabet(config),
    // One sentence per inference, as in training.
    policy: { targetSymbols: 1, maxSymbols: 420 },
    async speak(symbols: readonly ChunkSymbol[], speed: number, signal): Promise<ChunkAudio> {
      // `^ _ s1 _ s2 _ … sn _ $`: every symbol is followed by the blank that VITS expects.
      const ids: number[] = [...idsOf(PIPER_BOS), ...pad];
      const spans = symbols.map((symbol) => {
        const from = ids.length;
        ids.push(...idsOf(symbol.text), ...pad);
        return { from, count: ids.length - from };
      });
      ids.push(...idsOf(PIPER_EOS));
      const feeds: Parameters<NeuralEngine['run']>[0]['feeds'] = {
        input: { type: 'int64', data: BigInt64Array.from(ids, BigInt), dims: [1, ids.length] },
        input_lengths: { type: 'int64', data: BigInt64Array.of(BigInt(ids.length)), dims: [1] },
        scales: {
          type: 'float32',
          data: Float32Array.of(noiseScale, lengthScale / speed, noiseW),
          dims: [3],
        },
      };
      if (multiSpeaker) {
        feeds.sid = {
          type: 'int64',
          data: BigInt64Array.of(BigInt(options.speaker ?? 0)),
          dims: [1],
        };
      }
      const durationName = () => {
        const name = piperDurationOutputs.get(model.key);
        if (!name) throw new Error('The Piper graph was loaded without its duration output');
        return name;
      };
      const outputs = await engine.run({
        model,
        feeds,
        outputs: () => ['output', durationName()],
        ...(signal ? { signal } : {}),
      });
      const waveform = tensor(outputs, 'output');
      const durations = tensor(outputs, durationName());
      return { waveform, bounds: boundsFromDurations(durations, waveform.length, spans) };
    },
  };
}
