import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CREDIT_COSTS, api, newId } from '@parlante/shared';
import type { LLMProvider } from '@parlante/shared';
import { avatars, eq, interactiveMessages, interactiveSessions, voices } from '@parlante/db';
import { listStockAvatars } from '@parlante/renderer';
import { createTestApp } from '../../testing/index';
import type { TestActor, TestApp } from '../../testing/index';
import interactiveModule, {
  CONTEXT_CHARS,
  CONTEXT_MESSAGES,
  MAX_SESSION_MESSAGES,
  buildChatContext,
} from './index';
import { balanceOf, fakeLlm, installFakeTts, ledgerOf } from './test-doubles';
import type { FakeLlm, FakeTts } from './test-doubles';

/* TTS is a deterministic double (real WAV bytes + estimated timeline). The LLM is the REAL
 * local provider ("modo básico") unless a test installs the external double. Routes,
 * moderation, `synthesizeCached`, storage, signed URLs and the database are the real ones. */

const AVATAR_ID = listStockAvatars()[0]?.id ?? 'stock_missing';
const VOICE_ID = 'espeak:es-f1';
const PERSONA = {
  name: 'Lía',
  instructions: 'Eres la asistente de la tienda. Responde con amabilidad.',
  knowledge:
    'P: ¿Cuál es el horario de la tienda?\nR: Abrimos de lunes a sábado, de nueve de la mañana a ocho de la tarde.\n\nP: ¿Hacéis envíos?\nR: Sí, enviamos a toda la península en 48 horas.',
};

let t: TestApp;
let tts: FakeTts;
let localLlm: LLMProvider;

beforeAll(async () => {
  t = await createTestApp({
    modules: [interactiveModule],
    env: { MODERATION_EXTRA_BLOCKLIST: 'zzprohibido' },
  });
  localLlm = t.app.providers.llm;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  tts = installFakeTts(t);
  t.app.providers.llm = localLlm;
});

function useExternalLlm(): FakeLlm {
  const llm = fakeLlm();
  t.app.providers.llm = llm;
  return llm;
}

async function startSession(actor: TestActor, overrides: Record<string, unknown> = {}) {
  const res = await t.call(api.interactive.createSession, {
    as: actor,
    body: {
      avatarId: AVATAR_ID,
      voiceId: VOICE_ID,
      language: 'es',
      persona: PERSONA,
      ...overrides,
    },
  });
  expect(res.status, res.raw.body).toBe(201);
  return res.body;
}

