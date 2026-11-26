import { ArrowLeft, MonitorUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { api, useApiQuery } from '@/lib/api';
import { Button, EmptyState, ErrorState, VoiceBars } from '@/ui';
import { StudioEditor } from './StudioEditor';

/** The Studio is a desktop tool: canvas, scene list and inspector need at least 1024 px. */
const MIN_WIDTH = '(min-width: 1024px)';

function useWideEnough(): boolean {
  const query = () =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia(MIN_WIDTH).matches;
  const [wide, setWide] = useState(query);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(MIN_WIDTH);
    const onChange = () => setWide(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return wide;
}

function Frame({ videoId, children }: { videoId: string; children: React.ReactNode }) {
  const { t } = useTranslation('studio');
  return (
    <div className="booth-grid flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
        <Button asChild variant="ghost" size="sm" leftIcon={<ArrowLeft aria-hidden="true" />}>
          <Link to={videoId ? `/videos/${videoId}` : '/videos'}>{t('top.back')}</Link>
        </Button>
        <Logo size="sm" className="ml-auto" />
      </header>
      <div className="grid flex-1 place-items-center p-6">{children}</div>
    </div>
  );
}

export default function StudioPage() {
  const { t } = useTranslation('studio');
  const { videoId = '' } = useParams();
  const wide = useWideEnough();
  // Always start from a fresh copy: a cached one may predate the last autosave.
  const video = useApiQuery(
    api.videos.get,
    { params: { videoId } },
    {
      enabled: wide,
      staleTime: Infinity,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      retry: false,
    },
  );

  if (!wide) {
    return (
      <Frame videoId={videoId}>
        <EmptyState
          icon={<MonitorUp aria-hidden="true" />}
          title={t('small.title')}
          description={t('small.text')}
          action={
            <Button asChild variant="primary">
              <Link to={`/videos/${videoId}`}>{t('small.action')}</Link>
            </Button>
          }
        />
      </Frame>
    );
  }
  if (video.isError && !video.data) {
    return (
      <Frame videoId="">
        <ErrorState
          error={video.error}
          title={video.error.is('NOT_FOUND') ? t('load.notFound') : undefined}
          description={video.error.is('NOT_FOUND') ? t('load.notFoundText') : undefined}
          onRetry={video.error.is('NOT_FOUND') ? undefined : () => void video.refetch()}
          retrying={video.isFetching}
          action={
            <Button asChild>
              <Link to="/videos">{t('load.backToVideos')}</Link>
            </Button>
          }
        />
      </Frame>
    );
  }
  if (!video.data || !video.isFetchedAfterMount) {
    return (
      <div className="grid h-dvh place-items-center bg-bg" aria-busy="true">
        <div className="flex flex-col items-center gap-4">
          <VoiceBars size="lg" label={t('load.loading')} />
          <p className="eyebrow text-fg-muted">{t('load.loading')}</p>
        </div>
      </div>
    );
  }
  return <StudioEditor key={video.data.id} initial={video.data} />;
}
