import { GenderSchema, LANGUAGE_CODES, languageName } from '@parlante/shared';
import type { LanguageCode, Voice } from '@parlante/shared';
import { AudioLines, Mic, Play, Search, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  VoiceBars,
  cn,
} from '@/ui';
import {
  CountBadge,
  LIB_ROUTES,
  useAvailableRoutes,
  useDebounced,
  useSpeechPreview,
} from '@/features/avatars/kit';
import { DEFAULT_PREVIEW, VoiceConsole } from './components/VoiceConsole';
import type { PreviewSettings } from './components/VoiceConsole';
import {
  VOICE_KINDS,
  countByKind,
  filterVoices,
  groupVoices,
  hasActiveVoiceFilters,
  languageCounts,
  previewLanguage,
  providersOf,
  sampleText,
  voiceFiltersFromParams,
  voiceFiltersToParams,
} from './lib/voices';
import type { VoiceFilters, VoiceKind } from './lib/voices';

const ANY = 'any';
const POLL_MS = 2000;
const DESKTOP = '(min-width: 1024px)';

/** True from the `lg` breakpoint up (the console sits beside the list instead of in a sheet). */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const query = window.matchMedia(DESKTOP);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP).matches,
    () => true,
  );
}

function VoiceRow({
  voice,
  selected,
  state,
  onSelect,
  onToggle,
}: {
  voice: Voice;
  selected: boolean;
  state: 'idle' | 'loading' | 'playing';
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation('voices');
  const ready = voice.status === 'ready';
  return (
    <li
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-lg border bg-surface pl-1.5 transition-[border-color,box-shadow] duration-150',
        selected
          ? 'border-fg shadow-[inset_0_0_0_1px_var(--fg)]'
          : 'border-line hover:border-line-strong',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!ready}
        aria-label={
          state === 'idle'
            ? t('row.play', { name: voice.name })
            : t('row.stop', { name: voice.name })
        }
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full transition-colors duration-150',
          state === 'idle'
            ? 'bg-surface-3 text-fg hover:bg-accent hover:text-accent-fg'
            : 'bg-accent text-accent-fg',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
      >
        {state === 'loading' ? (
          <VoiceBars size="sm" label={null} className="text-accent-fg" />
        ) : state === 'playing' ? (
          <Square aria-hidden="true" className="size-3.5 fill-current" />
        ) : (
          <Play aria-hidden="true" className="ml-0.5 size-4 fill-current" />
        )}
      </button>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-2.5 pr-3 pl-2 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{voice.name}</span>
          <span className="block truncate text-xs text-fg-muted">
            {t(`gender.${voice.gender}`)}
            {voice.description ? ` · ${voice.description}` : ''}
          </span>
        </span>
        {voice.status === 'processing' && (
          <Badge tone="saffron" dot pulse size="sm">
            {t('row.processing')}
          </Badge>
        )}
        {voice.status === 'failed' && (
          <Badge tone="danger" size="sm">
            {t('row.failed')}
          </Badge>
        )}
        {voice.multilingual && (
          <Badge tone="info" size="sm">
            {t('multilingual')}
          </Badge>
        )}
        <ProviderBadge
          provider={voice.provider}
          tierOnly
          size="sm"
          className="hidden sm:inline-flex"
        />
      </button>
    </li>
  );
}

/**
 * Voice library (master prompt §3.3): voices by language, gender and provider, with a
 * listening desk (own text, speed, pitch) that always says which provider made the sound.
 */
