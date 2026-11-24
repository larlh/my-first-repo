import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  VOICE_INSTALL_MARKER,
  readVoiceMarker,
  voiceFilePath,
  voiceFileUrl,
  voiceSourceFolder,
} from './neural-models';
import type { VoiceInstallMarker, VoiceModelFile, VoiceModelSource } from './neural-models';

/* -------------------------------------------------------------------------------------------
 * Installer of the local neural voices (used by `pnpm voices:setup`).
 *
 *  - downloads each file from its pinned revision to `<file>.part`
 *  - checks size and SHA-256 BEFORE the file takes its final name (a file that does not match
 *    is deleted and the install fails: nothing unverified is ever left in place)
 *  - records every verified file in the folder's marker, which is what "installed" means; the
 *    marker is rewritten atomically after each file, so an interrupted install resumes
 *  - idempotent: a file the marker already vouches for is not touched; a file that is on disk
 *    without being in the marker is hashed instead of downloaded again
 *
 * Plain Node (fetch, streams, crypto): the same code runs on Windows, macOS and Linux.
 * ----------------------------------------------------------------------------------------- */

export type VoiceFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface VoiceInstallProgress {
  file: string;
  receivedBytes: number;
  totalBytes: number;
  /** `download` while bytes arrive, `verify` while an existing file is hashed, `done` once. */
  phase: 'download' | 'verify' | 'done';
  /** True when the file was already on disk. */
  reused: boolean;
}

export interface VoiceInstallOptions {
  modelsDir: string;
  source: VoiceModelSource;
  files: readonly VoiceModelFile[];
  fetch?: VoiceFetch;
  onProgress?: (progress: VoiceInstallProgress) => void;
  /** Download and verify everything again. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface VoiceInstallResult {
  dir: string;
  /** False when every file was already installed and nothing had to be done. */
  changed: boolean;
  downloadedBytes: number;
  files: { path: string; reused: boolean }[];
}

export class VoiceIntegrityError extends Error {
  constructor(
    readonly file: string,
    readonly problem: 'size' | 'sha256',
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${file}: ${problem} mismatch (expected ${expected}, got ${actual}). The file was discarded.`,
    );
    this.name = 'VoiceIntegrityError';
  }
}

async function sha256OfFile(
  file: string,
  onBytes?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  let seen = 0;
  for await (const chunk of createReadStream(file, { signal })) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    seen += bytes.length;
    onBytes?.(seen);
  }
  return hash.digest('hex');
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return -1;
  }
}

async function downloadVerified(
  url: string,
  target: string,
  file: VoiceModelFile,
  options: { fetch: VoiceFetch } & Pick<VoiceInstallOptions, 'onProgress' | 'signal'>,
): Promise<void> {
  const part = `${target}.part`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(part, { force: true });
  const response = await options.fetch(url, options.signal ? { signal: options.signal } : {});
  if (!response.ok || !response.body) {
    throw new Error(`${file.path}: download failed with HTTP ${response.status} (${url})`);
  }
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      // Stop as soon as the server sends more than the catalogue says the file holds.
      if (received > file.sizeBytes) {
        done(
          new VoiceIntegrityError(file.path, 'size', String(file.sizeBytes), `> ${file.sizeBytes}`),
        );
        return;
      }
      hash.update(chunk);
      options.onProgress?.({
        file: file.path,
        receivedBytes: received,
        totalBytes: file.sizeBytes,
        phase: 'download',
        reused: false,
      });
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(part, { flags: 'w', mode: 0o644 }),
      options.signal ? { signal: options.signal } : {},
    );
    if (received !== file.sizeBytes) {
      throw new VoiceIntegrityError(file.path, 'size', String(file.sizeBytes), String(received));
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      throw new VoiceIntegrityError(file.path, 'sha256', file.sha256, digest);
    }
    await fs.rename(part, target);
  } catch (err) {
    await fs.rm(part, { force: true });
    throw err;
  }
}

async function writeMarker(dir: string, marker: VoiceInstallMarker): Promise<void> {
  const file = path.join(dir, VOICE_INSTALL_MARKER);
  await fs.writeFile(`${file}.part`, `${JSON.stringify(marker, null, 2)}\n`);
  await fs.rename(`${file}.part`, file);
}

/** Install (or verify) files of one repository. Throws when one cannot be fetched or fails. */
export async function installVoiceFiles(options: VoiceInstallOptions): Promise<VoiceInstallResult> {
  const { modelsDir, source } = options;
  const fetchImpl: VoiceFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const dir = path.join(modelsDir, voiceSourceFolder(source));
  const marker = readVoiceMarker(modelsDir, source);
  // The same file can be asked for twice (every Kokoro voice needs the model).
  const files = [...new Map(options.files.map((file) => [file.path, file])).values()];

  let downloadedBytes = 0;
  let changed = false;
  const done: VoiceInstallResult['files'] = [];
  await fs.mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = voiceFilePath(modelsDir, source, file);
    const onDisk = (await sizeOf(target)) === file.sizeBytes;
    if (!options.force && onDisk && marker.files[file.path] === file.sha256) {
      done.push({ path: file.path, reused: true });
      continue;
    }
    changed = true;
    // From here on the file does not count as installed until it passes again.
    if (marker.files[file.path] !== undefined) {
      delete marker.files[file.path];
      await writeMarker(dir, marker);
    }
    let reused = false;
    if (!options.force && onDisk) {
      const digest = await sha256OfFile(
        target,
        (seen) =>
          options.onProgress?.({
            file: file.path,
            receivedBytes: seen,
            totalBytes: file.sizeBytes,
            phase: 'verify',
            reused: true,
          }),
        options.signal,
      );
      reused = digest === file.sha256;
    }
    if (!reused) {
      await fs.rm(target, { force: true });
      await downloadVerified(voiceFileUrl(source, file), target, file, {
        fetch: fetchImpl,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      downloadedBytes += file.sizeBytes;
    }
    marker.files[file.path] = file.sha256;
    await writeMarker(dir, marker);
    done.push({ path: file.path, reused });
    options.onProgress?.({
      file: file.path,
      receivedBytes: file.sizeBytes,
      totalBytes: file.sizeBytes,
      phase: 'done',
      reused,
    });
  }
  return { dir, changed, downloadedBytes, files: done };
}

/** Remove files of one repository (and forget them in the marker). Missing files are fine. */
export async function removeVoiceFiles(
  modelsDir: string,
  source: VoiceModelSource,
  files: readonly VoiceModelFile[],
): Promise<void> {
  const dir = path.join(modelsDir, voiceSourceFolder(source));
  const marker = readVoiceMarker(modelsDir, source);
  for (const file of files) {
    delete marker.files[file.path];
    await fs.rm(voiceFilePath(modelsDir, source, file), { force: true });
  }
  try {
    await fs.access(dir);
    await writeMarker(dir, marker);
  } catch {
    // Nothing was ever installed there.
  }
}
