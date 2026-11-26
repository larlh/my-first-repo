import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { ImageData, createCanvas } from '@napi-rs/canvas';
import type { Canvas } from '@napi-rs/canvas';
import type { PhotoLandmarks } from '@parlante/shared';
import { ffmpegPath, ffprobe } from '@parlante/shared/node';
import type { AvatarClipSource, RenderImage, VideoFrameSource } from '../types';

/* -------------------------------------------------------------------------------------------
 * Video frames for the Node renderer.
 *
 *  - `createRawVideoSource`  wraps RGBA frames somebody else decoded (any decoder, tests)
 *  - `openVideoSource`       decodes a file with ffmpeg ON DEMAND, a small window at a time:
 *                            60 s of 720p RGBA is several GB, so nothing is decoded up front
 *
 * `renderFrame` asks its sources synchronously (`frameAt`). A file-backed source therefore has
 * an async `prepare(timeMs)` that must be awaited first; `createFrameRenderer` (./frames) does
 * it for every video a frame needs, using the renderer's own media clock.
 * ----------------------------------------------------------------------------------------- */

/** A video source that must be told what it will be asked for before a frame is drawn. */
export interface PreparableVideoSource extends VideoFrameSource {
  /** Make `frameAt(timeMs)` answer synchronously. Resolves when that frame is decoded. */
  prepare(timeMs: number): Promise<void>;
  /** Stop decoding and free memory. Idempotent. */
  close(): Promise<void>;
}

export function isPreparable(source: VideoFrameSource | null): source is PreparableVideoSource {
  return (
    source !== null && typeof (source as Partial<PreparableVideoSource>).prepare === 'function'
  );
}

/** Turns raw RGBA frames into drawable images, reusing a couple of canvases. */
class FramePainter {
  private readonly slots: { canvas: Canvas; index: number }[] = [];
  private next = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly slotCount: number,
  ) {}

  /** Image for frame `index`; `read` supplies its pixels when it is not on a canvas yet. */
  image(index: number, read: () => Uint8Array | null): RenderImage | null {
    for (const slot of this.slots) {
      if (slot.index === index) return this.wrap(slot.canvas);
    }
    const pixels = read();
    if (!pixels || pixels.length < this.width * this.height * 4) return null;
    let slot = this.slots.length < this.slotCount ? undefined : this.slots[this.next];
    if (!slot) {
      slot = { canvas: createCanvas(this.width, this.height), index: -1 };
      this.slots.push(slot);
    } else {
      this.next = (this.next + 1) % this.slotCount;
    }
    const data = new ImageData(
      new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, this.width * this.height * 4),
      this.width,
      this.height,
    );
    slot.canvas.getContext('2d').putImageData(data, 0, 0);
    slot.index = index;
    return this.wrap(slot.canvas);
  }

  private wrap(canvas: Canvas): RenderImage {
    return {
      source: canvas as unknown as CanvasImageSource,
      width: this.width,
      height: this.height,
    };
  }
}

function frameIndexAt(timeMs: number, fps: number, frameCount: number): number {
  const index = Math.floor((Math.max(0, timeMs) * fps) / 1000 + 1e-6);
  return Math.max(0, Math.min(index, frameCount - 1));
}

export interface RawVideoSourceOptions {
  /** Size of the frames `readFrame` returns. */
  width: number;
  height: number;
  /** Frames per second of the decoded sequence. */
  fps: number;
  frameCount: number;
  /** Defaults to `frameCount / fps`. */
  durationMs?: number;
  /**
   * RGBA pixels (straight alpha, `width × height × 4` bytes) of frame `index`, or null when
   * it is not available (the renderer then draws its placeholder). Called synchronously.
   */
  readFrame(index: number): Uint8Array | null;
}

/** VideoFrameSource over frames that are already decoded (or cheap to produce on the spot). */
export function createRawVideoSource(options: RawVideoSourceOptions): VideoFrameSource {
  const { width, height, fps } = options;
  const frameCount = Math.max(1, Math.floor(options.frameCount));
  const painter = new FramePainter(width, height, 2);
  return {
    durationMs: options.durationMs ?? (frameCount * 1000) / fps,
    width,
    height,
    frameAt(timeMs) {
      const index = frameIndexAt(timeMs, fps, frameCount);
      return painter.image(index, () => options.readFrame(index));
    },
  };
}

/* ---------- ffmpeg-backed source ---------- */

export interface OpenVideoOptions {
  /** Server-generated local path of the video (never user input). */
  path: string;
  /**
   * Greyscale matte merged in as the alpha channel (white = opaque): a video with the same
   * timing, or a still image applied to every frame. For neural avatar clips.
   */
  mattePath?: string | null;
  /** Sampling rate of the decoded frames. Default 30 (the composition frame rate). */
  fps?: number;
  /** Decode no larger than this box (aspect kept, never enlarged). Default: source size. */
  maxWidth?: number;
  maxHeight?: number;
  /** Decoded frames kept ahead of the playhead (default 4). */
  readAhead?: number;
  signal?: AbortSignal;
}

