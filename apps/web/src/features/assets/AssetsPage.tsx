import type { Asset, AssetKind } from '@parlante/shared';
import { FolderOpen, HardDrive, Lock, Search, SearchX, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, downloadUrl, useApiInfiniteQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  LoadMore,
  PageHeader,
  SegmentedControl,
  Skeleton,
  cn,
} from '@/ui';
import { AssetCard } from './components/AssetCard';
import {
  AssetPreviewDialog,
  DeleteAssetDialog,
  RenameAssetDialog,
} from './components/AssetDialogs';
import { UploadDropArea } from './components/UploadDropArea';
import type { UploadDropAreaHandle } from './components/UploadDropArea';
import { UploadPanel } from './components/UploadPanel';
import { downloadHref, downloadName } from './lib/describe';
import { ASSET_KINDS, FORMAT_LABELS, acceptFor } from './lib/files';
import { useDebounced } from './lib/useDebounced';
import { useUploadQueue } from './lib/useUploadQueue';
import { useUploadRules } from './lib/useUploadRules';
import type { StorageUsage } from './lib/useUploadRules';

type KindFilter = 'all' | AssetKind;

export const ASSET_GRID =
  'grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 2xl:grid-cols-5';
const ACCEPT = acceptFor();
const BAR = { ok: 'bg-fg', high: 'bg-warning', full: 'bg-danger' } as const;

/** Storage of the workspace against the plan, plus the per-file limit. */
function StorageStrip({
  storage,
  failed,
  maxUploadBytes,
  plan,
}: {
  storage: StorageUsage | null;
  failed: boolean;
  maxUploadBytes: number;
  plan: string;
}) {
  const { t } = useTranslation('assets');
  const format = useFormat();
  const valueText = storage
    ? t('storage.value', {
        used: format.bytes(storage.usedBytes),
        limit: format.bytes(storage.limitBytes),
      })
    : '';
  return (
    <section
      aria-label={t('storage.title')}
      className="flex flex-col gap-x-8 gap-y-3 rounded-lg border border-line bg-surface px-5 py-4 shadow-xs md:flex-row md:items-center"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3.5">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-3 text-fg-muted"
        >
          <HardDrive className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="font-semibold">{t('storage.title')}</span>
            {storage ? (
              <span
                className={cn(
                  'nums font-medium whitespace-nowrap',
                  storage.level === 'full' && 'text-danger-text',
                )}
              >
                {valueText}
              </span>
            ) : failed ? (
              <span className="text-fg-muted">{t('storage.unknown')}</span>
            ) : (
              <Skeleton className="w-28" />
            )}
          </div>
          <div
            role="meter"
            aria-label={t('storage.title')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={storage?.percent ?? 0}
            aria-valuetext={storage ? valueText : t('storage.unknown')}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3"
          >
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-500',
                BAR[storage?.level ?? 'ok'],
              )}
              style={{
                width: `${storage ? Math.max(storage.percent, storage.usedBytes > 0 ? 2 : 0) : 0}%`,
              }}
            />
          </div>
        </div>
      </div>
      <p className="text-sm text-fg-muted md:max-w-xs md:text-right">
        {storage?.level === 'full'
          ? t('storage.full')
          : t('storage.perFile', { max: format.bytes(maxUploadBytes), plan })}
      </p>
    </section>
  );
}

