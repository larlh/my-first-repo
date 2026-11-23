import type {
  InteractiveMessage,
  InteractiveReply,
  InteractiveSession,
  Provenance,
  SceneRuntime,
  SynthesizedSpeech,
  WordCue,
} from '@parlante/shared';
import { computeAvatarState } from '@parlante/renderer';
import type { AvatarState } from '@parlante/renderer';

/* Pure model of a conversation with the interactive avatar: what the avatar is doing, the
 * pose to draw for it and the list of messages with its optimistic updates. No React. */

/* ---------- what the avatar is doing ---------- */

/**
 *  - `idle`:     waiting for the person (breathing, blinking)
 *  - `thinking`: the message was sent and the reply has not arrived
 *  - `speaking`: the reply is being played; the mouth follows its viseme timeline
 */
export type TalkPhase = 'idle' | 'thinking' | 'speaking';

export interface TalkPoseInput {
  phase: TalkPhase;
  /** Viseme / word timeline of the reply being spoken. */
  runtime: SceneRuntime | null;
  /** Position of the audio in ms; null or negative when it is not playing. */
  speechMs: number | null;
  /** Page time (ms): drives blinking, breathing and the slow drift of the head. */
  nowMs: number;
  /** Stable per avatar, so each one blinks on its own rhythm. */
  seed: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Pose of the avatar for one animation frame. It always comes from `computeAvatarState` of
 * @parlante/renderer — the function behind the Studio preview and the export — so the mouth
 * of a live answer moves exactly like it would in a rendered video. While thinking, the idle
 * pose looks up and aside with raised brows (a deterministic tweak, no randomness).
 */
export function talkPose(input: TalkPoseInput): AvatarState {
  const sceneMs = Math.max(0, input.nowMs);
  if (input.phase === 'speaking' && input.runtime) {
    return computeAvatarState({
      runtime: input.runtime,
      speechMs: input.speechMs ?? -1,
      sceneMs,
      seed: input.seed,
    });
  }
  const rest = computeAvatarState({ runtime: null, speechMs: -1, sceneMs, seed: input.seed });
  if (input.phase !== 'thinking') return rest;
  const sway = Math.sin(sceneMs / 900);
  return {
    ...rest,
    gaze: { x: clamp(0.45 + 0.2 * sway, -1, 1), y: clamp(-0.55 + 0.1 * sway, -1, 1) },
    head: {
      nod: clamp(rest.head.nod - 0.12, -1, 1),
      turn: clamp(rest.head.turn + 0.18, -1, 1),
      tilt: clamp(rest.head.tilt + 0.22, -1, 1),
    },
    brow: 0.45,
    smile: 0.2,
  };
}

/* ---------- live caption ---------- */

export interface Caption {
  /** Words of the line being spoken. */
  words: string[];
  /** Index (within `words`) of the word being said, -1 between words. */
  active: number;
}

/**
 * The caption line at a moment of the reply: words are grouped in lines of `perLine`, and the
 * line that contains the current word is shown (karaoke style). Null outside the speech.
 */
export function captionAt(
  words: readonly WordCue[],
  speechMs: number | null,
  perLine = 7,
): Caption | null {
  if (speechMs === null || speechMs < 0 || words.length === 0) return null;
  // Last word that has started.
  let current = -1;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word && word.tMs <= speechMs) current = i;
    else break;
  }
  const index = Math.max(0, current);
  const start = Math.floor(index / perLine) * perLine;
  const line = words.slice(start, start + perLine);
  const word = words[current];
  const speaking = word !== undefined && speechMs < word.tMs + word.durMs;
  return { words: line.map((cue) => cue.text), active: speaking ? current - start : -1 };
}

/* ---------- messages ---------- */

/** Response of `GET /api/interactive/sessions/:sessionId`. */
export interface InteractiveSessionDetail {
  session: InteractiveSession;
  messages: InteractiveMessage[];
}

export interface TalkMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  /** User message sent but not answered yet. */
  pending?: boolean;
  /** User message the server rejected; `error` says why. */
  failed?: boolean;
  errorCode?: string;
  /** Assistant message of THIS visit: its audio is at hand (signed URLs expire). */
  speech?: SynthesizedSpeech | null;
  /** Who produced the reply. */
  providers?: Provenance;
}

export function fromHistory(messages: readonly InteractiveMessage[]): TalkMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  }));
}

/** Add the message the person just sent, before the server answers. */
export function withPending(
  list: readonly TalkMessage[],
  tempId: string,
  text: string,
  createdAt: string,
): TalkMessage[] {
  return [...list, { id: tempId, role: 'user', text, createdAt, pending: true }];
}

/** Replace the optimistic message with the stored one and append the reply. */
export function withReply(
  list: readonly TalkMessage[],
  tempId: string,
  reply: InteractiveReply,
): TalkMessage[] {
  const user: TalkMessage = {
    id: reply.userMessage.id,
    role: 'user',
    text: reply.userMessage.text,
    createdAt: reply.userMessage.createdAt,
  };
  const assistant: TalkMessage = {
    id: reply.assistantMessage.id,
    role: 'assistant',
    text: reply.assistantMessage.text,
    createdAt: reply.assistantMessage.createdAt,
    speech: reply.speech,
    providers: reply.providers,
  };
  const next = list.some((message) => message.id === tempId)
    ? list.map((message) => (message.id === tempId ? user : message))
    : [...list, user];
  return [...next, assistant];
}

/** Keep a rejected message visible (nothing of it was stored) with the reason. */
export function withFailure(
  list: readonly TalkMessage[],
  tempId: string,
  errorCode: string,
): TalkMessage[] {
  return list.map((message) =>
    message.id === tempId ? { ...message, pending: false, failed: true, errorCode } : message,
  );
}

export function withoutMessage(list: readonly TalkMessage[], id: string): TalkMessage[] {
  return list.filter((message) => message.id !== id);
}

/** Longest message the API accepts. */
export const MESSAGE_MAX_CHARS = 1000;
export const PERSONA_NAME_MAX_CHARS = 60;
export const INSTRUCTIONS_MAX_CHARS = 4000;
export const KNOWLEDGE_MAX_CHARS = 20_000;
