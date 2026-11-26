/**
 * ffmpeg / ffprobe for jobs. The implementation lives in @parlante/shared/node so the API can
 * probe uploads with the same code. Always pass ARGUMENT ARRAYS; file paths must come from
 * `createTempDir().file(...)` or `storage.localPath(...)`, never from user input.
 */
export {
  ProcessError,
  ffmpegPath,
  ffprobe,
  ffprobePath,
  runFfmpeg,
  runProcess,
} from '@parlante/shared/node';
export type { MediaInfo, RunOptions, RunResult } from '@parlante/shared/node';

/**
 * Parse the position of an ffmpeg progress line (`… time=00:00:03.20 …`) in milliseconds.
 * Use with `onStderrLine` to turn encoder output into job progress. Returns null for other lines.
 */
export function parseFfmpegTime(line: string): number | null {
  const match = /time=(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(line);
  if (!match) return null;
  const [, h, m, s, frac] = match;
  const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + ms;
}
