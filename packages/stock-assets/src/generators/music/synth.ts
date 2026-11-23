/* -------------------------------------------------------------------------------------------
 * Tiny offline synthesiser used to GENERATE the stock music (Node only, build time).
 *
 * Everything here is deterministic: no Math.random(), no clocks. A track is rendered into
 * `Bus` buffers whose length is an exact number of bars; voices that ring past the end WRAP to
 * the beginning and every stateful effect is run until it reaches its periodic steady state
 * (`twoPass`), so the last sample flows into the first one and the track loops without a click.
 * ----------------------------------------------------------------------------------------- */

export const SAMPLE_RATE = 48_000;
const TAU = Math.PI * 2;

/** Seeded PRNG (mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [-1, 1). */
  bipolar(): number {
    return this.next() * 2 - 1;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

/** Equal-tempered frequency of a MIDI note (A4 = 69 = 440 Hz). */
export function midiToHz(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/* ---------- buses ---------- */

/** Stereo buffer of one loop. Voices are mixed in with wrap-around. */
export class Bus {
  readonly left: Float32Array;
  readonly right: Float32Array;

  constructor(readonly length: number) {
    this.left = new Float32Array(length);
    this.right = new Float32Array(length);
  }

  /**
   * Mix a mono voice starting at sample `start`; whatever runs past the end of the loop is
   * folded back to the beginning. `pan`: -1 left … 1 right (equal power).
   */
  add(voice: Float32Array, start: number, gain = 1, pan = 0): void {
    const n = this.length;
    const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
    const gl = Math.cos(angle) * gain;
    const gr = Math.sin(angle) * gain;
    let p = ((Math.round(start) % n) + n) % n;
    const { left, right } = this;
    for (let i = 0; i < voice.length; i += 1) {
      const v = voice[i] as number;
      left[p] = (left[p] as number) + v * gl;
      right[p] = (right[p] as number) + v * gr;
      p += 1;
      if (p === n) p = 0;
    }
  }

  /** Mix another bus of the same length into this one. */
  mix(other: Bus, gain = 1): void {
    const { left, right } = this;
    for (let i = 0; i < this.length; i += 1) {
      left[i] = (left[i] as number) + (other.left[i] as number) * gain;
      right[i] = (right[i] as number) + (other.right[i] as number) * gain;
    }
  }

  scale(gain: number): void {
    for (let i = 0; i < this.length; i += 1) {
      this.left[i] = (this.left[i] as number) * gain;
      this.right[i] = (this.right[i] as number) * gain;
    }
  }

  peak(): number {
    let peak = 0;
    for (let i = 0; i < this.length; i += 1) {
      peak = Math.max(peak, Math.abs(this.left[i] as number), Math.abs(this.right[i] as number));
    }
    return peak;
  }
}

/* ---------- filters ---------- */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'highshelf' | 'lowshelf';

/** RBJ cookbook biquads. `gainDb` only matters for peaking and shelves. */
export function biquad(kind: BiquadKind, freq: number, q = Math.SQRT1_2, gainDb = 0): BiquadCoeffs {
  const w0 = (TAU * Math.min(freq, SAMPLE_RATE * 0.45)) / SAMPLE_RATE;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  const a = 10 ** (gainDb / 40);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  switch (kind) {
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * a;
      b1 = -2 * cos;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cos;
      a2 = 1 - alpha / a;
      break;
    case 'highshelf': {
      const k = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 + (a - 1) * cos + k);
      b1 = -2 * a * (a - 1 + (a + 1) * cos);
      b2 = a * (a + 1 + (a - 1) * cos - k);
      a0 = a + 1 - (a - 1) * cos + k;
      a1 = 2 * (a - 1 - (a + 1) * cos);
      a2 = a + 1 - (a - 1) * cos - k;
      break;
    }
    case 'lowshelf': {
      const k = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 - (a - 1) * cos + k);
      b1 = 2 * a * (a - 1 - (a + 1) * cos);
      b2 = a * (a + 1 - (a - 1) * cos - k);
      a0 = a + 1 + (a - 1) * cos + k;
      a1 = -2 * (a - 1 + (a + 1) * cos);
      a2 = a + 1 + (a - 1) * cos - k;
      break;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Filter a one-shot mono voice in place (starts from silence). */
export function filterVoice(voice: Float32Array, c: BiquadCoeffs): Float32Array {
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < voice.length; i += 1) {
    const x = voice[i] as number;
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    voice[i] = y;
  }
  return voice;
}

function filterChannelPeriodic(data: Float32Array, c: BiquadCoeffs): void {
  let z1 = 0;
  let z2 = 0;
  // First pass only warms the state up with the end of the loop; second pass writes.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < data.length; i += 1) {
      const x = data[i] as number;
      const y = c.b0 * x + z1;
      z1 = c.b1 * x - c.a1 * y + z2;
      z2 = c.b2 * x - c.a2 * y;
      if (pass === 1) data[i] = y;
    }
  }
}

