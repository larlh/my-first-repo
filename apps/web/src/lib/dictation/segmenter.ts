import { rms } from './pcm';

/* Cuts a stream of speech into phrases by silence detection, so each phrase can be sent to
 * the transcriber on its own. Pure and synchronous: feed it mono samples, get phrases back. */

export interface SegmenterOptions {
  sampleRate: number;
  /** Hard limit of one phrase (what `capabilities.dictation.maxSegmentMs` announces). */
  maxSegmentMs: number;
  /** A pause this long closes the phrase. */
  silenceMs?: number;
  /** From this length on, a shorter pause (`shortSilenceMs`) is enough to close it. */
  softMaxMs?: number;
  shortSilenceMs?: number;
  /** Audio kept before the first speech frame, so the first consonant is not clipped. */
  preRollMs?: number;
  /** Audio kept after the last speech frame. */
  tailMs?: number;
  /** Phrases with less speech than this are dropped (clicks, key presses). */
  minSpeechMs?: number;
  /** Floor of the speech threshold (RMS, full scale = 1). */
  minThreshold?: number;
}

export type SegmentReason = 'pause' | 'max' | 'flush';

export interface SpeechSegment {
  samples: Float32Array;
  /** Position of the segment in the stream. */
  startMs: number;
  endMs: number;
  reason: SegmentReason;
}

const FRAME_MS = 20;
/** Safety margin under the hard limit: the server measures the real length. */
const HARD_MARGIN_MS = 1000;
/** Consecutive speech frames that open a phrase. */
const ONSET_FRAMES = 2;
/** Frames (3 s) over which the noise floor is measured. */
const NOISE_WINDOW_FRAMES = 150;

export class PhraseSegmenter {
  private readonly sampleRate: number;
  private readonly frameSize: number;
  private readonly silenceFrames: number;
  private readonly shortSilenceFrames: number;
  private readonly softMaxFrames: number;
  private readonly hardMaxFrames: number;
  private readonly preRollFrames: number;
  private readonly tailFrames: number;
  private readonly minSpeechFrames: number;
  private readonly minThreshold: number;

  /** Samples that do not fill a frame yet. */
  private carry = new Float32Array(0);
  /** Last frames while idle (pre-roll). */
  private ring: Float32Array[] = [];
  /** Frames of the phrase being recorded. */
  private frames: Float32Array[] = [];
  private inSpeech = false;
  private onset = 0;
  private speechFrames = 0;
  private silentRun = 0;
  private readonly recent = new Float32Array(NOISE_WINDOW_FRAMES);
  private frameIndex = 0;
  private segmentStartFrame = 0;

  constructor(options: SegmenterOptions) {
    const toFrames = (ms: number) => Math.max(1, Math.round(ms / FRAME_MS));
    this.sampleRate = options.sampleRate;
    this.frameSize = Math.round((options.sampleRate * FRAME_MS) / 1000);
    const hardMs = Math.max(2000, options.maxSegmentMs - HARD_MARGIN_MS);
    this.hardMaxFrames = toFrames(hardMs);
    this.softMaxFrames = Math.min(toFrames(options.softMaxMs ?? 12_000), this.hardMaxFrames);
    this.silenceFrames = toFrames(options.silenceMs ?? 700);
    this.shortSilenceFrames = toFrames(options.shortSilenceMs ?? 300);
    this.preRollFrames = toFrames(options.preRollMs ?? 300);
    this.tailFrames = toFrames(options.tailMs ?? 200);
    this.minSpeechFrames = toFrames(options.minSpeechMs ?? 160);
    this.minThreshold = options.minThreshold ?? 0.004;
  }

  /** True while a phrase is being recorded. */
  get speaking(): boolean {
    return this.inSpeech;
  }