describe('POST /api/interactive/sessions', () => {
  it('starts a free session in basic mode and says which providers answer', async () => {
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const session = await startSession(alice);
    expect(session).toMatchObject({
      workspaceId: alice.workspace.id,
      avatarId: AVATAR_ID,
      voiceId: VOICE_ID,
      language: 'es',
      persona: PERSONA,
      status: 'active',
      messageCount: 0,
      endedAt: null,
      providers: {
        llm: { id: 'local', quality: 'basic', local: true },
        tts: { id: 'espeak', local: true },
        moderation: { id: 'local' },
      },
    });
    expect(session.id).toMatch(/^ivs_/);
    // Basic mode is free.
    expect(await balanceOf(t, alice)).toBe(before);
  });

  it('charges 2 credits when an external LLM answers, and needs the balance', async () => {
    useExternalLlm();
    const alice = await t.signUp();
    const before = await balanceOf(t, alice);
    const session = await startSession(alice);
    expect(session.providers.llm).toMatchObject({
      id: 'acme-llm',
      quality: 'premium',
      local: false,
    });
    expect(await balanceOf(t, alice)).toBe(before - CREDIT_COSTS.interactiveSessionPremium);
    expect(
      (await ledgerOf(t, alice)).find((entry) => entry.reason === 'interactive'),
    ).toMatchObject({
      delta: -2,
      refType: 'interactiveSession',
      refId: session.id,
      createdBy: alice.user.id,
    });

    const poor = await t.signUp({ credits: 1 });
    const res = await t.call(api.interactive.createSession, {
      as: poor,
      body: { avatarId: AVATAR_ID, voiceId: VOICE_ID, persona: PERSONA },
    });
    expect(res.status).toBe(402);
    expect(res.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(
      await t.db
        .select()
        .from(interactiveSessions)
        .where(eq(interactiveSessions.workspaceId, poor.workspace.id)),
    ).toEqual([]);
  });

  it('validates avatar, voice and persona against the workspace', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const call = (overrides: Record<string, unknown>) =>
      t.call(api.interactive.createSession, {
        as: alice,
        body: { avatarId: AVATAR_ID, voiceId: VOICE_ID, persona: PERSONA, ...overrides },
      });

    expect((await call({ avatarId: 'stock_no-existe' })).status).toBe(404);
    expect((await call({ voiceId: 'espeak:no-such-voice' })).status).toBe(404);
    expect((await call({ voiceId: 'elevenlabs:abc' })).status).toBe(404); // provider not active
    expect((await call({ avatarId: 'not an id' })).status).toBe(400);
    expect((await call({ persona: { name: '' } })).status).toBe(400);
    expect((await call({ language: 'xx' })).status).toBe(400);

    // Another workspace's avatar / cloned voice look exactly like missing ones.
    const foreignAvatar = newId('avatar');
    await t.db.insert(avatars).values({
      id: foreignAvatar,
      workspaceId: mallory.workspace.id,
      name: 'Ajeno',
      origin: 'generated',
      status: 'ready',
    });
    expect((await call({ avatarId: foreignAvatar })).status).toBe(404);
    expect((await call({ voiceId: newId('voice') })).status).toBe(404);

    // An avatar of the workspace that is still being prepared cannot be used yet.
    const processing = newId('avatar');
    await t.db.insert(avatars).values({
      id: processing,
      workspaceId: alice.workspace.id,
      name: 'En preparación',
      origin: 'generated',
      status: 'processing',
    });
    const notReady = await call({ avatarId: processing });
    expect(notReady.status).toBe(400);
    expect(notReady.error.message).toBe('This avatar is not ready yet');

    const blockedName = await call({ persona: { ...PERSONA, name: 'zzprohibido' } });
    expect(blockedName.status).toBe(422);
    expect(blockedName.error.details).toMatchObject({ field: 'persona.name' });
    const blockedKnowledge = await call({
      persona: { ...PERSONA, knowledge: 'Datos internos zzprohibido' },
    });
    expect(blockedKnowledge.error.code).toBe('CONTENT_BLOCKED');
    expect(blockedKnowledge.error.details).toMatchObject({ field: 'persona.knowledge' });
    expect(
      await t.db
        .select()
        .from(interactiveSessions)
        .where(eq(interactiveSessions.workspaceId, alice.workspace.id)),
    ).toEqual([]);
    expect(await t.db.select().from(voices)).toEqual([]);
  });
});

