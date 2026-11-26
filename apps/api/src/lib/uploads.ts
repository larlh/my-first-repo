import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { fileTypeFromFile } from 'file-type';
import { ALLOWED_UPLOAD_MIME, AppError, assetKindForMime } from '@parlante/shared';
import type { AssetKind } from '@parlante/shared';
import { sanitizeFilename } from '@parlante/shared/node';

export interface ReceivedUpload {
  /** Temp file holding the upload. Call `cleanup()` when done (use try/finally). */
  tmpPath: string;
  /** MIME type detected from the file's magic bytes — never the client-declared one. */
  mimeType: string;
  /** Canonical extension for the detected type (`png`, `mp4`, `mp3`…). */
  ext: string;
  kind: AssetKind;
  sizeBytes: number;
  /** Sanitised original file name, safe to store and display. */
  filename: string;
  /** Text fields sent next to the file. */
  fields: Record<string, string>;
  cleanup(): Promise<void>;
}

export interface ReceiveUploadOptions {
  /** Maximum size in bytes (plan limit). Also capped by MAX_UPLOAD_MB. */
  maxBytes: number;
  /** Accepted kinds. Default: image, video and audio. */
  kinds?: readonly AssetKind[];
  /** Name of the file field. Default `file`. */
  fileField?: string;
}

/**
 * Receive ONE multipart file upload safely:
 *  - streams to a temp file with a random name (the client file name never touches a path)
 *  - enforces the size limit while streaming (PAYLOAD_TOO_LARGE)
 *  - detects the REAL type from magic bytes and checks it against the allow-list
 *    (UNSUPPORTED_MEDIA_TYPE) — the client's Content-Type and extension are ignored
 */
export async function receiveUpload(
  request: FastifyRequest,
  options: ReceiveUploadOptions,
): Promise<ReceivedUpload> {
  if (!request.isMultipart()) {
    throw new AppError('BAD_REQUEST', 'Expected a multipart/form-data request');
  }
  const config = request.server.config;
  const limit = Math.min(options.maxBytes, config.MAX_UPLOAD_MB * 1024 * 1024);
  const fileField = options.fileField ?? 'file';
  const tmpDir = config.UPLOAD_TMP_DIR ?? os.tmpdir();
  const tmpPath = path.join(tmpDir, `parlante-upload-${randomBytes(12).toString('hex')}`);
  const cleanup = async () => {
    await fs.rm(tmpPath, { force: true });
  };

  const fields: Record<string, string> = {};
  let received = false;
  let filename = 'file';
  let sizeBytes = 0;

  try {
    const parts = request.parts({
      limits: { fileSize: limit, files: 1, fields: 20, fieldSize: 10_000 },
    });
    for await (const part of parts) {
      if (part.type === 'file') {
        if (part.fieldname !== fileField || received) {
          // Drain unexpected files so the request can finish.
          part.file.resume();
          continue;
        }
        received = true;
        filename = sanitizeFilename(path.basename(part.filename ?? 'file'));
        await fs.mkdir(tmpDir, { recursive: true });
        await pipeline(part.file, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
        if (part.file.truncated) {
          throw new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than the allowed size', {
            maxBytes: limit,
          });
        }
        sizeBytes = part.file.bytesRead;
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!received) {
      throw AppError.validation('A file is required', [{ path: fileField, message: 'Required' }]);
    }
    if (sizeBytes === 0) {
      throw AppError.validation('The file is empty', [{ path: fileField, message: 'Empty file' }]);
    }

    const detected = await fileTypeFromFile(tmpPath);
    const kinds = options.kinds ?? (['image', 'video', 'audio'] as const);
    const kind = detected ? assetKindForMime(detected.mime) : null;
    if (!detected || !kind || !kinds.includes(kind)) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'This file type is not supported', {
        detected: detected?.mime ?? null,
        allowed: kinds.flatMap((k) => ALLOWED_UPLOAD_MIME[k]),
      });
    }
    return {
      tmpPath,
      mimeType: detected.mime,
      ext: detected.ext,
      kind,
      sizeBytes,
      filename,
      fields,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError('PAYLOAD_TOO_LARGE', 'The file is larger than the allowed size', {
        maxBytes: limit,
      });
    }
    throw err;
  }
}