/** Filter a whole loop in place so that the result is still periodic. */
export function filterBus(bus: Bus, c: BiquadCoeffs): Bus {
  filterChannelPeriodic(bus.left, c);
  filterChannelPeriodic(bus.right, c);
  return bus;
}

/* ---------- envelopes ---------- */

/** Raised-cosine fade in/out applied in place (seconds). */
export function fade(voice: Float32Array, fadeIn: number, fadeOut: number): Float32Array {
  const a = Math.min(voice.length, Math.max(1, Math.round(fadeIn * SAMPLE_RATE)));
  const r = Math.min(voice.length, Math.max(1, Math.round(fadeOut * SAMPLE_RATE)));
  for (let i = 0; i < a; i += 1) {
    voice[i] = (voice[i] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / a));
  }
  for (let i = 0; i < r; i += 1) {
    const idx = voice.length - 1 - i;
    voice[idx] = (voice[idx] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / r));
  }
  return voice;
}

/* ---------- pitched voices (mono one-shots) ---------- */

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

export interface PadOptions {
  /** Seconds. */
  attack: number;
  release: number;
  /** Low-pass cutoff in Hz: lower = darker. */
  cutoff: number;
  /** Detune between the three oscillators, in cents. */
  detune?: number;
  /** Slow pitch drift depth in cents (keeps long notes alive). */
  drift?: number;
}

/** Three detuned band-limited saws through a 24 dB low-pass: strings / synth pad. */
export function padVoice(freq: number, hold: number, opts: PadOptions): Float32Array {
  const n = Math.round((hold + opts.release) * SAMPLE_RATE);
  const out = new Float32Array(n);
  const detune = opts.detune ?? 9;
  const drift = opts.drift ?? 3;
  const ratios = [2 ** (-detune / 1200), 1, 2 ** (detune / 1200)];
  const phases = [0.11, 0.47, 0.83];
  const driftRate = [0.19, 0.13, 0.23];
  for (let v = 0; v < 3; v += 1) {
    let phase = phases[v] as number;
    const base = (freq * (ratios[v] as number)) / SAMPLE_RATE;
    const rate = (TAU * (driftRate[v] as number)) / SAMPLE_RATE;
    const depth = (drift / 1200) * Math.LN2;
    for (let i = 0; i < n; i += 1) {
      const dt = base * (1 + depth * Math.sin(rate * i + v * 2.1));
      out[i] = (out[i] as number) + (2 * phase - 1 - polyBlep(phase, dt)) / 3;
      phase += dt;
      if (phase >= 1) phase -= 1;
    }
  }
  const lp = biquad('lowpass', opts.cutoff, 0.6);
  filterVoice(filterVoice(out, lp), lp);
  // Envelope: raised-cosine attack, flat sustain, raised-cosine release.
  const a = Math.max(1, Math.round(Math.min(opts.attack, hold) * SAMPLE_RATE));
  const r = Math.max(1, Math.round(opts.release * SAMPLE_RATE));
  for (let i = 0; i < a; i += 1) {
    out[i] = (out[i] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / a));
  }
  for (let i = 0; i < r && i < n; i += 1) {
    const idx = n - 1 - i;
    out[idx] = (out[idx] as number) * (0.5 - 0.5 * Math.cos((Math.PI * i) / r));
  }
  return out;
}