describe('POST /api/interactive/sessions/:sessionId/messages', () => {
  it('answers from the persona knowledge with speech and a lip-sync timeline', async () => {
    const alice = await t.signUp();
    const session = await startSession(alice);
    const params = { sessionId: session.id };

    const reply = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: '  ¿Cuál es el horario de la tienda?  ' },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.userMessage).toMatchObject({
      sessionId: session.id,
      role: 'user',
      text: '¿Cuál es el horario de la tienda?',
    });
    expect(reply.body.assistantMessage.role).toBe('assistant');
    // The local "modo básico" answers with the stored text of the knowledge base.
    expect(reply.body.assistantMessage.text).toContain('de lunes a sábado');
    expect(reply.body.providers).toMatchObject({
      llm: { id: 'local', quality: 'basic' },
      tts: { id: 'espeak' },
    });

    // Speech: a real WAV behind a signed URL + the runtime the client rig is driven with.
    const speech = reply.body.speech;
    expect(speech).not.toBeNull();
    expect(speech?.mimeType).toBe('audio/wav');
    expect(speech?.provider.id).toBe('espeak');
    expect(speech?.runtime.audioDurationMs).toBeGreaterThan(500);
    expect(speech?.runtime.visemes.length).toBeGreaterThan(5);
    expect(speech?.runtime.words.map((word) => word.text).join(' ')).toContain('lunes');
    const audioUrl = new URL(speech?.audioUrl ?? '');
    const audio = await t.inject({ method: 'GET', url: audioUrl.pathname + audioUrl.search });
    expect(audio.statusCode).toBe(200);
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    expect(tts.requests).toHaveLength(1);
    expect(tts.requests[0]).toMatchObject({
      text: reply.body.assistantMessage.text,
      providerVoiceId: 'es-f1',
      language: 'es',
    });

    // A second turn; the history is stored in order and the session counts its messages.
    const second = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: '¿Hacéis envíos?' },
    });
    expect(second.body.assistantMessage.text).toContain('48 horas');
    const detail = await t.call(api.interactive.getSession, { as: alice, params });
    expect(detail.status).toBe(200);
    expect(detail.body.session.messageCount).toBe(4);
    expect(detail.body.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(detail.body.messages.map((message) => message.id)).toEqual([
      reply.body.userMessage.id,
      reply.body.assistantMessage.id,
      second.body.userMessage.id,
      second.body.assistantMessage.id,
    ]);
  });

  it('moderates the user message and the reply; a blocked turn stores nothing', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const session = await startSession(alice);
    const params = { sessionId: session.id };

    const blocked = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: 'Háblame de zzprohibido' },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.error.code).toBe('CONTENT_BLOCKED');
    expect(blocked.error.details).toMatchObject({ field: 'text' });
    expect(llm.chatRequests).toHaveLength(0); // never reached the LLM

    llm.nextReply = 'Claro: zzprohibido es estupendo.';
    const blockedReply = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: '¿Qué me recomiendas?' },
    });
    expect(blockedReply.status).toBe(422);
    expect(blockedReply.error.details).toMatchObject({ stage: 'reply' });
    expect(tts.requests).toHaveLength(0); // never synthesised

    expect(await t.db.select().from(interactiveMessages)).toEqual([]);
    const detail = await t.call(api.interactive.getSession, { as: alice, params });
    expect(detail.body.session.messageCount).toBe(0);
    expect(
      (await t.call(api.interactive.sendMessage, { as: alice, params, body: { text: '' } })).status,
    ).toBe(400);
    expect(
      (
        await t.call(api.interactive.sendMessage, {
          as: alice,
          params,
          body: { text: 'x'.repeat(1001) },
        })
      ).status,
    ).toBe(400);
  });

  it('reports an LLM failure as PROVIDER_ERROR and survives a speech failure with text only', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const session = await startSession(alice);
    const params = { sessionId: session.id };

    llm.fail = new Error('socket hang up');
    const failed = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: 'Hola' },
    });
    expect(failed.status).toBe(502);
    expect(failed.error).toMatchObject({
      code: 'PROVIDER_ERROR',
      details: { provider: 'acme-llm' },
    });
    expect(await t.db.select().from(interactiveMessages)).toEqual([]);

    llm.fail = null;
    llm.nextReply = 'Hola, ¿en qué puedo ayudarte?';
    tts.failSynthesis = new Error('tts exploded');
    const textOnly = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: 'Hola' },
    });
    expect(textOnly.status).toBe(200);
    expect(textOnly.body.speech).toBeNull();
    expect(textOnly.body.assistantMessage.text).toBe('Hola, ¿en qué puedo ayudarte?');
    expect(textOnly.body.providers.llm).toMatchObject({ id: 'acme-llm' });
    expect(await t.db.select().from(interactiveMessages)).toHaveLength(2);
  });

  it('hands the LLM a bounded history and caps the length of a session', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const session = await startSession(alice);
    const params = { sessionId: session.id };

    // 60 earlier messages (30 turns), one per second.
    const start = Date.now() - 120_000;
    await t.db.insert(interactiveMessages).values(
      Array.from({ length: 60 }, (_, index) => ({
        id: newId('interactiveMessage'),
        workspaceId: alice.workspace.id,
        sessionId: session.id,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `mensaje ${index}`,
        createdAt: new Date(start + index * 1000),
      })),
    );
    await t.db
      .update(interactiveSessions)
      .set({ messageCount: 60 })
      .where(eq(interactiveSessions.id, session.id));

    const res = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: 'la pregunta nueva' },
    });
    expect(res.status).toBe(200);
    const sent = llm.chatRequests[0]?.messages ?? [];
    expect(sent.length).toBeLessThanOrEqual(CONTEXT_MESSAGES);
    expect(sent.length).toBeGreaterThan(10);
    expect(sent[0]?.role).toBe('user');
    expect(sent[sent.length - 1]).toEqual({ role: 'user', text: 'la pregunta nueva' });
    // The most recent stored messages, in order — never the oldest ones.
    expect(sent[sent.length - 2]).toEqual({ role: 'assistant', text: 'mensaje 59' });
    expect(sent.map((message) => message.text)).not.toContain('mensaje 0');
    expect(llm.chatRequests[0]).toMatchObject({
      persona: PERSONA,
      language: 'es',
      maxSentences: 3,
    });

    await t.db
      .update(interactiveSessions)
      .set({ messageCount: MAX_SESSION_MESSAGES - 1 })
      .where(eq(interactiveSessions.id, session.id));
    const full = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: 'una más' },
    });
    expect(full.status).toBe(409);
    expect(full.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { maxMessages: MAX_SESSION_MESSAGES },
    });
    expect(llm.chatRequests).toHaveLength(1);
  });

  it('clips an over-long reply before speaking it', async () => {
    const llm = useExternalLlm();
    const alice = await t.signUp();
    const session = await startSession(alice);
    llm.nextReply = 'Esta es una frase de relleno bastante larga. '.repeat(60);
    const res = await t.call(api.interactive.sendMessage, {
      as: alice,
      params: { sessionId: session.id },
      body: { text: 'Cuéntame todo' },
    });
    expect(res.status).toBe(200);
    expect(res.body.assistantMessage.text.length).toBeLessThanOrEqual(1200);
    expect(res.body.assistantMessage.text.endsWith('.')).toBe(true);
    expect(tts.requests[0]?.text).toBe(res.body.assistantMessage.text);
  });
});

