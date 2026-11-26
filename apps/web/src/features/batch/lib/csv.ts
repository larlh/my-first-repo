import { parse } from 'csv-parse/browser/esm/sync';

/* CSV of a personalised batch, read in the browser with the same library, options and rules
 * as the API (`apps/api/src/modules/batch/csv.ts`): header row + one row per video; comma,
 * semicolon or tab separated; quoted cells, escaped quotes, CRLF and a UTF-8 BOM. Reading it
 * here lets the person map columns to variables and see every row before anything is sent. */

export const CSV_MAX_ROWS = 500;
export const CSV_MAX_CELL_CHARS = 500;
export const CSV_MAX_COLUMNS = 60;
export const CSV_MAX_CHARS = 1_000_000;

export interface ParsedCsv {
  /** Header names, trimmed, in file order. */
  columns: string[];
  /** One record per data row: every column present, values trimmed. */
  rows: Record<string, string>[];
  /** Separator that was detected. */
  delimiter: ',' | ';' | '\t';
}

export type CsvErrorCode =
  | 'empty'
  | 'tooLarge'
  | 'malformed'
  | 'tooManyColumns'
  | 'blankHeader'
  | 'duplicateHeader'
  | 'noRows'
  | 'tooManyRows'
  | 'rowTooWide';

export class CsvError extends Error {
  readonly code: CsvErrorCode;
  /** Numbers and names for the message: line, column, rows, max… */
  readonly detail: Record<string, string | number>;

  constructor(code: CsvErrorCode, detail: Record<string, string | number> = {}) {
    super(`Invalid CSV: ${code}`);
    this.name = 'CsvError';
    this.code = code;
    this.detail = detail;
  }
}

/** The separator used by the header line: the candidate that splits it into most cells. */
export function detectDelimiter(text: string): ParsedCsv['delimiter'] {
  const header =
    text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .find((line) => line.trim() !== '') ?? '';
  let best: ParsedCsv['delimiter'] = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t'] as const) {
    let cells = 0;
    let quoted = false;
    for (const char of header) {
      if (char === '"') quoted = !quoted;
      else if (char === candidate && !quoted) cells += 1;
    }
    if (cells > bestCount) {
      best = candidate;
      bestCount = cells;
    }
  }
  return best;
}

/** Parse CSV text. Throws `CsvError` with a code the UI translates. */
export function parseCsv(text: string): ParsedCsv {
  if (text.trim() === '') throw new CsvError('empty');
  if (text.length > CSV_MAX_CHARS) throw new CsvError('tooLarge', { max: CSV_MAX_CHARS });
  const delimiter = detectDelimiter(text);
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as string[][];
  } catch (err) {
    throw new CsvError('malformed', { line: (err as { lines?: number }).lines ?? 0 });
  }
  // Rows made only of separators ("; ;") carry no data.
  records = records.filter((record) => record.some((cell) => cell !== ''));
  const header = records[0];
  if (!header) throw new CsvError('empty');
  const columns = header.map((name) => name.trim());
  if (columns.length > CSV_MAX_COLUMNS) {
    throw new CsvError('tooManyColumns', { max: CSV_MAX_COLUMNS });
  }
  const blank = columns.findIndex((name) => name === '');
  if (blank >= 0) throw new CsvError('blankHeader', { column: blank + 1 });
  const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
  if (duplicate !== undefined) throw new CsvError('duplicateHeader', { column: duplicate });

  const data = records.slice(1);
  if (data.length === 0) throw new CsvError('noRows');
  if (data.length > CSV_MAX_ROWS) {
    throw new CsvError('tooManyRows', { rows: data.length, max: CSV_MAX_ROWS });
  }
  const rows = data.map((record, index) => {
    if (
      record.length > columns.length &&
      record.slice(columns.length).some((cell) => cell !== '')
    ) {
      // 1-based, counting the header as line 1 (what a spreadsheet shows).
      throw new CsvError('rowTooWide', {
        row: index + 2,
        values: record.length,
        columns: columns.length,
      });
    }
    const values: Record<string, string> = {};
    columns.forEach((column, position) => {
      values[column] = record[position] ?? '';
    });
    return values;
  });
  return { columns, rows, delimiter };
}

function cell(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** Comma-separated CSV with a header row (what `parseCsv` and the API read back). */
export function toCsv(columns: readonly string[], rows: readonly Record<string, string>[]): string {
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}
