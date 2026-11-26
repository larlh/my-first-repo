import { parse } from 'csv-parse/sync';
import { AppError } from '@parlante/shared';

/* -------------------------------------------------------------------------------------------
 * CSV of a personalised batch: a header row whose column names map to the `{{variables}}` of
 * the source video, then one row per video. Comma, semicolon (spreadsheets in Spanish
 * locales) or tab separated; quoted cells, escaped quotes, CRLF and a UTF-8 BOM are handled
 * by `csv-parse`. Anything malformed is UNPROCESSABLE with the line it was found on.
 * ----------------------------------------------------------------------------------------- */

/** Same bounds as the `rows` variant of the request body (`RowsSchema`). */
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_CELL_CHARS = 500;
const CSV_MAX_COLUMNS = 60;

export interface ParsedCsv {
  /** Header names, trimmed, in file order. */
  columns: string[];
  /** One record per data row: every column present, values trimmed. */
  rows: Record<string, string>[];
}

function unprocessable(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('UNPROCESSABLE', message, details);
}

/** The separator used by the header line: the candidate that splits it into most cells. */
function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t']) {
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

export function parseBatchCsv(csv: string): ParsedCsv {
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      delimiter: detectDelimiter(csv),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    }) as string[][];
  } catch (err) {
    const info = err as { message?: string; lines?: number };
    throw unprocessable(
      `The CSV could not be read${info.lines ? ` (line ${info.lines})` : ''}: ${(info.message ?? 'invalid format').split('\n')[0]}`,
      { line: info.lines ?? null },
    );
  }
  // Rows made only of separators ("; ;") carry no data.
  records = records.filter((record) => record.some((cell) => cell !== ''));
  const header = records[0];
  if (!header) throw unprocessable('The CSV is empty: it needs a header row and at least one row');
  const columns = header.map((name) => name.trim());
  if (columns.length > CSV_MAX_COLUMNS) {
    throw unprocessable(`The CSV has too many columns (maximum ${CSV_MAX_COLUMNS})`);
  }
  const blank = columns.findIndex((name) => name === '');
  if (blank >= 0) {
    throw unprocessable(`Column ${blank + 1} of the CSV header has no name`, { column: blank + 1 });
  }
  const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw unprocessable(`The CSV header repeats the column "${duplicate}"`, { column: duplicate });
  }
  const data = records.slice(1);
  if (data.length === 0) {
    throw unprocessable('The CSV has a header but no rows: add one row per video');
  }
  if (data.length > CSV_MAX_ROWS) {
    throw unprocessable(`The CSV has ${data.length} rows; the maximum is ${CSV_MAX_ROWS}`, {
      rows: data.length,
      max: CSV_MAX_ROWS,
    });
  }

  const rows = data.map((record, index) => {
    // 1-based, counting the header as line 1 (what a spreadsheet shows, blank lines aside).
    const row = index + 2;
    if (
      record.length > columns.length &&
      record.slice(columns.length).some((cell) => cell !== '')
    ) {
      throw unprocessable(
        `Row ${row} of the CSV has ${record.length} values but the header has ${columns.length} columns`,
        { row, values: record.length, columns: columns.length },
      );
    }
    const values: Record<string, string> = {};
    columns.forEach((column, position) => {
      const cell = record[position] ?? '';
      if (cell.length > CSV_MAX_CELL_CHARS) {
        throw unprocessable(
          `Row ${row}, column "${column}": the value is longer than ${CSV_MAX_CELL_CHARS} characters`,
          { row, column, max: CSV_MAX_CELL_CHARS },
        );
      }
      values[column] = cell;
    });
    return values;
  });
  return { columns, rows };
}
