import type { TimedText } from '@parlante/shared';
import { useQuery } from '@tanstack/react-query';
import { Captions } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatClock } from '@/lib/format';
import { scrollBehavior } from '@/lib/motion';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  SkeletonText,
  cn,
} from '@/ui';
import { fetchSubtitleCues } from '../lib/files';

/** Index of the cue on screen at `ms`, or -1 between cues. */
export function activeCueIndex(cues: readonly TimedText[], ms: number): number {
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (!cue) continue;
    if (ms >= cue.startMs && ms < cue.endMs) return index;
    if (cue.startMs > ms) break;
  }
  return -1;
}

export interface TranscriptPanelProps {
  videoId: string;
  /** VTT (preferred) or SRT file of the render. */
  subtitlesUrl: string;
  /** Changes with every render so a new output reloads the cues. */
  renderedAt: string | null;
  /** Playback position, to highlight the line being spoken. */
  currentMs: number;
  lang?: string;
  /** Jump the player to a line (the line becomes a button). */
  onSeek?: (ms: number) => void;
}

/** The subtitles of the render as a readable, time-coded transcript that follows playback. */
export function TranscriptPanel({
  videoId,
  subtitlesUrl,
  renderedAt,
  currentMs,
  lang,
  onSeek,
}: TranscriptPanelProps) {
  const { t } = useTranslation('videos');
  // Keyed by render, not by URL: signed URLs change on every poll.
  const urlRef = useRef(subtitlesUrl);
  urlRef.current = subtitlesUrl;
  const cues = useQuery({
    queryKey: ['videos', 'subtitles', videoId, renderedAt],
    queryFn: ({ signal }) => fetchSubtitleCues(urlRef.current, signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

  const active = cues.data ? activeCueIndex(cues.data, currentMs) : -1;
  const list = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (active < 0) return;
    const container = list.current;
    const item = container?.children[active] as HTMLElement | undefined;
    if (!container || !item) return;
    // Scroll inside the panel only (never the page) to keep the spoken line in view.
    const top = item.offsetTop - container.offsetTop;
    if (
      top < container.scrollTop ||
      top + item.offsetHeight > container.scrollTop + container.clientHeight
    ) {
      container.scrollTo({
        top: Math.max(0, top - container.clientHeight / 3),
        behavior: scrollBehavior(),
      });
    }
  }, [active]);

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Captions className="size-[1.125rem] text-fg-muted" aria-hidden="true" />
            {t('transcript.title')}
          </CardTitle>
          <CardDescription>{t('transcript.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {cues.isPending ? (
          <SkeletonText lines={4} />
        ) : cues.isError ? (
          <ErrorState
            size="sm"
            title={t('transcript.failed')}
            onRetry={() => void cues.refetch()}
            retrying={cues.isRefetching}
          />
        ) : cues.data.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('transcript.empty')}</p>
        ) : (
          <ol
            ref={list}
            lang={lang}
            tabIndex={onSeek ? undefined : 0}
            aria-label={t('transcript.title')}
            className="relative -mx-2 flex max-h-72 flex-col overflow-y-auto rounded-md"
          >
            {cues.data.map((cue, index) => {
              const current = index === active;
              const line = (
                <>
                  <span
                    className={cn(
                      'nums w-10 shrink-0 pt-px font-mono text-xs',
                      current ? 'text-accent-text' : 'text-fg-subtle',
                    )}
                  >
                    {formatClock(cue.startMs)}
                  </span>
                  <span className="min-w-0 whitespace-pre-line">{cue.text}</span>
                </>
              );
              const tone = current ? 'bg-accent-soft text-fg' : 'text-fg-muted';
              return (
                <li key={`${cue.startMs}-${index}`} aria-current={current ? 'true' : undefined}>
                  {onSeek ? (
                    <button
                      type="button"
                      onClick={() => onSeek(cue.startMs)}
                      title={t('transcript.jump', { time: formatClock(cue.startMs) })}
                      className={cn(
                        'flex w-full gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150',
                        'hover:bg-surface-2 hover:text-fg focus-visible:-outline-offset-2',
                        tone,
                      )}
                    >
                      {line}
                    </button>
                  ) : (
                    <div
                      className={cn(
                        'flex gap-3 rounded-md px-2 py-1.5 text-sm transition-colors duration-150',
                        tone,
                      )}
                    >
                      {line}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
