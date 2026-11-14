import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@parlante/shared';
import type {
  ProviderRef,
  StorageBody,
  StorageObjectInfo,
  StorageProvider,
  StoragePutOptions,
  StorageRange,
} from '@parlante/shared';
import { assertSafeStorageKey } from '@parlante/shared/node';

const META_SUFFIX = '.meta.json';

/**
 * Local-disk storage. Objects live under `rootDir/<key>`; the content type is kept in a
 * sidecar `<key>.meta.json`. Keys are validated (no traversal) and resolved paths are checked
 * to stay inside `rootDir`.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly info: ProviderRef = {
    id: 'local',
    name: 'Local disk',
    quality: 'basic',
    local: true,
  };

  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    assertSafeStorageKey(key);
    if (key.endsWith(META_SUFFIX)) throw new Error('Reserved storage key suffix');
    const full = path.resolve(this.rootDir, key);
    if (full !== this.rootDir && !full.startsWith(this.rootDir + path.sep)) {
      throw new Error('Storage key escapes the storage root');
    }
    return full;
  }

  async put(
    key: string,
    body: StorageBody,
    options: StoragePutOptions,
  ): Promise<StorageObjectInfo> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    // Write to a temp file and rename so readers never see partial objects.
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    try {
      if (body instanceof Uint8Array) {
        await fs.writeFile(tmp, body);
      } else if ('filePath' in body) {
        await fs.copyFile(body.filePath, tmp);
      } else {
        await pipeline(Readable.from(body), createWriteStream(tmp));
      }
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await fs.writeFile(
      `${full}${META_SUFFIX}`,
      JSON.stringify({ contentType: options.contentType }),
    );
    const stat = await fs.stat(full);
    return { key, size: stat.size, contentType: options.contentType, lastModified: stat.mtime };
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      throw mapNotFound(err, key);
    }
  }

  async getStream(key: string, range?: StorageRange): Promise<AsyncIterable<Uint8Array>> {
    const full = this.resolve(key);
    try {
      await fs.access(full);
    } catch (err) {
      throw mapNotFound(err, key);
    }
    return createReadStream(full, range ? { start: range.start, end: range.end } : undefined);
  }

  async stat(key: string): Promise<StorageObjectInfo | null> {
    const full = this.resolve(key);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) return null;
      let contentType: string | null = null;
      try {
        const meta = JSON.parse(await fs.readFile(`${full}${META_SUFFIX}`, 'utf8')) as {
          contentType?: unknown;
        };
        if (typeof meta.contentType === 'string') contentType = meta.contentType;
      } catch {
        contentType = null;
      }
      return { key, size: stat.size, contentType, lastModified: stat.mtime };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await fs.rm(full, { force: true });
    await fs.rm(`${full}${META_SUFFIX}`, { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const clean = prefix.replace(/\/+$/, '');
    if (clean === '') throw new Error('Refusing to delete the whole storage root');
    const full = this.resolve(clean);
    await fs.rm(full, { recursive: true, force: true });
    await fs.rm(`${full}${META_SUFFIX}`, { force: true });
  }

  async downloadTo(key: string, filePath: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.copyFile(this.resolve(key), filePath);
    } catch (err) {
      throw mapNotFound(err, key);
    }
  }

  localPath(key: string): string | null {
    return this.resolve(key);
  }

  async signedUrl(): Promise<string | null> {
    // Local files are served by the API through its own signed `/api/files/*` route.
    return null;
  }
}

function mapNotFound(err: unknown, key: string): unknown {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    return new AppError('NOT_FOUND', 'Stored file not found', { key });
  }
  return err;
}
