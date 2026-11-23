import { AppError, CREDIT_COSTS, api, buildPage, isAppError, newId } from '@parlante/shared';
import type {
  ChatMessage,
  ChatReply,
  InteractiveMessage,
  InteractiveSession,
  Provenance,
  SynthesizedSpeech,
} from '@parlante/shared';
import {
  and,
  chargeCredits,
  cursorOrder,
  cursorWhere,
  desc,
  eq,
  interactiveMessages,
  interactiveSessions,
  sql,
} from '@parlante/db';
import type { Db, InteractiveMessageRow, InteractiveSessionRow } from '@parlante/db';
import { resolveVoice, synthesizeCached } from '@parlante/jobs';
import type { FastifyInstance } from 'fastify';
import { defineRoute } from '../../lib/define-route';
import { iso, isoOrNull } from '../../lib/dto';
import { assertContentAllowed } from '../../lib/moderation';
import { defineModule } from '../../lib/modules';
import { getAvatar } from '../avatars/catalog';
import { getVoice } from '../voices/catalog';

/* -------------------------------------------------------------------------------------------
 * Interactive avatar (feature 16): a text conversation whose replies are SPOKEN. There is no
 * job — one turn is synchronous:
 *
 *   user text → moderation (`chat`) → providers.llm.chat → moderation of the reply
 *             → synthesizeCached (WAV + viseme/word timeline) → reply
 *
 * The browser plays `speech.audioUrl` and drives the avatar rig with `speech.runtime` using
 * the same renderer as the export. Cost (CREDIT_COSTS.interactiveSessionPremium): 2 credits
 * when the session starts and ONLY with an external LLM; free in basic mode. Every reply says
 * which providers produced it.
 * ----------------------------------------------------------------------------------------- */

/** A session holds at most this many messages (user + assistant); then a new one is needed. */
export const MAX_SESSION_MESSAGES = 200;
/** Messages of the conversation handed to the LLM on each turn (most recent). */
export const CONTEXT_MESSAGES = 20;
/** …further bounded by total characters, dropping the oldest first. */
export const CONTEXT_CHARS = 8_000;
/** Replies are spoken: ask for short ones and never synthesise more than this. */
const REPLY_MAX_SENTENCES = 3;
const REPLY_MAX_CHARS = 1_200;

function toSessionDto(row: InteractiveSessionRow): InteractiveSession {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    avatarId: row.avatarId,
    voiceId: row.voiceId,
    language: row.language,
    persona: row.persona,
    status: row.status,
    messageCount: row.messageCount,
    providers: row.providers,
    createdAt: iso(row.createdAt),
    endedAt: isoOrNull(row.endedAt),
  };
}

function toMessageDto(row: InteractiveMessageRow): InteractiveMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    text: row.text,
    createdAt: iso(row.createdAt),
  };
}

