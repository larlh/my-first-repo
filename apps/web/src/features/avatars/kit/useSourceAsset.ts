import type { Asset } from '@parlante/shared';
import { useCallback, useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api';
import type { UploadProgress } from '@/lib/api';

/**
 * Upload of the SOURCE of a photo avatar or a voice clone (the photo / the voice sample of a
 * real person). The file is uploaded once per `File` (a retry reuses it) and, because it is
 * personal data, an upload that never became an avatar or a voice is deleted again: when the
 * person picks another file, cancels, or leaves the page.
 */
export function useSourceAsset(purpose: 'avatar_source' | 'voice_sample'): {
  /** Upload `file` (or return the asset of the same file uploaded before). */
  ensure: (
    file: File,
    options?: { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void },
  ) => Promise<Asset>;
  /** The asset now belongs to a created avatar / voice: keep it. */
  adopt: () => void;
  /** Delete an upload that was not used (best effort). */
  discard: () => void;
} {
  const held = useRef<{ file: File; asset: Asset } | null>(null);

  const discard = useCallback(() => {
    const orphan = held.current;
    held.current = null;
    if (orphan) {
      void apiClient.assets.remove({ params: { assetId: orphan.asset.id } }).catch(() => undefined);
    }
  }, []);

  const ensure = useCallback(
    async (
      file: File,
      options: { signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void } = {},
    ) => {
      if (held.current?.file === file) return held.current.asset;
      discard();
      const asset = await apiClient.assets.upload(
        { file, fields: { name: file.name.slice(0, 120), purpose } },
        { signal: options.signal, onUploadProgress: options.onProgress },
      );
      held.current = { file, asset };
      return asset;
    },
    [discard, purpose],
  );

  const adopt = useCallback(() => {
    held.current = null;
  }, []);

  // Leaving the page with an unused upload removes it.
  useEffect(() => discard, [discard]);

  return { ensure, adopt, discard };
}
