import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { providerEnvSchema } from '../env';
import { createStorageProvider } from './index';
import { createS3Storage } from './s3';

/*
 * No S3 service or credentials exist in this environment: the adapter is exercised against an
 * in-memory fake that answers the SDK commands it sends (same command classes, same response
 * shapes), and URL signing runs for real (it is offline maths) with dummy credentials.
 */

interface StoredObject {
  body: Buffer;
  contentType: string | undefined;
  lastModified: Date;
}

class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly sent: string[] = [];
  readonly uploads = new Map<
    string,
    { key: string; contentType?: string; parts: Map<number, Buffer> }
  >();
  readonly aborted: string[] = [];
  failPart: number | null = null;
  failWith: (Error & { name: string; $metadata?: { httpStatusCode: number } }) | null = null;

  private notFound(name: 'NoSuchKey' | 'NotFound'): Error {
    return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
  }

  private static async bytes(body: unknown): Promise<Buffer> {
    if (body instanceof Uint8Array) return Buffer.from(body);
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async send(command: unknown): Promise<unknown> {
    this.sent.push((command as object).constructor.name);
    if (this.failWith) throw this.failWith;
    if (command instanceof PutObjectCommand) {
      const body = await FakeS3.bytes(command.input.Body);
      expect(command.input.ContentLength).toBe(body.length);
      this.objects.set(command.input.Key!, {
        body,
        contentType: command.input.ContentType,
        lastModified: new Date('2026-01-02T03:04:05Z'),
      });
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw this.notFound('NoSuchKey');
      const range = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '');
      const body = range
        ? object.body.subarray(Number(range[1]), Number(range[2]) + 1)
        : object.body;
      // Two chunks, like a network stream.
      const half = Math.ceil(body.length / 2);
      return { Body: Readable.from([body.subarray(0, half), body.subarray(half)]) };
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw this.notFound('NotFound');
      return {
        ContentLength: object.body.length,
        ContentType: object.contentType,
        LastModified: object.lastModified,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const all = [...this.objects.keys()]
        .filter((key) => key.startsWith(command.input.Prefix ?? ''))
        .sort();
      // Tiny pages to exercise pagination. Like S3, the token is a position in KEY order
      // (not an offset), so deleting the previous page does not shift the next one.
      const after = command.input.ContinuationToken;
      const rest = after ? all.filter((key) => key > after) : all;
      const page = rest.slice(0, 2);
      const truncated = rest.length > page.length;
      return {
        Contents: page.map((Key) => ({ Key })),
        IsTruncated: truncated,
        NextContinuationToken: truncated ? page.at(-1) : undefined,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const object of command.input.Delete?.Objects ?? []) this.objects.delete(object.Key!);
      return {};
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${this.uploads.size + 1}`;
      this.uploads.set(id, {
        key: command.input.Key!,
        contentType: command.input.ContentType,
        parts: new Map(),
      });
      return { UploadId: id };
    }
    if (command instanceof UploadPartCommand) {
      if (command.input.PartNumber === this.failPart) throw new Error('socket hang up');
      const body = await FakeS3.bytes(command.input.Body);
      this.uploads.get(command.input.UploadId!)!.parts.set(command.input.PartNumber!, body);
      return { ETag: `"etag-${command.input.PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const upload = this.uploads.get(command.input.UploadId!)!;
      const parts = command.input.MultipartUpload!.Parts!;
      expect(parts.map((part) => part.PartNumber)).toEqual(parts.map((_part, i) => i + 1));
      expect(parts.every((part) => part.ETag === `"etag-${part.PartNumber}"`)).toBe(true);
      this.objects.set(upload.key, {
        body: Buffer.concat(parts.map((part) => upload.parts.get(part.PartNumber!)!)),
        contentType: upload.contentType,
        lastModified: new Date(),
      });
      return {};
    }
    if (command instanceof AbortMultipartUploadCommand) {
      this.aborted.push(command.input.UploadId!);
      return {};
    }
    throw new Error(`FakeS3: unexpected command ${(command as object).constructor.name}`);
  }
}

const env = providerEnvSchema.parse({
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'parlante-test',
  S3_REGION: 'eu-west-1',
  S3_ENDPOINT: 'http://minio.internal:9000',
  S3_PUBLIC_ENDPOINT: 'https://files.example.com',
  S3_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST',
  S3_SECRET_ACCESS_KEY: 'test-secret-test-secret-test-secret-0000',
});

