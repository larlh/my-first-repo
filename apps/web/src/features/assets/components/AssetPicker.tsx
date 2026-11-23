import type { Asset, AssetKind, MediaRef, StockAsset } from '@parlante/shared';
import { Check, FolderOpen, Search, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useApiInfiniteQuery, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LoadMore,
  SegmentedControl,
  Skeleton,
  Tabs,
  cn,
} from '@/ui';
import { assetFacts } from '../lib/describe';
import { ASSET_KINDS, FORMAT_LABELS, acceptFor } from '../lib/files';
import { useDebounced } from '../lib/useDebounced';
import { useUploadQueue } from '../lib/useUploadQueue';
import { useUploadRules } from '../lib/useUploadRules';
import { AssetThumb } from './AssetThumb';
import { UploadDropArea } from './UploadDropArea';
import { UploadPanel } from './UploadPanel';

/** What the picker hands back: a ready `MediaRef` plus what a caller needs to show it. */
export interface PickedMedia {
  /** Put this in the composition (`background.src`, image / video layer `src`, music…). */
  ref: MediaRef;
  source: 'asset' | 'stock';
  kind: AssetKind;
  name: string;
  /** Signed (assets) or static (stock) URL. Pass it through `toAppUrl` before drawing it. */
  url: string;
  thumbnailUrl: string | null;
  /** Null for stock media. */
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface AssetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen file; the picker closes itself afterwards. */
  onSelect: (picked: PickedMedia) => void;
  /** Kinds the slot can use (default: all three). */
  kinds?: readonly AssetKind[];
  /** Also offer the built-in stock media (default true). */
  includeStock?: boolean;
  /** Narrow the stock tab to one category (`background`, `music`, `overlay`). */
  stockCategory?: StockAsset['category'];
  /** Currently used media: shown as selected when the picker opens. */
  value?: MediaRef | null;
  title?: ReactNode;
  description?: ReactNode;
  /** Label of the confirm button (default "Usar este archivo"). */
  confirmLabel?: ReactNode;
}

type Source = 'library' | 'stock';
type KindFilter = 'all' | AssetKind;

export function pickedFromAsset(asset: Asset): PickedMedia {
  return {
    ref: { source: 'asset', assetId: asset.id },
    source: 'asset',
    kind: asset.kind,
    name: asset.name,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
  };
}

export function pickedFromStock(stock: StockAsset): PickedMedia {
  return {
    ref: { source: 'stock', stockId: stock.id },
    source: 'stock',
    kind: stock.kind,
    name: stock.name,
    url: stock.url,
    thumbnailUrl: stock.kind === 'image' ? stock.url : null,
    sizeBytes: null,
    width: stock.width,
    height: stock.height,
    durationMs: stock.durationMs,
  };
}

function refKey(ref: MediaRef | null | undefined): string | null {
  if (!ref) return null;
  return ref.source === 'asset' ? `asset:${ref.assetId}` : `stock:${ref.stockId}`;
}

const GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4';

function Tile({
  media,
  facts,
  selected,
  onSelect,
  onConfirm,
}: {
  media: PickedMedia;
  facts: string;
  selected: boolean;
  onSelect: () => void;
  onConfirm: () => void;
}) {
  const id = media.ref.source === 'asset' ? media.ref.assetId : media.ref.stockId;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        onDoubleClick={onConfirm}
        className={cn(
          'relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg border bg-surface text-left transition-[border-color,box-shadow] duration-150',
          selected
            ? 'border-fg shadow-[inset_0_0_0_1px_var(--fg)]'
            : 'border-line hover:border-line-strong',
        )}
      >
        <AssetThumb
          id={id}
          kind={media.kind}
          imageUrl={media.thumbnailUrl ?? (media.kind === 'image' ? media.url : null)}
          durationMs={media.durationMs}
        />
        {selected && (
          <span
            aria-hidden="true"
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-accent text-accent-fg shadow-sm"
          >
            <Check className="size-4" strokeWidth={3} />
          </span>
        )}
        <span className="block min-w-0 px-3 py-2">
          <span className="block truncate text-sm font-semibold">{media.name}</span>
          <span className="nums block truncate text-xs text-fg-muted">{facts}</span>
        </span>
      </button>
    </li>
  );
}

