import type { ProviderRef, StorageProvider } from '@parlante/shared';
import type { ProviderEnv } from '../env';
import { notConfigured, notImplemented } from '../errors';

/**
 * S3-compatible storage adapter (AWS S3, MinIO, R2…). STUB — owner: providers-ai.
 * Use `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (already installed).
 */
export function createS3Storage(env: ProviderEnv): StorageProvider {
  if (!env.S3_BUCKET) throw notConfigured('s3', 'S3_BUCKET');
  const info: ProviderRef = { id: 's3', name: 'S3 compatible', quality: 'premium', local: false };
  const stub = (method: string) => () => notImplemented('storage', 's3', method);
  return {
    info,
    put: stub('put'),
    get: stub('get'),
    getStream: stub('getStream'),
    stat: stub('stat'),
    exists: stub('exists'),
    delete: stub('delete'),
    deletePrefix: stub('deletePrefix'),
    downloadTo: stub('downloadTo'),
    localPath: () => null,
    signedUrl: stub('signedUrl'),
  };
}
