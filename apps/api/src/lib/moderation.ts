import { AppError } from '@parlante/shared';
import type { ModerationContext, Providers } from '@parlante/shared';

export interface ModerationInput {
  text: string | null | undefined;
  context: ModerationContext;
  language?: string | undefined;
  /** Where the text came from (`name`, `prompt`, `persona.instructions`…): echoed in `details`. */
  field?: string | undefined;
}

/**
 * Run the ModerationProvider on one or more user texts and throw CONTENT_BLOCKED (422) at the
 * first one that is not allowed. Empty texts are skipped. `details` carries the provider's
 * flags (category + presentable reason — never the offending text) and the `field`, so the UI
 * can point at the input that has to change.
 *
 *   await assertContentAllowed(providers, [
 *     { text: body.name, context: 'name', field: 'name' },
 *     { text: body.prompt, context: 'avatar_prompt', field: 'prompt' },
 *   ]);
 */
export async function assertContentAllowed(
  providers: Pick<Providers, 'moderation'>,
  inputs: ModerationInput | ModerationInput[],
  extraDetails: Record<string, unknown> = {},
): Promise<void> {
  for (const input of Array.isArray(inputs) ? inputs : [inputs]) {
    const text = input.text?.trim();
    if (!text) continue;
    const verdict = await providers.moderation.check({
      text,
      context: input.context,
      ...(input.language ? { language: input.language } : {}),
    });
    if (!verdict.allowed) {
      throw new AppError('CONTENT_BLOCKED', 'This content was blocked by moderation', {
        ...(input.field ? { field: input.field } : {}),
        ...extraDetails,
        flags: verdict.flags,
      });
    }
  }
}
