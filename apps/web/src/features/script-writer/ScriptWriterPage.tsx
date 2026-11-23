import type { Video } from '@parlante/shared';
import { CircleAlert, ScrollText } from 'lucide-react';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, isApiError, useApiMutation, useApiQuery } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  SkeletonText,
  VoiceBars,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { BriefForm } from './components/BriefForm';
import { CreateVideoDialog } from './components/CreateVideoDialog';
import { ScriptEditor } from './components/ScriptEditor';
import { Notice, TOOL_ROUTES, draftPath, useAvailableRoutes, useUiLocale } from './kit';
import {
  DURATION_MAX_SEC,
  briefProblem,
  briefToBody,
  defaultBrief,
  draftFromGenerated,
  draftProblems,
  isBasic,
} from './lib/script';
import type { Brief, ScriptDraft } from './lib/script';
import { clearWork, loadWork, saveWork } from './lib/storage';

const makeId = () => nanoid(10);

/**
 * AI script writer (master prompt §3.11): a brief (topic or URL, tone, duration, language)
 * becomes a script split into scenes that can be edited, timed and turned into a draft video.
 * The page always says which provider wrote the script and when it was the local basic mode.
 */
export default function ScriptWriterPage() {
  const { t } = useTranslation('script-writer');
  const session = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const describe = useErrorText();
  const available = useAvailableRoutes();
  const uiLocale = useUiLocale();
  const workspaceId = session.workspace.id;
  const limits = session.plan.limits;

  const [work, setWork] = useState(
    () => loadWork(workspaceId) ?? { brief: defaultBrief(uiLocale), draft: null },
  );
  const { brief, draft } = work;
  const [errors, setErrors] = useState<{ topic?: string; url?: string }>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [created, setCreated] = useState<Video | null>(null);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    saveWork(workspaceId, brief, draft);
  }, [workspaceId, brief, draft]);

  // Which LLM would write the script (the local heuristic is "modo básico").
  const capabilities = useApiQuery(api.system.capabilities, undefined, { staleTime: 60_000 });
  const llm = capabilities.data?.active.llm;

  const setBrief = useCallback((patch: Partial<Brief>) => {
    setWork((current) => ({ ...current, brief: { ...current.brief, ...patch } }));
    setErrors({});
  }, []);
  const setDraft = useCallback((next: ScriptDraft | null) => {
    setWork((current) => ({ ...current, draft: next }));
  }, []);

  const generate = useApiMutation(api.scriptWriter.generate, {
    onSuccess: (script) => {
      setDraft(draftFromGenerated(script, brief.durationSec, makeId));
      setCreated(null);
      // A script written by an external LLM costs a credit.
      if (!isBasic(script.provider, script.basicMode)) void session.refresh();
      requestAnimationFrame(() => resultRef.current?.focus());
    },
    onError: (error) => {
      if (isApiError(error)) {
        const urlError =
          error.code === 'UNSAFE_URL'
            ? t('errors.unsafeUrl')
            : error.fieldErrors['body.source.url']
              ? t('errors.unreadableUrl')
              : undefined;
        if (urlError && brief.sourceKind === 'url') {
          setErrors({ url: urlError });
          return;
        }
      }
      setFailure(error);
    },
  });

  const submit = async () => {
    const problem = briefProblem(brief);
    if (problem === 'topicShort') return setErrors({ topic: t('errors.topicShort') });
    if (problem === 'urlInvalid') return setErrors({ url: t('errors.urlInvalid') });
    if (draft?.edited) {
      const ok = await confirm({
        title: t('replace.title'),
        description: t('replace.text'),
        confirmLabel: t('replace.confirm'),
      });
      if (!ok) return;
    }
    setFailure(null);
    setErrors({});
    generate.mutate({ body: briefToBody(brief) });
  };

  const discard = async () => {
    const ok = await confirm({
      title: t('discard.title'),
      description: t('discard.text'),
      confirmLabel: t('discard.confirm'),
      tone: 'danger',
    });
    if (!ok) return;
    setDraft(null);
    setCreated(null);
    clearWork(workspaceId);
  };

  const onCreated = (video: Video) => {
    setCreated(video);
    const path = draftPath(available, video.id);
    toast.success(t('create.done'), {
      description: path ? t('create.doneText') : t('create.doneNoStudio'),
    });
    if (path) void navigate(path);
  };

  const problems = draft
    ? draftProblems(draft, {
        maxScenesPerVideo: limits.maxScenesPerVideo,
        maxVideoDurationSec: limits.maxVideoDurationSec,
      })
    : null;
  const failureText = failure ? describe(failure) : null;
  const createdPath = created ? draftPath(available, created.id) : null;

  return (
    <>
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        description={t('page.description')}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] lg:items-start">
        <BriefForm
          brief={brief}
          onChange={setBrief}
          onSubmit={() => void submit()}
          llm={llm}
          maxDurationSec={Math.min(DURATION_MAX_SEC, limits.maxVideoDurationSec)}
          pending={generate.isPending}
          hasDraft={draft !== null}
          errors={errors}
          className="lg:sticky lg:top-6"
        />

        <section
          ref={resultRef}
          tabIndex={-1}
          aria-label={t('script.region')}
          aria-busy={generate.isPending}
          className="flex min-w-0 flex-col gap-4 rounded-xl outline-none"
        >
          {failureText && failure && (
            <Notice
              tone="danger"
              role="alert"
              icon={<CircleAlert />}
              title={failureText.title}
              action={
                failure.code === 'INSUFFICIENT_CREDITS' && available.billing ? (
                  <Button asChild size="sm" variant="secondary">
                    <Link to={TOOL_ROUTES.billing}>{t('errors.buyCredits')}</Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => void submit()}>
                    {t('errors.retry')}
                  </Button>
                )
              }
            >
              {failure.code === 'CONTENT_BLOCKED'
                ? t('errors.blocked')
                : failure.code === 'PROVIDER_ERROR'
                  ? t('errors.provider')
                  : failureText.message}
            </Notice>
          )}

          {created && (
            <Notice
              tone="success"
              role="status"
              title={t('create.done')}
              action={
                createdPath ? (
                  <Button asChild size="sm" variant="secondary">
                    <Link to={createdPath}>{t('create.open')}</Link>
                  </Button>
                ) : undefined
              }
            >
              {t('create.createdText', { title: created.title })}
            </Notice>
          )}

          {generate.isPending ? (
            <div
              role="status"
              className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
            >
              <p className="flex items-center gap-3 text-sm font-semibold">
                <VoiceBars size="sm" label={null} />
                {brief.sourceKind === 'url' ? t('loading.url') : t('loading.topic')}
              </p>
              <Skeleton className="h-10 w-2/3" />
              <SkeletonText lines={4} />
              <SkeletonText lines={3} />
            </div>
          ) : draft && problems ? (
            <ScriptEditor
              draft={draft}
              onChange={setDraft}
              problems={problems}
              maxScenes={limits.maxScenesPerVideo}
              maxDurationSec={limits.maxVideoDurationSec}
              makeId={makeId}
              onSceneAdded={(sceneId) =>
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLInputElement>(`[data-scene-id="${sceneId}"] input`)
                    ?.focus(),
                )
              }
              onCreateVideo={() => setDialogOpen(true)}
              onDiscard={() => void discard()}
            />
          ) : (
            <div className="booth-grid rounded-xl border border-dashed border-line-strong text-fg">
              <EmptyState
                icon={<ScrollText aria-hidden="true" />}
                title={t('empty.title')}
                description={t('empty.text')}
              />
            </div>
          )}
        </section>
      </div>

      {draft && (
        <CreateVideoDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          draft={draft}
          onCreated={onCreated}
        />
      )}
    </>
  );
}
