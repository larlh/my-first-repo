import type { ProviderRef, SceneRuntime, SynthesizedSpeech } from '@parlante/shared';

/* Client cache of synthesised narration. One entry per distinct (text, voice, speed, pitch,
 * language): editing a scene back to a text it already had, or two scenes that say the same,
 * cost no request. The API caches by content hash too, so this only saves round trips. */

export interface SpeechRequest {
  text: string;
  voiceId: string;
  speed: number;
  pitch: number;
  language: string;
}

export interface SpeechEntry {
  key: string;
  status: 'loading' | 'ready' | 'error';
  runtime: SceneRuntime | null;
  audioUrl: string | null;
  provider: ProviderRef | null;
  /** Decoded audio for WebAudio playback; null when it could not be decoded (or no WebAudio). */
  buffer: AudioBuffer | null;
  error: unknown;
}

export function speechKey(request: SpeechRequest): string {
  return JSON.stringify([
    request.text,
    request.voiceId,
    request.speed,
    request.pitch,
    request.language,
  ]);
}

export interface SpeechDeps {
  synthesize: (request: SpeechRequest) => Promise<SynthesizedSpeech>;
  /** Fetch + decode the WAV. May resolve null (no WebAudio): the mouth still moves. */
  decode: (url: string) => Promise<AudioBuffer | null>;
  /** Requests running at once (the API rate-limits synthesis). */
  concurrency?: number;
}

export class SpeechCache {
  private readonly entries = new Map<string, SpeechEntry>();
  private readonly pending = new Map<string, Promise<SpeechEntry>>();
  private readonly listeners = new Set<() => void>();
  private readonly queue: (() => void)[] = [];
  private running = 0;

  constructor(private readonly deps: SpeechDeps) {}

  get(key: string): SpeechEntry | undefined {
    return this.entries.get(key);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Synthesise (once) and resolve with the settled entry. Never rejects. */
  ensure(request: SpeechRequest, options: { retry?: boolean } = {}): Promise<SpeechEntry> {
    const key = speechKey(request);
    const existing = this.entries.get(key);
    if (existing?.status === 'ready') return Promise.resolve(existing);
    if (existing?.status === 'error' && !options.retry) return Promise.resolve(existing);
    const pending = this.pending.get(key);
    if (pending) return pending;
    this.put({
      key,
      status: 'loading',
      runtime: null,
      audioUrl: null,
      provider: null,
      buffer: null,
      error: null,
    });
    const job = this.slot()
      .then(() => this.deps.synthesize(request))
      .then(async (speech) => {
        const buffer = await this.deps.decode(speech.audioUrl).catch(() => null);
        return this.put({
          key,
          status: 'ready',
          runtime: speech.runtime,
          audioUrl: speech.audioUrl,
          provider: speech.provider,
          buffer,
          error: null,
        });
      })
      .catch((error: unknown) =>
        this.put({
          key,
          status: 'error',
          runtime: null,
          audioUrl: null,
          provider: null,
          buffer: null,
          error,
        }),
      )
      .finally(() => {
        this.pending.delete(key);
        this.release();
      });
    this.pending.set(key, job);
    return job;
  }

  private put(entry: SpeechEntry): SpeechEntry {
    this.entries.set(entry.key, entry);
    for (const listener of [...this.listeners]) listener();
    return entry;
  }

  private slot(): Promise<void> {
    const limit = this.deps.concurrency ?? 2;
    if (this.running < limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.running -= 1;
  }
}