export interface KeysOptions {
  /** FM index at the attack: higher = brighter, more bark. */
  bright?: number;
  /** Amplitude decay time constant in seconds at middle C. */
  decay?: number;
  /** Level of the short metallic "tine" partial. */
  tine?: number;
  /** Release time after the key is lifted (seconds). */
  release?: number;
}

/** Two-operator FM electric piano: soft, round, decays naturally while held. */
export function keysVoice(
  freq: number,
  hold: number,
  velocity: number,
  opts: KeysOptions = {},
): Float32Array {
  const release = opts.release ?? 0.25;
  const n = Math.round((hold + release) * SAMPLE_RATE);
  const out = new Float32Array(n);
  const bright = (opts.bright ?? 1.3) * (0.45 + 0.55 * velocity);
  // Low notes ring longer than high ones.
  const decay = (opts.decay ?? 1.6) * Math.min(2.2, Math.max(0.45, (261.6 / freq) ** 0.45));
  const tine = opts.tine ?? 0.05;
  const w = (TAU * freq) / SAMPLE_RATE;
  const holdSamples = Math.round(hold * SAMPLE_RATE);
  const releaseSamples = Math.max(1, n - holdSamples);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const index = bright * (0.25 + 0.75 * Math.exp(-t / 0.35));
    const body = Math.sin(w * i + index * Math.sin(w * i));
    const bell = tine * Math.exp(-t / 0.12) * Math.sin(w * 7.003 * i);
    let amp = Math.exp(-t / decay);
    if (i < 96) amp *= i / 96; // 2 ms anti-click
    if (i >= holdSamples) {
      const k = (i - holdSamples) / releaseSamples;
      amp *= 0.5 + 0.5 * Math.cos(Math.PI * k);
    }
    out[i] = (body + bell) * amp * velocity;
  }
  return out;
}

export interface PluckOptions {
  /** Seconds for the string to decay by 60 dB. */
  sustain?: number;
  /** 0 (dark, nylon) … 1 (bright, steel). */
  brightness?: number;
  /** Seconds; when set the string is damped (palm mute / staccato) after this time. */
  mute?: number;
}

/** Karplus–Strong plucked string with fractional tuning (Jaffe & Smith). */
export function pluckVoice(
  freq: number,
  duration: number,
  velocity: number,
  rng: Rng,
  opts: PluckOptions = {},
): Float32Array {
  const n = Math.round(duration * SAMPLE_RATE);
  const out = new Float32Array(n);
  const period = SAMPLE_RATE / freq;
  const brightness = opts.brightness ?? 0.5;
  // One-zero loop filter y = (1 - s) x[n] + s x[n-1]; its delay is `s` samples.
  const s = 0.5 - 0.42 * brightness;
  const size = Math.max(2, Math.floor(period - s - 0.1));
  const frac = period - s - size;
  const apCoeff = (1 - frac) / (1 + frac);
  const loopGain = 0.001 ** (1 / (freq * (opts.sustain ?? 2.5)));
  const line = new Float32Array(size);
  // Excitation: low-passed noise burst, DC removed. Harder picks are brighter.
  let lp1 = 0;
  let lp2 = 0;
  let mean = 0;
  const excite = 0.06 + 0.3 * brightness * (0.5 + 0.5 * velocity);
  for (let i = 0; i < size; i += 1) {
    lp1 += excite * (rng.bipolar() - lp1);
    lp2 += excite * (lp1 - lp2);
    line[i] = lp2;
    mean += lp2;
  }
  mean /= size;
  let peak = 1e-9;
  for (let i = 0; i < size; i += 1) {
    line[i] = (line[i] as number) - mean;
    peak = Math.max(peak, Math.abs(line[i] as number));
  }
  for (let i = 0; i < size; i += 1) line[i] = (line[i] as number) / peak;
  const muteAt = opts.mute === undefined ? n : Math.round(opts.mute * SAMPLE_RATE);
  let idx = 0;
  let prev = 0;
  let apIn = 0;
  let apOut = 0;
  for (let i = 0; i < n; i += 1) {
    const x = line[idx] as number;
    const gain = i < muteAt ? loopGain : loopGain * 0.93;
    const filtered = ((1 - s) * x + s * prev) * gain;
    prev = x;
    apOut = apCoeff * filtered + apIn - apCoeff * apOut;
    apIn = filtered;
    line[idx] = apOut;
    idx += 1;
    if (idx === size) idx = 0;
    out[i] = x * velocity;
  }
  return fade(out, 0.001, Math.min(0.06, duration / 4));
}

