import { listUsedVariables } from '@parlante/shared';
import type { BatchItem, BatchJob, Composition, Resolution } from '@parlante/shared';
import { CSV_MAX_CELL_CHARS } from './csv';

/* Pure model of the batch tool: the variables of the source video, the mapping from CSV
 * columns to those variables, the checks of every row and the reading of a running batch. */

/** A placeholder as the person writes it in a script, for explanatory texts. */
export const EXAMPLE_VARIABLE = '{{nombre}}';

/* ---------- variables of the source ---------- */

export interface SourceVariable {
  name: string;
  /** Human label declared in the Studio ('' when none). */
  label: string;
  defaultValue: string;
  /** No default value: every row must bring its own. */
  required: boolean;
}

/** `{{variables}}` a composition uses, in order of first appearance, with their defaults. */
export function sourceVariables(composition: Composition): SourceVariable[] {
  const declared = new Map(composition.variables.map((variable) => [variable.name, variable]));
  return listUsedVariables(composition).map((name) => {
    const definition = declared.get(name);
    const defaultValue = definition?.defaultValue ?? '';
    return {
      name,
      label: definition?.label ?? '',
      defaultValue,
      required: defaultValue === '',
    };
  });
}

/* ---------- column mapping ---------- */

/** Variable name → CSV column that feeds it (null = no column: the default value is used). */
export type Mapping = Record<string, string | null>;

