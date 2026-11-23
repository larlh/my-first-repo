/* -------------------------------------------------------------------------------------------
 * Voice analysis for LOCAL voice cloning: fundamental frequency (YIN) and articulation rate
 * (syllable nuclei of the loudness envelope). Pure, deterministic, dependency-free.
 *
 * This is deliberately modest signal processing: it measures HOW HIGH and HOW FAST a person
 * speaks, which is all the local "voice profile" uses. It does not model timbre.
 * ----------------------------------------------------------------------------------------- */

export interface VoiceAnalysis {
  /** Length of the analysed audio in seconds. */
  durationSec: number;
  /** Seconds in which a pitch was detected. */
  voicedSec: number;
  /** Seconds of speech (pauses longer than ~0.25 s excluded). */
  speakingSec: number;
  /** Median fundamental frequency of the voiced frames, or null when no pitch was found. */
  medianF0Hz: number | null;
  /** Syllable nuclei per second of speech, or null when there is too little speech. */
  syllablesPerSec: number | null;
}

/** Lowest / highest fundamental searched: covers bass voices up to children. */
export const MIN_F0_HZ = 60;
export const MAX_F0_HZ = 500;

const TARGET_RATE = 11_025;
const MAX_ANALYSIS_SEC = 90;
const HOP_SEC = 0.01;
const WINDOW_SEC = 0.032;
/** YIN absolute threshold and the weaker limit under which a frame still counts as voiced. */
const YIN_THRESHOLD = 0.15;
const YIN_VOICED_LIMIT = 0.3;
/** A frame is "active" when it is within this many dB of the loud parts of the clip. */
const ACTIVE_DB = 26;
const MIN_VOICED_SEC = 0.25;
const MIN_SPEAKING_SEC = 1;
const PAUSE_BRIDGE_SEC = 0.25;
const SYLLABLE_DIP_DB = 2;
/**
 * Envelope smoothing of ±1 frame (30 ms). Tuned on eSpeak speech at known speeds 0.7…1.6: the
 * rate estimate is off by about 7 % on average and by up to 40 % in the worst case, which is
 * why the local clone only nudges the pace inside a narrow range.
 */
const SMOOTH_HALF_FRAMES = 1;

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? 0;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Peak-normalised, DC-free copy decimated to about 11 kHz (box filter + integer factor). */
function prepare(
  samples: ArrayLike<number>,
  sampleRate: number,
): { signal: Float32Array; rate: number } {
  const limit = Math.min(samples.length, Math.floor(sampleRate * MAX_ANALYSIS_SEC));
  const factor = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const length = Math.floor(limit / factor);
  const signal = new Float32Array(length);
  let mean = 0;
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (let k = 0; k < factor; k += 1) sum += samples[i * factor + k] ?? 0;
    const value = sum / factor;
    signal[i] = value;
    mean += value;
  }
  mean /= Math.max(1, length);
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const value = (signal[i] ?? 0) - mean;
    signal[i] = value;
    if (Math.abs(value) > peak) peak = Math.abs(value);
  }
  if (peak > 0) for (let i = 0; i < length; i += 1) signal[i] = (signal[i] ?? 0) / peak;
  return { signal, rate: sampleRate / factor };
}

/**
 * YIN pitch detector on one frame starting at `start`. Returns the period in samples
 * (fractional) or null when the frame is not periodic enough.
 */
function yinPeriod(
  signal: Float32Array,
  start: number,
  window: number,
  tauMin: number,
  tauMax: number,
  scratch: Float32Array,
): number | null {
  let running = 0;
  scratch[0] = 1;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    let diff = 0;
    for (let j = 0; j < window; j += 1) {
      const delta = (signal[start + j] ?? 0) - (signal[start + j + tau] ?? 0);
      diff += delta * delta;
    }
    running += diff;
    scratch[tau] = running > 0 ? (diff * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if ((scratch[tau] ?? 1) < YIN_THRESHOLD) {
      best = tau;
      while (best + 1 <= tauMax && (scratch[best + 1] ?? 1) < (scratch[best] ?? 1)) best += 1;
      break;
    }
  }
  if (best < 0) {
    let lowest = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau += 1) {
      const value = scratch[tau] ?? 1;
      if (value < lowest) {
        lowest = value;
        best = tau;
      }
    }
    if (lowest > YIN_VOICED_LIMIT) return null;
  }
  // Parabolic interpolation around the minimum for sub-sample precision.
  const y0 = scratch[best - 1] ?? scratch[best] ?? 1;
  const y1 = scratch[best] ?? 1;
  const y2 = scratch[best + 1] ?? y1;
  const denominator = y0 - 2 * y1 + y2;
  const shift = Math.abs(denominator) > 1e-12 ? (0.5 * (y0 - y2)) / denominator : 0;
  return best + Math.max(-1, Math.min(1, shift));
}