type Decoder = ChildProcessByStdio<null, Readable, Readable>;

/** Jumping further ahead than this restarts ffmpeg at the target instead of decoding up to it. */
const SEEK_AHEAD_FRAMES = 45;
const KEEP_BEHIND_FRAMES = 2;
const RECENT_FRAMES = 3;

class FfmpegVideoSource implements PreparableVideoSource {
  readonly durationMs: number;
  private frameCount: number;
  private readonly frameBytes: number;
  private readonly painter: FramePainter;
  /** Sliding window of decoded frames around the playhead. */
  private readonly window = new Map<number, Buffer>();
  /** Last few frames actually requested (a held frame survives the window moving on). */
  private readonly recent = new Map<number, Buffer>();
  private decoder: Decoder | null = null;
  /** Index the running decoder will emit next. */
  private nextIndex = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private playhead = 0;
  private ended = false;
  private closed = false;
  private stderrTail = '';
  private waiters: { index: number; resolve: () => void; reject: (err: Error) => void }[] = [];

  constructor(
    private readonly options: OpenVideoOptions,
    readonly width: number,
    readonly height: number,
    private readonly fps: number,
    durationMs: number,
    private readonly matteIsVideo: boolean,
  ) {
    this.durationMs = durationMs;
    this.frameCount = Math.max(1, Math.round((durationMs * fps) / 1000));
    this.frameBytes = width * height * 4;
    this.painter = new FramePainter(width, height, 2);
    options.signal?.addEventListener('abort', () => void this.close(), { once: true });
  }

  frameAt(timeMs: number): RenderImage | null {
    const index = frameIndexAt(timeMs, this.fps, this.frameCount);
    return this.painter.image(
      index,
      () => this.window.get(index) ?? this.recent.get(index) ?? null,
    );
  }

  async prepare(timeMs: number): Promise<void> {
    await this.prepareIndex(frameIndexAt(timeMs, this.fps, this.frameCount), true);
  }