export interface Partial {
  /** Frequency ratio to the fundamental. */
  ratio: number;
  amp: number;
  /** Decay time constant in seconds. */
  decay: number;
}

export const MARIMBA: readonly Partial[] = [
  { ratio: 1, amp: 1, decay: 0.32 },
  { ratio: 3.93, amp: 0.22, decay: 0.09 },
  { ratio: 9.2, amp: 0.06, decay: 0.035 },
];

export const GLOCKEN: readonly Partial[] = [
  { ratio: 1, amp: 1, decay: 0.9 },
  { ratio: 2.76, amp: 0.3, decay: 0.45 },
  { ratio: 5.4, amp: 0.12, decay: 0.2 },
  { ratio: 8.93, amp: 0.05, decay: 0.09 },
];

export const SOFT_BELL: readonly Partial[] = [
  { ratio: 1, amp: 1, decay: 1.8 },
  { ratio: 2.0, amp: 0.35, decay: 1.1 },
  { ratio: 3.01, amp: 0.12, decay: 0.6 },
  { ratio: 4.2, amp: 0.05, decay: 0.3 },
];

/** Struck bar / bell: a few decaying sine partials. */
export function malletVoice(
  freq: number,
  duration: number,
  velocity: number,
  partials: readonly Partial[],
): Float32Array {
  const n = Math.round(duration * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (const partial of partials) {
    const f = freq * partial.ratio;
    if (f > SAMPLE_RATE * 0.45) continue;
    const w = (TAU * f) / SAMPLE_RATE;
    const k = 1 / (partial.decay * SAMPLE_RATE);
    for (let i = 0; i < n; i += 1) {
      out[i] = (out[i] as number) + partial.amp * Math.exp(-i * k) * Math.sin(w * i);
    }
  }
  for (let i = 0; i < n; i += 1) out[i] = (out[i] as number) * velocity;
  return fade(out, 0.0015, Math.min(0.08, duration / 3));
}

export interface BassOptions {
  /** Level of the second and third harmonics (0 = pure sine sub). */
  growl?: number;
  attack?: number;
  release?: number;
  /** Amplitude decay time constant while held; Infinity = organ-like sustain. */
  decay?: number;
}

/** Round bass: sine with a little harmonic content. */
export function bassVoice(
  freq: number,
  hold: number,
  velocity: number,
  opts: BassOptions = {},
): Float32Array {
  const release = opts.release ?? 0.08;
  const n = Math.round((hold + release) * SAMPLE_RATE);
  const out = new Float32Array(n);
  const growl = opts.growl ?? 0.25;
  const decay = opts.decay ?? Number.POSITIVE_INFINITY;
  const w = (TAU * freq) / SAMPLE_RATE;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const tone =
      Math.sin(w * i) + growl * Math.sin(2 * w * i) * 0.6 + growl * Math.sin(3 * w * i) * 0.25;
    out[i] = Math.tanh(tone * 1.2) * Math.exp(-t / decay) * velocity;
  }
  return fade(out, opts.attack ?? 0.008, release);
}

/* ---------- percussion ---------- */

export interface KickOptions {
  /** Start / end pitch of the sweep in Hz. */
  from?: number;
  to?: number;
  /** Seconds. */
  sweep?: number;
  decay?: number;
}

