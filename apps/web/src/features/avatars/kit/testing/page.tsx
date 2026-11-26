import { afterEach, beforeEach, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import { defineFeature } from '@/shell';
import { toast } from '@/ui';
import { resetApiClient, watchContractWarnings } from '@/features/videos/testing/harness';

/* Shared setup of the page tests of the library features. The harness itself (fake API,
 * real shell router) is the one of the web-core features. */

const RealXhr = globalThis.XMLHttpRequest;

export interface FakeUpload {
  url: string;
  /** Text fields of the multipart body. */
  fields: Record<string, string>;
  file: File | null;
}

/**
 * Replace XMLHttpRequest (the transport of uploads with progress) with a fake that answers
 * every upload with `respond(upload)`: `{ status, body }`. Returns the uploads seen.
 */
export function fakeUploads(
  respond: (upload: FakeUpload) => { status: number; body: unknown },
): FakeUpload[] {
  const seen: FakeUpload[] = [];
  class FakeXhr {
    status = 0;
    responseText = '';
    withCredentials = false;
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private url = '';
    open(_method: string, url: string): void {
      this.url = url;
    }
    setRequestHeader(): void {}
    abort(): void {
      this.onabort?.();
    }
    send(form: FormData): void {
      const fields: Record<string, string> = {};
      let file: File | null = null;
      form.forEach((value, key) => {
        if (typeof value === 'string') fields[key] = value;
        else file = value;
      });
      const upload: FakeUpload = { url: this.url, fields, file };
      seen.push(upload);
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
        const answer = respond(upload);
        this.status = answer.status;
        this.responseText = JSON.stringify(answer.body);
        this.onload?.();
      });
    }
  }
  // Restored by `usePageTestSetup` after each test.
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  return seen;
}

/** Stand-ins for sections owned by other features, so optional links and actions exist. */
export const others = defineFeature({
  id: 'others',
  routes: [
    { path: '/studio/:videoId', layout: 'fullscreen', component: () => <h1>Studio</h1> },
    { path: '/settings/billing', layout: 'app', component: () => <h1>Facturación</h1> },
    { path: '/settings/consents', layout: 'app', component: () => <h1>Consentimientos</h1> },
  ],
});

/**
 * Call at the top of a `describe`: Spanish UI, contract drift fails the test, media and
 * object URLs (missing in jsdom) are stubbed, and everything is undone afterwards.
 */
export function usePageTestSetup(): { play: ReturnType<typeof vi.fn> } {
  const play = vi.fn(() => Promise.resolve());
  let contract: ReturnType<typeof watchContractWarnings>;
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('es');
    contract = watchContractWarnings();
    play.mockClear();
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    // jsdom has no canvas: stages and players simply do not draw.
    vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    contract.assert();
    contract.restore();
    resetApiClient();
    toast.clear();
    vi.restoreAllMocks();
    globalThis.XMLHttpRequest = RealXhr;
  });
  return { play };
}
