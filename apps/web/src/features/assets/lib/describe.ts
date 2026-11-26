import type { Asset } from '@parlante/shared';
import type { Formatters } from '@/lib/format';

/** "1920 × 1080" for visual media, null otherwise. */
export function dimensionsOf(asset: Pick<Asset, 'width' | 'height'>): string | null {
  return asset.width !== null && asset.height !== null ? `${asset.width} × ${asset.height}` : null;
}

/** Short facts under a file name: size, then dimensions or duration ("2,4 MB · 1920 × 1080"). */
export function assetFacts(
  asset: Pick<Asset, 'kind' | 'sizeBytes' | 'width' | 'height' | 'durationMs'>,
  format: Pick<Formatters, 'bytes' | 'clock'>,
): string {
  const facts = [format.bytes(asset.sizeBytes)];
  if (asset.kind === 'image') {
    const size = dimensionsOf(asset);
    if (size) facts.push(size);
  } else if (asset.durationMs !== null) {
    facts.push(format.clock(asset.durationMs));
  }
  return facts.join(' · ');
}

export interface AssetUse {
  type: 'translationJob' | 'avatar' | 'voice';
  id: string;
}

/** Resources that still use an asset as their source (details of a 409 on delete). */
export function usesFromConflict(details: unknown): AssetUse[] {
  const raw = (details as { usedBy?: unknown } | undefined)?.usedBy;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is AssetUse =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as AssetUse).id === 'string' &&
      ['translationJob', 'avatar', 'voice'].includes((item as AssetUse).type),
  );
}

/** Extension of the stored file, read from the path of its (signed) URL. */
export function extensionOfUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

/** File name offered when downloading: the display name plus the real extension. */
export function downloadName(asset: Pick<Asset, 'name' | 'url'>): string {
  const ext = extensionOfUrl(asset.url);
  const safe =
    asset.name
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'asset';
  return ext && !safe.toLowerCase().endsWith(`.${ext}`) ? `${safe}.${ext}` : safe;
}

/**
 * Signed file URLs accept `download=<name>` and are then served as an attachment; that works
 * across origins, where the `download` attribute of a link is ignored.
 */
export function downloadHref(asset: Pick<Asset, 'name' | 'url'>): string {
  const separator = asset.url.includes('?') ? '&' : '?';
  return `${asset.url}${separator}download=${encodeURIComponent(downloadName(asset))}`;
}
