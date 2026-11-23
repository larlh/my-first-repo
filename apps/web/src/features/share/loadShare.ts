import type { PublicShare } from '@parlante/shared';
import { apiClient } from '@/lib/api';

/* `GET /api/public/shares/:token` counts a view on the server every time it is called. A page
 * visit must therefore read it exactly once — also in development, where React StrictMode
 * mounts every component twice (a query tied to the component would start, abort and repeat
 * the request, and the aborted one is still counted). The read is shared per token and is not
 * cancellable; a failed read is forgotten so "retry" asks again. */

const inFlight = new Map<string, Promise<PublicShare>>();

export function loadShare(token: string): Promise<PublicShare> {
  const existing = inFlight.get(token);
  if (existing) return existing;
  const request = apiClient.share.public({ params: { token } }).catch((error: unknown) => {
    inFlight.delete(token);
    throw error;
  });
  inFlight.set(token, request);
  return request;
}

/** Forget what was read (tests). */
export function resetShareCache(): void {
  inFlight.clear();
}
