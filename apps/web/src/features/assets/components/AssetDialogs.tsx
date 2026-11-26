import type { Asset } from '@parlante/shared';
import { Download, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, toAppUrl, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Button, ConfirmDialog, Dialog, Input, toast, useErrorText } from '@/ui';
import { dimensionsOf, usesFromConflict } from '../lib/describe';
import type { AssetUse } from '../lib/describe';
import { AssetThumb } from './AssetThumb';

const NAME_MAX = 120;

/* ---------- preview ---------- */

export function AssetPreviewDialog({
  asset,
  canEdit,
  onClose,
  onRename,
  onDownload,
  onDelete,
}: {
  asset: Asset | null;
  canEdit: boolean;
  onClose: () => void;
  onRename: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}) {
  const { t } = useTranslation('assets');
  const format = useFormat();
  if (!asset) return null;
  const url = toAppUrl(asset.url);
  const size = dimensionsOf(asset);
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      size="xl"
      title={asset.name}
      description={t(`kind.${asset.kind}`)}
      footer={
        <>
          {canEdit && (
            <>
              <Button
                variant="ghost"
                className="text-danger-text sm:mr-auto"
                leftIcon={<Trash2 aria-hidden="true" />}
                onClick={() => onDelete(asset)}
              >
                {t('actions.delete')}
              </Button>
              <Button leftIcon={<Pencil aria-hidden="true" />} onClick={() => onRename(asset)}>
                {t('actions.rename')}
              </Button>
            </>
          )}
          <Button
            variant="solid"
            leftIcon={<Download aria-hidden="true" />}
            onClick={() => onDownload(asset)}
          >
            {t('actions.download')}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-media">
          {asset.kind === 'image' ? (
            <img
              src={url}
              alt={t('preview.imageAlt', { name: asset.name })}
              className="max-h-[60dvh] w-full object-contain"
            />
          ) : asset.kind === 'video' ? (
            <video
              src={url}
              poster={toAppUrl(asset.thumbnailUrl)}
              controls
              playsInline
              preload="metadata"
              aria-label={t('preview.videoLabel', { name: asset.name })}
              className="max-h-[60dvh] w-full"
            />
          ) : (
            <div className="flex w-full flex-col">
              <AssetThumb id={asset.id} kind="audio" imageUrl={null} durationMs={null} />
              <audio
                src={url}
                controls
                preload="metadata"
                aria-label={t('preview.audioLabel', { name: asset.name })}
                className="w-full"
              />
            </div>
          )}
        </div>
        <dl className="grid content-start gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-1">
          <div>
            <dt className="text-fg-muted">{t('preview.type')}</dt>
            <dd className="font-medium break-all">{asset.mimeType}</dd>
          </div>
          <div>
            <dt className="text-fg-muted">{t('preview.size')}</dt>
            <dd className="nums font-medium">{format.bytes(asset.sizeBytes)}</dd>
          </div>
          {size && (
            <div>
              <dt className="text-fg-muted">{t('preview.dimensions')}</dt>
              <dd className="nums font-medium">{size} px</dd>
            </div>
          )}
          {asset.durationMs !== null && (
            <div>
              <dt className="text-fg-muted">{t('preview.duration')}</dt>
              <dd className="nums font-medium">{format.duration(asset.durationMs)}</dd>
            </div>
          )}
          <div>
            <dt className="text-fg-muted">{t('preview.uploaded')}</dt>
            <dd className="font-medium">
              {asset.createdBy
                ? t('preview.uploadedBy', {
                    name: asset.createdBy.name,
                    date: format.date(asset.createdAt),
                  })
                : format.date(asset.createdAt)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-fg-muted">{t('preview.id')}</dt>
            <dd className="font-mono text-xs break-all">{asset.id}</dd>
          </div>
        </dl>
      </div>
    </Dialog>
  );
}

/* ---------- rename ---------- */

export function RenameAssetDialog({
  asset,
  onClose,
  onRenamed,
}: {
  asset: Asset;
  onClose: () => void;
  /** Called with the updated asset after a successful rename (before `onClose`). */
  onRenamed?: (asset: Asset) => void;
}) {
  const { t } = useTranslation('assets');
  const errorText = useErrorText();
  const [name, setName] = useState(asset.name);
  const [error, setError] = useState<string | null>(null);
  const rename = useApiMutation(api.assets.update, {
    invalidates: [api.assets.list, api.assets.get],
    onSuccess: (updated) => {
      toast.success(t('rename.done'));
      onRenamed?.(updated);
      onClose();
    },
    onError: (err) => setError(errorText(err).title),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('rename.required'));
      return;
    }
    if (trimmed === asset.name) {
      onClose();
      return;
    }
    setError(null);
    rename.mutate({ params: { assetId: asset.id }, body: { name: trimmed } });
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => !next && !rename.isPending && onClose()}
      dismissible={!rename.isPending}
      size="sm"
      title={t('rename.title')}
      footer={
        <>
          <Button onClick={onClose} disabled={rename.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="rename-asset" variant="primary" loading={rename.isPending}>
            {t('rename.action')}
          </Button>
        </>
      }
    >
      <form id="rename-asset" onSubmit={submit} noValidate>
        <Input
          label={t('rename.name')}
          name="asset-name"
          maxLength={NAME_MAX}
          autoComplete="off"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          error={error ?? undefined}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

/* ---------- delete ---------- */

export function DeleteAssetDialog({
  asset,
  onClose,
  onDeleted,
}: {
  asset: Asset;
  onClose: () => void;
  onDeleted: (asset: Asset) => void;
}) {
  const { t } = useTranslation('assets');
  const errorText = useErrorText();
  const [uses, setUses] = useState<AssetUse[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const remove = useApiMutation(api.assets.remove, {
    invalidates: [api.assets.list, api.billing.overview],
    onError: (error: ApiError) => {
      const found = error.is('CONFLICT') ? usesFromConflict(error.details) : [];
      setUses(found);
      setFailure(found.length > 0 ? t('delete.inUse') : errorText(error).title);
    },
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      tone="danger"
      title={t('delete.title', { name: asset.name })}
      description={t('delete.text')}
      confirmLabel={t('delete.action')}
      onConfirm={async () => {
        setFailure(null);
        setUses([]);
        await remove.mutateAsync({ params: { assetId: asset.id } });
        toast.success(t('delete.done', { name: asset.name }));
        onDeleted(asset);
      }}
    >
      <p className="text-sm text-fg-muted">{t('delete.references')}</p>
      {failure && (
        <div
          role="alert"
          className="mt-3 rounded-md bg-danger-soft px-3.5 py-3 text-sm text-danger-text"
        >
          <p className="font-semibold">{failure}</p>
          {uses.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
              {uses.map((use) => (
                <li key={`${use.type}:${use.id}`}>
                  {t(`delete.usedBy.${use.type}`)}{' '}
                  <code className="font-mono text-xs">{use.id}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