/** Soft kick: sine with a downward pitch sweep. */
export function kickVoice(velocity: number, opts: KickOptions = {}): Float32Array {
  const from = opts.from ?? 115;
  const to = opts.to ?? 46;
  const sweep = opts.sweep ?? 0.045;
  const decay = opts.decay ?? 0.18;
  const n = Math.round(Math.min(1.5, decay * 6) * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    phase += (TAU * (to + (from - to) * Math.exp(-t / sweep))) / SAMPLE_RATE;
    out[i] = Math.sin(phase) * Math.exp(-t / decay) * velocity;
  }
  return fade(out, 0.002, 0.02);
}

export interface NoiseHitOptions {
  kind: 'bandpass' | 'highpass' | 'lowpass';
  freq: number;
  q?: number;
  /** Seconds. */
  attack?: number;
  decay: number;
}

/** Filtered noise burst: hats, shakers, snares, brushes. */
export function noiseHit(velocity: number, rng: Rng, opts: NoiseHitOptions): Float32Array {
  const attack = opts.attack ?? 0.001;
  const n = Math.round((attack + opts.decay * 6) * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = rng.bipolar();
  filterVoice(out, biquad(opts.kind, opts.freq, opts.q ?? 0.9));
  const a = Math.max(1, Math.round(attack * SAMPLE_RATE));
  for (let i = 0; i < n; i += 1) {
    const env = i < a ? i / a : Math.exp(-(i - a) / (opts.decay * SAMPLE_RATE));
    out[i] = (out[i] as number) * env * velocity;
  }
  return fade(out, 0.0005, 0.01);
}

/** Rim-shot / soft snare: short tone plus a band of noise. */
export function snareVoice(velocity: number, rng: Rng, tone = 185, decay = 0.09): Float32Array {
  const noise = noiseHit(velocity * 0.8, rng, { kind: 'bandpass', freq: 1900, q: 0.7, decay });
  const w = (TAU * tone) / SAMPLE_RATE;
  for (let i = 0; i < noise.length; i += 1) {
    const t = i / SAMPLE_RATE;
    noise[i] = (noise[i] as number) + Math.sin(w * i) * Math.exp(-t / 0.05) * velocity * 0.5;
  }
  return fade(noise, 0.001, 0.01);
}

/** Hand clap: three quick noise bursts and a short tail. */
export function clapVoice(velocity: number, rng: Rng): Float32Array {
  const n = Math.round(0.4 * SAMPLE_RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = rng.bipolar();
  filterVoice(out, biquad('bandpass', 1250, 1.1));
  const bursts = [0, 0.011, 0.023];
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    let env = 0;
    for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) / 0.008));
    if (t >= 0.023) env = Math.max(env, 0.7 * Math.exp(-(t - 0.023) / 0.07));
    out[i] = (out[i] as number) * env * velocity;
  }
  return fade(out, 0.0005, 0.02);
}

/** Low orchestral boom: deep sine with a slow fall plus a dull thump. */
export function boomVoice(velocity: number, rng: Rng, pitch = 52): Float32Array {
  const n = Math.round(2.2 * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    phase += (TAU * (pitch * (1 + 0.5 * Math.exp(-t / 0.05)))) / SAMPLE_RATE;
    lp += 0.02 * (rng.bipolar() - lp);
    out[i] = (Math.sin(phase) * Math.exp(-t / 0.55) + lp * 2.5 * Math.exp(-t / 0.12)) * velocity;
  }
  return fade(out, 0.004, 0.2);
}

/* ---------- effects (periodic) ---------- */

export interface DelayOptions {
  /** Delay times in seconds for the left / right taps. */
  timeLeft: number;
  timeRight: number;
  feedback: number;
  /** 0..1: how much high end each repeat loses. */
  damp?: number;
  /** Feed each channel's repeats into the other one (ping-pong). */
  cross?: boolean;
}

