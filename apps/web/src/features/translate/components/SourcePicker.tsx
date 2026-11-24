import { ALLOWED_UPLOAD_MIME } from '@parlante/shared';
import { CircleCheck, Film, FileVideo, Upload, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, toAppUrl, useApiInfiniteQuery, useUpload } from '@/lib/api';
import { useFormat } from '@/lib/format';
import {
  Button,
  EmptyState,
  ErrorState,
  FileDropzone,
  LoadMore,
  ProgressBar,
  Skeleton,
  TabPanel,
  Tabs,
  cn,
  useErrorText,
} from '@/ui';
import type { TranslationSource } from '../lib/translate';

type Tab = 'upload' | 'videos';

interface Choice {
  key: string;
  source: TranslationSource;
}

function ChoiceList({
  choices,
  value,
  onChange,
  legend,
}: {
  choices: Choice[];
  value: TranslationSource | null;
  onChange: (source: TranslationSource) => void;
  legend: string;
}) {
  const { t } = useTranslation('translate');
  const format = useFormat();
  const name = useId();
  const selectedKey =
    value === null ? null : value.kind === 'asset' ? value.assetId : value.videoId;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-semibold">{legend}</legend>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {choices.map(({ key, source }) => (
          <label key={key} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name={name}
              value={key}
              checked={selectedKey === key}
              onChange={() => onChange(source)}
              className="peer sr-only"
            />
            <span
              className={cn(
                'flex min-w-0 items-center gap-3 rounded-lg border border-line-strong bg-surface p-2 transition-colors duration-150',
                'hover:bg-surface-2 peer-checked:border-fg peer-checked:bg-surface-2 peer-checked:shadow-[inset_0_0_0_1px_var(--fg)]',
                'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
              )}
            >
              <span className="relative flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md bg-media text-on-media">
                {source.thumbnailUrl ? (
                  <img
                    src={toAppUrl(source.thumbnailUrl)}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <Film aria-hidden="true" className="size-5 opacity-60" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{source.name}</span>
                <span className="nums block font-mono text-xs text-fg-muted">
                  {source.durationMs ? format.clock(source.durationMs) : t('source.noDuration')}
                </span>
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface SourcePickerProps {
  value: TranslationSource | null;
  onChange: (source: TranslationSource | null) => void;
  /** Largest upload the plan accepts (bytes). */
  maxUploadBytes: number;
}

/** Step 1 of a translation: upload a video or pick a rendered one of the workspace. */
export function SourcePicker({ value, onChange, maxUploadBytes }: SourcePickerProps) {
  const { t } = useTranslation('translate');
  const format = useFormat();
  const describe = useErrorText();
  const [tab, setTab] = useState<Tab>('upload');

  const uploader = useUpload(api.assets.upload);
  const uploaded = useApiInfiniteQuery(api.assets.list, {
    query: { kind: 'video', purpose: 'translation_source', limit: 6 },
  });
  const videos = useApiInfiniteQuery(
    api.videos.list,
    { query: { status: 'completed', limit: 8 } },
    { enabled: tab === 'videos' },
  );

  const upload = async (file: File) => {
    try {
      const asset = await uploader.upload({
        file,
        fields: { name: file.name.slice(0, 120), purpose: 'translation_source' },
      });
      onChange({
        kind: 'asset',
        assetId: asset.id,
        name: asset.name,
        durationMs: asset.durationMs,
        thumbnailUrl: asset.thumbnailUrl,
      });
      void uploaded.refetch();
    } catch {
      // The dropzone shows `uploader.error`; a cancelled upload is silent.
    }
  };

  const uploadError = uploader.error ? describe(uploader.error) : null;

  // Translating one of "my videos" copies its MP4 into a new source file every time, so the
  // same video showed up once per earlier translation: identical files are offered once.
  const seen = new Set<string>();
  const earlier = uploaded.items.filter((asset) => {
    const key = `${asset.name}|${asset.sizeBytes}|${asset.durationMs ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {value && (
        <div
          role="status"
          className="flex min-w-0 items-center gap-3 rounded-lg border border-transparent bg-success-soft px-4 py-3 text-sm text-success-text"
        >
          <CircleCheck aria-hidden="true" className="size-5 shrink-0" />
          <p className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{value.name}</span>
            <span className="nums block">
              {value.kind === 'asset' ? t('source.chosenUpload') : t('source.chosenVideo')}
              {value.durationMs ? ` · ${format.duration(value.durationMs)}` : ''}
            </span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<X aria-hidden="true" />}
            onClick={() => {
              uploader.reset();
              onChange(null);
            }}
          >
            {t('source.clear')}
          </Button>
        </div>
      )}

      <Tabs<Tab>
        aria-label={t('source.tabs')}
        value={tab}
        onValueChange={setTab}
        variant="pills"
        tabs={[
          { value: 'upload', label: t('source.upload'), icon: <Upload aria-hidden="true" /> },
          { value: 'videos', label: t('source.videos'), icon: <Film aria-hidden="true" /> },
        ]}
      >
        <TabPanel value="upload" className="flex min-w-0 flex-col gap-4 pt-4">
          <FileDropzone
            aria-label={t('source.dropLabel')}
            accept={ALLOWED_UPLOAD_MIME.video}
            maxSizeBytes={maxUploadBytes}
            onFiles={(files) => {
              const [file] = files;
              if (file) void upload(file);
            }}
            disabled={uploader.status === 'uploading'}
            icon={<FileVideo aria-hidden="true" />}
            title={t('source.dropTitle')}
            description={t('source.dropText')}
            error={uploadError ? `${uploadError.title}. ${uploadError.message}`.trim() : undefined}
          >
            {uploader.status === 'uploading' ? (
              <div className="flex w-full max-w-sm flex-col gap-2">
                <ProgressBar
                  label={t('source.uploading')}
                  value={Math.round(uploader.progress * 100)}
                  showHeader
                />
              </div>
            ) : undefined}
          </FileDropzone>
          {uploader.status === 'uploading' && (
            <Button variant="secondary" size="sm" className="self-start" onClick={uploader.cancel}>
              {t('source.cancelUpload')}
            </Button>
          )}
          {earlier.length > 0 && (
            <ChoiceList
              legend={t('source.earlier')}
              value={value}
              onChange={onChange}
              choices={earlier.map((asset) => ({
                key: asset.id,
                source: {
                  kind: 'asset',
                  assetId: asset.id,
                  name: asset.name,
                  durationMs: asset.durationMs,
                  thumbnailUrl: asset.thumbnailUrl,
                },
              }))}
            />
          )}
        </TabPanel>

        <TabPanel value="videos" className="flex min-w-0 flex-col gap-3 pt-4">
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
              title={t('source.noVideosTitle')}
              description={t('source.noVideosText')}
            />
          ) : (
            <ChoiceList
              legend={t('source.videosLegend')}
              value={value}
              onChange={onChange}
              choices={videos.items.map((video) => ({
                key: video.id,
                source: {
                  kind: 'video',
                  videoId: video.id,
                  name: video.title,
                  durationMs: video.durationMs,
                  thumbnailUrl: video.thumbnailUrl,
                },
              }))}
            />
          )}
          <LoadMore
            hasMore={videos.hasNextPage}
            loading={videos.isFetchingNextPage}
            onLoadMore={() => void videos.fetchNextPage()}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}