/** Compare names ignoring case, accents, spaces and punctuation ("Nombre " ≈ "nombre"). */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * First guess of the mapping: a column with exactly the variable's name, else one whose name
 * (or the variable's label) matches loosely. A column feeds at most one variable.
 */
export function autoMap(variables: readonly SourceVariable[], columns: readonly string[]): Mapping {
  const mapping: Mapping = {};
  const taken = new Set<string>();
  for (const variable of variables) {
    const exact = columns.find((column) => column === variable.name && !taken.has(column));
    if (exact !== undefined) {
      mapping[variable.name] = exact;
      taken.add(exact);
    }
  }
  for (const variable of variables) {
    if (mapping[variable.name]) continue;
    const wanted = [normalizeName(variable.name), normalizeName(variable.label)].filter(Boolean);
    const loose = columns.find(
      (column) => !taken.has(column) && wanted.includes(normalizeName(column)),
    );
    mapping[variable.name] = loose ?? null;
    if (loose !== undefined) taken.add(loose);
  }
  return mapping;
}

/** Keep a mapping valid after the CSV changed: columns that no longer exist are dropped. */
export function reconcileMapping(
  mapping: Mapping,
  variables: readonly SourceVariable[],
  columns: readonly string[],
): Mapping {
  const guess = autoMap(variables, columns);
  const next: Mapping = {};
  for (const variable of variables) {
    const current = mapping[variable.name];
    next[variable.name] =
      current !== undefined && (current === null || columns.includes(current))
        ? current
        : (guess[variable.name] ?? null);
  }
  return next;
}

/** Required variables that no column feeds (blocking). */
export function unmappedRequired(variables: readonly SourceVariable[], mapping: Mapping): string[] {
  return variables
    .filter((variable) => variable.required && !mapping[variable.name])
    .map((variable) => variable.name);
}

/** Columns of the CSV that feed no variable (ignored). */
export function unusedColumns(columns: readonly string[], mapping: Mapping): string[] {
  const used = new Set(Object.values(mapping).filter((column): column is string => !!column));
  return columns.filter((column) => !used.has(column));
}

/** Rows keyed by VARIABLE name (what `POST /api/batches` takes), values trimmed. */
export function mapRows(
  rows: readonly Record<string, string>[],
  mapping: Mapping,
  variables: readonly SourceVariable[],
): Record<string, string>[] {
  return rows.map((row) => {
    const values: Record<string, string> = {};
    for (const variable of variables) {
      const column = mapping[variable.name];
      if (column) values[variable.name] = (row[column] ?? '').trim();
    }
    return values;
  });
}

/* ---------- row checks ---------- */

export interface RowIssue {
  variable: string;
  /** `blank`: no value and no default. `tooLong`: above the 500 characters a cell may have. */
  kind: 'blank' | 'tooLong';
}

/** Problems of one mapped row (empty array = the row is fine). */
export function rowIssues(
  values: Record<string, string>,
  variables: readonly SourceVariable[],
): RowIssue[] {
  const issues: RowIssue[] = [];
  for (const variable of variables) {
    const value = values[variable.name] ?? '';
    if (value === '' && variable.required) issues.push({ variable: variable.name, kind: 'blank' });
    else if (value.length > CSV_MAX_CELL_CHARS) {
      issues.push({ variable: variable.name, kind: 'tooLong' });
    }
  }
  return issues;
}

export interface BatchCheck {
  /** Issues per row, same order as the rows. */
  issues: RowIssue[][];
  /** Indexes of rows with at least one issue. */
  badRows: number[];
  unmapped: string[];
  /** More rows than the plan allows. */
  overLimit: boolean;
  /** Nothing blocks the batch. */
  ok: boolean;
}

export function checkBatch(input: {
  variables: readonly SourceVariable[];
  mapping: Mapping;
  rows: readonly Record<string, string>[];
  maxRows: number;
}): BatchCheck {
  const mapped = mapRows(input.rows, input.mapping, input.variables);
  const issues = mapped.map((values) => rowIssues(values, input.variables));
  const badRows = issues.flatMap((list, index) => (list.length > 0 ? [index] : []));
  const unmapped = unmappedRequired(input.variables, input.mapping);
  const overLimit = input.rows.length > input.maxRows;
  return {
    issues,
    badRows,
    unmapped,
    overLimit,
    ok:
      input.variables.length > 0 &&
      input.rows.length > 0 &&
      badRows.length === 0 &&
      unmapped.length === 0 &&
      !overLimit,
  };
}

/* ---------- preview of a personalised text ---------- */

export interface TextPart {
  text: string;
  /** Set when the part replaces a `{{variable}}`. */
  variable?: string;
  /** The variable had neither a value nor a default: it will be left empty. */
  missing?: boolean;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g;

/**
 * A text with its placeholders replaced the way the batch job does it (row value → default
 * value → empty), split into parts so the UI can highlight what changes from row to row.
 */
export function personalise(
  text: string,
  values: Record<string, string>,
  variables: readonly SourceVariable[],
): TextPart[] {
  const defaults = new Map(variables.map((variable) => [variable.name, variable.defaultValue]));
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    const name = match[1] ?? '';
    if (index > last) parts.push({ text: text.slice(last, index) });
    const value = (values[name] ?? '').trim() || (defaults.get(name) ?? '');
    parts.push(
      value === ''
        ? { text: `{{${name}}}`, variable: name, missing: true }
        : { text: value, variable: name },
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

const HAS_PLACEHOLDER = /\{\{\s*[A-Za-z_][A-Za-z0-9_]{0,39}\s*\}\}/;

export interface PersonalisedText {
  kind: 'narration' | 'text';
  /** 1-based scene number. */
  scene: number;
  text: string;
}

/** Texts of a composition that contain placeholders (narration before on-screen texts). */
export function personalisedTexts(composition: Composition): PersonalisedText[] {
  const out: PersonalisedText[] = [];
  composition.scenes.forEach((scene, index) => {
    const narration =
      scene.script.kind === 'tts'
        ? scene.script.text
        : scene.script.kind === 'audio'
          ? scene.script.transcript
          : '';
    if (HAS_PLACEHOLDER.test(narration)) {
      out.push({ kind: 'narration', scene: index + 1, text: narration });
    }
    for (const layer of scene.layers) {
      if (layer.type === 'text' && HAS_PLACEHOLDER.test(layer.text)) {
        out.push({ kind: 'text', scene: index + 1, text: layer.text });
      }
    }
  });
  return out;
}

/** Two example rows for a set of variables (the "use an example" button). */
export function sampleRows(
  variables: readonly SourceVariable[],
  samples: readonly string[][],
): Record<string, string>[] {
  return samples.map((sample) =>
    Object.fromEntries(
      variables.map((variable, index) => [
        variable.name,
        sample[index % sample.length] ?? variable.name,
      ]),
    ),
  );
}

/* ---------- reading a batch ---------- */

export function isBatchActive(job: Pick<BatchJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'processing';
}

export type ItemState = BatchItem['status'];

export function countItems(items: readonly BatchItem[]): Record<ItemState, number> {
  const counts: Record<ItemState, number> = {
    pending: 0,
    queued: 0,
    rendering: 0,
    completed: 0,
    failed: 0,
    canceled: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

/** Resolutions a plan may render (`1080p` only when the plan reaches it). */
export function allowedResolutions(maxResolution: Resolution): Resolution[] {
  return maxResolution === '1080p' ? ['720p', '1080p'] : ['720p'];
}
