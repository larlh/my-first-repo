import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryClient,
  QueryKey,
  UseInfiniteQueryResult,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';
import type { RouteDef } from '@parlante/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { InputOptional, RouteArgs, RouteInput, RouteResult, UploadProgress } from './client';
import type { ApiError } from './errors';
import { apiRequester } from './instance';

/* -------------------------------------------------------------------------------------------
 * TanStack Query helpers keyed by RouteDef.
 *
 *   const video = useApiQuery(api.videos.get, { params: { videoId } });
 *   const rename = useApiMutation(api.videos.update, { invalidates: [api.videos.list] });
 *   const list = useApiInfiniteQuery(api.videos.list, { query: { q } });
 *
 * Query keys: ['api', route.path, { params, query }]. Invalidate by route (all its params) or
 * by path prefix with `invalidateApi(queryClient, api.videos.list, '/api/videos')`.
 * ----------------------------------------------------------------------------------------- */

interface KeyInput {
  params?: unknown;
  query?: unknown;
}

/** Stable query key of a GET route + input. */
export function apiQueryKey(route: RouteDef, input?: KeyInput): QueryKey {
  const params = input?.params ?? null;
  const query = input?.query ?? null;
  return params === null && query === null
    ? ['api', route.path]
    : ['api', route.path, { params, query }];
}

/** A route (every query of that path) or a path prefix such as `/api/videos`. */
export type InvalidateTarget = RouteDef | string;

/** Invalidate every cached query of the given routes / path prefixes. */
export function invalidateApi(client: QueryClient, ...targets: InvalidateTarget[]): Promise<void> {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const target of targets) {
    if (typeof target === 'string') prefixes.push(target);
    else exact.add(target.path);
  }
  return client.invalidateQueries({
    predicate: (query) => {
      const [scope, path] = query.queryKey;
      if (scope !== 'api' || typeof path !== 'string') return false;
      return exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix));
    },
  });
}

/** `const invalidate = useInvalidateApi(); invalidate(api.videos.list)` */
export function useInvalidateApi(): (...targets: InvalidateTarget[]) => Promise<void> {
  const client = useQueryClient();
  return useCallback((...targets) => invalidateApi(client, ...targets), [client]);
}

const call = apiRequester.request as (
  route: RouteDef,
  input?: unknown,
  options?: { signal?: AbortSignal; onUploadProgress?: (p: UploadProgress) => void },
) => Promise<unknown>;

export type ApiQueryOptions<R extends RouteDef, TData = RouteResult<R>> = Omit<
  UseQueryOptions<RouteResult<R>, ApiError, TData>,
  'queryKey' | 'queryFn'
>;

/** `useQuery` for a GET route. The input is optional when the route needs none. */
export function useApiQuery<R extends RouteDef, TData = RouteResult<R>>(
  route: R,
  ...args: RouteArgs<R, ApiQueryOptions<R, TData>>
): UseQueryResult<TData, ApiError> {
  const [input, options] = args;
  return useQuery<RouteResult<R>, ApiError, TData>({
    ...options,
    queryKey: apiQueryKey(route, input as KeyInput | undefined),
    queryFn: ({ signal }) => call(route, input, { signal }) as Promise<RouteResult<R>>,
  });
}

/** Variables of a mutation: the route input, or nothing when every part is optional. */
export type MutationVariables<R extends RouteDef> =
  InputOptional<R> extends true ? RouteInput<R> | void : RouteInput<R>;

export interface ApiMutationOptions<R extends RouteDef, TContext = unknown> extends Omit<
  UseMutationOptions<RouteResult<R>, ApiError, MutationVariables<R>, TContext>,
  'mutationFn'
> {
  /** Routes / path prefixes whose cached queries are invalidated after a success. */
  invalidates?: InvalidateTarget[];
}

/** `useMutation` for any route. `mutate({ params, body })`. */
export function useApiMutation<R extends RouteDef, TContext = unknown>(
  route: R,
  options: ApiMutationOptions<R, TContext> = {},
): UseMutationResult<RouteResult<R>, ApiError, MutationVariables<R>, TContext> {
  const client = useQueryClient();
  const { invalidates, onSuccess, ...rest } = options;
  return useMutation<RouteResult<R>, ApiError, MutationVariables<R>, TContext>({
    ...rest,
    mutationFn: (variables) => call(route, variables ?? undefined) as Promise<RouteResult<R>>,
    onSuccess: async (...successArgs) => {
      if (invalidates && invalidates.length > 0) await invalidateApi(client, ...invalidates);
      return onSuccess?.(...successArgs);
    },
  });
}

