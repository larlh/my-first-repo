import {
  applyVariables,
  creditsForRender,
  estimateCompositionDurationMs,
  listUsedVariables,
  usesPhotorealAvatars,
} from '@parlante/shared';
import type { Composition, Resolution } from '@parlante/shared';
import { and, assets, eq, inArray } from '@parlante/db';
import type { Db } from '@parlante/db';

/* -------------------------------------------------------------------------------------------
 * What a set of rows means for a source video — shared by `POST /api/batches/preview` and
 * `POST /api/batches`, so the preview shows exactly what the creation will accept and cost.
 * ----------------------------------------------------------------------------------------- */

export interface BatchPlan {
  /** `{{variables}}` used by the source video, in order of first appearance. */
  variables: string[];
  /** Columns present in the data, in order. */
  columns: string[];
  /** Variables with no column and no default value: the batch cannot be created. */
  missingColumns: string[];
  /** Columns that match no variable: ignored. */
  unknownColumns: string[];
  /**
   * Per row, the values that will be applied: only variables of the video, only non-empty
   * cells (an empty cell falls back to the default value of the variable).
   */
  values: Record<string, string>[];
  /** Per row, variables left without any value (empty cell, no default). */
  blanks: string[][];
  /** Per row, estimated duration of its video in ms. */
  durationsMs: number[];
  /** Sum of the estimated render cost of every row. */
  estimatedCredits: number;
}

/** Durations of the narration audio assets of the composition (assetId → ms). */
export async function narrationAudioDurations(
  db: Db,
  workspaceId: string,
  composition: Composition,
): Promise<Record<string, number>> {
  const ids = [
    ...new Set(
      composition.scenes.flatMap((scene) =>
        scene.script.kind === 'audio' ? [scene.script.assetId] : [],
      ),
    ),
  ];
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: assets.id, durationMs: assets.durationMs })
    .from(assets)
    .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)));
  return Object.fromEntries(rows.map((row) => [row.id, row.durationMs ?? 0]));
}

export function planBatch(input: {
  composition: Composition;
  rows: Record<string, string>[];
  resolution: Resolution;
  audioDurations: Record<string, number>;
}): BatchPlan {
  const { composition, rows, resolution, audioDurations } = input;
  const variables = listUsedVariables(composition);
  const defaults = new Map(composition.variables.map((v) => [v.name, v.defaultValue]));
  const hasDefault = (name: string) => (defaults.get(name) ?? '') !== '';

  const columns: string[] = [];
  for (const row of rows) {
    for (const column of Object.keys(row)) if (!columns.includes(column)) columns.push(column);
  }
  const photoreal = usesPhotorealAvatars(composition);
  const values: Record<string, string>[] = [];
  const blanks: string[][] = [];
  const durationsMs: number[] = [];
  let estimatedCredits = 0;
  for (const row of rows) {
    const applied: Record<string, string> = {};
    const blank: string[] = [];
    for (const name of variables) {
      const value = (Object.prototype.hasOwnProperty.call(row, name) ? row[name] : '') ?? '';
      const trimmed = value.trim();
      if (trimmed !== '') applied[name] = trimmed;
      else if (!hasDefault(name)) blank.push(name);
    }
    const durationMs = estimateCompositionDurationMs(
      applyVariables(composition, applied),
      audioDurations,
    );
    values.push(applied);
    blanks.push(blank);
    durationsMs.push(durationMs);
    estimatedCredits += creditsForRender(durationMs, resolution, { photoreal });
  }
  return {
    variables,
    columns,
    missingColumns: variables.filter((name) => !columns.includes(name) && !hasDefault(name)),
    unknownColumns: columns.filter((name) => !variables.includes(name)),
    values,
    blanks,
    durationsMs,
    estimatedCredits,
  };
}
