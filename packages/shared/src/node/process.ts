import { spawn } from 'node:child_process';
import { AppError } from '../errors';

/* -------------------------------------------------------------------------------------------
 * Child-process helpers for ffmpeg / ffprobe. Commands are ALWAYS spawned with an argument
 * array and `shell: false`: never build a command line by concatenating strings, and never
 * pass user input as an option name. File paths given to ffmpeg must be server-generated.
 * ----------------------------------------------------------------------------------------- */

export interface RunOptions {
  cwd?: string;
  /** Kill the process after this long (default 10 min). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Data written to stdin (then closed). Use `stdinStream` to pipe frames incrementally. */
  input?: Uint8Array | string;
  /** Receive the child's stdin to write to it yourself (e.g. raw frames). Must call `.end()`. */
  onStdin?: (stdin: NodeJS.WritableStream) => void;
  /** Called for every stderr line (ffmpeg progress, warnings). */
  onStderrLine?: (line: string) => void;
  /** Max bytes of stdout kept in memory (default 32 MiB). */
  maxStdoutBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  /** Last ~8 kB of stderr. */
  stderrTail: string;
}

export class ProcessError extends Error {
  readonly command: string;
  readonly code: number | null;
  readonly stderrTail: string;

  constructor(command: string, code: number | null, stderrTail: string, reason?: string) {
    super(
      `${command} ${reason ?? `exited with code ${String(code)}`}: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`,
    );
    this.name = 'ProcessError';
    this.command = command;
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

/** Spawn `command` with `args` (no shell). Rejects with ProcessError on non-zero exit. */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const maxStdout = options.maxStdoutBytes ?? 32 * 1024 * 1024;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let pendingLine = '';
    let settled = false;
    let killedReason: string | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = (reason: string) => {
      killedReason = reason;
      child.kill('SIGKILL');
    };
    const onAbort = () => kill('was aborted');
    const timer = setTimeout(() => kill('timed out'), options.timeoutMs ?? 600_000);
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        kill('produced too much output');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-8192);
      if (options.onStderrLine) {
        const parts = (pendingLine + text).split(/\r\n|\n|\r/);
        pendingLine = parts.pop() ?? '';
        for (const line of parts) if (line !== '') options.onStderrLine(line);
      }
    });
    // Writing to a process that already exited must not crash the caller.
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      finish(() =>
        reject(
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? new AppError('SERVICE_UNAVAILABLE', `${command} is not installed or not on PATH`)
            : err,
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        if (killedReason || code !== 0) {
          reject(new ProcessError(command, code, stderrTail, killedReason));
        } else {
          resolve({ code: code ?? 0, stdout: Buffer.concat(stdout), stderrTail });
        }
      });
    });

    if (options.onStdin) options.onStdin(child.stdin);
    else if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}
export function ffprobePath(): string {
  return process.env.FFPROBE_PATH?.trim() || 'ffprobe';
}

/**
 * Run ffmpeg with the given argument array. `-hide_banner -nostdin -y` are prepended.
 *   await runFfmpeg(['-i', inputPath, '-c:v', 'libx264', outputPath]);
 */
export function runFfmpeg(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return runProcess(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], {
    ...options,
    onStdin: options.onStdin,
  });
}

export interface MediaInfo {
  formatName: string;
  durationMs: number | null;
  sizeBytes: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !Number.isFinite(num)) return null;
  const value = den && Number.isFinite(den) ? num / den : num;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Inspect a local media file with ffprobe. Throws AppError UNPROCESSABLE for unreadable files. */
export async function ffprobe(filePath: string, options: RunOptions = {}): Promise<MediaInfo> {
  let result: RunResult;
  try {
    result = await runProcess(
      ffprobePath(),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath],
      { timeoutMs: 30_000, ...options },
    );
  } catch (err) {
    if (err instanceof ProcessError) {
      throw new AppError('UNPROCESSABLE', 'The media file could not be read');
    }
    throw err;
  }
  const parsed = JSON.parse(result.stdout.toString('utf8')) as {
    format?: { format_name?: string; duration?: string; size?: string };
    streams?: ProbeStream[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    formatName: parsed.format?.format_name ?? '',
    durationMs:
      Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec * 1000) : null,
    sizeBytes: parsed.format?.size ? Number(parsed.format.size) : null,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ?? null,
  };
}
