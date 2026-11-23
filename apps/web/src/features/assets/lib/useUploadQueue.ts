import type { Asset, AssetKind, AssetPurpose } from '@parlante/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, apiRequester, invalidateApi, toApiError } from '@/lib/api';
import { checkFiles, displayNameOf } from './files';
import type { UploadRules } from './files';
import { nextToStart, summarize, uploadReducer } from './uploadQueue';
import type { QueueSummary, UploadItem } from './uploadQueue';

const CONCURRENCY = 2;
let sequence = 0;

export interface UploadQueue {
  items: UploadItem[];
  summary: QueueSummary;
  /** Check the files and queue the accepted ones; the rejected ones stay listed with a reason. */
  add: (files: readonly File[]) => void;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

export interface UploadQueueOptions {
  rules: UploadRules;
  purpose?: AssetPurpose;
  kinds?: readonly AssetKind[];
  /** Called once per file that reached the library. */
  onUploaded?: (asset: Asset) => void;
}

/**
 * Multi-file upload queue with per-file progress, cancel and retry. Two uploads run at a time;
 * every finished one refreshes the asset list and the storage usage. Leaving the page aborts
 * what is still in flight.
 */
export function useUploadQueue({
  rules,
  purpose,
  kinds,
  onUploaded,
}: UploadQueueOptions): UploadQueue {
  const client = useQueryClient();
  const [items, dispatch] = useReducer(uploadReducer, []);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;

  const run = useCallback(
    async (id: string, name: string) => {
      const file = files.current.get(id);
      if (!file) return;
      const controller = new AbortController();
      controllers.current.set(id, controller);
      try {
        const asset = await apiRequester.request(
          api.assets.upload,
          { file, fields: { name, ...(purpose ? { purpose } : {}) } },
          {
            signal: controller.signal,
            onUploadProgress: (progress) =>
              dispatch({ type: 'progress', id, fraction: progress.fraction }),
          },
        );
        dispatch({ type: 'done', id, asset });
        files.current.delete(id);
        uploaded.current?.(asset);
        void invalidateApi(client, api.assets.list, api.billing.overview);
      } catch (err) {
        const error = toApiError(err);
        // An abort was asked for by the user: the reducer already marked it as canceled.
        if (error.code !== 'ABORTED') {
          dispatch({ type: 'fail', id, code: error.code, message: error.message });
        }
      } finally {
        controllers.current.delete(id);
      }
    },
    [client, purpose],
  );

  // Start queued uploads whenever a slot is free.
  useEffect(() => {
    for (const id of nextToStart(items, CONCURRENCY)) {
      const item = items.find((entry) => entry.id === id);
      if (!item) continue;
      dispatch({ type: 'start', id });
      void run(id, item.name);
    }
  }, [items, run]);

  // Abort whatever is still in flight when the owner unmounts.
  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
    };
  }, []);

  const add = useCallback(
    (selection: readonly File[]) => {
      const checked = checkFiles(selection, { ...rules, kinds });
      dispatch({
        type: 'add',
        items: checked.map(({ file, kind, reason }) => {
          sequence += 1;
          const id = `upload-${sequence}`;
          if (reason === null) files.current.set(id, file);
          return {
            id,
            name: displayNameOf(file.name),
            fileName: file.name,
            sizeBytes: file.size,
            kind,
            rejection: reason,
          };
        }),
      });
    },
    [kinds, rules],
  );

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    dispatch({ type: 'cancel', id });
  }, []);
  const retry = useCallback((id: string) => dispatch({ type: 'retry', id }), []);
  const dismiss = useCallback((id: string) => {
    files.current.delete(id);
    dispatch({ type: 'dismiss', id });
  }, []);
  const clearFinished = useCallback(() => dispatch({ type: 'clearFinished' }), []);

  const summary = useMemo(() => summarize(items), [items]);
  return { items, summary, add, cancel, retry, dismiss, clearFinished };
}
