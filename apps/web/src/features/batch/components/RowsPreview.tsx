import type { Composition } from '@parlante/shared';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Table, TBody, Td, Th, THead, Tr, cn } from '@/ui';
import { personalise, personalisedTexts } from '../lib/batch';
import type { RowIssue, SourceVariable } from '../lib/batch';

const PAGE = 20;

export interface RowsPreviewProps {
  variables: readonly SourceVariable[];
  /** Rows keyed by variable name. */
  rows: readonly Record<string, string>[];
  issues: readonly RowIssue[][];
  /** Rows above this index exceed the plan limit. */
  maxRows: number;
  composition: Composition;
}

/**
 * Step 4 of a batch: every row as the video will receive it, with its problems, and the texts
 * of the video rewritten for the selected row.
 */
export function RowsPreview({ variables, rows, issues, maxRows, composition }: RowsPreviewProps) {
  const { t } = useTranslation('batch');
  const [selected, setSelected] = useState(0);
  const [shown, setShown] = useState(PAGE);
  const current = Math.min(selected, Math.max(0, rows.length - 1));
  const texts = personalisedTexts(composition).slice(0, 4);
  const values = rows[current] ?? {};

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Table dense aria-label={t('rows.table')}>
        <THead>
          <Tr>
            <Th className="w-12">{t('rows.number')}</Th>
            {variables.map((variable) => (
              <Th key={variable.name}>{variable.name}</Th>
            ))}
            <Th>{t('rows.state')}</Th>
            <Th className="w-28">
              <span className="sr-only">{t('rows.preview')}</span>
            </Th>
          </Tr>
        </THead>
        <TBody>
          {rows.slice(0, shown).map((row, index) => {
            const rowIssues = issues[index] ?? [];
            const over = index >= maxRows;
            const bad = rowIssues.length > 0 || over;
            return (
              <Tr key={index} selected={index === current} data-row={index + 1}>
                <Td className="nums font-mono text-xs text-fg-muted">{index + 1}</Td>
                {variables.map((variable) => {
                  const value = row[variable.name] ?? '';
                  const issue = rowIssues.find((item) => item.variable === variable.name);
                  return (
                    <Td
                      key={variable.name}
                      className={cn('max-w-56 truncate', issue && 'text-danger-text')}
                    >
                      {value !== '' ? (
                        value
                      ) : variable.defaultValue ? (
                        <span className="text-fg-subtle italic">{variable.defaultValue}</span>
                      ) : (
                        <span className="font-semibold">{t('rows.blank')}</span>
                      )}
                    </Td>
                  );
                })}
                <Td>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 text-xs font-medium',
                      bad ? 'text-danger-text' : 'text-success-text',
                    )}
                  >
                    {bad ? (
                      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                    ) : (
                      <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    {over
                      ? t('rows.overLimit')
                      : rowIssues.length > 0
                        ? rowIssues
                            .map((issue) =>
                              t(`rows.issues.${issue.kind}`, { name: issue.variable }),
                            )
                            .join(' · ')
                        : t('rows.ok')}
                  </span>
                </Td>
                <Td>
                  <Button
                    variant="link"
                    size="sm"
                    aria-pressed={index === current}
                    onClick={() => setSelected(index)}
                  >
                    {t('rows.show', { number: index + 1 })}
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </Table>
      {rows.length > shown && (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => setShown(rows.length)}
        >
          {t('rows.showAll', { count: rows.length })}
        </Button>
      )}

      {texts.length > 0 && rows.length > 0 && (
        <section
          aria-live="polite"
          className="min-w-0 rounded-lg border border-line bg-surface-2 p-4"
        >
          <h3 className="eyebrow text-fg-subtle">
            {t('rows.sampleTitle', { number: current + 1 })}
          </h3>
          <ul className="mt-3 flex min-w-0 flex-col gap-3">
            {texts.map((entry, index) => (
              <li key={index} className="min-w-0 text-sm">
                <span className="mb-1 block text-xs text-fg-muted">
                  {t(`rows.kinds.${entry.kind}`, { scene: entry.scene })}
                </span>
                <p className="leading-relaxed break-words">
                  {personalise(entry.text, values, variables).map((part, position) =>
                    part.variable ? (
                      <mark
                        key={position}
                        className={cn(
                          'rounded-xs px-0.5',
                          part.missing
                            ? 'bg-danger-soft text-danger-text'
                            : 'bg-saffron-soft text-saffron-text',
                        )}
                      >
                        {part.text}
                      </mark>
                    ) : (
                      <span key={position}>{part.text}</span>
                    ),
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