/** Stereo feedback delay. Returns the WET signal only, periodic over the loop. */
export function delay(input: Bus, opts: DelayOptions): Bus {
  const n = input.length;
  const wet = new Bus(n);
  const dl = Math.max(1, Math.round(opts.timeLeft * SAMPLE_RATE)) % n;
  const dr = Math.max(1, Math.round(opts.timeRight * SAMPLE_RATE)) % n;
  const damp = opts.damp ?? 0.35;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    mono[i] = ((input.left[i] as number) + (input.right[i] as number)) * 0.5;
  }
  let lpL = 0;
  let lpR = 0;
  // Repeats decay far below audibility within one loop, so two passes give the steady state.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      const il = i - dl < 0 ? i - dl + n : i - dl;
      const ir = i - dr < 0 ? i - dr + n : i - dr;
      if (opts.cross) {
        // Ping-pong: the dry signal enters on the left, bounces right, then feeds back left.
        lpL += (1 - damp) * ((wet.right[il] as number) - lpL);
        lpR += (1 - damp) * ((wet.left[ir] as number) - lpR);
        wet.left[i] = (mono[il] as number) + opts.feedback * lpL;
        wet.right[i] = 0.85 * lpR;
      } else {
        lpL += (1 - damp) * ((wet.left[il] as number) - lpL);
        lpR += (1 - damp) * ((wet.right[ir] as number) - lpR);
        wet.left[i] = (input.left[il] as number) + opts.feedback * lpL;
        wet.right[i] = (input.right[ir] as number) + opts.feedback * lpR;
      }
    }
  }
  return wet;
}

export interface ReverbOptions {
  /** 0..1: longer tail. */
  size?: number;
  /** 0..1: darker tail. */
  damp?: number;
}

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

class ReverbChannel {
  private readonly combs: Float32Array[];
  private readonly combIdx: number[];
  private readonly combLp: number[];
  private readonly allpasses: Float32Array[];
  private readonly allpassIdx: number[];

  constructor(
    offset: number,
    private readonly feedback: number,
    private readonly damp: number,
  ) {
    const scale = SAMPLE_RATE / 44_100;
    this.combs = COMB_TUNING.map((len) => new Float32Array(Math.round((len + offset) * scale)));
    this.combIdx = COMB_TUNING.map(() => 0);
    this.combLp = COMB_TUNING.map(() => 0);
    this.allpasses = ALLPASS_TUNING.map(
      (len) => new Float32Array(Math.round((len + offset) * scale)),
    );
    this.allpassIdx = ALLPASS_TUNING.map(() => 0);
  }

  process(x: number): number {
    let out = 0;
    for (let c = 0; c < this.combs.length; c += 1) {
      const buf = this.combs[c] as Float32Array;
      const idx = this.combIdx[c] as number;
      const y = buf[idx] as number;
      const lp = y * (1 - this.damp) + (this.combLp[c] as number) * this.damp;
      this.combLp[c] = lp;
      buf[idx] = x + lp * this.feedback;
      this.combIdx[c] = idx + 1 === buf.length ? 0 : idx + 1;
      out += y;
    }
    for (let a = 0; a < this.allpasses.length; a += 1) {
      const buf = this.allpasses[a] as Float32Array;
      const idx = this.allpassIdx[a] as number;
      const delayed = buf[idx] as number;
      buf[idx] = out + delayed * 0.5;
      this.allpassIdx[a] = idx + 1 === buf.length ? 0 : idx + 1;
      out = delayed - out;
    }
    return out;
  }
}

/** Freeverb-style reverb. Returns the WET signal only, periodic over the loop. */
export function reverb(input: Bus, opts: ReverbOptions = {}): Bus {
  const n = input.length;
  const wet = new Bus(n);
  const feedback = 0.7 + 0.28 * (opts.size ?? 0.6);
  const damp = 0.4 * (opts.damp ?? 0.5);
  const left = new ReverbChannel(0, feedback, damp);
  const right = new ReverbChannel(STEREO_SPREAD, feedback, damp);
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = ((input.left[i] as number) + (input.right[i] as number)) * 0.015;
      const l = left.process(x);
      const r = right.process(x);
      if (pass === 1) {
        wet.left[i] = l;
        wet.right[i] = r;
      }
    }
  }
  return wet;
}

/**
 * Side-chain style "pump": dips the bus at the start of every `periodSamples` and lets it swell
 * back. Periodic by construction when the loop is a whole number of periods.
 */