/**
 * Measure pitch and articulation rate of a mono recording. `samples` may be in any linear
 * scale (Int16 or -1..1 floats): the analysis is level-independent.
 */
export function analyzeVoice(samples: ArrayLike<number>, sampleRate: number): VoiceAnalysis {
  const empty: VoiceAnalysis = {
    durationSec: sampleRate > 0 ? samples.length / sampleRate : 0,
    voicedSec: 0,
    speakingSec: 0,
    medianF0Hz: null,
    syllablesPerSec: null,
  };
  if (!(sampleRate > 0) || samples.length === 0) return empty;
  const { signal, rate } = prepare(samples, sampleRate);
  const hop = Math.max(1, Math.round(rate * HOP_SEC));
  const window = Math.max(8, Math.round(rate * WINDOW_SEC));
  const tauMin = Math.max(2, Math.floor(rate / MAX_F0_HZ));
  const tauMax = Math.ceil(rate / MIN_F0_HZ);
  const frames = Math.floor((signal.length - window - tauMax) / hop);
  if (frames < 5) return empty;

  // ---- loudness envelope (dB) per frame
  const levels: number[] = [];
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const start = f * hop;
    for (let j = 0; j < window; j += 1) {
      const value = signal[start + j] ?? 0;
      sum += value * value;
    }
    levels.push(10 * Math.log10(sum / window + 1e-12));
  }
  const loud = percentile(levels, 0.95);
  if (loud < -70) return empty; // digital silence
  const floor = loud - ACTIVE_DB;
  const active = levels.map((level) => level > floor);

  // ---- pitch
  const scratch = new Float32Array(tauMax + 2);
  const f0: (number | null)[] = [];
  for (let f = 0; f < frames; f += 1) {
    if (!active[f]) {
      f0.push(null);
      continue;
    }
    const period = yinPeriod(signal, f * hop, window, tauMin, tauMax, scratch);
    f0.push(period && period > 0 ? rate / period : null);
  }
  let voiced = f0.filter((value): value is number => value !== null);
  let medianF0: number | null = null;
  if (voiced.length * HOP_SEC >= MIN_VOICED_SEC) {
    // Drop octave errors (more than ~0.8 octave from the first median) and take it again.
    const first = median(voiced);
    voiced = voiced.filter((value) => Math.abs(Math.log2(value / first)) < 0.8);
    medianF0 = median(voiced);
  }

  // ---- speaking time: active frames, with short gaps bridged (they are stops, not pauses)
  const bridge = Math.round(PAUSE_BRIDGE_SEC / HOP_SEC);
  const speaking = [...active];
  let lastActive = -1;
  for (let f = 0; f < frames; f += 1) {
    if (!active[f]) continue;
    if (lastActive >= 0 && f - lastActive - 1 <= bridge) {
      for (let g = lastActive + 1; g < f; g += 1) speaking[g] = true;
    }
    lastActive = f;
  }
  const speakingSec = speaking.filter(Boolean).length * HOP_SEC;

  // ---- syllable nuclei: peaks of the smoothed envelope that rise ≥ 2 dB above the dip
  // before them and fall ≥ 2 dB after, on voiced stretches.
  const smooth: number[] = [];
  const half = SMOOTH_HALF_FRAMES;
  const dip = SYLLABLE_DIP_DB;
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    let count = 0;
    for (let g = Math.max(0, f - half); g <= Math.min(frames - 1, f + half); g += 1) {
      sum += levels[g] ?? 0;
      count += 1;
    }
    smooth.push(sum / count);
  }
  const isVoicedNear = (f: number) => {
    for (let g = Math.max(0, f - 3); g <= Math.min(frames - 1, f + 3); g += 1) {
      if (f0[g] !== null && f0[g] !== undefined) return true;
    }
    return false;
  };
  let nuclei = 0;
  let valley = smooth[0] ?? floor;
  let candidate = -1;
  for (let f = 1; f < frames; f += 1) {
    const level = smooth[f] ?? floor;
    if (candidate < 0) {
      if (level < valley) valley = level;
      else if (level - valley >= dip && level > floor) candidate = f;
    } else if (level > (smooth[candidate] ?? floor)) {
      candidate = f;
    } else if ((smooth[candidate] ?? floor) - level >= dip) {
      if (isVoicedNear(candidate)) nuclei += 1;
      candidate = -1;
      valley = level;
    }
  }
  if (candidate >= 0 && isVoicedNear(candidate)) nuclei += 1;

  return {
    durationSec: signal.length / rate,
    voicedSec: voiced.length * HOP_SEC,
    speakingSec,
    medianF0Hz: medianF0,
    syllablesPerSec: speakingSec >= MIN_SPEAKING_SEC && nuclei > 0 ? nuclei / speakingSec : null,
  };
}

/** Musical interval between two frequencies in semitones (positive when `to` is higher). */
export function semitonesBetween(fromHz: number, toHz: number): number {
  return 12 * Math.log2(toHz / fromHz);
}