describe('listing, ending, roles and workspace isolation', () => {
  it('lists newest first with a cursor and ends a session once', async () => {
    const alice = await t.signUp();
    const first = await startSession(alice);
    const second = await startSession(alice, { persona: { ...PERSONA, name: 'Leo' } });
    const third = await startSession(alice);
    // Distinct creation times (the three inserts may share a millisecond).
    for (const [index, id] of [first.id, second.id, third.id].entries()) {
      await t.db
        .update(interactiveSessions)
        .set({ createdAt: new Date(Date.now() - (3 - index) * 60_000) })
        .where(eq(interactiveSessions.id, id));
    }

    const page1 = await t.call(api.interactive.listSessions, { as: alice, query: { limit: 2 } });
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((s) => s.id)).toEqual([third.id, second.id]);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await t.call(api.interactive.listSessions, {
      as: alice,
      query: { limit: 2, cursor: page1.body.nextCursor ?? '' },
    });
    expect(page2.body.items.map((s) => s.id)).toEqual([first.id]);
    expect(page2.body.nextCursor).toBeNull();
    expect(
      (await t.call(api.interactive.listSessions, { as: alice, query: { cursor: 'garbage' } }))
        .status,
    ).toBe(400);

    const params = { sessionId: second.id };
    const ended = await t.call(api.interactive.endSession, { as: alice, params });
    expect(ended.status).toBe(200);
    expect(ended.body.status).toBe('ended');
    expect(ended.body.endedAt).not.toBeNull();
    const again = await t.call(api.interactive.endSession, { as: alice, params });
    expect(again.body.endedAt).toBe(ended.body.endedAt);
    const closed = await t.call(api.interactive.sendMessage, {
      as: alice,
      params,
      body: { text: 'Hola' },
    });
    expect(closed.status).toBe(409);
    expect(closed.error.code).toBe('INVALID_STATE');
  });

  it('requires a session and the editor role to talk; viewers can only read', async () => {
    const owner = await t.signUp();
    const viewer = await t.addMember(owner.workspace, 'viewer');
    const session = await startSession(owner);
    const params = { sessionId: session.id };
    const createBody = { avatarId: AVATAR_ID, voiceId: VOICE_ID, persona: PERSONA };

    expect((await t.call(api.interactive.createSession, { body: createBody })).status).toBe(401);
    expect((await t.call(api.interactive.listSessions)).status).toBe(401);
    expect((await t.call(api.interactive.getSession, { params })).status).toBe(401);
    expect(
      (await t.call(api.interactive.sendMessage, { params, body: { text: 'Hola' } })).status,
    ).toBe(401);
    expect((await t.call(api.interactive.endSession, { params })).status).toBe(401);

    expect(
      (await t.call(api.interactive.createSession, { as: viewer, body: createBody })).status,
    ).toBe(403);
    expect(
      (await t.call(api.interactive.sendMessage, { as: viewer, params, body: { text: 'Hola' } }))
        .status,
    ).toBe(403);
    expect((await t.call(api.interactive.endSession, { as: viewer, params })).status).toBe(403);
    expect((await t.call(api.interactive.listSessions, { as: viewer })).body.items).toHaveLength(1);
    expect((await t.call(api.interactive.getSession, { as: viewer, params })).status).toBe(200);
  });

  it('never exposes or changes a session of another workspace (404)', async () => {
    const alice = await t.signUp();
    const mallory = await t.signUp();
    const session = await startSession(alice);
    await t.call(api.interactive.sendMessage, {
      as: alice,
      params: { sessionId: session.id },
      body: { text: '¿Hacéis envíos?' },
    });
    const params = { sessionId: session.id };

    expect((await t.call(api.interactive.listSessions, { as: mallory })).body.items).toEqual([]);
    expect((await t.call(api.interactive.getSession, { as: mallory, params })).status).toBe(404);
    expect(
      (await t.call(api.interactive.sendMessage, { as: mallory, params, body: { text: 'Hola' } }))
        .status,
    ).toBe(404);
    expect((await t.call(api.interactive.endSession, { as: mallory, params })).status).toBe(404);
    expect(
      (await t.call(api.interactive.getSession, { as: alice, params: { sessionId: 'nope' } }))
        .status,
    ).toBe(400);
    const detail = await t.call(api.interactive.getSession, { as: alice, params });
    expect(detail.body.session.status).toBe('active');
    expect(detail.body.messages).toHaveLength(2);
  });
});

describe('buildChatContext', () => {
  it('keeps the latest turns that fit, starting with a user turn and ending with the new one', () => {
    const history = Array.from({ length: 50 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `m${index}`,
    }));
    const context = buildChatContext(history, 'nuevo');
    expect(context.length).toBeLessThanOrEqual(CONTEXT_MESSAGES);
    expect(context[0]?.role).toBe('user');
    expect(context[context.length - 1]).toEqual({ role: 'user', text: 'nuevo' });
    expect(context[context.length - 2]?.text).toBe('m49');

    const huge = [
      { role: 'user' as const, text: 'a'.repeat(CONTEXT_CHARS) },
      { role: 'assistant' as const, text: 'respuesta corta' },
    ];
    // The oversized old turn is dropped; an assistant turn cannot open the conversation.
    expect(buildChatContext(huge, 'hola')).toEqual([{ role: 'user', text: 'hola' }]);
    expect(buildChatContext([], 'hola')).toEqual([{ role: 'user', text: 'hola' }]);
  });
});
