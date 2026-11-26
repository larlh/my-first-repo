import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '@parlante/shared';
import type {
  ProviderRef,
  StorageBody,
  StorageObjectInfo,
  StorageProvider,
  StoragePutOptions,
  StorageRange,
} from '@parlante/shared';
import { assertSafeStorageKey, sanitizeFilename } from '@parlante/shared/node';
import type { ProviderEnv } from '../env';
import { notConfigured } from '../errors';

/* -------------------------------------------------------------------------------------------
 * S3-compatible storage (AWS S3, MinIO, Cloudflare R2, Backblaze B2…) with the official AWS
 * SDK for JavaScript v3. Selected with STORAGE_PROVIDER=s3.
 *
 *   S3_BUCKET (required) · S3_REGION · S3_ENDPOINT (empty for AWS) · S3_FORCE_PATH_STYLE
 *   S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY (+ S3_SESSION_TOKEN) — when absent the SDK's
 *   default credential chain is used (instance role, environment, profile)
 *   S3_PUBLIC_ENDPOINT — host written into signed URLs when browsers reach the bucket under
 *   another name than the servers do
 *
 * Objects are private; the API hands out time-limited signed GET URLs (`signedUrl`), so file
 * bytes never travel through the Node processes on download.
 * ----------------------------------------------------------------------------------------- */

const INFO: ProviderRef = { id: 's3', name: 'S3 compatible', quality: 'premium', local: false };

/** Files above this size are uploaded in parts (a single PUT is limited to 5 GB). */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;
/** DeleteObjects accepts at most 1000 keys per request. */
const DELETE_BATCH = 1000;
/** Signature V4 presigned URLs are valid for at most seven days. */
const MAX_SIGNED_URL_SEC = 7 * 24 * 60 * 60;

export interface S3StorageOptions {
  /** Injected in tests; defaults to a client built from the environment. */
  client?: S3Client;
  /** Client used only to SIGN urls (S3_PUBLIC_ENDPOINT); defaults to `client`. */
  signingClient?: S3Client;
}

type S3Env = Pick<
  ProviderEnv,
  | 'S3_BUCKET'
  | 'S3_REGION'
  | 'S3_ENDPOINT'
  | 'S3_PUBLIC_ENDPOINT'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_SESSION_TOKEN'
  | 'S3_FORCE_PATH_STYLE'
>;

function buildClient(env: S3Env, endpoint: string | undefined): S3Client {
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
    throw notConfigured('s3', env.S3_ACCESS_KEY_ID ? 'S3_SECRET_ACCESS_KEY' : 'S3_ACCESS_KEY_ID');
  }
  return new S3Client({
    region: env.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            ...(env.S3_SESSION_TOKEN ? { sessionToken: env.S3_SESSION_TOKEN } : {}),
          },
        }
      : {}),
  });
}

function isNotFound(err: unknown): boolean {
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return (
    error?.name === 'NoSuchKey' ||
    error?.name === 'NotFound' ||
    error?.$metadata?.httpStatusCode === 404
  );
}

function storageError(err: unknown, key: string, action: string): unknown {
  if (err instanceof AppError) return err;
  if (isNotFound(err)) return new AppError('NOT_FOUND', 'Stored file not found', { key });
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return new AppError(
    'PROVIDER_ERROR',
    `S3 storage could not ${action} (${error?.name ?? 'unknown error'})`,
    { providerId: 's3', key, httpStatus: error?.$metadata?.httpStatusCode ?? null },
    { cause: err },
  );
}

/** `attachment` header with an ASCII fallback and the UTF-8 name (RFC 6266). */
function contentDisposition(downloadName: string): string {
  const ascii = sanitizeFilename(downloadName, 'download');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}

