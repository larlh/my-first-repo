import { buildPath } from '@parlante/shared';
import type {
  MultipartSpec,
  RouteBodyInput,
  RouteDef,
  RouteParamsInput,
  RouteQueryInput,
  RouteResponse,
} from '@parlante/shared';
import type { z } from 'zod';
import { ApiError, errorFromResponse, toApiError } from './errors';

/* -------------------------------------------------------------------------------------------
 * Typed API client derived from the route table of @parlante/shared.
 *
 * Nothing here knows a concrete endpoint: the types are computed from each `RouteDef` (zod
 * input types for params / query / body, zod output type for the response) and the runtime
 * walks the `api` object. When shared adds a route, `apiClient.<group>.<name>` exists and is
 * typed without touching this file.
 * ----------------------------------------------------------------------------------------- */

type Simplify<T> = { [K in keyof T]: T[K] } & unknown;

/** `{ key: T }`, optional when T accepts an empty object, absent when the route has no T. */
type Slot<K extends string, T> = [T] extends [undefined]
  ? unknown
  : Partial<T> extends T
    ? { [P in K]?: T }
    : { [P in K]: T };

type MultipartSlot<R extends RouteDef> = R extends { multipart: infer M extends MultipartSpec }
  ? {
      /** The file part (a `File` keeps its name; pass `fileName` for a bare Blob). */
      file: Blob;
      fileName?: string;
      /** Text fields sent next to the file. */
      fields?: z.input<M['fields']>;
    }
  : unknown;

/** What a caller passes for a route: `{ params?, query?, body? }` (+ `file`/`fields`). */
export type RouteInput<R extends RouteDef> = Simplify<
  Slot<'params', RouteParamsInput<R>> &
    Slot<'query', RouteQueryInput<R>> &
    Slot<'body', RouteBodyInput<R>> &
    MultipartSlot<R>
>;

/** What a caller gets back: the parsed JSON body, or a Blob for `binary` routes. */
export type RouteResult<R extends RouteDef> = R extends { binary: true } ? Blob : RouteResponse<R>;

/** True when every part of the input is optional (the whole argument can be omitted). */
export type InputOptional<R extends RouteDef> =
  Partial<RouteInput<R>> extends RouteInput<R> ? true : false;

/** Argument list `(input, extra?)` where `input` is optional when it has no required part. */
export type RouteArgs<R extends RouteDef, Extra> =
  InputOptional<R> extends true
    ? [input?: RouteInput<R>, extra?: Extra]
    : [input: RouteInput<R>, extra?: Extra];

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0..1 (0 while the total is unknown). */
  fraction: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Do not notify `onUnauthenticated` for a 401 on this call (used by the session probe). */
  skipAuthRedirect?: boolean;
  /** Upload progress for multipart routes (switches the transport to XMLHttpRequest). */
  onUploadProgress?: (progress: UploadProgress) => void;
  headers?: Record<string, string>;
}

export interface ApiClientConfig {
  /** Prefix for every path. Empty = same origin (Vite proxy / reverse proxy). */
  baseUrl?: string;
  /** Called when a `session` route answers 401 UNAUTHENTICATED (expired or missing session). */
  onUnauthenticated?: (info: { route: RouteDef; error: ApiError }) => void;
  /** Check success bodies against the route schema and warn on drift (default: dev only). */
  validateResponses?: boolean;
  fetch?: typeof fetch;
}

interface LooseInput {
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  file?: Blob;
  fileName?: string;
  fields?: Record<string, unknown>;
}

export type RouteCaller<R extends RouteDef> = (
  ...args: RouteArgs<R, RequestOptions>
) => Promise<RouteResult<R>>;

export type ApiClient<C> = {
  readonly [G in keyof C]: {
    readonly [N in keyof C[G]]: C[G][N] extends RouteDef ? RouteCaller<C[G][N]> : never;
  };
};

export interface ApiRequester {
  /** Call any RouteDef: `request(api.videos.get, { params: { videoId } })`. */
  request<R extends RouteDef>(
    route: R,
    ...args: RouteArgs<R, RequestOptions>
  ): Promise<RouteResult<R>>;
  /** Absolute-or-relative URL of a route (links, `<a download>`, EventSource…). */
  url<R extends RouteDef>(route: R, input?: Pick<LooseInput, 'params' | 'query'>): string;
  /** Change settings after creation (the app shell wires `onUnauthenticated`). */
  configure(patch: Partial<ApiClientConfig>): void;
}