/** Routes whose response is a cursor page `{ items, nextCursor }`. */
type PageOf<R extends RouteDef> =
  RouteResult<R> extends { items: (infer T)[]; nextCursor: string | null } ? T : never;

export interface ApiInfiniteOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
}

export type ApiInfiniteResult<R extends RouteDef> = UseInfiniteQueryResult<
  InfiniteData<RouteResult<R>, string | undefined>,
  ApiError
> & {
  /** Every loaded item, flattened in order. */
  items: PageOf<R>[];
};

/**
 * `useInfiniteQuery` for cursor-paginated list routes. Pass the query WITHOUT `cursor`; pair
 * it with `<LoadMore>` from the UI kit:
 *   <LoadMore hasMore={list.hasNextPage} loading={list.isFetchingNextPage} onLoadMore={list.fetchNextPage} />
 */
export function useApiInfiniteQuery<R extends RouteDef>(
  route: R,
  ...args: RouteArgs<R, ApiInfiniteOptions>
): ApiInfiniteResult<R> {
  const [input, options] = args;
  const loose = input as { params?: unknown; query?: Record<string, unknown> } | undefined;
  const result = useInfiniteQuery<
    RouteResult<R>,
    ApiError,
    InfiniteData<RouteResult<R>, string | undefined>,
    QueryKey,
    string | undefined
  >({
    ...options,
    queryKey: [
      ...apiQueryKey(route, { params: loose?.params, query: loose?.query ?? {} }),
      'infinite',
    ],
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      call(
        route,
        { ...loose, query: { ...loose?.query, ...(pageParam ? { cursor: pageParam } : {}) } },
        { signal },
      ) as Promise<RouteResult<R>>,
    getNextPageParam: (last) => (last as { nextCursor?: string | null }).nextCursor ?? undefined,
  });
  const items = useMemo(
    () =>
      (result.data?.pages ?? []).flatMap((page) => (page as { items: PageOf<R>[] }).items ?? []),
    [result.data],
  );
  return Object.assign(result, { items });
}

export interface UploadState<R extends RouteDef> {
  status: 'idle' | 'uploading' | 'success' | 'error';
  /** 0..1 */
  progress: number;
  error: ApiError | null;
  data: RouteResult<R> | null;
}

export interface UseUploadResult<R extends RouteDef> extends UploadState<R> {
  /** Start an upload; resolves with the response or rejects with an ApiError. */
  upload: (input: RouteInput<R>) => Promise<RouteResult<R>>;
  /** Abort the upload in flight. */
  cancel: () => void;
  reset: () => void;
}

/**
 * Upload helper for multipart routes with progress and cancel:
 *   const { upload, progress, status } = useUpload(api.assets.upload, { invalidates: [api.assets.list] });
 *   await upload({ file, fields: { name } });
 */
export function useUpload<R extends RouteDef>(
  route: R,
  options: { invalidates?: InvalidateTarget[] } = {},
): UseUploadResult<R> {
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<UploadState<R>>({
    status: 'idle',
    progress: 0,
    error: null,
    data: null,
  });
  const invalidates = options.invalidates;

  const upload = useCallback(
    async (input: RouteInput<R>) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setState({ status: 'uploading', progress: 0, error: null, data: null });
      try {
        const data = (await call(route, input, {
          signal: current.signal,
          onUploadProgress: (p) =>
            setState((prev) =>
              prev.status === 'uploading' ? { ...prev, progress: p.fraction } : prev,
            ),
        })) as RouteResult<R>;
        setState({ status: 'success', progress: 1, error: null, data });
        if (invalidates && invalidates.length > 0) await invalidateApi(client, ...invalidates);
        return data;
      } catch (err) {
        const error = err as ApiError;
        setState(
          error.code === 'ABORTED'
            ? { status: 'idle', progress: 0, error: null, data: null }
            : { status: 'error', progress: 0, error, data: null },
        );
        throw error;
      }
    },
    [client, invalidates, route],
  );

  const cancel = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => {
    controller.current?.abort();
    setState({ status: 'idle', progress: 0, error: null, data: null });
  }, []);

  return { ...state, upload, cancel, reset };
}
