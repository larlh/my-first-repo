/**
 * The API returns absolute, signed file URLs (`${PUBLIC_API_URL}/api/files/...`). In
 * development the Vite server proxies `/api` to the API, so mapping those URLs onto the app
 * origin keeps media same-origin: `fetch()` of subtitles needs no CORS and canvases that draw
 * images/videos stay readable. In production (or for any other URL) the URL is returned as is.
 */
export function toAppUrl(url: string): string;
export function toAppUrl(url: string | null | undefined): string | undefined;
export function toAppUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined || url === '') return undefined;
  const target =
    typeof __PARLANTE_API_PROXY_TARGET__ === 'string' ? __PARLANTE_API_PROXY_TARGET__ : '';
  if (
    import.meta.env.DEV &&
    !import.meta.env.VITE_API_URL &&
    target &&
    url.startsWith(`${target}/`)
  ) {
    return url.slice(target.length);
  }
  return url;
}

/** Trigger a browser download of a URL (signed file URLs accept `&download=<name>`). */
export function downloadUrl(url: string, fileName?: string): void {
  const link = document.createElement('a');
  link.href = toAppUrl(url);
  if (fileName) link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
