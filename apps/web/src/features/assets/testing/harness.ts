import { AssetSchema, StockAssetSchema } from '@parlante/shared';
import type { Asset, StockAsset } from '@parlante/shared';
import { vi } from 'vitest';
import { NOW, WS_A, fileUrl } from '../../videos/testing/harness';
import type { FakeApi } from '../../videos/testing/harness';

/* Test helpers of the assets feature: contract-checked fixtures and an XMLHttpRequest stand-in
 * (uploads with progress use XHR, which the fetch-based fake API of the shared harness does
 * not see). */

const pad = (n: number) => String(n).padStart(4, '0');

export function makeAsset(n: number, overrides: Partial<Asset> = {}): Asset {
  const id = overrides.id ?? `ast_${pad(n)}abcdefgh1234`;
  const kind = overrides.kind ?? 'image';
  const ext = kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
  return AssetSchema.parse({
    id,
    workspaceId: WS_A,
    kind,
    purpose: 'library',
    name: `Archivo ${n}`,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    sizeBytes: 2_516_582,
    width: kind === 'audio' ? null : 1920,
    height: kind === 'audio' ? null : 1080,
    durationMs: kind === 'image' ? null : 65_000,
    url: fileUrl(`ws/${WS_A}/assets/${id}/file.${ext}`),
    thumbnailUrl: kind === 'audio' ? null : fileUrl(`ws/${WS_A}/assets/${id}/thumb.jpg`),
    createdBy: { id: 'usr_a1b2c3d4e5f6g7h8', name: 'Lucía Ferrer' },
    createdAt: NOW,
    ...overrides,
  });
}

export function makeStock(id: string, overrides: Partial<StockAsset> = {}): StockAsset {
  return StockAssetSchema.parse({
    id,
    kind: 'image',
    category: 'background',
    name: `Fondo ${id}`,
    tags: ['fondo'],
    mimeType: 'image/png',
    width: 1920,
    height: 1080,
    durationMs: null,
    url: `/api/stock-assets/${id}/file`,
    ...overrides,
  });
}

export interface UploadCall {
  /** Text fields of the multipart body. */
  fields: Record<string, string>;
  file: File;
  /** Report upload progress (0..1). */
  progress: (fraction: number) => void;
  /** Answer the request. */
  respond: (status: number, body: unknown) => void;
  aborted: boolean;
}

/**
 * Replace XMLHttpRequest with a controllable stand-in. Every `POST /api/assets` shows up in
 * `uploads`; the test drives its progress and its answer. With `auto`, uploads answer at once
 * with whatever the function returns.
 */
export function stubUploads(
  api: FakeApi,
  auto?: (call: UploadCall) => { status: number; body: unknown },
): { uploads: UploadCall[]; restore: () => void } {
  const uploads: UploadCall[] = [];

  class FakeXhr {
    status = 0;
    responseText = '';
    withCredentials = false;
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private method = 'GET';
    private url = '';
    private call: UploadCall | null = null;

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(): void {}
    send(form: FormData): void {
      api.calls.push(`${this.method} ${new URL(this.url, 'http://localhost').pathname}`);
      const fields: Record<string, string> = {};
      let file: File | null = null;
      form.forEach((value, key) => {
        if (value instanceof File) file = value;
        else fields[key] = value;
      });
      const call: UploadCall = {
        fields,
        file: file as unknown as File,
        aborted: false,
        progress: (fraction) =>
          this.upload.onprogress?.({
            lengthComputable: true,
            loaded: fraction * 1000,
            total: 1000,
          } as ProgressEvent),
        respond: (status, body) => {
          if (call.aborted) return;
          this.status = status;
          this.responseText = JSON.stringify(body);
          this.onload?.();
        },
      };
      this.call = call;
      uploads.push(call);
      if (auto) {
        const answer = auto(call);
        queueMicrotask(() => call.respond(answer.status, answer.body));
      }
    }
    abort(): void {
      if (this.call) this.call.aborted = true;
      this.onabort?.();
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return { uploads, restore: () => vi.unstubAllGlobals() };
}

export function pngFile(name: string, size = 2048): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}
