import { useMemo } from 'react';
import { api, useApiQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { UploadRules } from './files';

export interface StorageUsage {
  usedBytes: number;
  limitBytes: number;
  leftBytes: number;
  /** 0..100 */
  percent: number;
  level: 'ok' | 'high' | 'full';
}

export function storageUsage(usedBytes: number, limitBytes: number): StorageUsage {
  const leftBytes = Math.max(0, limitBytes - usedBytes);
  const ratio = limitBytes > 0 ? usedBytes / limitBytes : 1;
  return {
    usedBytes,
    limitBytes,
    leftBytes,
    percent: Math.min(100, Math.max(0, Math.round(ratio * 100))),
    level: ratio >= 1 ? 'full' : ratio >= 0.8 ? 'high' : 'ok',
  };
}

/**
 * Upload limits of the active workspace: the per-file maximum comes from the plan; the free
 * storage from the billing overview (unknown while it loads or if it fails — the server
 * enforces both anyway).
 */
export function useUploadRules(): {
  rules: UploadRules;
  storage: StorageUsage | null;
  storageQuery: ReturnType<typeof useApiQuery<typeof api.billing.overview>>;
} {
  const session = useSession();
  const overview = useApiQuery(api.billing.overview);
  const maxUploadBytes = session.plan.limits.maxUploadBytes;
  const used = overview.data?.usage.storageBytes;
  const limit = overview.data?.limits.maxStorageBytes;
  const storage = useMemo(
    () => (used !== undefined && limit !== undefined ? storageUsage(used, limit) : null),
    [used, limit],
  );
  const rules = useMemo<UploadRules>(
    () => ({ maxUploadBytes, storageLeftBytes: storage ? storage.leftBytes : null }),
    [maxUploadBytes, storage],
  );
  return { rules, storage, storageQuery: overview };
}
