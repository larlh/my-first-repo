import { CreateInteractiveSessionBodySchema } from '@parlante/shared';
import type { Avatar, LanguageCode } from '@parlante/shared';
import { DEFAULT_STOCK_AVATAR_ID, computeAvatarState } from '@parlante/renderer';
import { ArrowRight, MessagesSquare, Radio } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, isApiError, useApiInfiniteQuery, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadMore,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  toast,
  useErrorText,
} from '@/ui';
import {
  AvatarCanvas,
  AvatarPicker,
  CreditCost,
  ModeNotice,
  Notice,
  TOOL_ROUTES,
  VoiceSelect,
  canAfford,
  defaultVoiceOf,
  languageShortName,
  usableAvatars,
  useAvatars,
  useLanguageOptions,
  useUiLocale,
  useVoices,
} from '@/features/script-writer/kit';
import { INSTRUCTIONS_MAX_CHARS, KNOWLEDGE_MAX_CHARS, PERSONA_NAME_MAX_CHARS } from './lib/talk';

/** Credits a session costs with an external LLM (free in basic mode). */
const PREMIUM_SESSION_CREDITS = 2;

const PresetSchema = CreateInteractiveSessionBodySchema.partial();

/**
 * Interactive avatar (master prompt §3.16), set-up screen: who the person talks to (avatar,
 * voice, language, persona), which LLM answers and what it costs, plus earlier conversations.
 */
