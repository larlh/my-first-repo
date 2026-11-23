import type { Video } from '@parlante/shared';
import { Captions, Download, FileVideo } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppUrl } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Button, Card, CardContent, CardHeader, CardTitle, toast } from '@/ui';
import { downloadTextFile } from '../lib/files';
import { downloadFileName } from '../lib/video';

function Row({
  icon,
  name,
  detail,
  children,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-line py-2.5 first:pt-0 last:border-b-0 last:pb-0">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-3 text-fg-muted [&_svg]:size-[1.125rem]"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{name}</span>
        <span className="block text-xs text-fg-muted">{detail}</span>
      </span>
      {children}
    </li>
  );
}

/** Files of the current render: the MP4 and its subtitles in SRT and WebVTT. */
export function DownloadsPanel({ video }: { video: Video }) {
  const { t } = useTranslation('videos');
  const format = useFormat();
  const [busy, setBusy] = useState<'srt' | 'vtt' | null>(null);
  const ready = video.downloadUrl !== null || video.srtUrl !== null || video.vttUrl !== null;

  const saveText = async (kind: 'srt' | 'vtt', url: string) => {
    setBusy(kind);
    try {
      await downloadTextFile(url, downloadFileName(video.title, kind));
    } catch {
      toast.error(t('downloads.failed'));
    } finally {
      setBusy(null);
    }
  };

  const videoDetail = [
    'MP4 · H.264 + AAC',
    video.resolution,
    video.durationMs ? format.duration(Math.round(video.durationMs / 1000) * 1000) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('downloads.title')}</CardTitle>
      </CardHeader>
      {!ready && (
        <CardContent className="pt-2">
          <p className="text-sm text-fg-muted">{t('downloads.empty')}</p>
        </CardContent>
      )}
      {ready && (
        <CardContent>
          <ul className="flex flex-col">
            {video.downloadUrl && (
              <Row icon={<FileVideo />} name={t('downloads.video')} detail={videoDetail}>
                <Button
                  asChild
                  variant="solid"
                  size="sm"
                  leftIcon={<Download aria-hidden="true" />}
                >
                  <a
                    href={toAppUrl(video.downloadUrl)}
                    download={downloadFileName(video.title, 'mp4')}
                    aria-label={t('downloads.videoAction')}
                  >
                    MP4
                  </a>
                </Button>
              </Row>
            )}
            {video.srtUrl && (
              <Row icon={<Captions />} name={t('downloads.srt')} detail={t('downloads.srtHint')}>
                <Button
                  size="sm"
                  leftIcon={<Download aria-hidden="true" />}
                  loading={busy === 'srt'}
                  aria-label={t('downloads.srtAction')}
                  onClick={() => void saveText('srt', video.srtUrl as string)}
                >
                  SRT
                </Button>
              </Row>
            )}
            {video.vttUrl && (
              <Row icon={<Captions />} name={t('downloads.vtt')} detail={t('downloads.vttHint')}>
                <Button
                  size="sm"
                  leftIcon={<Download aria-hidden="true" />}
                  loading={busy === 'vtt'}
                  aria-label={t('downloads.vttAction')}
                  onClick={() => void saveText('vtt', video.vttUrl as string)}
                >
                  VTT
                </Button>
              </Row>
            )}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