function buildFormData(route: RouteDef, input: LooseInput): FormData {
  const form = new FormData();
  // Text fields go first: the API parses the stream in order and needs them before the file.
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const field = route.multipart?.fileField ?? 'file';
  if (!input.file) throw new ApiError('BAD_REQUEST', `Missing "${field}" file`);
  const name = input.fileName ?? (input.file instanceof File ? input.file.name : 'upload.bin');
  form.append(field, input.file, name);
  return form;
}

async function readJson(text: string, status: number): Promise<unknown> {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (status >= 200 && status < 300) {
      throw new ApiError('INVALID_RESPONSE', 'The server did not answer with JSON', status);
    }
    return undefined;
  }
}

/** XMLHttpRequest transport, used only when upload progress is requested. */
function xhrUpload(
  method: string,
  url: string,
  form: FormData,
  options: RequestOptions,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : 0;
      options.onUploadProgress?.({
        loaded: event.loaded,
        total,
        fraction: total > 0 ? Math.min(1, event.loaded / total) : 0,
      });
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new ApiError('NETWORK_ERROR', 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError('ABORTED', 'Upload aborted'));
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new ApiError('ABORTED', 'Upload aborted'));
        return;
      }
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(form);
  });
}

export function createApiRequester(initial: ApiClientConfig = {}): ApiRequester {
  const config: ApiClientConfig = { ...initial };

  const fullUrl = (route: RouteDef, input?: Pick<LooseInput, 'params' | 'query'>): string =>
    (config.baseUrl ?? '').replace(/\/+$/, '') + buildPath(route.path, input?.params, input?.query);

  function fail(route: RouteDef, error: ApiError, options: RequestOptions): never {
    if (
      error.status === 401 &&
      error.code === 'UNAUTHENTICATED' &&
      route.auth === 'session' &&
      !options.skipAuthRedirect
    ) {
      config.onUnauthenticated?.({ route, error });
    }
    throw error;
  }

  function checkContract(route: RouteDef, data: unknown): void {
    const enabled = config.validateResponses ?? import.meta.env.DEV;
    if (!enabled) return;
    const result = route.response.safeParse(data);
    if (!result.success) {
      console.warn(
        `[api] ${route.method} ${route.path} answered a body that does not match the contract`,
        result.error.issues.slice(0, 5),
      );
    }
  }

  async function request(
    route: RouteDef,
    input: LooseInput = {},
    options: RequestOptions = {},
  ): Promise<unknown> {
    const url = fullUrl(route, input);
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };

    let status: number;
    let text: string;

    try {
      if (route.multipart) {
        const form = buildFormData(route, input);
        if (options.onUploadProgress) {
          ({ status, text } = await xhrUpload(route.method, url, form, options));
        } else {
          const res = await (config.fetch ?? fetch)(url, {
            method: route.method,
            credentials: 'include',
            headers,
            body: form,
            signal: options.signal,
          });
          status = res.status;
          text = await res.text();
        }
      } else {
        const hasBody =
          route.method !== 'GET' && (route.body !== undefined || input.body !== undefined);
        if (hasBody) headers['Content-Type'] = 'application/json';
        const res = await (config.fetch ?? fetch)(url, {
          method: route.method,
          credentials: 'include',
          headers,
          // A route with a body schema always gets a JSON object so server defaults apply.
          body: hasBody ? JSON.stringify(input.body ?? {}) : undefined,
          signal: options.signal,
        });
        status = res.status;
        if (route.binary && res.ok) return await res.blob();
        text = await res.text();
      }
    } catch (err) {
      throw toApiError(err);
    }

    const body = await readJson(text, status);
    if (status < 200 || status >= 300) fail(route, errorFromResponse(status, body), options);
    checkContract(route, body);
    return body;
  }

  return {
    request: request as ApiRequester['request'],
    url: fullUrl,
    configure(patch) {
      Object.assign(config, patch);
    },
  };
}

/**
 * Build `client.<group>.<name>(input, options)` for every route of a contract object.
 * Generic on purpose: pass `api` from @parlante/shared (or any `{ group: { name: RouteDef } }`).
 */
export function createApiClient<const C extends Record<string, Record<string, RouteDef>>>(
  contract: C,
  requester: ApiRequester,
): ApiClient<C> {
  const client: Record<string, Record<string, unknown>> = {};
  for (const [group, routes] of Object.entries(contract)) {
    const calls: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(routes)) {
      calls[name] = (input?: unknown, options?: RequestOptions) =>
        (requester.request as (r: RouteDef, i?: unknown, o?: RequestOptions) => Promise<unknown>)(
          def,
          input,
          options,
        );
    }
    client[group] = Object.freeze(calls);
  }
  return Object.freeze(client) as ApiClient<C>;
}