/** S3-compatible storage adapter. Owner: providers-ai. */
export function createS3Storage(env: S3Env, options: S3StorageOptions = {}): StorageProvider {
  if (!env.S3_BUCKET) throw notConfigured('s3', 'S3_BUCKET');
  const bucket = env.S3_BUCKET;
  const client = options.client ?? buildClient(env, env.S3_ENDPOINT);
  const signingClient =
    options.signingClient ??
    (env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT
      ? buildClient(env, env.S3_PUBLIC_ENDPOINT)
      : client);

  const checked = (key: string): string => {
    assertSafeStorageKey(key);
    return key;
  };

  const uploadFile = async (
    key: string,
    filePath: string,
    size: number,
    contentType: string,
  ): Promise<void> => {
    if (size <= MULTIPART_THRESHOLD) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
      return;
    }
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    );
    const uploadId = created.UploadId;
    if (!uploadId) throw new Error('S3 did not return an upload id');
    const handle = await fs.open(filePath, 'r');
    try {
      const parts: { ETag: string | undefined; PartNumber: number }[] = [];
      for (let offset = 0, partNumber = 1; offset < size; offset += PART_SIZE, partNumber += 1) {
        const length = Math.min(PART_SIZE, size - offset);
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        const uploaded = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: buffer,
            ContentLength: length,
          }),
        );
        parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
      }
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (err) {
      // Do not leave a half-uploaded object billing storage forever.
      await client
        .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
        .catch(() => undefined);
      throw err;
    } finally {
      await handle.close();
    }
  };

  const getBody = async (key: string, range?: StorageRange): Promise<Readable> => {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    if (!response.Body) throw new AppError('NOT_FOUND', 'Stored file not found', { key });
    return response.Body as Readable;
  };

  return {
    info: INFO,

    async put(
      key: string,
      body: StorageBody,
      putOptions: StoragePutOptions,
    ): Promise<StorageObjectInfo> {
      checked(key);
      try {
        let size: number;
        if (body instanceof Uint8Array) {
          size = body.byteLength;
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: body,
              ContentLength: size,
              ContentType: putOptions.contentType,
            }),
          );
        } else if ('filePath' in body) {
          size = (await fs.stat(body.filePath)).size;
          await uploadFile(key, body.filePath, size, putOptions.contentType);
        } else {
          // A stream of unknown length: spool it to disk, then upload with a known size.
          const spool = path.join(os.tmpdir(), `parlante-s3-${randomBytes(8).toString('hex')}`);
          try {
            await pipeline(Readable.from(body), createWriteStream(spool));
            size = (await fs.stat(spool)).size;
            await uploadFile(key, spool, size, putOptions.contentType);
          } finally {
            await fs.rm(spool, { force: true });
          }
        }
        return { key, size, contentType: putOptions.contentType, lastModified: new Date() };
      } catch (err) {
        throw storageError(err, key, 'store the file');
      }
    },

    async get(key: string): Promise<Uint8Array> {
      checked(key);
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await getBody(key)) chunks.push(Buffer.from(chunk as Uint8Array));
        return Buffer.concat(chunks);
      } catch (err) {
        throw storageError(err, key, 'read the file');
      }
    },

    async getStream(key: string, range?: StorageRange): Promise<AsyncIterable<Uint8Array>> {
      checked(key);
      try {
        return await getBody(key, range);
      } catch (err) {
        throw storageError(err, key, 'read the file');
      }
    },

    async stat(key: string): Promise<StorageObjectInfo | null> {
      checked(key);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          key,
          size: head.ContentLength ?? 0,
          contentType: head.ContentType ?? null,
          lastModified: head.LastModified ?? null,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw storageError(err, key, 'inspect the file');
      }
    },

    async exists(key: string): Promise<boolean> {
      return (await this.stat(key)) !== null;
    },

    async delete(key: string): Promise<void> {
      checked(key);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (isNotFound(err)) return;
        throw storageError(err, key, 'delete the file');
      }
    },

    async deletePrefix(prefix: string): Promise<void> {
      const clean = prefix.replace(/\/+$/, '');
      if (clean === '') throw new Error('Refusing to delete the whole storage root');
      checked(clean);
      try {
        // `clean/` and not `clean`: "videos/vid_1" must not take "videos/vid_10" with it.
        let token: string | undefined;
        do {
          const page = await client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: `${clean}/`,
              ContinuationToken: token,
              MaxKeys: DELETE_BATCH,
            }),
          );
          const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
          if (keys.length > 0) {
            const result = await client.send(
              new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
              }),
            );
            const failed = result.Errors?.[0];
            if (failed) {
              throw new AppError(
                'PROVIDER_ERROR',
                `S3 storage could not delete ${result.Errors?.length ?? 1} file(s) (${failed.Code ?? 'unknown error'})`,
                { providerId: 's3', key: failed.Key ?? clean },
              );
            }
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
        // Same semantics as the local disk: an object named exactly like the prefix goes too.
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: clean }));
      } catch (err) {
        throw storageError(err, clean, 'delete the files');
      }
    },

    async downloadTo(key: string, filePath: string): Promise<void> {
      checked(key);
      const tmp = `${filePath}.${randomBytes(4).toString('hex')}.part`;
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await pipeline(await getBody(key), createWriteStream(tmp));
        await fs.rename(tmp, filePath);
      } catch (err) {
        await fs.rm(tmp, { force: true });
        throw storageError(err, key, 'download the file');
      }
    },

    localPath(): string | null {
      return null;
    },

    async signedUrl(
      key: string,
      urlOptions: { expiresInSec: number; downloadName?: string },
    ): Promise<string | null> {
      checked(key);
      const expiresIn = Math.min(
        MAX_SIGNED_URL_SEC,
        Math.max(1, Math.round(urlOptions.expiresInSec)),
      );
      return getSignedUrl(
        signingClient,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(urlOptions.downloadName
            ? { ResponseContentDisposition: contentDisposition(urlOptions.downloadName) }
            : {}),
        }),
        { expiresIn },
      );
    },
  };
}
