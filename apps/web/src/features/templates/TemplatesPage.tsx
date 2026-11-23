import { AspectRatioSchema, TEMPLATE_CATEGORIES } from '@parlante/shared';
import type { AspectRatio, Template } from '@parlante/shared';
import { Eye, LayoutTemplate, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, toAppUrl, useApiMutation, useApiQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Tabs,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { CountBadge, draftPath, useAvailableRoutes, useDebounced } from '@/features/avatars/kit';
import { TemplateSheet } from './components/TemplateSheet';
import {
  TEMPLATE_KINDS,
  aspectShape,
  categoriesOf,
  countByTemplateKind,
  filterTemplates,
  hasActiveTemplateFilters,
  templateFiltersFromParams,
  templateFiltersToParams,
} from './lib/templates';
import type { TemplateFilters, TemplateKind } from './lib/templates';

const ANY = 'any';
const ASPECT_KEYS: Record<AspectRatio, string> = {
  '16:9': 'landscape',
  '9:16': 'portrait',
  '1:1': 'square',
};
const GRID = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4';

function Poster({ template }: { template: Template }) {
  const { t } = useTranslation('templates');
  const [broken, setBroken] = useState(false);
  return (
    <span className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden bg-media p-2.5">
      <span aria-hidden="true" className="absolute inset-0 booth-grid text-on-media opacity-40" />
      {template.thumbnailUrl && !broken ? (
        <img
          src={toAppUrl(template.thumbnailUrl)}
          alt={t('card.poster', { name: template.name })}
          loading="lazy"
          onError={() => setBroken(true)}
          className={cn(
            'relative max-h-full max-w-full rounded-sm object-contain shadow-lg transition-transform duration-300 ease-standard group-hover:scale-[1.03]',
            aspectShape(template.aspect),
          )}
        />
      ) : (
        <span
          role="img"
          aria-label={t('card.noPoster', { name: template.name })}
          className={cn(
            'relative flex h-full max-w-full items-center justify-center rounded-sm bg-on-media/10 text-on-media/60',
            aspectShape(template.aspect),
          )}
        >
          <LayoutTemplate aria-hidden="true" className="size-8" strokeWidth={1.25} />
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-center gap-1.5 bg-media/85 py-2 text-xs font-semibold text-on-media transition-transform duration-200 ease-standard group-hover:translate-y-0 group-focus-visible:translate-y-0">
        <Eye aria-hidden="true" className="size-3.5" />
        {t('card.preview')}
      </span>
    </span>
  );
}

function TemplateCard({
  template,
  onOpen,
  onUse,
  using,
  canUse,
}: {
  template: Template;
  onOpen: () => void;
  onUse: () => void;
  using: boolean;
  canUse: boolean;
}) {
  const { t } = useTranslation('templates');
  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-md">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('card.open', { name: template.name })}
        className="group flex min-w-0 flex-1 flex-col text-left"
      >
        <Poster template={template} />
        <span className="flex min-w-0 flex-1 flex-col gap-1 px-4 pt-3.5">
          <span className="eyebrow text-fg-subtle">{t(`category.${template.category}`)}</span>
          <span className="display truncate text-xl leading-tight">{template.name}</span>
          <span className="line-clamp-2 min-h-10 text-sm text-fg-muted">
            {template.description}
          </span>
        </span>
      </button>
      <div className="flex items-center gap-2 px-4 pt-3 pb-4">
        <Badge tone="neutral" variant="outline" size="sm" className="nums font-mono">
          {template.aspect}
        </Badge>
        <span className="nums text-xs text-fg-muted">
          {t('card.scenes', { count: template.sceneCount })}
        </span>
        {template.kind === 'custom' && (
          <Badge tone="saffron" size="sm">
            {t('kind.custom')}
          </Badge>
        )}
        <Button
          size="sm"
          variant="solid"
          className="ml-auto"
          disabled={!canUse}
          loading={using}
          onClick={onUse}
        >
          {t('use')}
        </Button>
      </div>
    </li>
  );
}

/**
 * Template gallery (master prompt §3.7): built-in and custom templates with their poster, a
 * live preview drawn by the renderer, and "use template" → a draft opened in the Studio.
 */
export default function TemplatesPage() {
  const { t } = useTranslation('templates');
  const session = useSession();
  const navigate = useNavigate();
  const describe = useErrorText();
  const available = useAvailableRoutes();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => templateFiltersFromParams(params), [params]);
  const openId = params.get('template');

  const gallery = useApiQuery(api.templates.list);
  const all = useMemo(() => gallery.data?.items ?? [], [gallery.data]);

  const [search, setSearch] = useState(filters.q);
  const settledSearch = useDebounced(search);
  const update = (patch: Partial<TemplateFilters>) =>
    setParams(
      (current) =>
        templateFiltersToParams({ ...templateFiltersFromParams(current), ...patch }, current),
      { replace: true },
    );
  useEffect(() => {
    if (settledSearch !== filters.q) update({ q: settledSearch });
    // Only the settled text drives the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSearch]);
  useEffect(() => {
    setSearch((current) => (current.trim() === filters.q.trim() ? current : filters.q));
  }, [filters.q]);

  const shown = useMemo(() => filterTemplates(all, filters), [all, filters]);
  const counts = useMemo(() => countByTemplateKind(all, filters), [all, filters]);
  const categories = useMemo(() => categoriesOf(all), [all]);
  const open = openId ? (all.find((template) => template.id === openId) ?? null) : null;

  const setOpen = (template: Template | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (template) next.set('template', template.id);
      else next.delete('template');
      return next;
    });

  const [usingId, setUsingId] = useState<string | null>(null);
  const use = useApiMutation(api.templates.use, {
    invalidates: [api.videos.list],
    onSuccess: (video) => {
      toast.success(t('used'));
      const path = draftPath(available, video.id);
      if (path) void navigate(path);
    },
    onError: (error) => toast.error(t('useFailed'), { description: describe(error).title }),
    onSettled: () => setUsingId(null),
  });
  const startFrom = (template: Template, title = '') => {
    setUsingId(template.id);
    use.mutate({
      params: { templateId: template.id },
      body: title !== '' ? { title } : {},
    });
  };
  const canUse = session.can('editor') && (available.studio || available.video);

  const clear = () => {
    setSearch('');
    update({ category: null, aspect: null, q: '' });
  };

  return (
    <>
      <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')}>
        <Tabs
          aria-label={t('kinds.label')}
          value={filters.kind}
          onValueChange={(kind: TemplateKind) => update({ kind })}
          tabs={TEMPLATE_KINDS.map((kind) => ({
            value: kind,
            label: t(`kinds.${kind}`),
            badge: gallery.isSuccess ? <CountBadge value={counts[kind]} /> : undefined,
          }))}
        />
      </PageHeader>

      <div
        role="search"
        aria-label={t('filters.label')}
        className="mb-6 flex flex-wrap items-center gap-3"
      >
        <Input
          type="search"
          aria-label={t('filters.search')}
          placeholder={t('filters.searchPlaceholder')}
          leading={<Search aria-hidden="true" />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          wrapperClassName="min-w-0 flex-1 basis-64"
        />
        <Select
          aria-label={t('filters.category')}
          value={filters.category ?? ANY}
          onValueChange={(value) =>
            update({
              category:
                value === ANY
                  ? null
                  : (TEMPLATE_CATEGORIES.find((category) => category === value) ?? null),
            })
          }
          options={[
            { value: ANY, label: t('filters.anyCategory') },
            ...categories.map((value) => ({
              value: value as string,
              label: t(`category.${value}`),
            })),
          ]}
          wrapperClassName="w-full sm:w-56"
          className="w-full sm:w-56"
        />
        <SegmentedControl
          aria-label={t('filters.aspect')}
          value={filters.aspect ?? ANY}
          onValueChange={(value) =>
            update({
              aspect: value === ANY ? null : (AspectRatioSchema.parse(value) as AspectRatio),
            })
          }
          options={[
            { value: ANY, label: t('filters.anyAspect') },
            ...AspectRatioSchema.options.map((value) => ({
              value: value as string,
              label: value,
              title: t(`aspect.${ASPECT_KEYS[value]}`),
            })),
          ]}
        />
        {hasActiveTemplateFilters(filters) && (
          <Button variant="ghost" leftIcon={<X aria-hidden="true" />} onClick={clear}>
            {t('filters.clear')}
          </Button>
        )}
      </div>

      {gallery.isPending ? (
        <div className={GRID} aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-80 rounded-xl" />
          ))}
        </div>
      ) : gallery.isError ? (
        <ErrorState
          error={gallery.error}
          onRetry={() => void gallery.refetch()}
          retrying={gallery.isRefetching}
        />
      ) : shown.length === 0 ? (
        filters.kind === 'custom' && !hasActiveTemplateFilters(filters) ? (
          <EmptyState
            icon={<LayoutTemplate aria-hidden="true" />}
            title={t('empty.customTitle')}
            description={t('empty.customText')}
            action={
              <Button onClick={() => update({ kind: 'builtin' })}>{t('empty.seeBuiltin')}</Button>
            }
          />
        ) : (
          <EmptyState
            icon={<Search aria-hidden="true" />}
            title={t('empty.title')}
            description={t('empty.text')}
            action={
              hasActiveTemplateFilters(filters) ? (
                <Button onClick={clear}>{t('filters.clear')}</Button>
              ) : undefined
            }
          />
        )
      ) : (
        <ul className={GRID}>
          {shown.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onOpen={() => setOpen(template)}
              onUse={() => startFrom(template)}
              using={usingId === template.id && use.isPending}
              canUse={canUse && !use.isPending}
            />
          ))}
        </ul>
      )}

      <TemplateSheet
        template={open}
        onClose={() => setOpen(null)}
        onUse={startFrom}
        using={use.isPending}
        canUse={canUse && !use.isPending}
      />
    </>
  );
}
