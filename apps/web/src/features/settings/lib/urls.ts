/* URLs of the API as seen from the browser. In development (and behind a reverse proxy) the
 * API is served from the app origin; otherwise `VITE_API_URL` points at it. */

export function apiBaseUrl(): string {
  const configured = (import.meta.env.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

/** Interactive OpenAPI documentation served by the API itself (Swagger UI). */
export function apiDocsUrl(): string {
  return `${apiBaseUrl()}/docs`;
}

/** Machine-readable OpenAPI document. */
export function openApiUrl(): string {
  return `${apiBaseUrl()}/openapi.json`;
}

/** Example request shown after creating an API key. */
export function curlExample(key: string): string {
  return `curl ${apiBaseUrl()}/v1/me \\\n  -H "Authorization: Bearer ${key}"`;
}
