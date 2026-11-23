import { CircleCheck, FileSpreadsheet, TableProperties } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, FileDropzone, Textarea } from '@/ui';
import { CSV_MAX_CHARS, toCsv } from '../lib/csv';
import type { CsvError, ParsedCsv } from '../lib/csv';
import { sampleRows } from '../lib/batch';
import type { SourceVariable } from '../lib/batch';

/** Example people for the "use an example" button (data, not interface text). */
const SAMPLES = [
  ['Lucía', 'Ferrer Asesores', 'Madrid', 'lunes'],
  ['Marc', 'Taller Riera', 'Girona', 'jueves'],
  ['Ainhoa', 'Clínica Ibai', 'Bilbao', 'martes'],
];

const DELIMITER_KEYS = { ',': 'comma', ';': 'semicolon', '\t': 'tab' } as const;

export interface DataStepProps {
  text: string;
  onText: (text: string) => void;
  parsed: ParsedCsv | null;
  error: CsvError | null;
  /** Variables of the source video (shape of the example). */
  variables: readonly SourceVariable[];
}

/** Step 2 of a batch: the CSV, uploaded as a file or pasted as text. */
export function DataStep({ text, onText, parsed, error, variables }: DataStepProps) {
  const { t } = useTranslation('batch');

  const load = async (file: File | undefined) => {
    if (!file) return;
    onText((await file.text()).slice(0, CSV_MAX_CHARS + 1));
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FileDropzone
        compact
        aria-label={t('data.dropLabel')}
        accept={['.csv', 'text/csv', 'text/plain', '.tsv', '.txt']}
        maxSizeBytes={2 * 1024 * 1024}
        onFiles={(files) => void load(files[0])}
        icon={<FileSpreadsheet aria-hidden="true" />}
        title={t('data.dropTitle')}
        description={t('data.dropText')}
      />
      <Textarea
        label={t('data.paste')}
        labelAside={
          variables.length > 0 ? (
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                onText(
                  toCsv(
                    variables.map((variable) => variable.name),
                    sampleRows(variables, SAMPLES),
                  ),
                )
              }
            >
              {t('data.useSample')}
            </Button>
          ) : undefined
        }
        value={text}
        onChange={(event) => onText(event.target.value)}
        rows={6}
        spellCheck={false}
        placeholder={t('data.placeholder')}
        hint={t('data.hint')}
        error={
          error
            ? t(`data.errors.${error.code}`, {
                line: error.detail.line ?? '',
                column: error.detail.column ?? '',
                row: error.detail.row ?? '',
                rows: error.detail.rows ?? '',
                max: error.detail.max ?? '',
              })
            : undefined
        }
        className="font-mono text-xs leading-5"
      />
      {parsed && (
        <p role="status" className="flex min-w-0 items-center gap-2 text-sm text-success-text">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
          <TableProperties aria-hidden="true" className="size-4 shrink-0" />
          {t('data.read', {
            count: parsed.rows.length,
            columns: parsed.columns.length,
            delimiter: t(`data.delimiters.${DELIMITER_KEYS[parsed.delimiter]}`),
          })}
        </p>
      )}
    </div>
  );
}