async function findSession(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<InteractiveSessionRow> {
  const [row] = await db
    .select()
    .from(interactiveSessions)
    .where(
      and(eq(interactiveSessions.id, sessionId), eq(interactiveSessions.workspaceId, workspaceId)),
    );
  if (!row) throw AppError.notFound('Interactive session');
  return row;
}

/** The most recent `limit` messages of a session, oldest first. */
async function recentMessages(
  db: Db,
  workspaceId: string,
  sessionId: string,
  limit: number,
): Promise<InteractiveMessageRow[]> {
  const rows = await db
    .select()
    .from(interactiveMessages)
    .where(
      and(
        eq(interactiveMessages.sessionId, sessionId),
        eq(interactiveMessages.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(interactiveMessages.createdAt), desc(interactiveMessages.id))
    .limit(limit);
  return rows.reverse();
}

/** Bounded context for the LLM: the latest turns that fit, always ending with the new one. */
export function buildChatContext(history: ChatMessage[], userText: string): ChatMessage[] {
  const context: ChatMessage[] = [];
  let budget = CONTEXT_CHARS - userText.length;
  for (let i = history.length - 1; i >= 0 && context.length < CONTEXT_MESSAGES - 1; i -= 1) {
    const message = history[i];
    if (!message) continue;
    budget -= message.text.length;
    if (budget < 0) break;
    context.unshift(message);
  }
  // The provider expects the conversation to open with a user turn.
  while (context[0]?.role === 'assistant') context.shift();
  context.push({ role: 'user', text: userText });
  return context;
}

/** Cut an over-long reply at a sentence end (it is going to be spoken). */
function clipReply(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= REPLY_MAX_CHARS) return clean;
  const slice = clean.slice(0, REPLY_MAX_CHARS);
  const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
  return (stop > REPLY_MAX_CHARS * 0.5 ? slice.slice(0, stop + 1) : `${slice.trimEnd()}…`).trim();
}

function catalogDeps(app: FastifyInstance) {
  return {
    db: app.db,
    providers: app.providers,
    fileUrl: app.fileUrl,
    publicApiUrl: app.config.PUBLIC_API_URL,
  };
}

export default defineModule({
  name: 'interactive',
  register(app) {
    defineRoute(app, api.interactive.createSession, async ({ auth, body, app: instance }) => {
      const { db, providers } = instance;
      // Avatar and voice must exist for THIS workspace and be usable (404 otherwise: a foreign
      // avatar or cloned voice looks exactly like a missing one).
      const avatar = await getAvatar(
        catalogDeps(instance),
        auth.workspaceId,
        auth.user.locale,
        body.avatarId,
      );
      const voice = await getVoice({ db, providers }, auth.workspaceId, body.voiceId);
      if (avatar.status !== 'ready' || voice.status !== 'ready') {
        throw new AppError(
          'VALIDATION_ERROR',
          avatar.status !== 'ready'
            ? 'This avatar is not ready yet'
            : 'This voice is not ready yet',
          {
            issues: [
              avatar.status !== 'ready'
                ? { path: 'body.avatarId', message: `Avatar is ${avatar.status}` }
                : { path: 'body.voiceId', message: `Voice is ${voice.status}` },
            ],
          },
        );
      }
      const resolved = await resolveVoice(db, providers, auth.workspaceId, body.voiceId);

      await assertContentAllowed(providers, [
        { text: body.persona.name, context: 'name', field: 'persona.name' },
        {
          text: body.persona.instructions,
          context: 'chat',
          language: body.language,
          field: 'persona.instructions',
        },
        {
          text: body.persona.knowledge,
          context: 'chat',
          language: body.language,
          field: 'persona.knowledge',
        },
      ]);

      const sessionId = newId('interactiveSession');
      const provenance: Provenance = {
        llm: providers.llm.info,
        tts: resolved.tts.info,
        moderation: providers.moderation.info,
      };
      const row = await db.transaction(async (tx) => {
        // Only a session answered by an external LLM costs credits (free in basic mode).
        if (!providers.llm.info.local) {
          await chargeCredits(tx, {
            workspaceId: auth.workspaceId,
            amount: CREDIT_COSTS.interactiveSessionPremium,
            reason: 'interactive',
            refType: 'interactiveSession',
            refId: sessionId,
            description: `Interactive session with ${body.persona.name} (${providers.llm.info.name})`,
            createdBy: auth.userId,
          });
        }
        const [created] = await tx
          .insert(interactiveSessions)
          .values({
            id: sessionId,
            workspaceId: auth.workspaceId,
            userId: auth.userId,
            avatarId: body.avatarId,
            voiceId: body.voiceId,
            language: body.language,
            persona: body.persona,
            status: 'active',
            providers: provenance,
          })
          .returning();
        if (!created) throw new Error('Insert returned no row');
        return created;
      });
      return toSessionDto(row);
    });

    defineRoute(app, api.interactive.listSessions, async ({ auth, query, app: { db } }) => {
      const rows = await db
        .select()
        .from(interactiveSessions)
        .where(
          and(
            eq(interactiveSessions.workspaceId, auth.workspaceId),
            cursorWhere(interactiveSessions.createdAt, interactiveSessions.id, query.cursor),
          ),
        )
        .orderBy(...cursorOrder(interactiveSessions.createdAt, interactiveSessions.id))
        .limit(query.limit + 1);
      const page = buildPage(rows, query.limit);
      return { items: page.items.map(toSessionDto), nextCursor: page.nextCursor };
    });

    defineRoute(app, api.interactive.getSession, async ({ auth, params, app: { db } }) => {
      const session = await findSession(db, auth.workspaceId, params.sessionId);
      const messages = await recentMessages(db, auth.workspaceId, session.id, MAX_SESSION_MESSAGES);
      return { session: toSessionDto(session), messages: messages.map(toMessageDto) };
    });

    defineRoute(
      app,
      api.interactive.sendMessage,
      async ({ auth, params, body, request, app: instance }) => {
        const { db, providers, fileUrl } = instance;
        const session = await findSession(db, auth.workspaceId, params.sessionId);
        if (session.status !== 'active') {
          throw AppError.invalidState('This session has ended. Start a new one to keep talking');
        }
        if (session.messageCount + 2 > MAX_SESSION_MESSAGES) {
          throw new AppError(
            'INVALID_STATE',
            'This session reached its message limit. Start a new one to keep talking',
            { maxMessages: MAX_SESSION_MESSAGES },
          );
        }
        // Nothing of a blocked message is stored or sent to the LLM.
        await assertContentAllowed(providers, {
          text: body.text,
          context: 'chat',
          language: session.language,
          field: 'text',
        });

        const history = await recentMessages(db, auth.workspaceId, session.id, CONTEXT_MESSAGES);
        let reply: ChatReply;
        try {
          reply = await providers.llm.chat({
            persona: session.persona,
            language: session.language,
            messages: buildChatContext(
              history.map((m) => ({ role: m.role, text: m.text })),
              body.text,
            ),
            maxSentences: REPLY_MAX_SENTENCES,
          });
        } catch (err) {
          if (isAppError(err)) throw err;
          throw new AppError(
            'PROVIDER_ERROR',
            `${providers.llm.info.name} could not answer. Try again`,
            { provider: providers.llm.info.id },
            { cause: err },
          );
        }
        const replyText = clipReply(reply.text);
        if (replyText === '') {
          throw new AppError('PROVIDER_ERROR', `${reply.provider.name} returned an empty answer`, {
            provider: reply.provider.id,
          });
        }
        await assertContentAllowed(
          providers,
          { text: replyText, context: 'chat', language: session.language },
          { stage: 'reply' },
        );

        // Speech is best effort: when synthesis fails the text reply still arrives
        // (`speech: null`, as the contract says) instead of losing the turn.
        let speech: SynthesizedSpeech | null = null;
        try {
          const audio = await synthesizeCached({ db, providers }, auth.workspaceId, {
            text: replyText,
            voiceId: session.voiceId,
            language: session.language,
          });
          speech = {
            audioUrl: await fileUrl(audio.audioKey),
            mimeType: 'audio/wav',
            runtime: audio.runtime,
            provider: audio.provider,
          };
        } catch (err) {
          request.log.warn(
            { err, sessionId: session.id, voiceId: session.voiceId },
            'Interactive reply could not be synthesised; answering with text only',
          );
        }

        const provenance: Provenance = {
          ...session.providers,
          llm: reply.provider,
          ...(speech ? { tts: speech.provider } : {}),
          moderation: providers.moderation.info,
        };
        const now = Date.now();
        const stored = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(interactiveSessions)
            .set({
              messageCount: sql`${interactiveSessions.messageCount} + 2`,
              // Who is actually answering (an external LLM may have fallen back to basic).
              providers: provenance,
            })
            .where(
              and(
                eq(interactiveSessions.id, session.id),
                eq(interactiveSessions.workspaceId, auth.workspaceId),
                eq(interactiveSessions.status, 'active'),
              ),
            )
            .returning({ id: interactiveSessions.id });
          if (!updated) {
            throw AppError.invalidState('This session has ended. Start a new one to keep talking');
          }
          const base = { workspaceId: auth.workspaceId, sessionId: session.id };
          return tx
            .insert(interactiveMessages)
            .values([
              {
                ...base,
                id: newId('interactiveMessage'),
                role: 'user' as const,
                text: body.text,
                createdAt: new Date(now),
              },
              {
                ...base,
                id: newId('interactiveMessage'),
                role: 'assistant' as const,
                text: replyText,
                // Strictly after the question, so the history always reads in order.
                createdAt: new Date(now + 1),
              },
            ])
            .returning();
        });
        const userMessage = stored.find((m) => m.role === 'user');
        const assistantMessage = stored.find((m) => m.role === 'assistant');
        if (!userMessage || !assistantMessage) throw new Error('Insert returned no rows');
        return {
          userMessage: toMessageDto(userMessage),
          assistantMessage: toMessageDto(assistantMessage),
          speech,
          providers: provenance,
        };
      },
    );

    defineRoute(app, api.interactive.endSession, async ({ auth, params, app: { db } }) => {
      const session = await findSession(db, auth.workspaceId, params.sessionId);
      if (session.status === 'ended') return toSessionDto(session);
      const [updated] = await db
        .update(interactiveSessions)
        .set({ status: 'ended', endedAt: new Date() })
        .where(
          and(
            eq(interactiveSessions.id, session.id),
            eq(interactiveSessions.workspaceId, auth.workspaceId),
          ),
        )
        .returning();
      if (!updated) throw AppError.notFound('Interactive session');
      return toSessionDto(updated);
    });
  },
});
