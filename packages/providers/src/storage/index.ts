import type { StorageProvider } from '@parlante/shared';
import { resolveStorageDir } from '../env';
import type { ProviderEnv } from '../env';
import { LocalStorageProvider } from './local';
import { createS3Storage } from './s3';

export { LocalStorageProvider } from './local';

/** Owner: providers-ai. Selected by STORAGE_PROVIDER (`local` default, `s3`). */
export function createStorageProvider(env: ProviderEnv): StorageProvider {
  if (env.STORAGE_PROVIDER === 's3') return createS3Storage(env);
  return new LocalStorageProvider(resolveStorageDir(env));
}