let dir: string;
let fake: FakeS3;
let storage: ReturnType<typeof createS3Storage>;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parlante-s3-test-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake = new FakeS3();
  storage = createS3Storage(env, { client: fake as unknown as S3Client });
});

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('S3 storage (fake client)', () => {
  const key = 'ws/ws_test/assets/ast_1/original.txt';

  it('is selected by STORAGE_PROVIDER=s3 and requires its configuration', () => {
    const provider = createStorageProvider(env);
    expect(provider.info).toEqual({
      id: 's3',
      name: 'S3 compatible',
      quality: 'premium',
      local: false,
    });
    expect(provider.localPath(key)).toBeNull();
    expect(() =>
      createStorageProvider(providerEnvSchema.parse({ STORAGE_PROVIDER: 's3' })),
    ).toThrow(/S3_BUCKET/);
    expect(() =>
      createStorageProvider(
        providerEnvSchema.parse({
          STORAGE_PROVIDER: 's3',
          S3_BUCKET: 'b',
          S3_ACCESS_KEY_ID: 'only',
        }),
      ),
    ).toThrow(/S3_SECRET_ACCESS_KEY/);
    // No explicit keys at all is fine: the SDK's default credential chain is used.
    expect(
      createStorageProvider(providerEnvSchema.parse({ STORAGE_PROVIDER: 's3', S3_BUCKET: 'b' }))
        .info.id,
    ).toBe('s3');
  });

  it('puts bytes, stats, reads, streams ranges', async () => {
    const info = await storage.put(key, Buffer.from('hello world'), { contentType: 'text/plain' });
    expect(info).toMatchObject({ key, size: 11, contentType: 'text/plain' });
    expect(info.lastModified).toBeInstanceOf(Date);
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.stat(key)).toEqual({
      key,
      size: 11,
      contentType: 'text/plain',
      lastModified: new Date('2026-01-02T03:04:05Z'),
    });
    expect(Buffer.from(await storage.get(key)).toString()).toBe('hello world');
    expect((await collect(await storage.getStream(key))).toString()).toBe('hello world');
    expect((await collect(await storage.getStream(key, { start: 6, end: 10 }))).toString()).toBe(
      'world',
    );
  });

  it('accepts file paths and async iterables as bodies and downloads to disk', async () => {
    const src = path.join(dir, 'source.bin');
    await fs.writeFile(src, 'from file');
    const fromFile = await storage.put(
      'cache/a.bin',
      { filePath: src },
      { contentType: 'video/mp4' },
    );
    expect(fromFile).toMatchObject({ size: 9, contentType: 'video/mp4' });
    expect(fake.objects.get('cache/a.bin')?.body.toString()).toBe('from file');

    async function* chunks() {
      yield new TextEncoder().encode('part1-');
      yield new TextEncoder().encode('part2');
    }
    const streamed = await storage.put('cache/b.bin', chunks(), {
      contentType: 'application/octet-stream',
    });
    expect(streamed.size).toBe(11);
    expect(fake.objects.get('cache/b.bin')?.body.toString()).toBe('part1-part2');

    const out = path.join(dir, 'out', 'copy.bin');
    await storage.downloadTo('cache/b.bin', out);
    expect(await fs.readFile(out, 'utf8')).toBe('part1-part2');
    expect(await fs.readdir(path.dirname(out))).toEqual(['copy.bin']); // no .part left behind
  });

  it('uploads large files in parts and aborts the upload when a part fails', async () => {
    const big = path.join(dir, 'big.bin');
    const size = 70 * 1024 * 1024 + 123;
    const handle = await fs.open(big, 'w');
    await handle.truncate(size);
    await handle.write(Buffer.from('START'), 0, 5, 0);
    await handle.write(Buffer.from('END'), 0, 3, size - 3);
    await handle.close();

    const info = await storage.put(
      'ws/ws_test/videos/vid_1/video.mp4',
      { filePath: big },
      {
        contentType: 'video/mp4',
      },
    );
    expect(info.size).toBe(size);
    const stored = fake.objects.get('ws/ws_test/videos/vid_1/video.mp4')!;
    expect(stored.body.length).toBe(size);
    expect(stored.body.subarray(0, 5).toString()).toBe('START');
    expect(stored.body.subarray(size - 3).toString()).toBe('END');
    expect(stored.contentType).toBe('video/mp4');
    expect(fake.sent.filter((name) => name === 'UploadPartCommand')).toHaveLength(5);
    expect(fake.sent).not.toContain('PutObjectCommand');

    fake.failPart = 3;
    await expect(
      storage.put(
        'ws/ws_test/videos/vid_2/video.mp4',
        { filePath: big },
        { contentType: 'video/mp4' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(fake.aborted).toEqual(['upload-2']);
    expect(fake.objects.has('ws/ws_test/videos/vid_2/video.mp4')).toBe(false);
    await fs.rm(big);
  });

  it('reports missing objects as NOT_FOUND / null and other failures as PROVIDER_ERROR', async () => {
    expect(await storage.stat('ws/ws_test/missing.txt')).toBeNull();
    expect(await storage.exists('ws/ws_test/missing.txt')).toBe(false);
    await expect(storage.get('ws/ws_test/missing.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(storage.getStream('ws/ws_test/missing.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      storage.downloadTo('ws/ws_test/missing.txt', path.join(dir, 'nope.bin')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await storage.delete('ws/ws_test/missing.txt'); // idempotent

    fake.failWith = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    await expect(storage.get(key)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: 'S3 storage could not read the file (AccessDenied)',
      details: { httpStatus: 403 },
    });
    await expect(storage.stat(key)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('rejects unsafe keys before talking to S3', async () => {
    for (const bad of ['../outside.txt', 'ws/../../etc/passwd', '/etc/passwd', 'a\\b']) {
      await expect(
        storage.put(bad, Buffer.from('x'), { contentType: 'text/plain' }),
        bad,
      ).rejects.toThrow();
      await expect(storage.get(bad), bad).rejects.toThrow();
      await expect(storage.signedUrl(bad, { expiresInSec: 60 }), bad).rejects.toThrow();
    }
    await expect(storage.deletePrefix('')).rejects.toThrow();
    await expect(storage.deletePrefix('/')).rejects.toThrow();
    expect(fake.sent).toEqual([]);
  });

  it('deletes whole prefixes (paginated) without touching sibling prefixes', async () => {
    const put = (k: string) => storage.put(k, Buffer.from('x'), { contentType: 'text/plain' });
    await put('ws/ws_del/videos/vid_1/a.txt');
    await put('ws/ws_del/videos/vid_1/b.txt');
    await put('ws/ws_del/videos/vid_1/sub/c.txt');
    await put('ws/ws_del/videos/vid_1/sub/d.txt');
    await put('ws/ws_del/videos/vid_1/sub/e.txt');
    await put('ws/ws_del/videos/vid_10/keep.txt');
    await put('ws/ws_del/videos/vid_2/keep.txt');
    await storage.deletePrefix('ws/ws_del/videos/vid_1/');
    expect([...fake.objects.keys()].sort()).toEqual([
      'ws/ws_del/videos/vid_10/keep.txt',
      'ws/ws_del/videos/vid_2/keep.txt',
    ]);
    expect(fake.sent.filter((name) => name === 'ListObjectsV2Command')).toHaveLength(3);
    await storage.deletePrefix('ws/ws_del/videos/vid_1'); // idempotent
  });
});

describe('S3 signed URLs (real signing, no network)', () => {
  it('signs time-limited GET URLs on the public endpoint, with a download name', async () => {
    const real = createS3Storage(env); // real clients; presigning never opens a connection
    const url = new URL(
      (await real.signedUrl('ws/ws_1/videos/vid_1/rjb_1/video.mp4', { expiresInSec: 900 }))!,
    );
    expect(url.origin).toBe('https://files.example.com');
    expect(url.pathname).toBe('/parlante-test/ws/ws_1/videos/vid_1/rjb_1/video.mp4');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^AKIATESTTESTTESTTEST\/\d{8}\/eu-west-1\/s3\/aws4_request$/,
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('response-content-disposition')).toBeNull();
    expect(url.toString()).not.toContain('test-secret');

    const download = new URL(
      (await real.signedUrl('ws/ws_1/videos/vid_1/rjb_1/video.mp4', {
        expiresInSec: 60 * 60 * 24 * 30, // clamped to the 7 days Signature V4 allows
        downloadName: 'Presentación año 2026.mp4',
      }))!,
    );
    expect(download.searchParams.get('X-Amz-Expires')).toBe('604800');
    expect(download.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="Presentacion ano 2026.mp4"; filename*=UTF-8''Presentaci%C3%B3n%20a%C3%B1o%202026.mp4`,
    );
    expect(download.searchParams.get('X-Amz-Signature')).not.toBe(
      url.searchParams.get('X-Amz-Signature'),
    );
  });

  it('uses virtual-hosted URLs on AWS when path style is off', async () => {
    const aws = createS3Storage(
      providerEnvSchema.parse({
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'my-bucket',
        S3_REGION: 'eu-south-2',
        S3_FORCE_PATH_STYLE: 'false',
        S3_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST',
        S3_SECRET_ACCESS_KEY: 'test-secret-test-secret-test-secret-0000',
        S3_SESSION_TOKEN: 'session-token',
      }),
    );
    const url = new URL((await aws.signedUrl('cache/tts/abc.wav', { expiresInSec: 120 }))!);
    expect(url.host).toBe('my-bucket.s3.eu-south-2.amazonaws.com');
    expect(url.pathname).toBe('/cache/tts/abc.wav');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token');
  });
});