export default function InteractivePage() {
  const { t } = useTranslation('interactive');
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const format = useFormat();
  const locale = useUiLocale();
  const describe = useErrorText();
  const languages = useLanguageOptions();
  const canWrite = session.can('editor');

  // "Talk again" from an ended conversation hands its set-up over in the router state.
  const preset = useMemo(() => {
    const parsed = PresetSchema.safeParse((location.state as { preset?: unknown } | null)?.preset);
    return parsed.success ? parsed.data : {};
  }, [location.state]);

  const capabilities = useApiQuery(api.system.capabilities, undefined, { staleTime: 60_000 });
  const llm = capabilities.data?.active.llm;
  const avatars = useAvatars();
  const choices = useMemo(() => usableAvatars(avatars.data?.items ?? []), [avatars.data]);

  const [avatar, setAvatar] = useState<Avatar | null>(null);
  const [language, setLanguage] = useState<LanguageCode>(preset.language ?? locale);
  const [voiceId, setVoiceId] = useState<string | undefined>(preset.voiceId);
  const [name, setName] = useState(preset.persona?.name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(preset.persona?.name));
  const [instructions, setInstructions] = useState(preset.persona?.instructions ?? '');
  const [knowledge, setKnowledge] = useState(preset.persona?.knowledge ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (avatar !== null || choices.length === 0) return;
    const start =
      choices.find((a) => a.id === preset.avatarId) ??
      choices.find((a) => a.id === DEFAULT_STOCK_AVATAR_ID) ??
      choices[0] ??
      null;
    setAvatar(start);
  }, [avatar, choices, preset.avatarId]);

  // The persona takes the avatar's name until the person writes another.
  useEffect(() => {
    if (!nameTouched && avatar) setName(avatar.name.slice(0, PERSONA_NAME_MAX_CHARS));
  }, [avatar, nameTouched]);

  const voices = useVoices(language);
  const voiceList = voices.data?.items;
  useEffect(() => {
    if (!voiceList) return;
    if (voiceId === undefined || !voiceList.some((voice) => voice.id === voiceId)) {
      setVoiceId(defaultVoiceOf(voiceList, language)?.id);
    }
  }, [voiceList, voiceId, language]);

  const cost = llm ? (llm.local ? 0 : PREMIUM_SESSION_CREDITS) : null;

  const create = useApiMutation(api.interactive.createSession, {
    invalidates: [api.interactive.listSessions],
    onSuccess: (created) => {
      if (cost) void session.refresh();
      void navigate(TOOL_ROUTES.interactiveSession(created.id));
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'CONTENT_BLOCKED') {
        const field = (error.details as { field?: string } | undefined)?.field;
        const key =
          field === 'persona.name'
            ? 'name'
            : field === 'persona.knowledge'
              ? 'knowledge'
              : 'instructions';
        setFieldErrors({ [key]: t('setup.errors.blocked') });
        return;
      }
      const text = describe(error);
      toast.error(t('setup.errors.failed'), { description: text.message || text.title });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!avatar || !voiceId) return;
    const personaName = name.trim();
    if (personaName === '') return setFieldErrors({ name: t('setup.errors.name') });
    setFieldErrors({});
    create.mutate({
      body: {
        avatarId: avatar.id,
        voiceId,
        language,
        persona: {
          name: personaName,
          instructions: instructions.trim(),
          knowledge: knowledge.trim(),
        },
      },
    });
  };

  const sessions = useApiInfiniteQuery(api.interactive.listSessions, { query: { limit: 10 } });
  const seed = avatar?.id ?? 'avatar';
  const idlePose = useCallback(
    (nowMs: number) => computeAvatarState({ runtime: null, speechMs: -1, sceneMs: nowMs, seed }),
    [seed],
  );
  const ready = avatar !== null && voiceId !== undefined && canAfford(cost, session.credits);

  return (
    <>
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        description={t('page.description')}
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start">
        <Card padded className="min-w-0 rounded-xl sm:p-6">
          <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-5">
            <div>
              <p className="eyebrow text-fg-subtle">{t('setup.eyebrow')}</p>
              <h2 className="mt-1 text-xl">{t('setup.title')}</h2>
            </div>

            {!canWrite && <Notice tone="info">{t('setup.viewer')}</Notice>}

            {avatars.isPending ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton key={index} className="aspect-square" />
                ))}
              </div>
            ) : avatars.isError ? (
              <ErrorState
                size="sm"
                error={avatars.error}
                onRetry={() => void avatars.refetch()}
                retrying={avatars.isRefetching}
              />
            ) : (
              <AvatarPicker
                legend={t('setup.avatar')}
                hint={t('setup.avatarHint')}
                avatars={choices}
                value={avatar?.id ?? null}
                onChange={setAvatar}
                disabled={!canWrite}
              />
            )}

            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Select<LanguageCode>
                label={t('setup.language')}
                value={language}
                onValueChange={(next) => {
                  setLanguage(next);
                  setVoiceId(undefined);
                }}
                options={languages}
                disabled={!canWrite}
              />
              <VoiceSelect
                label={t('setup.voice')}
                language={language}
                value={voiceId}
                onValueChange={(next) => setVoiceId(next)}
                disabled={!canWrite}
              />
            </div>

            <Input
              label={t('setup.name')}
              hint={t('setup.nameHint')}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNameTouched(true);
              }}
              maxLength={PERSONA_NAME_MAX_CHARS}
              required
              error={fieldErrors.name}
              disabled={!canWrite}
            />
            <Textarea
              label={t('setup.instructions')}
              optionalLabel={t('setup.optional')}
              hint={t('setup.instructionsHint')}
              placeholder={t('setup.instructionsPlaceholder')}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={3}
              maxLength={INSTRUCTIONS_MAX_CHARS}
              showCount
              error={fieldErrors.instructions}
              disabled={!canWrite}
            />
            <Textarea
              label={t('setup.knowledge')}
              optionalLabel={t('setup.optional')}
              hint={t('setup.knowledgeHint')}
              placeholder={t('setup.knowledgePlaceholder')}
              value={knowledge}
              onChange={(event) => setKnowledge(event.target.value)}
              rows={4}
              maxLength={KNOWLEDGE_MAX_CHARS}
              showCount
              error={fieldErrors.knowledge}
              disabled={!canWrite}
            />

            <ModeNotice
              provider={llm}
              basic={t('setup.mode.basic')}
              premium={t('setup.mode.premium', { name: llm?.name ?? '' })}
            />
            {cost !== null && cost > 0 && <CreditCost cost={cost} detail={t('setup.costDetail')} />}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="self-start"
              loading={create.isPending}
              disabled={!canWrite || !ready}
              rightIcon={<ArrowRight aria-hidden="true" />}
            >
              {t('setup.start')}
            </Button>
          </form>
        </Card>

        <aside className="flex min-w-0 flex-col gap-6">
          <div className="relative isolate overflow-hidden rounded-2xl bg-media text-on-media shadow-lg">
            <div aria-hidden="true" className="booth-grid absolute inset-0 -z-10 opacity-60" />
            <p className="flex items-center gap-2 px-4 pt-4 text-xs font-semibold tracking-wide uppercase">
              <Radio aria-hidden="true" className="size-4 text-saffron" />
              {t('setup.preview')}
            </p>
            <div className="relative aspect-[4/3] w-full">
              {avatar ? (
                <AvatarCanvas
                  avatar={avatar}
                  label={t('setup.previewLabel', { name: avatar.name })}
                  pose={idlePose}
                  animate
                  maxSide={720}
                  className="absolute inset-0"
                />
              ) : (
                <Skeleton className="absolute inset-6 rounded-xl opacity-30" />
              )}
            </div>
            <p className="px-4 pb-4 text-sm text-on-media/80">
              {avatar?.rendering === 'photoreal' ? t('setup.photoreal') : t('setup.instant')}
            </p>
          </div>

          <section aria-labelledby="interactive-recent" className="min-w-0">
            <h2 id="interactive-recent" className="text-lg">
              {t('recent.title')}
            </h2>
            {sessions.isPending ? (
              <div className="mt-3 flex flex-col gap-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : sessions.isError ? (
              <ErrorState
                size="sm"
                error={sessions.error}
                onRetry={() => void sessions.refetch()}
                retrying={sessions.isRefetching}
              />
            ) : sessions.items.length === 0 ? (
              <EmptyState
                size="sm"
                icon={<MessagesSquare aria-hidden="true" />}
                title={t('recent.emptyTitle')}
                description={t('recent.emptyText')}
              />
            ) : (
              <ul className="mt-3 flex min-w-0 flex-col gap-2">
                {sessions.items.map((item) => (
                  <li key={item.id} className="min-w-0">
                    <Link
                      to={TOOL_ROUTES.interactiveSession(item.id)}
                      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">
                          {item.persona.name}
                        </span>
                        <span className="nums block truncate text-xs text-fg-muted">
                          {languageShortName(item.language, locale)} ·{' '}
                          {t('recent.messages', { count: item.messageCount })} ·{' '}
                          {format.relative(item.createdAt)}
                        </span>
                      </span>
                      {item.status === 'active' ? (
                        <Badge tone="accent" dot size="sm">
                          {t('recent.active')}
                        </Badge>
                      ) : (
                        <Badge tone="neutral" size="sm">
                          {t('recent.ended')}
                        </Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <LoadMore
              hasMore={sessions.hasNextPage}
              loading={sessions.isFetchingNextPage}
              onLoadMore={() => void sessions.fetchNextPage()}
              className="mt-3"
            />
          </section>
        </aside>
      </div>
    </>
  );
}
