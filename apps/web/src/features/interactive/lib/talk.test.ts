import { InteractiveReplySchema, sceneRuntimeFromTranscript } from '@parlante/shared';
import { computeAvatarState } from '@parlante/renderer';
import { describe, expect, it } from 'vitest';
import {
  captionAt,
  fromHistory,
  talkPose,
  withFailure,
  withPending,
  withReply,
  withoutMessage,
} from './talk';

const NOW = '2026-11-20T10:00:00.000Z';
const TEXT = 'Abrimos de lunes a viernes de nueve a ocho.';
const runtime = sceneRuntimeFromTranscript(TEXT, 3000);

const reply = InteractiveReplySchema.parse({
  userMessage: {
    id: 'ivm_user0000000000001',
    sessionId: 'ivs_a1b2c3d4e5f6g7h8',
    role: 'user',
    text: '¿Cuál es el horario?',
    createdAt: NOW,
  },
  assistantMessage: {
    id: 'ivm_asst0000000000001',
    sessionId: 'ivs_a1b2c3d4e5f6g7h8',
    role: 'assistant',
    text: TEXT,
    createdAt: NOW,
  },
  speech: {
    audioUrl: 'http://localhost:4000/api/files/cache/tts/abc.wav?exp=1&sig=x',
    mimeType: 'audio/wav',
    runtime,
    provider: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic', local: true },
  },
  providers: {
    llm: { id: 'heuristic', name: 'Heurística local', quality: 'basic', local: true },
    tts: { id: 'espeak', name: 'eSpeak NG (local)', quality: 'basic', local: true },
  },
});

describe('talkPose', () => {
  it('is exactly the renderer pose while speaking, so the lips match an exported video', () => {
    for (const speechMs of [0, 400, 1200, 2600]) {
      expect(
        talkPose({ phase: 'speaking', runtime, speechMs, nowMs: 5000, seed: 'stock_lucia' }),
      ).toEqual(computeAvatarState({ runtime, speechMs, sceneMs: 5000, seed: 'stock_lucia' }));
    }
  });

  it('opens the mouth during the speech and keeps it closed when idle or thinking', () => {
    const open = Array.from({ length: 30 }, (_, index) =>
      talkPose({
        phase: 'speaking',
        runtime,
        speechMs: 100 + index * 90,
        nowMs: 1000,
        seed: 'a',
      }),
    );
    const shapes = new Set(open.map((state) => JSON.stringify(state.mouth)));
    // The mouth takes several different shapes along one sentence.
    expect(shapes.size).toBeGreaterThan(3);

    const idle = talkPose({ phase: 'idle', runtime: null, speechMs: null, nowMs: 1000, seed: 'a' });
    const rest = computeAvatarState({ runtime: null, speechMs: -1, sceneMs: 1000, seed: 'a' });
    expect(idle).toEqual(rest);
    // A leftover timeline is ignored once the audio stopped.
    expect(
      talkPose({ phase: 'idle', runtime, speechMs: 500, nowMs: 1000, seed: 'a' }).mouth,
    ).toEqual(rest.mouth);
  });

  it('looks up and aside while thinking, deterministically', () => {
    const input = {
      phase: 'thinking',
      runtime: null,
      speechMs: null,
      nowMs: 2500,
      seed: 'a',
    } as const;
    const thinking = talkPose(input);
    const rest = talkPose({ ...input, phase: 'idle' });
    expect(thinking.gaze.y).toBeLessThan(-0.4);
    expect(thinking.brow).toBe(0.45);
    expect(rest.brow ?? 0).toBeLessThan(0.45);
    expect(thinking.mouth).toEqual(rest.mouth);
    expect(talkPose(input)).toEqual(thinking);
    for (const value of [
      thinking.gaze.x,
      thinking.head.nod,
      thinking.head.turn,
      thinking.head.tilt,
    ]) {
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
  });
});

describe('captionAt', () => {
  const words = runtime.words;

  it('shows the line that contains the word being said', () => {
    expect(captionAt(words, null)).toBeNull();
    expect(captionAt(words, -1)).toBeNull();
    expect(captionAt([], 100)).toBeNull();

    const first = captionAt(words, (words[0]?.tMs ?? 0) + 1, 4);
    expect(first?.words).toEqual(words.slice(0, 4).map((word) => word.text));
    expect(first?.active).toBe(0);

    const fifth = words[4];
    expect(fifth).toBeDefined();
    const second = captionAt(words, (fifth?.tMs ?? 0) + 1, 4);
    expect(second?.words).toEqual(words.slice(4, 8).map((word) => word.text));
    expect(second?.active).toBe(0);
  });

  it('highlights nothing after the last word ended', () => {
    const last = words.at(-1);
    const after = captionAt(words, (last?.tMs ?? 0) + (last?.durMs ?? 0) + 500, 4);
    expect(after?.active).toBe(-1);
    expect(after?.words.at(-1)).toBe(last?.text);
  });
});

describe('message list', () => {
  it('shows the message at once and swaps it for the stored pair when the reply arrives', () => {
    const history = fromHistory([reply.userMessage, reply.assistantMessage]);
    expect(history.every((message) => message.speech === undefined)).toBe(true);

    const pending = withPending([], 'pending-1', '¿Cuál es el horario?', NOW);
    expect(pending).toEqual([
      {
        id: 'pending-1',
        role: 'user',
        text: '¿Cuál es el horario?',
        createdAt: NOW,
        pending: true,
      },
    ]);

    const answered = withReply(pending, 'pending-1', reply);
    expect(answered.map((message) => message.id)).toEqual([
      'ivm_user0000000000001',
      'ivm_asst0000000000001',
    ]);
    expect(answered[0]?.pending).toBeUndefined();
    expect(answered[1]?.speech?.runtime.audioDurationMs).toBe(3000);
    expect(answered[1]?.providers?.llm?.quality).toBe('basic');
    // A reply whose optimistic message is gone is still appended whole.
    expect(withReply([], 'pending-9', reply)).toHaveLength(2);
  });

  it('keeps a rejected message with its reason until it is retried or removed', () => {
    const failed = withFailure(
      withPending([], 'pending-1', 'hola', NOW),
      'pending-1',
      'CONTENT_BLOCKED',
    );
    expect(failed[0]).toMatchObject({ pending: false, failed: true, errorCode: 'CONTENT_BLOCKED' });
    expect(withoutMessage(failed, 'pending-1')).toEqual([]);
  });
});
