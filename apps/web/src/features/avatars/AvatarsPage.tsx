import { AgeGroupSchema, AvatarStyleSchema, GenderSchema } from '@parlante/shared';
import type { Avatar } from '@parlante/shared';
import { Search, Sparkles, UserRoundPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApiQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  toast,
} from '@/ui';
import { AvatarCard } from './components/AvatarCard';
import { AvatarSheet } from './components/AvatarSheet';
import { CountBadge, EngineStrip, LIB_ROUTES, useAvailableRoutes, useDebounced } from './kit';
import {
  AVATAR_VIEWS,
  countByView,
  filterAvatars,
  filtersFromParams,
  filtersToParams,
  hasActiveFilters,
  shelvesOf,
} from './lib/filters';
import type { AvatarFilters, AvatarView } from './lib/filters';

const ANY = 'any';
const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5';
/** While an own avatar is being prepared the catalogue is re-read to show its progress. */
const POLL_MS = 2000;

/**
 * Avatar library (master prompt §3.2 and §2b): instant 2D avatars with a live animated
 * preview, the photorealistic stock of synthetic people and the avatars the workspace made
 * from a photo or a description — always labelled by how they are animated.
 */
export default function AvatarsPage() {
  const { t } = useTranslation('avatars');
  const session = useSession();
  const available = useAvailableRoutes();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const openId = params.get('avatar');

  const catalogue = useApiQuery(api.avatars.list, undefined, {
    refetchInterval: (query) =>
      query.state.data?.items.some((avatar) => avatar.status === 'processing') ? POLL_MS : false,
  });
  const all = useMemo(() => catalogue.data?.items ?? [], [catalogue.data]);
  const engine = catalogue.data?.engine ?? null;

  // The search box answers at once; the URL (and the grid) follow when typing pauses.
  const [search, setSearch] = useState(filters.q);
  const settledSearch = useDebounced(search);
  const update = (patch: Partial<AvatarFilters>) =>
    setParams((current) => filtersToParams({ ...filtersFromParams(current), ...patch }, current), {
      replace: true,
    });
  useEffect(() => {
    if (settledSearch !== filters.q) update({ q: settledSearch });
    // Only the settled text drives the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSearch]);
  useEffect(() => {
    // Back / forward and "clear filters" change the URL behind the box.
    setSearch((current) => (current.trim() === filters.q.trim() ? current : filters.q));
  }, [filters.q]);

  const shown = useMemo(() => filterAvatars(all, filters), [all, filters]);
  const counts = useMemo(() => countByView(all, filters), [all, filters]);
  const shelves = useMemo(() => shelvesOf(shown), [shown]);

  const fromList = openId ? (all.find((avatar) => avatar.id === openId) ?? null) : null;
  const single = useApiQuery(
    api.avatars.get,
    { params: { avatarId: openId ?? '' } },
    { enabled: openId !== null && catalogue.isSuccess && fromList === null, retry: false },
  );
  const open: Avatar | null = openId ? (fromList ?? single.data ?? null) : null;

  const setOpen = (avatar: Avatar | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (avatar) next.set('avatar', avatar.id);
      else next.delete('avatar');
      return next;
    });
  useEffect(() => {
    if (!single.isError) return;
    toast.error(t('missing'));
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('avatar');
        return next;
      },
      { replace: true },
    );
  }, [single.isError, setParams, t]);

  const clear = () => {
    setSearch('');
    update({ gender: null, ageGroup: null, style: null, q: '' });
  };

  const canCreate = available.newAvatar && session.can('editor');
  const createButton = canCreate ? (
    <Button asChild variant="primary" leftIcon={<UserRoundPlus aria-hidden="true" />}>
      <Link to={LIB_ROUTES.newAvatar}>{t('create')}</Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        actions={createButton}
      >
        <Tabs
          aria-label={t('views.label')}
          value={filters.view}
          onValueChange={(view: AvatarView) => update({ view })}
          tabs={AVATAR_VIEWS.map((view) => ({
            value: view,
            label: t(`views.${view}`),
            badge: catalogue.isSuccess ? <CountBadge value={counts[view]} /> : undefined,
          }))}
        />
      </PageHeader>

      <div
        role="search"
        aria-label={t('filters.label')}
        className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1fr)_repeat(3,11rem)_auto]"
      >
        <Input
          type="search"
          aria-label={t('filters.search')}
          placeholder={t('filters.searchPlaceholder')}
          leading={<Search aria-hidden="true" />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          wrapperClassName="col-span-2 lg:col-span-1"
        />
        <Select
          aria-label={t('filters.gender')}
          value={filters.gender ?? ANY}
          onValueChange={(value) =>
            update({ gender: value === ANY ? null : GenderSchema.parse(value) })
          }
          options={[
            { value: ANY, label: t('filters.anyGender') },
            ...GenderSchema.options.map((value) => ({ value, label: t(`gender.${value}`) })),
          ]}
        />
        <Select
          aria-label={t('filters.age')}
          value={filters.ageGroup ?? ANY}
          onValueChange={(value) =>
            update({ ageGroup: value === ANY ? null : AgeGroupSchema.parse(value) })
          }
          options={[
            { value: ANY, label: t('filters.anyAge') },
            ...AgeGroupSchema.options.map((value) => ({ value, label: t(`age.${value}`) })),
          ]}
        />
        <Select
          aria-label={t('filters.style')}
          className={hasActiveFilters(filters) ? undefined : 'max-sm:col-span-2'}
          value={filters.style ?? ANY}
          onValueChange={(value) =>
            update({ style: value === ANY ? null : AvatarStyleSchema.parse(value) })
          }
          options={[
            { value: ANY, label: t('filters.anyStyle') },
            ...AvatarStyleSchema.options.map((value) => ({ value, label: t(`style.${value}`) })),
          ]}
        />
        {hasActiveFilters(filters) && (
          <Button variant="ghost" leftIcon={<X aria-hidden="true" />} onClick={clear}>
            {t('filters.clear')}
          </Button>
        )}
      </div>

      {filters.view !== 'instant' && catalogue.isSuccess && (
        <EngineStrip
          engine={engine}
          onRefresh={() => void catalogue.refetch()}
          refreshing={catalogue.isRefetching}
          className="mb-6"
        />
      )}

      {catalogue.isPending ? (
        <div className={GRID} aria-busy="true">
          {Array.from({ length: 10 }, (_, index) => (
            <Skeleton key={index} className="aspect-[4/6] rounded-xl" />
          ))}
        </div>
      ) : catalogue.isError ? (
        <ErrorState
          error={catalogue.error}
          onRetry={() => void catalogue.refetch()}
          retrying={catalogue.isRefetching}
        />
      ) : shown.length === 0 ? (
        filters.view === 'mine' && !hasActiveFilters(filters) ? (
          <EmptyState
            icon={<Sparkles aria-hidden="true" />}
            title={t('empty.mineTitle')}
            description={t('empty.mineText')}
            action={createButton}
          />
        ) : (
          <EmptyState
            icon={<Search aria-hidden="true" />}
            title={t('empty.title')}
            description={t('empty.text')}
            action={
              hasActiveFilters(filters) ? (
                <Button onClick={clear}>{t('filters.clear')}</Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div className="flex flex-col gap-10">
          {shelves.map((shelf) => (
            <section key={shelf.origin} aria-labelledby={`shelf-${shelf.origin}`}>
              <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
                <div className="min-w-0">
                  <p className="eyebrow nums text-fg-subtle">
                    {t('shelf.count', { count: shelf.avatars.length })}
                  </p>
                  <h2 id={`shelf-${shelf.origin}`} className="text-2xl">
                    {t(`shelf.${shelf.origin}.title`)}
                  </h2>
                </div>
                <p className="max-w-xl text-sm text-pretty text-fg-muted">
                  {t(`shelf.${shelf.origin}.text`)}
                </p>
              </div>
              <ul className={GRID}>
                {shelf.avatars.map((avatar, index) => (
                  <AvatarCard key={avatar.id} avatar={avatar} index={index} onOpen={setOpen} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <AvatarSheet avatar={open} engine={engine} onClose={() => setOpen(null)} />
    </>
  );
}
