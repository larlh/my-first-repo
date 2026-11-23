import Anthropic from '@anthropic-ai/sdk';

/* -------------------------------------------------------------------------------------------
 * Test double for the Anthropic API at the HTTP level: a REAL SDK client whose `fetch` is a
 * stub. Requests are therefore built, validated and parsed by the official SDK (headers, JSON
 * body, structured-output parsing, SSE decoding) — only the network is fake.
 * ----------------------------------------------------------------------------------------- */

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type Reply =
  | { kind: 'json'; text: string; stopReason?: string; stopDetails?: Record<string, unknown> }
  | { kind: 'stream'; chunks: string[]; stopReason?: string }
  | { kind: 'error'; status: number; type: string; message: string };

export interface FakeAnthropic {
  client: Anthropic;
  requests: RecordedRequest[];
  /** Replies handed out in order; the last one repeats. */
  replies: Reply[];
}

function messageJson(reply: Extract<Reply, { kind: 'json' }>, model: string): unknown {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: reply.text === '' ? [] : [{ type: 'text', text: reply.text }],
    stop_reason: reply.stopReason ?? 'end_turn',
    stop_sequence: null,
    stop_details: reply.stopDetails ?? null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function sse(reply: Extract<Reply, { kind: 'stream' }>, model: string): string {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    ...reply.chunks.map((text): [string, unknown] => [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: reply.stopReason ?? 'end_turn', stop_sequence: null },
        usage: { output_tokens: 20 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

export function fakeAnthropic(replies: Reply[]): FakeAnthropic {
  const fake: FakeAnthropic = { client: undefined as unknown as Anthropic, requests: [], replies };
  let served = 0;
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    fake.requests.push({
      url: String(input instanceof Request ? input.url : input),
      headers,
      body,
    });
    const reply = fake.replies[Math.min(served, fake.replies.length - 1)]!;
    served += 1;
    const model = String(body.model);
    if (reply.kind === 'error') {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } }),
        { status: reply.status, headers: { 'content-type': 'application/json' } },
      );
    }
    if (reply.kind === 'stream') {
      return new Response(sse(reply, model), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(messageJson(reply, model)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  fake.client = new Anthropic({
    apiKey: 'test-key-not-real',
    fetch: fetchStub as unknown as typeof fetch,
    maxRetries: 0,
  });
  return fake;
}
