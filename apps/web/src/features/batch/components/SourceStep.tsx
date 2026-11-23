import type { Composition, VideoSummary } from '@parlante/shared';
import { CircleCheck, Film, LayoutTemplate, Search, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { JobStatusBadge } from '@/components/JobStatus';
import { api, toAppUrl, useApiInfiniteQuery, useApiMutation, useApiQuery } from '@/lib/api';
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  LoadMore,
  Skeleton,
  Spinner,
  TabPanel,
  Tabs,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { Notice, TOOL_ROUTES, useAvailableRoutes } from '@/features/script-writer/kit';
import { EXAMPLE_VARIABLE, sourceVariables } from '../lib/batch';
import type { SourceVariable } from '../lib/batch';

export interface BatchSource {
  videoId: string;
  title: string;
  composition: Composition;
  variables: SourceVariable[];
}

type Tab = 'videos' | 'templates';

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

function Thumb({ url }: { url: string | null }) {
  return (
    <span className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-media text-on-media">
      {url ? (
        <img
          src={toAppUrl(url)}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <Film aria-hidden="true" className="size-5 opacity-60" />
      )}
    </span>
  );
}

const RADIO_TILE = cn(
  'flex min-w-0 items-center gap-3 rounded-lg border border-line-strong bg-surface p-2 transition-colors duration-150',
  'hover:bg-surface-2 peer-checked:border-fg peer-checked:bg-surface-2 peer-checked:shadow-[inset_0_0_0_1px_var(--fg)]',
  'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
);

export function VariableChips({ variables }: { variables: readonly SourceVariable[] }) {
  const { t } = useTranslation('batch');
  return (
    <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label={t('source.variables')}>
      {variables.map((variable) => (
        <li
          key={variable.name}
          className="rounded-md bg-saffron-soft px-2 py-0.5 font-mono text-xs font-medium text-saffron-text"
          title={
            variable.defaultValue
              ? t('source.default', { value: variable.defaultValue })
              : undefined
          }
        >
          {`{{${variable.name}}}`}
        </li>
      ))}
    </ul>
  );
}

export interface SourceStepProps {
  source: BatchSource | null;
  onChange: (source: BatchSource | null) => void;
}

/**
 * Step 1 of a batch: the video whose `{{variables}}` are filled from the data — one of the
 * workspace's videos, or a template (which first becomes a draft video, because a batch is
 * always made from a video).
 */
export function SourceStep({ source, onChange }: SourceStepProps) {
  const { t } = useTranslation('batch');
  const describe = useErrorText();
  const available = useAvailableRoutes();
  const name = useId();
  const [tab, setTab] = useState<Tab>('videos');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);

  const videos = useApiInfiniteQuery(api.videos.list, {
    query: { limit: 8, ...(q !== '' ? { q } : {}) },
  });
  const video = useApiQuery(
    api.videos.get,
    { params: { videoId: videoId ?? '' } },
    { enabled: videoId !== null },
  );
  const templates = useApiQuery(
    api.templates.list,
    { query: {} },
    { enabled: tab === 'templates' },
  );
  const template = useApiQuery(
    api.templates.get,
    { params: { templateId: templateId ?? '' } },
    { enabled: templateId !== null },
  );

  // A chosen video becomes the source as soon as its document (and so its variables) arrives.
  const loaded = video.data;
  useEffect(() => {
    if (!loaded || loaded.id !== videoId || source?.videoId === loaded.id) return;
    onChange({
      videoId: loaded.id,
      title: loaded.title,
      composition: loaded.composition,
      variables: sourceVariables(loaded.composition),
    });
  }, [loaded, videoId, source?.videoId, onChange]);

  const useTemplate = useApiMutation(api.templates.use, {
    invalidates: [api.videos.list],
    onSuccess: (created) => {
      toast.success(t('source.templateUsed', { title: created.title }));
      setVideoId(created.id);
      setTemplateId(null);
      onChange({
        videoId: created.id,
        title: created.title,
        composition: created.composition,
        variables: sourceVariables(created.composition),
      });
    },
    onError: (error) => {
      const text = describe(error);
      toast.error(t('source.templateFailed'), { description: text.message || text.title });
    },
  });

  const clear = () => {
    setVideoId(null);
    setTemplateId(null);
    onChange(null);
  };

  if (source) {
    const studio = available.studio ? TOOL_ROUTES.studio(source.videoId) : null;
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div
          role="status"
          className="flex min-w-0 items-start gap-3 rounded-lg bg-success-soft px-4 py-3 text-sm text-success-text"
        >
          <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{source.title}</p>
            <p>{t('source.chosen', { count: source.variables.length })}</p>
          </div>
          <Button variant="ghost" size="sm" leftIcon={<X aria-hidden="true" />} onClick={clear}>
            {t('source.change')}
          </Button>
        </div>
        {source.variables.length > 0 ? (
          <VariableChips variables={source.variables} />
        ) : (
          <Notice
            tone="warning"
            role="alert"
            icon={<TriangleAlert />}
            title={t('source.noVariablesTitle')}
            action={
              studio ? (
                <Button asChild size="sm" variant="secondary">
                  <Link to={studio}>{t('source.openStudio')}</Link>
                </Button>
              ) : undefined
            }
          >
            {t('source.noVariablesText', { example: EXAMPLE_VARIABLE })}
          </Notice>
        )}
      </div>
    );
  }

  const templateVariables = template.data ? sourceVariables(template.data.composition) : null;

  return (
    <Tabs<Tab>
      aria-label={t('source.tabs')}
      value={tab}
      onValueChange={setTab}
      variant="pills"
      tabs={[
        { value: 'videos', label: t('source.videos'), icon: <Film aria-hidden="true" /> },
        {
          value: 'templates',
          label: t('source.templates'),
          icon: <LayoutTemplate aria-hidden="true" />,
        },
      ]}
    >
      <TabPanel value="videos" className="flex min-w-0 flex-col gap-3 pt-4">
        <Input
          type="search"
          aria-label={t('source.search')}
          placeholder={t('source.searchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          leading={<Search aria-hidden="true" className="size-4" />}
          wrapperClassName="sm:max-w-sm"
        />
        {videos.isPending ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </div>
        ) : videos.isError ? (
          <ErrorState
            size="sm"
            error={videos.error}
            onRetry={() => void videos.refetch()}
            retrying={videos.isRefetching}
          />
        ) : videos.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<Film aria-hidden="true" />}
            title={q !== '' ? t('source.noMatchTitle') : t('source.noVideosTitle')}
            description={q !== '' ? t('source.noMatchText') : t('source.noVideosText')}
          />
        ) : (
          <fieldset className="min-w-0">
            <legend className="sr-only">{t('source.videosLegend')}</legend>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              {videos.items.map((item: VideoSummary) => (
                <label key={item.id} className="relative min-w-0 cursor-pointer">
                  <input
                    type="radio"
                    name={`${name}-video`}
                    value={item.id}
                    checked={videoId === item.id}
                    onChange={() => setVideoId(item.id)}
                    className="peer sr-only"
                  />
                  <span className={RADIO_TILE}>
                    <Thumb url={item.thumbnailUrl} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{item.title}</span>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-fg-muted">
                        <JobStatusBadge
                          status={item.status}
                          size="sm"
                          labels={{ idle: t('source.draft') }}
                        />
                        <span className="nums font-mono">{item.aspect}</span>
                      </span>
                    </span>
                    {videoId === item.id && video.isFetching && <Spinner size="sm" label={null} />}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {video.isError && videoId !== null && (
          <ErrorState size="sm" error={video.error} onRetry={() => void video.refetch()} />
        )}
        <LoadMore
          hasMore={videos.hasNextPage}
          loading={videos.isFetchingNextPage}
          onLoadMore={() => void videos.fetchNextPage()}
        />
      </TabPanel>

      <TabPanel value="templates" className="flex min-w-0 flex-col gap-3 pt-4">
        {templates.isPending ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-16" />
            ))}
          </div>
        ) : templates.isError ? (
          <ErrorState
            size="sm"
            error={templates.error}
            onRetry={() => void templates.refetch()}
            retrying={templates.isRefetching}
          />
        ) : templates.data.items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<LayoutTemplate aria-hidden="true" />}
            title={t('source.noTemplates')}
          />
        ) : (
          <fieldset className="min-w-0">
            <legend className="sr-only">{t('source.templatesLegend')}</legend>
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              {templates.data.items.map((item) => (
                <label key={item.id} className="relative min-w-0 cursor-pointer">
                  <input
                    type="radio"
                    name={`${name}-template`}
                    value={item.id}
                    checked={templateId === item.id}
                    onChange={() => setTemplateId(item.id)}
                    className="peer sr-only"
                  />
                  <span className={RADIO_TILE}>
                    <Thumb url={item.thumbnailUrl} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{item.name}</span>
                      <span className="nums block truncate font-mono text-xs text-fg-muted">
                        {item.aspect} · {t('source.scenes', { count: item.sceneCount })}
                      </span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {templateId !== null && (
          <div
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-2 p-4"
            aria-live="polite"
          >
            {template.isPending ? (
              <Skeleton className="h-10" />
            ) : template.isError ? (
              <ErrorState
                size="sm"
                error={template.error}
                onRetry={() => void template.refetch()}
              />
            ) : templateVariables && templateVariables.length > 0 ? (
              <>
                <p className="text-sm">
                  {t('source.templateVariables', { count: templateVariables.length })}
                </p>
                <VariableChips variables={templateVariables} />
                <p className="text-sm text-fg-muted">{t('source.templateNote')}</p>
                <Button
                  variant="secondary"
                  className="self-start"
                  loading={useTemplate.isPending}
                  onClick={() => useTemplate.mutate({ params: { templateId }, body: {} })}
                >
                  {t('source.useTemplate')}
                </Button>
              </>
            ) : (
              <p className="text-sm text-warning-text">{t('source.templateNoVariables')}</p>
            )}
          </div>
        )}
      </TabPanel>
    </Tabs>
  );
}
