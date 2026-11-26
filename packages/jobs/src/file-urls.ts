import type { StorageProvider } from '@parlante/shared';
import { buildSignedFilePath } from '@parlante/shared/node';

export interface FileUrlOptions {
  /** Validity of the link. Default 6 h (rounded up to the hour so URLs stay cache-stable). */
  expiresInSec?: number;
  /** Serve as an attachment with this file name. */
  downloadName?: string;
}

/** Turns a storage key into a ready-to-use absolute URL. */
export type FileUrlBuilder = {
  (key: string, options?: FileUrlOptions): Promise<string>;
  (key: string | null | undefined, options?: FileUrlOptions): Promise<string | null>;
};

export const WEBHOOK_URL_TTL_SEC = 7 * 24 * 3600;

/**
 * The ONE way to expose stored files: remote storage → provider-signed URL; local storage →
 * `${PUBLIC_API_URL}/api/files/<key>?exp=…&sig=…` (served by the API's signed files route).
 * Used by the API for every `*Url` field and by the worker for webhook payloads.
 */
export function createFileUrlBuilder(config: {
  storage: StorageProvider;
  appSecret: string;
  publicApiUrl: string;
}): FileUrlBuilder {
  const base = config.publicApiUrl.replace(/\/+$/, '');
  const build = async (
    key: string | null | undefined,
    options: FileUrlOptions = {},
  ): Promise<string | null> => {
    if (!key) return null;
    const expiresInSec = options.expiresInSec ?? 6 * 3600;
    const remote = await config.storage.signedUrl(key, {
      expiresInSec,
      downloadName: options.downloadName,
    });
    if (remote) return remote;
    return `${base}${buildSignedFilePath(config.appSecret, key, { expiresInSec, downloadName: options.downloadName })}`;
  };
  return build as FileUrlBuilder;
}
