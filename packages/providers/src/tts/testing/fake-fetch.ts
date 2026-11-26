import type { SpeechFetch, SpeechHttpOptions } from '../http';

/* Test double for the external speech services: records every request and answers from a
 * queue of scripted replies (the last one repeats). No network, no real waiting. */

/** A multipart field: text or a file. */
export type FormValue = ReturnType<FormData['getAll']>[number];

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, FormData fields, or null. */
  json: unknown;
  form: Map<string, FormValue[]> | null;
}

export type Reply = Response | Error | ((call: RecordedCall) => Response | Promise<Response>);

export interface FakeService {
  http: SpeechHttpOptions;
  calls: RecordedCall[];
  /** Milliseconds the adapter asked to wait between attempts. */
  sleeps: number[];
}

export function jsonReply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function bytesReply(bytes: Uint8Array, status = 200) {
  return new Response(bytes, { status, headers: { 'content-type': 'application/octet-stream' } });
}

export function fakeService(replies: Reply[]): FakeService {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let json: unknown = null;
    let form: RecordedCall['form'] = null;
    if (typeof init?.body === 'string') {
      json = JSON.parse(init.body) as unknown;
    } else if (init?.body instanceof FormData) {
      form = new Map();
      for (const [key, value] of init.body.entries()) {
        form.set(key, [...(form.get(key) ?? []), value]);
      }
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      json,
      form,
    };
    calls.push(call);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error('fakeService: no reply scripted');
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply.clone();
    return reply(call);
  };
  return {
    http: {
      fetch: fetchImpl as SpeechFetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
    calls,
    sleeps,
  };
}

/** PCM16 little-endian bytes of a sine tone (what the services return as raw audio). */
export function tonePcmBytes(durationMs: number, sampleRate: number, hz = 220): Uint8Array {
  const count = Math.round((durationMs * sampleRate) / 1000);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i += 1) {
    view.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / sampleRate)), true);
  }
  return bytes;
}