  /** Feed samples; returns the phrases that ended inside this block (usually none or one). */
  push(samples: Float32Array): SpeechSegment[] {
    const out: SpeechSegment[] = [];
    let data = samples;
    if (this.carry.length > 0) {
      data = new Float32Array(this.carry.length + samples.length);
      data.set(this.carry);
      data.set(samples, this.carry.length);
    }
    let offset = 0;
    while (data.length - offset >= this.frameSize) {
      const frame = data.slice(offset, offset + this.frameSize);
      offset += this.frameSize;
      const segment = this.pushFrame(frame);
      if (segment) out.push(segment);
    }
    this.carry = data.slice(offset);
    return out;
  }

  /** The stream ended: returns the phrase in progress, if it holds enough speech. */
  flush(): SpeechSegment | null {
    if (!this.inSpeech) {
      this.reset();
      return null;
    }
    if (this.carry.length > 0) this.frames.push(this.carry);
    const segment = this.close('flush', this.silentRun);
    this.reset();
    return segment;
  }

  private reset(): void {
    this.carry = new Float32Array(0);
    this.ring = [];
    this.frames = [];
    this.inSpeech = false;
    this.onset = 0;
    this.speechFrames = 0;
    this.silentRun = 0;
  }

  private pushFrame(frame: Float32Array): SpeechSegment | null {
    this.frameIndex += 1;
    const energy = rms(frame);
    // Noise floor = the quietest frame of the last few seconds. Speech always dips to the
    // level of the room between syllables, so the floor follows the room whether or not
    // somebody is talking — and steady noise (a fan) stops counting as speech by itself.
    this.recent[(this.frameIndex - 1) % NOISE_WINDOW_FRAMES] = energy;
    let floor = Infinity;
    const known = Math.min(this.frameIndex, NOISE_WINDOW_FRAMES);
    for (let i = 0; i < known; i += 1) {
      const value = this.recent[i] ?? 0;
      if (value < floor) floor = value;
    }
    const threshold = this.inSpeech
      ? Math.max(this.minThreshold * 0.7, floor * 2.5)
      : Math.max(this.minThreshold, floor * 3.5);
    const speech = energy > threshold;

    if (!this.inSpeech) {
      this.ring.push(frame);
      if (this.ring.length > this.preRollFrames + ONSET_FRAMES) this.ring.shift();
      this.onset = speech ? this.onset + 1 : 0;
      if (this.onset >= ONSET_FRAMES) {
        this.inSpeech = true;
        this.frames = this.ring;
        this.ring = [];
        this.segmentStartFrame = this.frameIndex - this.frames.length;
        this.speechFrames = this.onset;
        this.silentRun = 0;
        this.onset = 0;
      }
      return null;
    }

    this.frames.push(frame);
    if (speech) {
      this.speechFrames += 1;
      this.silentRun = 0;
    } else {
      this.silentRun += 1;
    }

    const length = this.frames.length;
    const pause = length >= this.softMaxFrames ? this.shortSilenceFrames : this.silenceFrames;
    if (this.silentRun >= pause) {
      const segment = this.close('pause', this.silentRun);
      this.inSpeech = false;
      this.frames = [];
      this.speechFrames = 0;
      this.silentRun = 0;
      return segment;
    }
    if (length >= this.hardMaxFrames) {
      // Still talking at the limit: cut here and keep recording the same phrase.
      const segment = this.close('max', 0);
      this.frames = [];
      this.segmentStartFrame = this.frameIndex;
      this.speechFrames = 0;
      this.silentRun = 0;
      return segment;
    }
    return null;
  }

  /** Build the segment from `frames`, dropping trailing silence beyond the tail. */
  private close(reason: SegmentReason, trailingSilence: number): SpeechSegment | null {
    if (this.speechFrames < this.minSpeechFrames) return null;
    const drop = Math.max(0, trailingSilence - this.tailFrames);
    const kept = drop > 0 ? this.frames.slice(0, this.frames.length - drop) : this.frames;
    let total = 0;
    for (const frame of kept) total += frame.length;
    const samples = new Float32Array(total);
    let at = 0;
    for (const frame of kept) {
      samples.set(frame, at);
      at += frame.length;
    }
    const startMs = this.segmentStartFrame * FRAME_MS;
    return {
      samples,
      startMs,
      endMs: startMs + Math.round((total / this.sampleRate) * 1000),
      reason,
    };
  }
}