export function pump(bus: Bus, periodSamples: number, depth: number, recovery = 0.45): Bus {
  for (let i = 0; i < bus.length; i += 1) {
    const phase = (i % periodSamples) / periodSamples;
    const gain = 1 - depth * Math.exp(-phase / (recovery * 0.35)) * (1 - Math.exp(-phase * 400));
    bus.left[i] = (bus.left[i] as number) * gain;
    bus.right[i] = (bus.right[i] as number) * gain;
  }
  return bus;
}

/** Slow periodic volume swell (whole number of cycles per loop). */
export function swell(bus: Bus, cycles: number, depth: number, phase = 0): Bus {
  for (let i = 0; i < bus.length; i += 1) {
    const gain = 1 - depth * (0.5 + 0.5 * Math.cos(TAU * ((cycles * i) / bus.length + phase)));
    bus.left[i] = (bus.left[i] as number) * gain;
    bus.right[i] = (bus.right[i] as number) * gain;
  }
  return bus;
}

/* ---------- mastering ---------- */

// ITU-R BS.1770 K-weighting at 48 kHz.
const K_SHELF: BiquadCoeffs = {
  b0: 1.53512485958697,
  b1: -2.69169618940638,
  b2: 1.19839281085285,
  a1: -1.69065929318241,
  a2: 0.73248077421585,
};
const K_HIGHPASS: BiquadCoeffs = {
  b0: 1,
  b1: -2,
  b2: 1,
  a1: -1.99004745483398,
  a2: 0.99007225036621,
};

function meanSquareK(data: Float32Array): number {
  const copy = Float32Array.from(data);
  filterChannelPeriodic(copy, K_SHELF);
  filterChannelPeriodic(copy, K_HIGHPASS);
  let sum = 0;
  for (let i = 0; i < copy.length; i += 1) sum += (copy[i] as number) ** 2;
  return sum / copy.length;
}

/** Integrated loudness (ungated BS.1770) of a loop in LUFS. */
export function loudnessLufs(bus: Bus): number {
  return -0.691 + 10 * Math.log10(meanSquareK(bus.left) + meanSquareK(bus.right) + 1e-12);
}

export interface MasterOptions {
  /** Target integrated loudness. */
  lufs: number;
  /** Absolute sample ceiling (linear). */
  ceiling?: number;
  /** Optional overall low-pass (lo-fi warmth). */
  lowpass?: number;
}

/**
 * Final chain, in place: sub-sonic high-pass, a gentle dip around the speech presence band (so
 * the bed stays out of the way of a voice), loudness normalisation and a memoryless soft
 * limiter. Every stage keeps the loop periodic.
 */
export function master(bus: Bus, opts: MasterOptions): Bus {
  filterBus(bus, biquad('highpass', 32, 0.707));
  filterBus(bus, biquad('peaking', 2600, 0.8, -3));
  if (opts.lowpass) filterBus(bus, biquad('lowpass', opts.lowpass, 0.707));
  const ceiling = opts.ceiling ?? 0.89;
  const knee = ceiling * 0.7;
  for (let round = 0; round < 3; round += 1) {
    bus.scale(dbToGain(opts.lufs - loudnessLufs(bus)));
    if (bus.peak() <= ceiling) break;
    const span = ceiling - knee;
    for (const data of [bus.left, bus.right]) {
      for (let i = 0; i < data.length; i += 1) {
        const x = data[i] as number;
        const mag = Math.abs(x);
        if (mag > knee) data[i] = Math.sign(x) * (knee + span * Math.tanh((mag - knee) / span));
      }
    }
  }
  return bus;
}

/** Interleaved little-endian float32 PCM (what ffmpeg reads as `-f f32le -ac 2`). */
export function toInterleavedF32(bus: Bus): Buffer {
  const out = Buffer.allocUnsafe(bus.length * 8);
  for (let i = 0; i < bus.length; i += 1) {
    out.writeFloatLE(bus.left[i] as number, i * 8);
    out.writeFloatLE(bus.right[i] as number, i * 8 + 4);
  }
  return out;
}
