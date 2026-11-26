import { ALLOWED_UPLOAD_MIME, assetKindForMime } from '@parlante/shared';
import type { AssetKind } from '@parlante/shared';

/* What may be uploaded, checked in the browser BEFORE sending anything. The server decides
 * again from the real bytes of the file (never trust this check). */

export const ASSET_KINDS = ['image', 'video', 'audio'] as const satisfies readonly AssetKind[];

/** File extensions per kind, for browsers that report an empty or exotic MIME type. */
const EXTENSIONS: Record<AssetKind, readonly string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  video: ['mp4', 'webm', 'mov'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'weba'],
};

/** Formats named in the upload hint, per kind. */
export const FORMAT_LABELS: Record<AssetKind, string> = {
  image: 'PNG, JPG, WebP, GIF',
  video: 'MP4, WebM, MOV',
  audio: 'MP3, WAV, OGG, M4A, AAC, FLAC',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Kind of a file from its MIME type, falling back to the extension. Null = not accepted. */
export function kindOfFile(file: Pick<File, 'name' | 'type'>): AssetKind | null {
  const byMime = assetKindForMime(file.type.toLowerCase());
  if (byMime) return byMime;
  // Only trust the extension when the browser gave no usable type at all.
  if (file.type !== '' && file.type !== 'application/octet-stream') return null;
  const ext = extensionOf(file.name);
  return ASSET_KINDS.find((kind) => EXTENSIONS[kind].includes(ext)) ?? null;
}

/** `accept` attribute of the file input for the given kinds (MIME types + extensions). */
export function acceptFor(kinds: readonly AssetKind[] = ASSET_KINDS): string[] {
  return kinds.flatMap((kind) => [
    ...ALLOWED_UPLOAD_MIME[kind],
    ...EXTENSIONS[kind].map((ext) => `.${ext}`),
  ]);
}

export type RejectReason = 'type' | 'kind' | 'empty' | 'size' | 'storage';

export interface UploadRules {
  /** Largest single file of the plan (`maxUploadBytes`). */
  maxUploadBytes: number;
  /** Bytes still free in the workspace storage; null while unknown (the server checks). */
  storageLeftBytes: number | null;
  /** Restrict to some kinds (the picker asks only for what the slot can use). */
  kinds?: readonly AssetKind[];
}

export interface FileCheck {
  kind: AssetKind | null;
  reason: RejectReason | null;
}

export function checkFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  rules: UploadRules,
): FileCheck {
  const kind = kindOfFile(file);
  if (!kind) return { kind: null, reason: 'type' };
  if (rules.kinds && !rules.kinds.includes(kind)) return { kind, reason: 'kind' };
  if (file.size === 0) return { kind, reason: 'empty' };
  if (file.size > rules.maxUploadBytes) return { kind, reason: 'size' };
  if (rules.storageLeftBytes !== null && file.size > rules.storageLeftBytes) {
    return { kind, reason: 'storage' };
  }
  return { kind, reason: null };
}

export interface CheckedFile<F> {
  file: F;
  kind: AssetKind | null;
  reason: RejectReason | null;
}

/**
 * Check a whole selection. Files are accepted in order while they fit in the storage that is
 * left, so dropping ten files with room for three accepts three and explains the other seven.
 */
export function checkFiles<F extends Pick<File, 'name' | 'type' | 'size'>>(
  files: readonly F[],
  rules: UploadRules,
): CheckedFile<F>[] {
  let left = rules.storageLeftBytes;
  return files.map((file) => {
    const check = checkFile(file, { ...rules, storageLeftBytes: left });
    if (check.reason === null && left !== null) left -= file.size;
    return { file, ...check };
  });
}

/** Display name of an upload: the file name without its extension, trimmed to the API limit. */
export function displayNameOf(fileName: string, max = 120): string {
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  return (base || fileName).slice(0, max);
}
