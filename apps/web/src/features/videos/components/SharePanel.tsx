import type { ShareLink, Video } from '@parlante/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Eye, Link2Off } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, apiQueryKey, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Switch,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { copyText } from '../lib/files';
import { EXPIRY_CHOICES, expiryToDate, isExpired, isShareLive } from '../lib/share';
import type { ExpiryChoice } from '../lib/share';
import { canShare } from '../lib/video';

/**
 * Public link of a video: turn it on, copy it, decide whether visitors may download the file
 * and when it stops working. Readers can see and copy an existing link; editors manage it.
 */
export function SharePanel({ video, canEdit }: { video: Video; canEdit: boolean }) {
  const { t } = useTranslation('videos');
  const format = useFormat();
  const describe = useErrorText();
  const confirm = useConfirm();
  const client = useQueryClient();
  const params = { videoId: video.id };
  const shareable = canShare(video);

  const query = useApiQuery(api.share.get, { params });
  const share = query.data?.share ?? null;
  const live = isShareLive(share);
  const setCached = (next: ShareLink | null) =>
    client.setQueryData(apiQueryKey(api.share.get, { params }), { share: next });

  const upsert = useApiMutation(api.share.upsert, {
    onSuccess: (next) => setCached(next),
    onError: (error) => toast.error(t('share.failed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.share.remove, {
    onSuccess: () => {
      setCached(null);
      toast.success(t('share.removed'));
    },
    onError: (error) => toast.error(t('share.failed'), { description: describe(error).title }),
  });

  const save = (patch: { enabled?: boolean; allowDownload?: boolean; expiresAt?: string | null }) =>
    upsert.mutate({
      params,
      body: {
        enabled: patch.enabled ?? share?.enabled ?? true,
        allowDownload: patch.allowDownload ?? share?.allowDownload ?? true,
        expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : (share?.expiresAt ?? null),
      },
    });

  // "Copied" feedback on the button for a moment.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const copy = async () => {
    if (!share) return;
    if (await copyText(share.url)) {
      setCopied(true);
      toast.success(t('share.copied'));
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('share.copyFailed'));
    }
  };

  const removeLink = async () => {
    const ok = await confirm({
      title: t('share.removeTitle'),
      description: t('share.removeText'),
      confirmLabel: t('share.removeConfirm'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params });
  };

  const expired = share ? isExpired(share) : false;
  const expiryValue: ExpiryChoice = share?.expiresAt ? 'custom' : 'never';
  const busy = upsert.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{t('share.title')}</CardTitle>
          <CardDescription>{t('share.description')}</CardDescription>
        </div>
        {share && (
          <Badge tone={live ? 'success' : 'neutral'} dot>
            {live ? t('share.live') : expired ? t('share.expired') : t('share.off')}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isPending ? (
          <Skeleton className="h-10" />
        ) : query.isError ? (
          <ErrorState
            size="sm"
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        ) : !shareable && !share ? (
          <p className="flex items-start gap-2.5 text-sm text-fg-muted">
            <Link2Off className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t('share.needsRender')}
          </p>
        ) : (
          <>
            {canEdit && (
              <Switch
                checked={share?.enabled ?? false}
                onCheckedChange={(enabled) => save({ enabled })}
                disabled={busy || (!shareable && !share?.enabled)}
                label={t('share.enable')}
                description={t('share.enableHint')}
                labelPosition="start"
              />
            )}

            {share && share.enabled && (
              <>
                <div className="flex flex-col gap-2">
                  <Input
                    label={t('share.link')}
                    value={share.url}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                    className="font-mono text-xs"
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="solid"
                      className="min-w-0 flex-1"
                      onClick={() => void copy()}
                      leftIcon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                    >
                      {copied ? t('share.copiedShort') : t('share.copy')}
                    </Button>
                    <Button asChild variant="secondary" className="w-10 px-0">
                      <a
                        href={share.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t('share.open')}
                        title={t('share.open')}
                      >
                        <ExternalLink aria-hidden="true" />
                      </a>
                    </Button>
                  </div>
                </div>
                {expired && (
                  <p role="status" className="text-sm font-medium text-warning-text">
                    {t('share.expiredHint')}
                  </p>
                )}

                {canEdit && (
                  <>
                    <Switch
                      checked={share.allowDownload}
                      onCheckedChange={(allowDownload) => save({ allowDownload })}
                      disabled={busy}
                      label={t('share.allowDownload')}
                      labelPosition="start"
                    />
                    <Select<ExpiryChoice>
                      label={t('share.expiry')}
                      value={expiryValue}
                      disabled={busy}
                      onValueChange={(choice) => {
                        if (choice !== 'custom') save({ expiresAt: expiryToDate(choice) });
                      }}
                      options={[
                        ...(share.expiresAt
                          ? [
                              {
                                value: 'custom' as const,
                                label: t('share.expiresOn', {
                                  date: format.dateTime(share.expiresAt),
                                }),
                              },
                            ]
                          : []),
                        ...EXPIRY_CHOICES.map((choice) => ({
                          value: choice,
                          label: t(`share.expiryOptions.${choice}`),
                        })),
                      ]}
                    />
                  </>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3.5 text-sm text-fg-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <Eye className="size-4" aria-hidden="true" />
                    {t('share.views', { count: share.viewCount })}
                  </span>
                  {canEdit && (
                    <Button
                      variant="link"
                      className="text-danger-text"
                      disabled={busy}
                      onClick={() => void removeLink()}
                    >
                      {t('share.remove')}
                    </Button>
                  )}
                </div>
              </>
            )}

            {!canEdit && !(share && share.enabled) && (
              <p className="text-sm text-fg-muted">{t('share.noneViewer')}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