function GridSkeleton() {
  return (
    <div className={ASSET_GRID} aria-hidden="true">
      {Array.from({ length: 10 }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-lg border border-line bg-surface">
          <Skeleton className="aspect-video h-auto w-full rounded-none" />
          <div className="flex flex-col gap-2 p-3.5">
            <Skeleton className="w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Asset library (master prompt §3.8): images, video and audio of the workspace, with drag and
 * drop upload, per-file progress, type and size checks against the plan, filters, preview,
 * rename, delete and the storage in use.
 */
export default function AssetsPage() {
  const { t } = useTranslation('assets');
  const format = useFormat();
  const session = useSession();
  const canEdit = session.can('editor');
  const dropArea = useRef<UploadDropAreaHandle | null>(null);

  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [previewing, setPreviewing] = useState<Asset | null>(null);
  const [renaming, setRenaming] = useState<Asset | null>(null);
  const [deleting, setDeleting] = useState<Asset | null>(null);

  const { rules, storage, storageQuery } = useUploadRules();
  const queue = useUploadQueue({ rules });
  const assets = useApiInfiniteQuery(api.assets.list, {
    query: { limit: 30, ...(kind === 'all' ? {} : { kind }), ...(q ? { q } : {}) },
  });

  const filtered = kind !== 'all' || q !== '';
  const maxUpload = format.bytes(rules.maxUploadBytes);
  const formats = ASSET_KINDS.map((item) => `${t(`kind.${item}`)}: ${FORMAT_LABELS[item]}`).join(
    ' · ',
  );
  const download = (asset: Asset) => downloadUrl(downloadHref(asset), downloadName(asset));
  const emptyLibrary = assets.isSuccess && assets.items.length === 0 && !filtered;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canEdit && (
            <Button
              variant="primary"
              leftIcon={<Upload aria-hidden="true" />}
              onClick={() => dropArea.current?.open()}
            >
              {t('upload.action')}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-5">
        <StorageStrip
          storage={storage}
          failed={storageQuery.isError}
          maxUploadBytes={rules.maxUploadBytes}
          plan={session.plan.name}
        />

        {canEdit ? (
          <UploadDropArea
            ref={dropArea}
            onFiles={queue.add}
            accept={ACCEPT}
            pageDrop
            pageDropLabel={t('upload.dropPage')}
            compact={!emptyLibrary}
            title={emptyLibrary ? t('upload.heroTitle') : t('upload.title')}
            description={
              <>
                {formats}
                <span className="block">{t('upload.limit', { max: maxUpload })}</span>
              </>
            }
          />
        ) : (
          <p className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3.5 text-sm">
            <Lock className="mt-0.5 size-[1.125rem] shrink-0 text-fg-muted" aria-hidden="true" />
            <span>{t('readOnly')}</span>
          </p>
        )}

        <UploadPanel queue={queue} maxUploadBytes={rules.maxUploadBytes} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedControl
            aria-label={t('filters.kind')}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'all', label: t('filters.all') },
              ...ASSET_KINDS.map((item) => ({ value: item, label: t(`kinds.${item}`) })),
            ]}
          />
          <Input
            type="search"
            aria-label={t('filters.search')}
            placeholder={t('filters.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leading={<Search aria-hidden="true" />}
            trailing={
              search !== '' && (
                <IconButton
                  size="sm"
                  noTooltip
                  label={t('filters.clearSearch')}
                  onClick={() => setSearch('')}
                >
                  <X aria-hidden="true" />
                </IconButton>
              )
            }
            wrapperClassName="sm:w-72"
            className="[&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        {assets.isPending ? (
          <GridSkeleton />
        ) : assets.isError ? (
          <div className="rounded-lg border border-line bg-surface">
            <ErrorState
              error={assets.error}
              onRetry={() => void assets.refetch()}
              retrying={assets.isRefetching}
            />
          </div>
        ) : assets.items.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            {filtered ? (
              <EmptyState
                icon={<SearchX />}
                title={t('empty.filteredTitle')}
                description={t('empty.filteredText')}
                action={
                  <Button
                    onClick={() => {
                      setKind('all');
                      setSearch('');
                    }}
                  >
                    {t('empty.clear')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<FolderOpen />}
                title={t('empty.title')}
                description={canEdit ? t('empty.text') : t('empty.textViewer')}
                action={
                  canEdit && (
                    <Button
                      variant="primary"
                      leftIcon={<Upload aria-hidden="true" />}
                      onClick={() => dropArea.current?.open()}
                    >
                      {t('upload.action')}
                    </Button>
                  )
                }
              />
            )}
          </div>
        ) : (
          <>
            <ul className={ASSET_GRID} aria-label={t('list')}>
              {assets.items.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  canEdit={canEdit}
                  onPreview={setPreviewing}
                  onRename={setRenaming}
                  onDownload={download}
                  onDelete={setDeleting}
                />
              ))}
            </ul>
            <LoadMore
              hasMore={assets.hasNextPage}
              loading={assets.isFetchingNextPage}
              onLoadMore={() => void assets.fetchNextPage()}
            />
          </>
        )}
      </div>

      <AssetPreviewDialog
        asset={previewing}
        canEdit={canEdit}
        onClose={() => setPreviewing(null)}
        onRename={setRenaming}
        onDownload={download}
        onDelete={setDeleting}
      />
      {renaming && (
        <RenameAssetDialog
          asset={renaming}
          onClose={() => setRenaming(null)}
          // Keep an open preview in step with the new name.
          onRenamed={(updated) => setPreviewing((current) => (current ? updated : null))}
        />
      )}
      {deleting && (
        <DeleteAssetDialog
          asset={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => setPreviewing(null)}
        />
      )}
    </>
  );
}
