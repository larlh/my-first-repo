import { useTranslation } from 'react-i18next';
import { Badge, Select, Table, TBody, Td, Th, THead, Tr } from '@/ui';
import type { Mapping, SourceVariable } from '../lib/batch';

const NONE = '__none__';

export interface MappingTableProps {
  variables: readonly SourceVariable[];
  columns: readonly string[];
  mapping: Mapping;
  /** The person gave a variable a column by hand (null = no column). */
  onChoose: (variable: string, column: string | null) => void;
  /** First data row: shown as a sample of what each column carries. */
  sample: Record<string, string> | undefined;
}

/** Step 3 of a batch: which CSV column feeds each `{{variable}}` of the video. */
export function MappingTable({ variables, columns, mapping, onChoose, sample }: MappingTableProps) {
  const { t } = useTranslation('batch');
  return (
    <Table dense>
      <THead>
        <Tr>
          <Th>{t('mapping.variable')}</Th>
          <Th>{t('mapping.column')}</Th>
          <Th>{t('mapping.sample')}</Th>
          <Th>{t('mapping.state')}</Th>
        </Tr>
      </THead>
      <TBody>
        {variables.map((variable) => {
          const column = mapping[variable.name] ?? null;
          const example = column ? (sample?.[column] ?? '') : variable.defaultValue;
          return (
            <Tr key={variable.name}>
              <Td>
                <code className="rounded-md bg-saffron-soft px-1.5 py-0.5 font-mono text-xs font-medium text-saffron-text">
                  {`{{${variable.name}}}`}
                </code>
                {variable.label && (
                  <span className="mt-1 block text-xs text-fg-muted">{variable.label}</span>
                )}
              </Td>
              <Td className="min-w-44">
                <Select
                  size="sm"
                  aria-label={t('mapping.columnFor', { name: variable.name })}
                  value={column ?? NONE}
                  onValueChange={(next) => onChoose(variable.name, next === NONE ? null : next)}
                  options={[
                    { value: NONE, label: t('mapping.none') },
                    ...columns.map((name) => ({ value: name, label: name })),
                  ]}
                />
              </Td>
              <Td className="max-w-48 truncate text-fg-muted">{example || '—'}</Td>
              <Td>
                {column ? (
                  <Badge tone="success" size="sm">
                    {t('mapping.mapped')}
                  </Badge>
                ) : variable.required ? (
                  <Badge tone="danger" size="sm">
                    {t('mapping.missing')}
                  </Badge>
                ) : (
                  <Badge tone="neutral" size="sm">
                    {t('mapping.usesDefault')}
                  </Badge>
                )}
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </Table>
  );
}
