/* PCM helpers of the dictation capture: resampling to the rate the server expects, level
 * metering and WAV encoding. Pure functions and classes — no Web Audio in here. */

/** Root mean square of a block, 0..1 for full-scale float samples. */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  const count = to - from;
  if (count <= 0) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / count);
}

/**
 * Maps an RMS value onto a 0..1 meter. Speech sits between roughly −50 and −12 dBFS, so the
 * meter is logarithmic: a linear one barely moves for a normal voice.
 */
export function levelOf(value: number): number {
  if (value <= 0) return 0;
  const db = 20 * Math.log10(value);
  const level = (db + 54) / 42;
  return level < 0 ? 0 : level > 1 ? 1 : level;
}

/**
 * Raise a quiet phrase towards full scale. The gain is bounded so background noise that slipped
 * through the phrase detector is not turned into something the server takes for speech, and a
 * phrase that is already loud is returned untouched (never attenuated, never clipped).
 */
export function normalizeSegment(
  samples: Float32Array,
  targetPeak = 0.89,
  maxGain = 4,
): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  if (peak === 0 || peak >= targetPeak) return samples;
  const gain = Math.min(maxGain, targetPeak / peak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] ?? 0) * gain;
  return out;
}

/** Zero crossings of the windowed sinc on each side of its centre. */
const SINC_ZEROS = 8;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Streaming sample-rate converter (band-limited: windowed sinc low-pass at 92 % of the lower
 * Nyquist frequency). Feed it blocks of any size; it returns the output samples that can be
 * computed so far and keeps the tail it needs for the next block, so the result does not
 * depend on how the input was cut into blocks.
 */
export class StreamingResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  private readonly step: number;
  private readonly cutoff: number;
  private readonly halfWidth: number;
  private buffer: Float32Array;
  /** Index, inside `buffer`, of the centre of the next output sample. */
  private position: number;

  constructor(inputRate: number, outputRate: number) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new RangeError('Sample rates must be positive');
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.step = inputRate / outputRate;
    // Normalised cut-off (cycles per input sample).
    this.cutoff = (Math.min(inputRate, outputRate) / 2 / inputRate) * 0.92;
    this.halfWidth = Math.ceil(SINC_ZEROS / (2 * this.cutoff));
    // Silence before the first sample, so the first outputs have a full kernel.
    this.buffer = new Float32Array(this.halfWidth);
    this.position = this.halfWidth;
  }

  process(input: Float32Array): Float32Array {
    if (this.inputRate === this.outputRate) return input.slice();
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    merged.set(input, this.buffer.length);

    const { step, cutoff, halfWidth } = this;
    const available = Math.floor((merged.length - 1 - halfWidth - this.position) / step) + 1;
    const output = new Float32Array(Math.max(0, available));
    let centre = this.position;
    for (let n = 0; n < output.length; n += 1) {
      const first = Math.ceil(centre - halfWidth);
      const last = Math.floor(centre + halfWidth);
      let acc = 0;
      let weight = 0;
      for (let i = first; i <= last; i += 1) {
        const x = i - centre;
        // Hann window over the kernel width.
        const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / halfWidth);
        const tap = sinc(2 * cutoff * x) * window;
        acc += (merged[i] ?? 0) * tap;
        weight += tap;
      }
      output[n] = weight === 0 ? 0 : acc / weight;
      centre += step;
    }

    // Keep only what the next output sample still needs.
    const keepFrom = Math.max(0, Math.ceil(centre - halfWidth));
    this.buffer = merged.slice(keepFrom);
    this.position = centre - keepFrom;
    return output;
  }
}

/** Float samples (−1..1) → little-endian signed 16-bit, clipped. */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
  }
  return out;
}

/** A RIFF/WAVE file: PCM 16-bit, mono, with the canonical 44-byte header. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const pcm = floatToPcm16(samples);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i] ?? 0, true);
  return buffer;
}