  private async prepareIndex(index: number, retry: boolean): Promise<void> {
    if (this.closed) throw new Error('Video source is closed');
    const held = this.window.get(index) ?? this.recent.get(index);
    if (held) {
      this.remember(index, held);
      // A held frame of another instant (frozen scene) must not drag the window back.
      if (this.window.has(index)) this.advance(index);
      return;
    }
    const reachable =
      this.decoder !== null &&
      index >= this.nextIndex &&
      index - this.nextIndex <= SEEK_AHEAD_FRAMES;
    if (!reachable) this.restart(index);
    this.advance(index);
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ index, resolve, reject });
      this.pump();
    });
    const frame = this.window.get(index);
    if (frame) {
      this.remember(index, frame);
      return;
    }
    // The stream ended before `index` (container durations are approximate): `frameCount`
    // now holds the real length, and the last real frame is held from here on.
    const last = this.frameCount - 1;
    if (retry && last < index) await this.prepareIndex(last, false);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    this.window.clear();
    this.recent.clear();
    this.settle(new Error('Video source is closed'));
  }

  private remember(index: number, frame: Buffer): void {
    this.recent.delete(index);
    this.recent.set(index, frame);
    while (this.recent.size > RECENT_FRAMES) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  /** Move the playhead: drop frames behind it and let the decoder read ahead again. */
  private advance(index: number): void {
    this.playhead = index;
    for (const key of this.window.keys()) {
      // The newest decoded frame always stays: it is the one held past the end of the stream.
      if (key < index - KEEP_BEHIND_FRAMES && key !== this.nextIndex - 1) this.window.delete(key);
    }
    this.pump();
  }

  private pump(): void {
    const decoder = this.decoder;
    if (!decoder) return;
    const ahead = this.options.readAhead ?? 4;
    const wanted = Math.max(this.playhead, ...this.waiters.map((w) => w.index)) + ahead;
    if (this.nextIndex <= wanted) decoder.stdout.resume();
    else decoder.stdout.pause();
  }

  private stop(): void {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) {
      decoder.stdout.removeAllListeners();
      decoder.removeAllListeners();
      decoder.on('error', () => undefined);
      decoder.kill('SIGKILL');
    }
    this.pending = [];
    this.pendingBytes = 0;
  }

  private restart(index: number): void {
    this.stop();
    this.window.clear();
    this.ended = false;
    this.nextIndex = index;
    const startSec = (index / this.fps).toFixed(6);
    const size = `${this.width}:${this.height}`;
    const args = [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-ss',
      startSec,
      '-i',
      this.options.path,
    ];
    const matte = this.options.mattePath;
    if (matte) {
      if (this.matteIsVideo) args.push('-ss', startSec, '-i', matte);
      else args.push('-loop', '1', '-i', matte);
      args.push(
        '-filter_complex',
        `[0:v]fps=${this.fps},scale=${size}:flags=bilinear,format=rgba[v];` +
          `[1:v]fps=${this.fps},scale=${size}:flags=bilinear,format=gray[m];` +
          `[v][m]alphamerge=shortest=1,format=rgba[out]`,
        '-map',
        '[out]',
      );
    } else {
      args.push('-vf', `fps=${this.fps},scale=${size}:flags=bilinear,format=rgba`, '-map', '0:v:0');
    }
    args.push('-an', '-sn', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
    const decoder = spawn(ffmpegPath(), args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.decoder = decoder;
    this.stderrTail = '';
    decoder.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    decoder.stdout.on('data', (chunk: Buffer) => {
      if (this.decoder !== decoder) return;
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
      while (this.pendingBytes >= this.frameBytes) this.takeFrame();
      this.pump();
    });
    decoder.on('error', (err) => {
      if (this.decoder !== decoder) return;
      this.decoder = null;
      this.settle(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('ffmpeg is not installed or not on PATH')
          : err,
      );
    });
    decoder.on('close', (code) => {
      if (this.decoder !== decoder) return;
      this.decoder = null;
      this.ended = true;
      const decoded = this.nextIndex;
      if (code !== 0 && decoded === index) {
        this.settle(new Error(`ffmpeg could not decode the video: ${this.stderrTail.trim()}`));
        return;
      }
      // End of stream: the real length is known now; later frames hold the last one.
      if (decoded > 0 && decoded < this.frameCount) this.frameCount = decoded;
      this.resolveWaiters();
    });
  }

  private takeFrame(): void {
    const frame = Buffer.allocUnsafe(this.frameBytes);
    let filled = 0;
    while (filled < this.frameBytes) {
      const head = this.pending[0];
      if (!head) break;
      const take = Math.min(head.length, this.frameBytes - filled);
      head.copy(frame, filled, 0, take);
      filled += take;
      if (take === head.length) this.pending.shift();
      else this.pending[0] = head.subarray(take);
    }
    this.pendingBytes -= this.frameBytes;
    this.window.set(this.nextIndex, frame);
    this.nextIndex += 1;
    this.resolveWaiters();
  }

  private resolveWaiters(): void {
    this.waiters = this.waiters.filter((waiter) => {
      // At the end of the stream every waiter is released; `prepareIndex` then falls back
      // to the last real frame.
      if (this.window.has(waiter.index) || this.ended) {
        waiter.resolve();
        return false;
      }
      return true;
    });
  }

  private settle(error: Error): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
}

/**
 * Open a video file as a frame source decoded on demand by ffmpeg. Call `prepare(t)` (or let
 * `createFrameRenderer` do it) before the renderer asks for `frameAt(t)`, and `close()` when
 * done. Sequential access is the fast path (one ffmpeg process streams frames); jumping
 * backwards or far ahead — a loop wrapping around, a scrub — restarts it at the new position.
 */
export async function openVideoSource(options: OpenVideoOptions): Promise<PreparableVideoSource> {
  const info = await ffprobe(options.path, { signal: options.signal });
  if (!info.hasVideo || !info.width || !info.height) {
    throw new Error('The file has no video stream');
  }
  let matteIsVideo = false;
  if (options.mattePath) {
    const matte = await ffprobe(options.mattePath, { signal: options.signal });
    matteIsVideo =
      matte.hasVideo && (matte.durationMs ?? 0) > 0 && !/image2|_pipe/.test(matte.formatName);
  }
  const fps = options.fps ?? 30;
  const scale = Math.min(
    1,
    (options.maxWidth ?? Infinity) / info.width,
    (options.maxHeight ?? Infinity) / info.height,
  );
  // Even dimensions keep every ffmpeg scaler / pixel format happy.
  const width = Math.max(2, Math.round((info.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((info.height * scale) / 2) * 2);
  const durationMs = info.durationMs && info.durationMs > 0 ? info.durationMs : 1000 / fps;
  return new FfmpegVideoSource(options, width, height, fps, durationMs, matteIsVideo);
}

/**
 * Open a neural avatar clip (video + matte from the engine) as an `AvatarClipSource` whose
 * frames carry alpha. `originMs: 0` when the clip covers the whole scene (what the render job
 * produces); pass the avatar's `landmarks` so `photoAvatarPlacement` honours the framing.
 */
export async function openAvatarClipSource(
  options: OpenVideoOptions & { originMs?: number; landmarks?: PhotoLandmarks },
): Promise<AvatarClipSource & PreparableVideoSource> {
  const source = await openVideoSource(options);
  return {
    get durationMs() {
      return source.durationMs;
    },
    width: source.width,
    height: source.height,
    originMs: options.originMs,
    landmarks: options.landmarks,
    frameAt: (timeMs) => source.frameAt(timeMs),
    prepare: (timeMs) => source.prepare(timeMs),
    close: () => source.close(),
  };
}
