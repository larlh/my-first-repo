import type { Asset } from '@parlante/shared';
import { Download, Ellipsis, Eye, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/ui';
import { assetFacts } from '../lib/describe';
import { AssetThumb, KIND_ICON } from './AssetThumb';

export interface AssetCardProps {
  asset: Asset;
  canEdit: boolean;
  onPreview: (asset: Asset) => void;
  onRename: (asset: Asset) => void;
  onDownload: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

/** One file of the library: the thumbnail opens the preview, the menu holds the actions. */
export function AssetCard({
  asset,
  canEdit,
  onPreview,
  onRename,
  onDownload,
  onDelete,
}: AssetCardProps) {
  const { t } = useTranslation('assets');
  const format = useFormat();
  const Icon = KIND_ICON[asset.kind];
  return (
    <li className="group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xs transition-[border-color,box-shadow] duration-150 focus-within:border-line-strong hover:border-line-strong hover:shadow-md">
      <button
        type="button"
        onClick={() => onPreview(asset)}
        aria-label={t('card.preview', { name: asset.name })}
        className="block w-full outline-offset-[-2px]"
      >
        <AssetThumb
          id={asset.id}
          kind={asset.kind}
          imageUrl={asset.thumbnailUrl ?? (asset.kind === 'image' ? asset.url : null)}
          durationMs={asset.durationMs}
        />
      </button>
      <div className="flex items-start gap-1 py-2.5 pr-1.5 pl-3.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={asset.name}>
            {asset.name}
          </p>
          <p className="nums mt-0.5 flex items-center gap-1.5 truncate text-xs text-fg-muted">
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t(`kind.${asset.kind}`)}.</span>
            {assetFacts(asset, format)}
          </p>
        </div>
        <Menu>
          <MenuTrigger asChild>
            <IconButton size="sm" noTooltip label={t('card.more', { name: asset.name })}>
              <Ellipsis aria-hidden="true" />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem icon={<Eye />} onSelect={() => onPreview(asset)}>
              {t('actions.preview')}
            </MenuItem>
            <MenuItem icon={<Download />} onSelect={() => onDownload(asset)}>
              {t('actions.download')}
            </MenuItem>
            {canEdit && (
              <>
                <MenuItem icon={<Pencil />} onSelect={() => onRename(asset)}>
                  {t('actions.rename')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem tone="danger" icon={<Trash2 />} onSelect={() => onDelete(asset)}>
                  {t('actions.delete')}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>
    </li>
  );
}
