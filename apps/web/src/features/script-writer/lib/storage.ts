import { z } from 'zod';
import { BriefSchema, ScriptDraftSchema } from './script';
import type { Brief, ScriptDraft } from './script';

/* The brief and the script being edited survive a reload or a detour to another section:
 * they are kept in sessionStorage per workspace (this tab only; nothing is sent anywhere).
 * Anything that does not parse is ignored. */

const SavedSchema = z.object({
  v: z.literal(1),
  brief: BriefSchema,
  draft: ScriptDraftSchema.nullable(),
});
export type SavedWork = Omit<z.infer<typeof SavedSchema>, 'v'>;

function keyOf(workspaceId: string): string {
  return `parlante.script-writer.${workspaceId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadWork(workspaceId: string): SavedWork | null {
  try {
    const raw = storage()?.getItem(keyOf(workspaceId));
    if (!raw) return null;
    const parsed = SavedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { brief: parsed.data.brief, draft: parsed.data.draft } : null;
  } catch {
    return null;
  }
}

export function saveWork(workspaceId: string, brief: Brief, draft: ScriptDraft | null): void {
  try {
    storage()?.setItem(keyOf(workspaceId), JSON.stringify({ v: 1, brief, draft }));
  } catch {
    // Storage full or blocked: the work simply does not survive a reload.
  }
}

export function clearWork(workspaceId: string): void {
  try {
    storage()?.removeItem(keyOf(workspaceId));
  } catch {
    // Nothing to clear.
  }
}
