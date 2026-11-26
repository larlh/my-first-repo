import { AUDIO_MIX } from '@parlante/shared';
import type { FrameRenderer } from '@parlante/renderer/node';
import { runFfmpeg } from '../../lib/ffmpeg';

/* -------------------------------------------------------------------------------------------
 * Stages `frames` + `encode`: every frame is drawn by the renderer's Node adapter and piped as
 * raw RGBA into ONE ffmpeg process that encodes H.264 (yuv420p) and muxes the soundtrack as
 * AAC into an MP4 with the index up front (`+faststart`).
 * ----------------------------------------------------------------------------------------- */

/**
 * x264 settings of every export, chosen by measurement on the 4-core build machine (240 frames
 * of the demo video at 720p, other builds running): `veryfast` encodes at ≈ 146 fps and gives
 * the SMALLEST file at CRF 20 (592 KB vs 1247 KB for `superfast`, 652 KB for `faster` at 114
 * fps); flat graphics and text stay clean. The renderer — which shares the cores with the
 * encoder — is the bottleneck of an export, not x264 (scripts/demo.ts prints the speed).
 */
export const VIDEO_ENCODING = { preset: 'veryfast', crf: 20, audioBitrate: '160k' } as const;

export interface EncodeArgsInput {
  width: number;
  height: number;
  fps: number;
  /** WAV with the whole soundtrack, exactly as long as the video. */
  soundtrackPath: string;
  outputPath: string;
  /** Container metadata (e.g. `AI_GENERATED_METADATA`). Keys and values are server constants. */
  metadata?: Readonly<Record<string, string>>;
}

/** ffmpeg arguments of the export, as an ARRAY (frames arrive on stdin). */
export function encodeArgs(input: EncodeArgsInput): string[] {
  const metadata = Object.entries(input.metadata ?? {});
  return [
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-video_size',
    `${input.width}x${input.height}`,
    '-framerate',
    String(input.fps),
    '-i',
    'pipe:0',
    '-i',
    input.soundtrackPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    // RGB → BT.709 limited range, tagged as such: what players assume for HD video.
    '-vf',
    'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    VIDEO_ENCODING.preset,
    '-crf',
    String(VIDEO_ENCODING.crf),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(input.fps * 2),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
    '-b:a',
    VIDEO_ENCODING.audioBitrate,
    '-ar',
    String(AUDIO_MIX.sampleRate),
    '-ac',
    String(AUDIO_MIX.channels),
    '-movflags',
    // Custom keys (`com.parlante.…`) are only written with `use_metadata_tags`.
    metadata.length > 0 ? '+faststart+use_metadata_tags' : '+faststart',
    ...metadata.flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
    '-f',
    'mp4',
    input.outputPath,
  ];
}

export interface EncodeInput extends Omit<EncodeArgsInput, 'width' | 'height' | 'fps'> {
  frames: FrameRenderer;
  signal: AbortSignal;
  /** Called after frame `done` of `total` has been handed to the encoder. */
  onFrame?(done: number, total: number): Promise<void> | void;
  /** Called once every frame is written, while ffmpeg finishes the file. */
  onFramesDone?(): Promise<void> | void;
}

export interface EncodeStats {
  frames: number;
  /** Wall-clock ms spent drawing and piping frames / until ffmpeg closed the file. */
  framesMs: number;
  totalMs: number;
}

/**
 * Draw every frame and encode the MP4. Frame buffers are recycled once ffmpeg has taken them,
 * and the pipe's back-pressure paces the renderer, so memory stays flat whatever the length.
 */
export async function encodeVideo(input: EncodeInput): Promise<EncodeStats> {
  const { frames } = input;
  const total = frames.totalFrames;
  const local = new AbortController();
  const signal = AbortSignal.any([input.signal, local.signal]);
  const startedAt = performance.now();

  // Mutated from callbacks: kept on an object so the compiler does not narrow them away.
  const state: { stdin: NodeJS.WritableStream | null; settled: boolean; failure: unknown } = {
    stdin: null,
    settled: false,
    failure: null,
  };
  const exited = runFfmpeg(
    encodeArgs({ ...input, width: frames.width, height: frames.height, fps: frames.fps }),
    {
      signal,
      // Generous: the renderer, not a timer, decides how long an export takes.
      timeoutMs: 1_800_000 + frames.timeline.totalMs * 20,
      onStdin: (stream) => {
        state.stdin = stream;
      },
    },
  ).then(
    () => {
      state.settled = true;
    },
    (err: unknown) => {
      state.settled = true;
      state.failure = err ?? new Error('ffmpeg failed');
    },
  );
  const pipe = state.stdin;
  if (!pipe) {
    await exited;
    throw state.failure ?? new Error('ffmpeg did not start');
  }

  const pool: Buffer[] = [];
  let framesMs: number;
  try {
    for (let index = 0; index < total && !state.settled; index += 1) {
      const buffer = pool.pop() ?? Buffer.allocUnsafe(frames.frameBytes);
      await frames.frame(index, buffer);
      if (state.settled) break;
      const flushed = pipe.write(buffer, () => {
        pool.push(buffer);
      });
      if (!flushed) {
        await Promise.race([
          new Promise<void>((resolve) => {
            pipe.once('drain', resolve);
          }),
          exited,
        ]);
      }
      await input.onFrame?.(index + 1, total);
    }
    framesMs = performance.now() - startedAt;
    pipe.end();
    if (!state.settled) await input.onFramesDone?.();
  } catch (err) {
    // Drawing failed (or a callback threw, e.g. a cancellation): stop the encoder first.
    local.abort();
    await exited;
    throw err;
  }
  await exited;
  if (state.failure) throw state.failure;
  return { frames: total, framesMs, totalMs: performance.now() - startedAt };
}
