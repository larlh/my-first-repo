import { parseSubtitles } from '@parlante/shared';
import type { TimedText } from '@parlante/shared';
import { downloadUrl, toAppUrl } from '@/lib/api';

/* Subtitle files are small text files behind signed URLs. They are fetched as text both to
 * show the transcript and to hand the browser a real download (a cross-origin `<a download>`
 * would just open the file in a tab). */

export async function fetchSubtitleCues(url: string, signal?: AbortSignal): Promise<TimedText[]> {
  const response = await fetch(toAppUrl(url), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseSubtitles(await response.text());
}

/** Signed file URLs of the API accept `&download=<name>` to be served as an attachment. */
export function withDownloadName(url: string, fileName: string): string {
  if (!/[?&]sig=/.test(url) || /[?&]download=/.test(url)) return url;
  return `${url}&download=${encodeURIComponent(fileName)}`;
}

/**
 * Save a text file (SRT / VTT) under `fileName`. Preferred path: fetch it and download a Blob,
 * which works for any origin that allows the read. Fallback: let the server name the file.
 */
export async function downloadTextFile(url: string, fileName: string): Promise<void> {
  try {
    const response = await fetch(toAppUrl(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      downloadUrl(objectUrl, fileName);
    } finally {
      // Give the browser a moment to start the download before the URL is revoked.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
    }
  } catch {
    downloadUrl(withDownloadName(url, fileName), fileName);
  }
}

/** Copy text to the clipboard; resolves to false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