export default function VoicesPage() {
  const { t, i18n } = useTranslation('voices');
  const session = useSession();
  const available = useAvailableRoutes();
  const desktop = useIsDesktop();
  const uiLocale = i18n.language.startsWith('en') ? 'en' : 'es';
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => voiceFiltersFromParams(params), [params]);
  const selectedId = params.get('voice');

  const catalogue = useApiQuery(api.voices.list, undefined, {
    refetchInterval: (query) =>
      query.state.data?.items.some((voice) => voice.status === 'processing') ? POLL_MS : false,
  });
  const all = useMemo(() => catalogue.data?.items ?? [], [catalogue.data]);

  const [search, setSearch] = useState(filters.q);
  const settledSearch = useDebounced(search);
  const update = (patch: Partial<VoiceFilters>) =>
    setParams(
      (current) => voiceFiltersToParams({ ...voiceFiltersFromParams(current), ...patch }, current),
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

  const shown = useMemo(() => filterVoices(all, filters), [all, filters]);
  const counts = useMemo(() => countByKind(all, filters), [all, filters]);
  const groups = useMemo(() => groupVoices(shown), [shown]);
  const languages = useMemo(() => languageCounts(all), [all]);
  const providers = useMemo(() => providersOf(all), [all]);

  const [settings, setSettings] = useState<PreviewSettings>(DEFAULT_PREVIEW);
  const speech = useSpeechPreview();
  /** Phones: the console opens in a sheet when a voice is chosen. */
  const [sheetOpen, setSheetOpen] = useState(false);

  // On a wide screen there is always a voice on the desk: the first one listed.
  const explicit = selectedId ? (all.find((voice) => voice.id === selectedId) ?? null) : null;
  const selected: Voice | null = explicit ?? (desktop ? (shown[0] ?? null) : null);

  const languageOf = (voice: Voice): LanguageCode =>
    previewLanguage(voice, settings.language ?? filters.language);

  const select = (voice: Voice) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('voice', voice.id);
        return next;
      },
      { replace: true },
    );
    if (!desktop) setSheetOpen(true);
  };

  const play = (voice: Voice) => {
    const language = languageOf(voice);
    void speech.play(voice.id, {
      text: (settings.text ?? sampleText(language)).trim() || sampleText(language),
      voiceId: voice.id,
      language,
      speed: settings.speed,
      pitch: settings.pitch,
    });
  };
  const toggle = (voice: Voice) => {
    if (speech.activeKey === voice.id && speech.status !== 'error') return speech.stop();
    // A quick listen from the list also puts the voice on the desk (not in a sheet).
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('voice', voice.id);
        return next;
      },
      { replace: true },
    );
    play(voice);
  };

  const clear = () => {
    setSearch('');
    update({ language: null, gender: null, provider: null, q: '' });
  };
  const closeSheet = () => {
    setSheetOpen(false);
    speech.stop();
  };
  const dropSelection = () => {
    setSheetOpen(false);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('voice');
        return next;
      },
      { replace: true },
    );
  };

  const console_ = selected ? (
    <VoiceConsole
      voice={selected}
      language={languageOf(selected)}
      settings={settings}
      onSettings={setSettings}
      speech={speech}
      onPlay={play}
      onDeleted={dropSelection}
    />
  ) : null;

  const canClone = available.cloneVoice && session.can('editor');
  const cloneButton = canClone ? (
    <Button asChild variant="primary" leftIcon={<Mic aria-hidden="true" />}>
      <Link to={LIB_ROUTES.cloneVoice}>{t('clone')}</Link>
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        actions={cloneButton}
      >
        <Tabs
          aria-label={t('kinds.label')}
          value={filters.kind}
          onValueChange={(kind: VoiceKind) => update({ kind })}
          tabs={VOICE_KINDS.map((kind) => ({
            value: kind,
            label: t(`kinds.${kind}`),
            badge: catalogue.isSuccess ? <CountBadge value={counts[kind]} /> : undefined,
          }))}
        />
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0">
          <div
            role="search"
            aria-label={t('filters.label')}
            className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3"
          >
            <Input
              type="search"
              aria-label={t('filters.search')}
              placeholder={t('filters.searchPlaceholder')}
              leading={<Search aria-hidden="true" />}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              wrapperClassName="col-span-2 sm:col-span-3"
            />
            <Select
              aria-label={t('filters.language')}
              className="max-sm:col-span-2"
              value={filters.language ?? ANY}
              onValueChange={(value) =>
                update({
                  language:
                    value === ANY ? null : (LANGUAGE_CODES.find((code) => code === value) ?? null),
                })
              }
              options={[
                { value: ANY, label: t('filters.anyLanguage') },
                ...languages.map((entry) => ({
                  value: entry.code as string,
                  label: `${languageName(entry.code, uiLocale)} (${entry.count})`,
                })),
              ]}
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
              aria-label={t('filters.provider')}
              value={filters.provider ?? ANY}
              onValueChange={(value) => update({ provider: value === ANY ? null : value })}
              options={[
                { value: ANY, label: t('filters.anyProvider') },
                ...providers.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                  description:
                    provider.quality === 'basic' ? t('filters.basic') : t('filters.premium'),
                })),
              ]}
            />
            {hasActiveVoiceFilters(filters) && (
              <Button
                variant="ghost"
                className="justify-self-start"
                leftIcon={<X aria-hidden="true" />}
                onClick={clear}
              >
                {t('filters.clear')}
              </Button>
            )}
          </div>

          {catalogue.isPending ? (
            <div className="grid gap-2 sm:grid-cols-2" aria-busy="true">
              {Array.from({ length: 12 }, (_, index) => (
                <Skeleton key={index} className="h-14 rounded-lg" />
              ))}
            </div>
          ) : catalogue.isError ? (
            <ErrorState
              error={catalogue.error}
              onRetry={() => void catalogue.refetch()}
              retrying={catalogue.isRefetching}
            />
          ) : shown.length === 0 ? (
            filters.kind === 'cloned' && !hasActiveVoiceFilters(filters) ? (
              <EmptyState
                icon={<Mic aria-hidden="true" />}
                title={t('empty.clonedTitle')}
                description={t('empty.clonedText')}
                action={cloneButton}
              />
            ) : (
              <EmptyState
                icon={<AudioLines aria-hidden="true" />}
                title={t('empty.title')}
                description={t('empty.text')}
                action={
                  hasActiveVoiceFilters(filters) ? (
                    <Button onClick={clear}>{t('filters.clear')}</Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <div className="flex flex-col gap-7">
              {groups.map((group) => (
                <section key={group.key} aria-labelledby={`voices-${group.key}`}>
                  <div className="mb-2.5 flex items-baseline gap-3">
                    <h2 id={`voices-${group.key}`} className="text-xl">
                      {group.key === 'cloned'
                        ? t('groups.cloned')
                        : group.key === 'multi'
                          ? t('groups.multi')
                          : languageName(group.key, uiLocale)}
                    </h2>
                    {group.key !== 'cloned' && group.key !== 'multi' && (
                      <span className="font-mono text-xs text-fg-subtle uppercase">
                        {group.key}
                      </span>
                    )}
                    <span aria-hidden="true" className="h-px flex-1 bg-line" />
                    <span className="nums text-xs text-fg-muted">
                      {t('groups.count', { count: group.voices.length })}
                    </span>
                  </div>
                  {group.key === 'multi' && (
                    <p className="mb-2.5 text-sm text-fg-muted">{t('groups.multiHint')}</p>
                  )}
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {group.voices.map((voice) => (
                      <VoiceRow
                        key={voice.id}
                        voice={voice}
                        selected={selected?.id === voice.id}
                        state={
                          speech.activeKey === voice.id &&
                          (speech.status === 'loading' || speech.status === 'playing')
                            ? speech.status
                            : 'idle'
                        }
                        onSelect={() => select(voice)}
                        onToggle={() => toggle(voice)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        {desktop && (
          <aside className="sticky top-6 min-w-0">
            {console_ ??
              (catalogue.isPending ? (
                <Skeleton className="h-[32rem] rounded-xl" />
              ) : (
                <div className="rounded-xl border border-dashed border-line-strong p-6 text-center text-sm text-fg-muted">
                  {t('console.none')}
                </div>
              ))}
          </aside>
        )}
      </div>

      {!desktop && (
        <Dialog
          open={sheetOpen && selected !== null}
          onOpenChange={(open) => !open && closeSheet()}
          title={t('console.sheetTitle')}
          hideTitle
          size="md"
        >
          {console_}
        </Dialog>
      )}
    </>
  );
}
