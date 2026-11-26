import { AppError } from '@parlante/shared';
import { loadNodeImage } from '@parlante/renderer/node';
import { ffprobe, parseFfmpegTime, runFfmpeg } from '../../lib/ffmpeg';
import type { MediaInfo } from '../../lib/ffmpeg';
import type { TempDir } from '../../lib/tmp';
import { DUB_SAMPLE_RATE } from './dub';

/* -------------------------------------------------------------------------------------------
 * ffmpeg side of a translation: inspecting the source, extracting its audio for the STT
 * provider and producing the dubbed MP4. Every command is an ARGUMENT ARRAY and every path is
 * server-generated (temp dir / storage); numbers that go into filters are formatted here from
 * validated numeric options, never from text.
 * ----------------------------------------------------------------------------------------- */

/** Burned-in subtitles re-encode the picture anyway: larger sources are scaled down to this. */
export const MAX_BURN_SIDE = 1920;
/** Peak ceiling of the final mix. */
const LIMITER = 'alimiter=limit=0.95:level=disabled';
/**
 * The mono dub on both channels at its full level (a plain mono → stereo conversion would
 * lower it by 3 dB).
 */
const DUB_TO_STEREO = 'pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp';

export interface SourceVideo {
  path: string;
  info: MediaInfo;
  durationMs: number;
  /** Size of the picture AS DISPLAYED (rotation applied), even numbers. */
  width: number;
  height: number;
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** MP4 stores the language of a track as ISO 639-2; ours are ISO 639-1. */
const ISO_639_2: Readonly<Record<string, string>> = {
  es: 'spa',
  en: 'eng',
  fr: 'fra',
  de: 'deu',
  it: 'ita',
  pt: 'por',
  ca: 'cat',
  nl: 'nld',
  pl: 'pol',
  sv: 'swe',
  tr: 'tur',
  ru: 'rus',
  el: 'ell',
};

/**
 * Inspect the source and decode its first frame (which also yields the displayed size:
 * phone videos carry a rotation that ffprobe's coded width / height do not show).
 */
export async function inspectSource(
  sourcePath: string,
  tmp: TempDir,
  signal?: AbortSignal,
): Promise<SourceVideo> {
  const info = await ffprobe(sourcePath, { signal });
  if (!info.hasVideo) {
    throw new AppError('UNPROCESSABLE', 'The file to translate has no video stream');
  }
  if (!info.durationMs || info.durationMs < 200) {
    throw new AppError('UNPROCESSABLE', 'The length of this video could not be read');
  }
  try {
    await runFfmpeg(
      ['-v', 'error', '-i', sourcePath, '-map', '0:v:0', '-frames:v', '1', tmp.file('first.png')],
      { signal, timeoutMs: 60_000 },
    );
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new AppError('UNPROCESSABLE', 'The video could not be decoded', undefined, {
      cause: err,
    });
  }
  const frame = await loadNodeImage(tmp.file('first.png'));
  return {
    path: sourcePath,
    info,
    durationMs: info.durationMs,
    width: even(frame.width),
    height: even(frame.height),
  };
}

/** Audio of the source as the STT contract wants it: WAV PCM 16-bit mono 16 kHz. */
export async function extractSpeechAudio(
  source: SourceVideo,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg(
    [
      '-v',
      'error',
      '-i',
      source.path,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outputPath,
    ],
    { signal, timeoutMs: 30 * 60_000 },
  );
}

/** Size of the output picture when subtitles are burned in (long side ≤ MAX_BURN_SIDE). */
export function burnFrameSize(source: Pick<SourceVideo, 'width' | 'height'>): {
  width: number;
  height: number;
} {
  const factor = Math.min(1, MAX_BURN_SIDE / Math.max(source.width, source.height));
  return { width: even(source.width * factor), height: even(source.height * factor) };
}

export interface MixOptions {
  source: SourceVideo;
  /** Raw dub track: s16le mono `DUB_SAMPLE_RATE`. */
  dubPath: string;
  outputPath: string;
  /** 0 = replace the original voice; otherwise its volume under the dub. */
  originalAudioVolume: number;
  /** Concat script of the subtitle pictures and the size they were painted at, or null. */
  overlay: { scriptPath: string; width: number; height: number } | null;
  /** ISO 639-1 code of the dub (stored on the audio track as ISO 639-2). */
  language: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** True when the picture can be copied untouched into the MP4. */
export function canCopyVideo(options: Pick<MixOptions, 'source' | 'overlay'>): boolean {
  return options.overlay === null && options.source.info.videoCodec === 'h264';
}

/** The complete ffmpeg argument list of the final mix (exported for tests). */
export function mixArguments(options: MixOptions): string[] {
  const { source, overlay } = options;
  const totalSec = (source.durationMs / 1000).toFixed(3);
  const volume = Math.min(1, Math.max(0, options.originalAudioVolume));
  const keepOriginal = source.info.hasAudio && volume > 0;

  const args = ['-i', source.path];
  args.push('-f', 's16le', '-ar', String(DUB_SAMPLE_RATE), '-ac', '1', '-i', options.dubPath);
  if (overlay) args.push('-f', 'concat', '-safe', '0', '-i', overlay.scriptPath);

  const graph: string[] = [];
  graph.push(
    keepOriginal
      ? `[0:a:0]aresample=${DUB_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${volume.toFixed(3)}[orig];` +
          `[1:a:0]${DUB_TO_STEREO}[dub];` +
          `[orig][dub]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,${LIMITER}[a]`
      : `[1:a:0]${DUB_TO_STEREO},${LIMITER}[a]`,
  );
  const copy = canCopyVideo(options);
  if (overlay) {
    graph.push(
      `[0:v:0]scale=${overlay.width}:${overlay.height},setsar=1[base];` +
        `[2:v:0]format=rgba[sub];` +
        `[base][sub]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[v]`,
    );
  } else if (!copy) {
    graph.push(`[0:v:0]scale=${source.width}:${source.height},setsar=1,format=yuv420p[v]`);
  }
  args.push('-filter_complex', graph.join(';'));
  args.push('-map', copy ? '0:v:0' : '[v]', '-map', '[a]');
  if (copy) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', String(DUB_SAMPLE_RATE), '-ac', '2');
  args.push(
    '-t',
    totalSec,
    '-map_metadata',
    '-1',
    '-metadata:s:a:0',
    `language=${ISO_639_2[options.language] ?? 'und'}`,
    '-metadata',
    'comment=Dubbed with a synthetic voice by Parlante',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    options.outputPath,
  );
  return args;
}

/** Produce the dubbed MP4 (H.264 + AAC, faststart). */
export async function mixDubbedVideo(options: MixOptions): Promise<void> {
  const totalMs = options.source.durationMs;
  await runFfmpeg(mixArguments(options), {
    signal: options.signal,
    timeoutMs: Math.max(10 * 60_000, totalMs * 20),
    onStderrLine: (line) => {
      const at = parseFfmpegTime(line);
      if (at !== null) options.onProgress?.(Math.min(1, at / totalMs));
    },
  });
}
