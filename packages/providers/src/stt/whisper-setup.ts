import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  WHISPER_INSTALL_MARKER,
  inspectWhisperInstall,
  whisperFileUrl,
  whisperModelBytes,
  whisperModelFolder,
} from './whisper-models';
import type { WhisperInstallMarker, WhisperModelDef, WhisperModelFile } from './whisper-models';

/* -------------------------------------------------------------------------------------------
 * Installer of a local speech model (used by `pnpm dictation:setup`).
 *
 *  - downloads each file of the catalogue from its pinned revision to `<file>.part`
 *  - checks size and SHA-256 BEFORE the file takes its final name (a file that does not match
 *    is deleted and the install fails: nothing unverified is ever left in place)
 *  - writes the marker last, so an interrupted install is never reported as installed
 *  - idempotent: files already present are re-hashed instead of downloaded again, and a
 *    complete, verified install returns immediately
 *
 * Plain Node (fetch, streams, crypto): the same code runs on Windows, macOS and Linux.
 * ----------------------------------------------------------------------------------------- */

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface InstallProgress {
  file: string;
  /** Bytes of this file received so far / expected. */
  receivedBytes: number;
  totalBytes: number;
  /** `download` while bytes arrive, `verify` while an existing file is hashed, `done` once. */
  phase: 'download' | 'verify' | 'done';
  /** True when the file was already on disk and only had to be verified. */
  reused: boolean;
}

export interface InstallOptions {
  modelsDir: string;
  model: WhisperModelDef;
  fetch?: FetchLike;
  onProgress?: (progress: InstallProgress) => void;
  /** Re-download and re-verify everything even when the marker says it is installed. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface InstallResult {
  dir: string;
  /** False when the model was already installed and nothing had to be done. */
  changed: boolean;
  downloadedBytes: number;
  totalBytes: number;
  files: { path: string; reused: boolean }[];
}

export class ModelIntegrityError extends Error {
  constructor(
    readonly file: string,
    readonly problem: 'size' | 'sha256',
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${file}: ${problem} mismatch (expected ${expected}, got ${actual}). The file was discarded.`,
    );
    this.name = 'ModelIntegrityError';
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
  file: WhisperModelFile,
  options: Required<Pick<InstallOptions, 'fetch'>> & Pick<InstallOptions, 'onProgress' | 'signal'>,
): Promise<void> {
  const part = `${target}.part`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(part, { force: true });
  const response = await options.fetch(url, { signal: options.signal });
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
        done(new ModelIntegrityError(file.path, 'size', String(file.sizeBytes), `> ${file.sizeBytes}`));
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
      { signal: options.signal },
    );
    if (received !== file.sizeBytes) {
      throw new ModelIntegrityError(file.path, 'size', String(file.sizeBytes), String(received));
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256) {
      throw new ModelIntegrityError(file.path, 'sha256', file.sha256, digest);
    }
    await fs.rename(part, target);
  } catch (err) {
    await fs.rm(part, { force: true });
    throw err;
  }
}

/** Install (or verify) one model. Throws when a file cannot be fetched or fails its check. */
export async function installWhisperModel(options: InstallOptions): Promise<InstallResult> {
  const { modelsDir, model } = options;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const dir = path.join(modelsDir, whisperModelFolder(model));
  const totalBytes = whisperModelBytes(model);

  if (!options.force && inspectWhisperInstall(modelsDir, model).installed) {
    return {
      dir,
      changed: false,
      downloadedBytes: 0,
      totalBytes,
      files: model.files.map((file) => ({ path: file.path, reused: true })),
    };
  }

  await fs.mkdir(dir, { recursive: true });
  // The marker goes first: from here on the folder is "incomplete" until every file passed.
  await fs.rm(path.join(dir, WHISPER_INSTALL_MARKER), { force: true });

  let downloadedBytes = 0;
  const files: InstallResult['files'] = [];
  for (const file of model.files) {
    const target = path.join(dir, ...file.path.split('/'));
    let reused = false;
    if (!options.force && (await sizeOf(target)) === file.sizeBytes) {
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
      await downloadVerified(whisperFileUrl(model, file), target, file, {
        fetch: fetchImpl,
        onProgress: options.onProgress,
        signal: options.signal,
      });
      downloadedBytes += file.sizeBytes;
    }
    files.push({ path: file.path, reused });
    options.onProgress?.({
      file: file.path,
      receivedBytes: file.sizeBytes,
      totalBytes: file.sizeBytes,
      phase: 'done',
      reused,
    });
  }

  const marker: WhisperInstallMarker = {
    model: model.id,
    repo: model.repo,
    revision: model.revision,
    verifiedAt: new Date().toISOString(),
    files: model.files.map((file) => ({ ...file })),
  };
  const markerPath = path.join(dir, WHISPER_INSTALL_MARKER);
  await fs.writeFile(`${markerPath}.part`, `${JSON.stringify(marker, null, 2)}\n`);
  await fs.rename(`${markerPath}.part`, markerPath);
  return { dir, changed: true, downloadedBytes, totalBytes, files };
}
