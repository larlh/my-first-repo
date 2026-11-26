import type { TranscriptFormat } from '@parlante/shared';
import { CircleAlert, CircleCheck, FileUp } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { Button, SegmentedControl, Textarea, cn } from '@/ui';
import { TRANSCRIPT_MAX_CHARS, checkTranscript, detectTranscriptFormat } from '../lib/translate';

export interface TranscriptFieldProps {
  format: TranscriptFormat;
  content: string;
  onChange: (patch: { format?: TranscriptFormat; content?: string }) => void;
  /** Length of the source video, when known (to check that the cues fit). */
  durationMs: number | null;
  required: boolean;
  /** Error forced by the form (missing transcript on submit). */
  error?: string;
  /** Where the content came from when the form filled it in (the subtitles of a video). */
  note?: string;
  /** Language spoken in the video: the language dictated into the transcript. */
  language?: string;
}

const FORMATS: TranscriptFormat[] = ['srt', 'vtt', 'text'];

/**
 * The transcript the person supplies: pasted or loaded from a .srt / .vtt / .txt file. It is
 * checked on the spot with the parser the server uses, so "12 fragmentos" here means 12 there.
 */
export function TranscriptField({
  format,
  content,
  onChange,
  durationMs,
  required,
  error,
  note,
  language,
}: TranscriptFieldProps) {
  const { t } = useTranslation('translate');
  const formatter = useFormat();
  const file = useRef<HTMLInputElement>(null);
  const check = content.trim() === '' ? null : checkTranscript(format, content, durationMs);

  const load = async (picked: File | undefined) => {
    if (!picked) return;
    const text = (await picked.text()).slice(0, TRANSCRIPT_MAX_CHARS);
    onChange({ format: detectTranscriptFormat(picked.name, text), content: text });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <SegmentedControl<TranscriptFormat>
          aria-label={t('transcript.format')}
          size="sm"
          value={format}
          onValueChange={(next) => onChange({ format: next })}
          options={FORMATS.map((value) => ({ value, label: t(`transcript.formats.${value}`) }))}
        />
        <input
          ref={file}
          type="file"
          accept=".srt,.vtt,.txt,text/plain,text/vtt,application/x-subrip"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void load(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<FileUp aria-hidden="true" />}
          onClick={() => file.current?.click()}
        >
          {t('transcript.loadFile')}
        </Button>
      </div>

      <Textarea
        label={t('transcript.label')}
        optionalLabel={required ? undefined : t('common.optional')}
        required={required}
        value={content}
        onChange={(event) => onChange({ content: event.target.value })}
        rows={8}
        maxLength={TRANSCRIPT_MAX_CHARS}
        spellCheck={false}
        placeholder={t(`transcript.placeholders.${format}`)}
        hint={note ? `${note} ${t(`transcript.hints.${format}`)}` : t(`transcript.hints.${format}`)}
        error={error}
        dictationLanguage={language}
        className="font-mono text-xs leading-5"
      />

      {check && (
        <p
          role="status"
          className={cn(
            'flex min-w-0 items-start gap-2 text-sm',
            check.problem ? 'text-danger-text' : 'text-success-text',
          )}
        >
          {check.problem ? (
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          )}
          <span>
            {check.problem
              ? t(`transcript.problems.${check.problem}`)
              : durationMs
                ? t('transcript.okTimed', {
                    count: check.cues,
                    covered: formatter.clock(check.coveredMs),
                    total: formatter.clock(durationMs),
                  })
                : t('transcript.ok', { count: check.cues })}
            {!check.problem && check.ignored > 0 && (
              <> {t('transcript.ignored', { count: check.ignored })}</>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