function GridSkeleton() {
  return (
    <div className={GRID} aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="aspect-[4/3] h-auto rounded-lg" />
      ))}
    </div>
  );
}

/* The body is mounted only while the dialog is open, so closing discards the search, the
 * selection and any finished upload rows. */
function PickerBody({
  onOpenChange,
  onSelect,
  kinds,
  includeStock,
  stockCategory,
  value,
  title,
  description,
  confirmLabel,
}: Required<Pick<AssetPickerProps, 'onOpenChange' | 'onSelect' | 'kinds' | 'includeStock'>> &
  Pick<AssetPickerProps, 'stockCategory' | 'value' | 'title' | 'description' | 'confirmLabel'>) {
  const { t } = useTranslation('assets');
  const format = useFormat();
  const session = useSession();
  const canEdit = session.can('editor');
  const initialKey = refKey(value);

  const [source, setSource] = useState<Source>(
    includeStock && value?.source === 'stock' ? 'stock' : 'library',
  );
  const [kind, setKind] = useState<KindFilter>(
    kinds.length === 1 ? (kinds[0] as AssetKind) : 'all',
  );
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey);

  const select = (media: PickedMedia) => {
    setPicked(media);
    setSelectedKey(refKey(media.ref));
  };
  const confirm = (media: PickedMedia | null = picked) => {
    if (!media) return;
    onSelect(media);
    onOpenChange(false);
  };

  const { rules } = useUploadRules();
  const queue = useUploadQueue({
    rules,
    kinds,
    // A file uploaded from here is what the user came for: select it right away.
    onUploaded: (asset) => {
      if (kinds.includes(asset.kind)) select(pickedFromAsset(asset));
    },
  });

  // One kind → ask the API for it; several (but not all) → filter the page in the browser.
  const apiKind = kind !== 'all' ? kind : kinds.length === 1 ? kinds[0] : undefined;
  const assets = useApiInfiniteQuery(
    api.assets.list,
    { query: { limit: 24, ...(apiKind ? { kind: apiKind } : {}), ...(q ? { q } : {}) } },
    { enabled: source === 'library' },
  );
  const stock = useApiQuery(
    api.assets.listStock,
    {
      query: {
        ...(apiKind ? { kind: apiKind } : {}),
        ...(stockCategory ? { category: stockCategory } : {}),
      },
    },
    { enabled: includeStock && source === 'stock', staleTime: 5 * 60_000 },
  );

  const libraryItems = useMemo(
    () => assets.items.filter((asset) => kinds.includes(asset.kind)).map(pickedFromAsset),
    [assets.items, kinds],
  );
  const stockItems = useMemo(() => {
    const needle = q.toLowerCase();
    return (stock.data?.items ?? [])
      .filter((item) => kinds.includes(item.kind))
      .filter(
        (item) =>
          needle === '' ||
          item.name.toLowerCase().includes(needle) ||
          item.tags.some((tag) => tag.toLowerCase().includes(needle)),
      )
      .map(pickedFromStock);
  }, [stock.data, kinds, q]);

  const query = source === 'library' ? assets : stock;
  const items = source === 'library' ? libraryItems : stockItems;
  const filtered = q !== '' || (kind !== 'all' && kinds.length > 1);
  const formats = kinds.map((item) => FORMAT_LABELS[item]).join(', ');
  // Something is selected but its details are unknown until it is clicked (initial `value`).
  const keepingCurrent = picked === null && selectedKey !== null && selectedKey === initialKey;

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="xl"
      title={title ?? t('picker.title')}
      description={description ?? t('picker.text')}
      footer={
        <>
          <p
            className="min-w-0 truncate text-sm text-fg-muted sm:mr-auto sm:self-center"
            role="status"
          >
            {picked
              ? t('picker.selected', { name: picked.name })
              : keepingCurrent
                ? t('picker.current')
                : t('picker.none')}
          </p>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!picked} onClick={() => confirm()}>
            {confirmLabel ?? t('picker.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {includeStock && (
          <Tabs
            aria-label={t('picker.source')}
            value={source}
            onValueChange={setSource}
            tabs={[
              { value: 'library', label: t('picker.library') },
              { value: 'stock', label: t('picker.stock') },
            ]}
          />
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {kinds.length > 1 ? (
            <SegmentedControl
              size="sm"
              aria-label={t('filters.kind')}
              value={kind}
              onValueChange={setKind}
              options={[
                { value: 'all', label: t('filters.all') },
                ...ASSET_KINDS.filter((item) => kinds.includes(item)).map((item) => ({
                  value: item,
                  label: t(`kinds.${item}`),
                })),
              ]}
            />
          ) : (
            <p className="text-sm font-medium text-fg-muted">
              {t('picker.only', { kind: t(`kinds.${kinds[0] as AssetKind}`) })}
            </p>
          )}
          <Input
            type="search"
            size="sm"
            aria-label={t('filters.search')}
            placeholder={t('filters.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leading={<Search aria-hidden="true" />}
            wrapperClassName="sm:w-64"
          />
        </div>

        {source === 'library' && canEdit && (
          <>
            <UploadDropArea
              compact
              onFiles={queue.add}
              accept={acceptFor(kinds)}
              title={t('picker.upload')}
              description={t('picker.uploadHint', {
                formats,
                max: format.bytes(rules.maxUploadBytes),
              })}
            />
            <UploadPanel queue={queue} maxUploadBytes={rules.maxUploadBytes} />
          </>
        )}

        {source === 'stock' && <p className="text-sm text-fg-muted">{t('picker.stockHint')}</p>}

        <div className="min-h-48">
          {query.isPending ? (
            <GridSkeleton />
          ) : query.isError ? (
            <ErrorState
              size="sm"
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isRefetching}
            />
          ) : items.length === 0 ? (
            <EmptyState
              size="sm"
              icon={filtered ? <SearchX /> : <FolderOpen />}
              title={
                filtered
                  ? t('empty.filteredTitle')
                  : source === 'stock'
                    ? t('picker.emptyStock')
                    : t('picker.emptyLibrary')
              }
              description={
                filtered
                  ? t('empty.filteredText')
                  : source === 'library'
                    ? canEdit
                      ? t('picker.emptyLibraryText')
                      : t('empty.textViewer')
                    : undefined
              }
            />
          ) : (
            <ul className={GRID} aria-label={t('picker.results')}>
              {items.map((media) => {
                const key = refKey(media.ref);
                return (
                  <Tile
                    key={key}
                    media={media}
                    facts={
                      media.sizeBytes !== null
                        ? assetFacts({ ...media, sizeBytes: media.sizeBytes }, format)
                        : t('picker.stockBadge')
                    }
                    selected={key === selectedKey}
                    onSelect={() => select(media)}
                    onConfirm={() => confirm(media)}
                  />
                );
              })}
            </ul>
          )}
        </div>
        {source === 'library' && (
          <LoadMore
            hasMore={assets.hasNextPage}
            loading={assets.isFetchingNextPage}
            onLoadMore={() => void assets.fetchNextPage()}
          />
        )}
      </div>
    </Dialog>
  );
}

/**
 * Reusable asset picker (Studio backgrounds, image / video layers, music, brand logos…).
 *
 *   const [open, setOpen] = useState(false);
 *   <AssetPicker
 *     open={open}
 *     onOpenChange={setOpen}
 *     kinds={['image']}
 *     onSelect={(picked) => setBackground({ type: 'image', src: picked.ref })}
 *   />
 *
 * It lists the workspace library (search, kind filter, pagination) and, unless
 * `includeStock={false}`, the built-in stock media; editors can upload from inside it and the
 * new file is selected automatically. `onSelect` receives a `MediaRef` ready for a
 * Composition. Needs a session (use it under `app` / `fullscreen` routes).
 */
export function AssetPicker({
  open,
  onOpenChange,
  onSelect,
  kinds = ASSET_KINDS,
  includeStock = true,
  ...rest
}: AssetPickerProps) {
  if (!open) return null;
  return (
    <PickerBody
      onOpenChange={onOpenChange}
      onSelect={onSelect}
      kinds={kinds}
      includeStock={includeStock}
      {...rest}
    />
  );
}
