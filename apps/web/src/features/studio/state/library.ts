import { collectAssetIds } from '@parlante/shared';
import type {
  Asset,
  Avatar,
  BrandKit,
  Capabilities,
  Composition,
  StockAsset,
  Voice,
} from '@parlante/shared';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, apiClient, apiQueryKey, useApiInfiniteQuery, useApiQuery } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import type { MediaInfo, MediaResolver } from '../preview/engine';

/* Everything the Studio reads besides the video: avatars, voices, uploads, stock media, brand
 * kits and provider capabilities. Each list degrades on its own — a failed list shows its
 * error in the picker that needs it and never blocks editing. */

export interface ListState<T> {
  items: T[];
  isPending: boolean;
  error: ApiError | null;
  refetch: () => void;
}

export interface StudioLibrary {
  avatars: ListState<Avatar>;
  /** Live state of the photorealistic engine (null when the API does not report it). */
  avatarEngine: Capabilities['avatarEngine'] | null;
  voices: ListState<Voice>;
  assets: ListState<Asset> & { hasMore: boolean; loadMore: () => void; loadingMore: boolean };
  stock: ListState<StockAsset>;
  brandKits: ListState<BrandKit>;
  capabilities: Capabilities | null;
  /** URL and kind of a media key (`asset:<id>` / `stock:<id>`), null when unknown. */
  media: MediaResolver;
  /** Display name of a media key. */
  mediaName: (key: string) => string | null;
  avatarById: (id: string) => Avatar | undefined;
  voiceById: (id: string) => Voice | undefined;
}

const STALE = 60_000;

export function useStudioLibrary(composition: Composition): StudioLibrary {
  const avatars = useApiQuery(api.avatars.list, undefined, { staleTime: STALE });
  const voices = useApiQuery(api.voices.list, undefined, { staleTime: STALE });
  const stock = useApiQuery(api.assets.listStock, undefined, { staleTime: 10 * STALE });
  const brandKits = useApiQuery(api.brandKits.list, undefined, { staleTime: STALE });
  const capabilities = useApiQuery(api.system.capabilities, undefined, { staleTime: STALE });
  const assets = useApiInfiniteQuery(api.assets.list, { query: { limit: 60 } });

  // Assets the document uses that are not in the loaded pages (older uploads, brand logos).
  const used = useMemo(() => collectAssetIds(composition), [composition]);
  const loaded = useMemo(() => new Set(assets.items.map((asset) => asset.id)), [assets.items]);
  const missing = useMemo(
    () => (assets.isPending ? [] : used.filter((id) => !loaded.has(id))),
    [assets.isPending, used, loaded],
  );
  const extra = useQueries({
    queries: missing.map((assetId) => ({
      queryKey: apiQueryKey(api.assets.get, { params: { assetId } }),
      queryFn: () => apiClient.assets.get({ params: { assetId } }),
      staleTime: STALE,
      retry: false,
    })),
  });
  const extraAssets = extra.map((query) => query.data).filter((a): a is Asset => a !== undefined);
  const extraKey = extraAssets.map((asset) => asset.id).join(',');

  const index = useMemo(() => {
    const map = new Map<string, MediaInfo & { name: string }>();
    for (const item of stock.data?.items ?? []) {
      map.set(`stock:${item.id}`, {
        url: item.url,
        kind: item.kind,
        durationMs: item.durationMs,
        name: item.name,
      });
    }
    for (const asset of [...assets.items, ...extraAssets]) {
      map.set(`asset:${asset.id}`, {
        url: asset.url,
        kind: asset.kind,
        durationMs: asset.durationMs,
        name: asset.name,
      });
    }
    return map;
    // `extraKey` stands for `extraAssets`, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock.data, assets.items, extraKey]);

  const avatarMap = useMemo(
    () => new Map((avatars.data?.items ?? []).map((avatar) => [avatar.id, avatar])),
    [avatars.data],
  );
  const voiceMap = useMemo(
    () => new Map((voices.data?.items ?? []).map((voice) => [voice.id, voice])),
    [voices.data],
  );

  return useMemo<StudioLibrary>(
    () => ({
      avatars: {
        items: avatars.data?.items ?? [],
        isPending: avatars.isPending,
        error: avatars.error,
        refetch: () => void avatars.refetch(),
      },
      avatarEngine: avatars.data?.engine ?? capabilities.data?.avatarEngine ?? null,
      voices: {
        items: voices.data?.items ?? [],
        isPending: voices.isPending,
        error: voices.error,
        refetch: () => void voices.refetch(),
      },
      assets: {
        items: assets.items,
        isPending: assets.isPending,
        error: assets.error,
        refetch: () => void assets.refetch(),
        hasMore: assets.hasNextPage,
        loadMore: () => void assets.fetchNextPage(),
        loadingMore: assets.isFetchingNextPage,
      },
      stock: {
        items: stock.data?.items ?? [],
        isPending: stock.isPending,
        error: stock.error,
        refetch: () => void stock.refetch(),
      },
      brandKits: {
        items: brandKits.data?.items ?? [],
        isPending: brandKits.isPending,
        error: brandKits.error,
        refetch: () => void brandKits.refetch(),
      },
      capabilities: capabilities.data ?? null,
      media: (key) => index.get(key) ?? null,
      mediaName: (key) => index.get(key)?.name ?? null,
      avatarById: (id) => avatarMap.get(id),
      voiceById: (id) => voiceMap.get(id),
    }),
    // The query objects are stable enough through the fields read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      avatars.data,
      avatars.isPending,
      avatars.error,
      voices.data,
      voices.isPending,
      voices.error,
      assets.items,
      assets.isPending,
      assets.error,
      assets.hasNextPage,
      assets.isFetchingNextPage,
      stock.data,
      stock.isPending,
      stock.error,
      brandKits.data,
      brandKits.isPending,
      brandKits.error,
      capabilities.data,
      index,
      avatarMap,
      voiceMap,
    ],
  );
}
