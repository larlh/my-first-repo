import type { InteractiveSessionDetail } from './lib/talk';
import { Cpu, MessageSquarePlus, PhoneOff, Play, Square, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, apiClient, isApiError, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  ErrorState,
  IconButton,
  PageHeader,
  Skeleton,
  SkeletonText,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { Notice, TOOL_ROUTES, languageShortName, useUiLocale } from '@/features/script-writer/kit';
import { Composer } from './components/Composer';
import { Stage } from './components/Stage';
import { Transcript } from './components/Transcript';
import { fromHistory, withFailure, withPending, withReply, withoutMessage } from './lib/talk';
import type { TalkMessage, TalkPhase } from './lib/talk';
import { useSpeechPlayer } from './lib/useSpeechPlayer';

let tempCounter = 0;

/**
 * One conversation with the interactive avatar (master prompt §3.16): the person writes, the
 * reply arrives as text + audio + viseme timeline, and the avatar speaks it on a canvas with
 * the same rig code as the exported videos. Sending another message or leaving the page stops
 * the audio.
 */
export default function SessionPage() {
  const { t } = useTranslation('interactive');
  const { sessionId = '' } = useParams();
  // Always read the history afresh when the conversation is opened; never behind its back.
  const detail = useApiQuery(
    api.interactive.getSession,
    { params: { sessionId } },
    { enabled: sessionId !== '', staleTime: Infinity, gcTime: 0 },
  );

  if (detail.isPending) {
    return (
      <>
        <PageHeader
          back={{ to: TOOL_ROUTES.interactive, label: t('page.title') }}
          title={<Skeleton className="h-9 w-56" />}
        />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Skeleton className="aspect-[4/3] rounded-2xl" />
          <SkeletonText lines={6} />
        </div>
      </>
    );
  }
  if (detail.isError) {
    return (
      <>
        <PageHeader
          back={{ to: TOOL_ROUTES.interactive, label: t('page.title') }}
          title={t('session.missingTitle')}
        />
        <ErrorState
          error={detail.error}
          onRetry={() => void detail.refetch()}
          retrying={detail.isRefetching}
          action={
            <Button asChild variant="secondary">
              <Link to={TOOL_ROUTES.interactive}>{t('session.back')}</Link>
            </Button>
          }
        />
      </>
    );
  }

  return <Conversation key={detail.data.session.id} detail={detail.data} />;
}

function Conversation({ detail }: { detail: InteractiveSessionDetail }) {
  const { t } = useTranslation('interactive');
  const talk = detail.session;
  const sessionId = talk.id;
  const session = useSession();
  const format = useFormat();
  const locale = useUiLocale();
  const confirm = useConfirm();
  const describe = useErrorText();
  const canWrite = session.can('editor');

  const avatar = useApiQuery(
    api.avatars.get,
    { params: { avatarId: talk.avatarId } },
    { staleTime: 60_000 },
  );
  const voice = useApiQuery(
    api.voices.get,
    { params: { voiceId: talk.voiceId } },
    { staleTime: 60_000 },
  );

  const player = useSpeechPlayer();
  const [messages, setMessages] = useState<TalkMessage[]>(() => fromHistory(detail.messages));
  const [thinking, setThinking] = useState(false);
  const [text, setText] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [ended, setEnded] = useState(talk.status === 'ended');
  const [endedAt, setEndedAt] = useState(talk.endedAt);
  const [providers, setProviders] = useState(talk.providers);
  /** A reply whose audio the browser refused to start without a click. */
  const [blocked, setBlocked] = useState<TalkMessage | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // Ignore answers that arrive after the person left this conversation.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { play, stop } = player;
  const speak = useCallback(
    async (message: TalkMessage) => {
      if (!message.speech) return;
      setBlocked(null);
      const outcome = await play(message.id, message.speech);
      if (!alive.current) return;
      if (outcome === 'blocked') setBlocked(message);
    },
    [play],
  );

  const send = useCallback(
    async (content: string, replaceId?: string) => {
      const body = content.trim();
      if (body === '' || thinking) return;
      // A new question interrupts whatever the avatar was saying.
      stop();
      setBlocked(null);
      tempCounter += 1;
      const tempId = `pending-${tempCounter}`;
      setMessages((list) =>
        withPending(
          replaceId ? withoutMessage(list, replaceId) : list,
          tempId,
          body,
          new Date().toISOString(),
        ),
      );
      setThinking(true);
      try {
        const reply = await apiClient.interactive.sendMessage({
          params: { sessionId },
          body: { text: body },
        });
        if (!alive.current) return;
        setMessages((list) => withReply(list, tempId, reply));
        setProviders(reply.providers);
        setThinking(false);
        if (reply.speech) {
          void speak({
            id: reply.assistantMessage.id,
            role: 'assistant',
            text: reply.assistantMessage.text,
            createdAt: reply.assistantMessage.createdAt,
            speech: reply.speech,
          });
        }
      } catch (error) {
        if (!alive.current) return;
        const code = isApiError(error) ? error.code : 'INTERNAL';
        setMessages((list) => withFailure(list, tempId, code));
        setThinking(false);
        if (code === 'INVALID_STATE') setEnded(true);
      } finally {
        if (alive.current) setFocusKey((key) => key + 1);
      }
    },
    [sessionId, thinking, stop, speak],
  );

  // Listen again: this visit's replies keep their audio; older ones are synthesised afresh
  // with the session voice (the server caches speech by content).
  const listen = useCallback(
    async (message: TalkMessage) => {
      if (message.speech) return void speak(message);
      setLoadingId(message.id);
      try {
        const speech = await apiClient.voices.synthesize({
          body: { text: message.text, voiceId: talk.voiceId, language: talk.language },
        });
        if (!alive.current) return;
        setMessages((list) =>
          list.map((item) => (item.id === message.id ? { ...item, speech } : item)),
        );
        void speak({ ...message, speech });
      } catch (error) {
        if (!alive.current) return;
        toast.error(t('message.audioFailed'), { description: describe(error).title });
      } finally {
        if (alive.current) setLoadingId(null);
      }
    },
    [speak, talk, t, describe],
  );

  const end = useApiMutation(api.interactive.endSession, {
    invalidates: [api.interactive.listSessions],
    onSuccess: (updated) => {
      stop();
      setEnded(true);
      setEndedAt(updated.endedAt);
    },
    onError: (error) => toast.error(t('end.failed'), { description: describe(error).title }),
  });
  const endSession = async () => {
    const ok = await confirm({
      title: t('end.title'),
      description: t('end.text'),
      confirmLabel: t('end.confirm'),
    });
    if (ok) end.mutate({ params: { sessionId } });
  };

  const phase: TalkPhase = thinking ? 'thinking' : player.playingId ? 'speaking' : 'idle';
  const personaName = talk.persona.name;
  const llm = providers.llm;
  const tts = providers.tts;
  const voiceName = voice.data?.name;

  return (
    <>
      <PageHeader
        back={{ to: TOOL_ROUTES.interactive, label: t('page.title') }}
        eyebrow={t('session.eyebrow')}
        title={personaName}
        meta={
          ended ? (
            <Badge tone="neutral">{t('session.ended')}</Badge>
          ) : (
            <Badge tone="accent" dot pulse>
              {t('session.live')}
            </Badge>
          )
        }
        description={[
          languageShortName(talk.language, locale),
          voiceName ? t('session.voice', { name: voiceName }) : null,
          t('session.started', { when: format.relative(talk.createdAt) }),
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          !ended && canWrite ? (
            <Button
              variant="secondary"
              leftIcon={<PhoneOff aria-hidden="true" />}
              loading={end.isPending}
              onClick={() => void endSession()}
            >
              {t('end.action')}
            </Button>
          ) : (
            <Button asChild variant="secondary" leftIcon={<MessageSquarePlus aria-hidden="true" />}>
              <Link
                to={TOOL_ROUTES.interactive}
                state={{
                  preset: {
                    avatarId: talk.avatarId,
                    voiceId: talk.voiceId,
                    language: talk.language,
                    persona: talk.persona,
                  },
                }}
              >
                {t('session.again')}
              </Link>
            </Button>
          )
        }
      />

      {/* The one audio element of the conversation (kept in the DOM so it can be inspected). */}
      <audio ref={player.audioRef} preload="auto" className="hidden" data-interactive-audio />

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-6">
          <Stage
            avatar={avatar.data ?? null}
            label={t('stage.label', { name: personaName })}
            phase={phase}
            runtime={player.runtime}
            clock={player.clock}
            controls={
              <>
                {player.playingId && (
                  <IconButton
                    label={t('stage.stop')}
                    size="sm"
                    className="text-on-media hover:bg-on-media/15 [--ring:var(--saffron)]"
                    onClick={stop}
                  >
                    <Square aria-hidden="true" />
                  </IconButton>
                )}
                <IconButton
                  label={player.muted ? t('stage.unmute') : t('stage.mute')}
                  size="sm"
                  aria-pressed={player.muted}
                  className="text-on-media hover:bg-on-media/15 [--ring:var(--saffron)]"
                  onClick={() => player.setMuted(!player.muted)}
                >
                  {player.muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                </IconButton>
              </>
            }
          />

          {blocked && (
            <Notice
              tone="warning"
              role="status"
              title={t('stage.blockedTitle')}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Play aria-hidden="true" />}
                  onClick={() => void speak(blocked)}
                >
                  {t('stage.blockedAction')}
                </Button>
              }
            >
              {t('stage.blockedText')}
            </Notice>
          )}
          {avatar.isError && <Notice tone="warning">{t('stage.avatarMissing')}</Notice>}

          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg-muted">
            <span>{t('session.answeredBy')}</span>
            {llm && <ProviderBadge provider={llm} size="sm" />}
            {tts && (
              <>
                <span>{t('session.spokenBy')}</span>
                <ProviderBadge provider={tts} size="sm" />
              </>
            )}
          </div>
          {llm?.quality === 'basic' && (
            <Notice icon={<Cpu />} title={t('session.basicTitle')}>
              {t('session.basicText')}
            </Notice>
          )}
          {avatar.data?.rendering === 'photoreal' && (
            <Notice tone="info">{t('stage.photoreal')}</Notice>
          )}
        </div>

        <section
          aria-label={t('transcript.region')}
          className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface-2 p-4 sm:p-5"
        >
          {messages.length === 0 && !thinking ? (
            <p className="py-6 text-center text-sm text-fg-muted">
              {ended ? t('transcript.emptyEnded') : t('transcript.empty', { name: personaName })}
            </p>
          ) : (
            <Transcript
              messages={messages}
              personaName={personaName}
              thinking={thinking}
              playingId={player.playingId}
              loadingId={loadingId}
              onListen={(message) => void listen(message)}
              onStop={stop}
              onRetry={(message) => void send(message.text, message.id)}
              onRemove={(message) => setMessages((list) => withoutMessage(list, message.id))}
              className="max-h-[min(60vh,34rem)] overflow-y-auto pr-1"
            />
          )}

          {ended ? (
            <Notice role="status" title={t('session.endedTitle')}>
              {endedAt
                ? t('session.endedAt', { when: format.dateTime(endedAt) })
                : t('session.endedText')}
            </Notice>
          ) : canWrite ? (
            <Composer
              value={text}
              onChange={setText}
              onSend={() => {
                const content = text;
                setText('');
                void send(content);
              }}
              busy={thinking}
              personaName={personaName}
              focusKey={focusKey}
            />
          ) : (
            <Notice>{t('session.viewer')}</Notice>
          )}
        </section>
      </div>
    </>
  );
}
