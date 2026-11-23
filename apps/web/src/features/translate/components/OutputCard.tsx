import { Captions, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { JobStatusBadge } from '@/components/JobStatus';
import { VideoPlayer } from '@/components/VideoPlayer';
import { toAppUrl } from '@/lib/api';
import { Button, ProgressBar, cn } from '@/ui';
import {
  languageLabel,
  languageShortName,
  useStoredErrorText,
  useUiLocale,
} from '@/features/script-writer/kit';
import type { LanguageResult } from '../lib/translate';

export interface OutputCardProps {
  result: LanguageResult;
  /** Name of the job (file names of the downloads, title of the player). */
  jobName: string;
  /** Name of the voice that dubs this language, when known. */
  voiceName?: string;
}

/** One target language of a translation: its state and, when ready, player and downloads. */
export function OutputCard({ result, jobName, voiceName }: OutputCardProps) {
  const { t } = useTranslation('translate');
  const locale = useUiLocale();
  const describe = useStoredErrorText();
  const { language, status, output } = result;
  const name = languageShortName(language, locale);
  const error = output?.error ? describe(output.error) : null;
  const done = status === 'completed' && output?.videoUrl;

  return (
    <article
      data-language={language}
      data-status={status}
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xs"
    >
      <header className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-base">{languageLabel(language, locale)}</h3>
          {voiceName && (
            <p className="truncate text-xs text-fg-muted">
              {t('output.voice', { name: voiceName })}
            </p>
          )}
        </div>
        <JobStatusBadge
          status={status}
          size="sm"
          labels={{
            queued: t('output.status.pending'),
            running: t('output.status.processing'),
            completed: t('output.status.completed'),
            failed: t('output.status.failed'),
          }}
        />
      </header>

      {done && output.videoUrl ? (
        <>
          <VideoPlayer
            src={toAppUrl(output.videoUrl)}
            title={t('output.playerTitle', { name: jobName, language: name })}
            subtitles={
              output.vttUrl ? [{ lang: language, label: name, src: output.vttUrl }] : undefined
            }
            defaultSubtitleLang={null}
            className="rounded-none"
          />
          <div className="flex min-w-0 flex-wrap gap-2 px-4 py-3">
            <Button
              asChild
              size="sm"
              variant="secondary"
              leftIcon={<Download aria-hidden="true" />}
            >
              <a href={toAppUrl(output.downloadUrl ?? output.videoUrl)} download>
                {t('output.downloadVideo')}
              </a>
            </Button>
            {output.srtUrl && (
              <Button asChild size="sm" variant="ghost" leftIcon={<Captions aria-hidden="true" />}>
                <a href={toAppUrl(output.srtUrl)} download={`${jobName}.${language}.srt`}>
                  SRT
                </a>
              </Button>
            )}
            {output.vttUrl && (
              <Button asChild size="sm" variant="ghost" leftIcon={<Captions aria-hidden="true" />}>
                <a href={toAppUrl(output.vttUrl)} download={`${jobName}.${language}.vtt`}>
                  VTT
                </a>
              </Button>
            )}
          </div>
        </>
      ) : (
        <div
          className={cn(
            'flex min-h-36 flex-1 flex-col justify-center gap-3 border-t border-line px-4 py-5 text-sm',
            status === 'failed' ? 'bg-danger-soft text-danger-text' : 'bg-surface-2 text-fg-muted',
          )}
        >
          {status === 'failed' ? (
            <div role="alert">
              <p className="font-semibold">{error?.title ?? t('output.failed')}</p>
              {error?.detail && <p className="mt-1 break-words">{error.detail}</p>}
            </div>
          ) : status === 'processing' ? (
            <>
              <p>{t('output.processing', { language: name })}</p>
              <ProgressBar label={t('output.processing', { language: name })} value={null} />
            </>
          ) : (
            <p>{t('output.pending')}</p>
          )}
        </div>
      )}
    </article>
  );
}
