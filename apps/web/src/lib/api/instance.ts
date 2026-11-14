import { api } from '@parlante/shared';
import { createApiClient, createApiRequester } from './client';

/** Shared requester: `apiRequester.request(route, input)` for code that receives a RouteDef. */
export const apiRequester = createApiRequester({
  baseUrl: (import.meta.env.VITE_API_URL ?? '').trim(),
});

/**
 * The typed client for the whole contract: `apiClient.videos.get({ params: { videoId } })`.
 * Derived at runtime from `api`, so new routes in @parlante/shared appear here untouched.
 */
export const apiClient = createApiClient(api, apiRequester);
