import { AppError, CREDIT_COSTS, api, isAppError, newId } from '@parlante/shared';
import type { GeneratedScene, GeneratedScript, ScriptGenerationRequest } from '@parlante/shared';
import { chargeCredits, refundCredits } from '@parlante/db';
import { defineRoute } from '../../lib/define-route';
import { assertWithinLimit, planLimits } from '../../lib/limits';
import { assertContentAllowed } from '../../lib/moderation';
import { defineModule } from '../../lib/modules';
import { fetchReadablePage } from './fetch-page';
import type { ReadablePage } from './fetch-page';

/* -------------------------------------------------------------------------------------------
 * AI script writer (feature 11): topic or URL + tone + duration + language → scenes.
 *
 *  1. plan limits (duration and number of scenes the workspace could render at all)
 *  2. URL sources are downloaded behind the SSRF guard with time and size limits (fetch-page)
 *  3. moderation of everything the user supplied (topic, audience, page text)
 *  4. `providers.llm.generateScript` — Claude when configured, the local heuristic otherwise
 *  5. moderation of what came back
 *  6. credits: 1 only when an EXTERNAL model wrote the script; reserved before the call and
 *     refunded if the call fails, the result is blocked, or the provider answered in basic mode
 * The response always says which provider wrote it and whether it is "modo básico".
 * ----------------------------------------------------------------------------------------- */

const LEDGER_REF_TYPE = 'script';

/** Keep opening and closing when a script has more scenes than the plan can render. */
function fitScenes(scenes: GeneratedScene[], max: number): GeneratedScene[] {
  if (scenes.length <= max) return scenes;
  const last = scenes[scenes.length - 1];
  return last && max > 1 ? [...scenes.slice(0, max - 1), last] : scenes.slice(0, max);
}

function cleanScenes(scenes: GeneratedScene[]): GeneratedScene[] {
  return scenes
    .map((scene) => ({
      title: scene.title.trim(),
      text: scene.text.trim(),
      headline: scene.headline.trim(),
      estimatedSec: Number.isFinite(scene.estimatedSec) ? Math.max(0, scene.estimatedSec) : 0,
    }))
    .filter((scene) => scene.text !== '');
}

export default defineModule({
  name: 'script-writer',
  register(app) {
    defineRoute(app, api.scriptWriter.generate, async ({ auth, body, app: instance }) => {
      const { db, providers, config } = instance;
      const limits = planLimits(auth.workspace);
      // A script the plan could never render is refused up front, with the limit in `details`.
      assertWithinLimit(auth.workspace, 'maxVideoDurationSec', body.durationSec);
      if (body.sceneCount !== undefined) {
        assertWithinLimit(auth.workspace, 'maxScenesPerVideo', body.sceneCount);
      }

      let page: ReadablePage | null = null;
      if (body.source.kind === 'url') {
        page = await fetchReadablePage(body.source.url, {
          allowPrivate: config.ALLOW_PRIVATE_URLS,
          language: body.language,
        });
      }

      await assertContentAllowed(providers, [
        body.source.kind === 'topic'
          ? { text: body.source.topic, context: 'script', language: body.language, field: 'topic' }
          : { text: page?.title, context: 'script', field: 'source.url' },
        { text: page?.text, context: 'script', field: 'source.url' },
        { text: body.audience, context: 'script', language: body.language, field: 'audience' },
      ]);

      const request: ScriptGenerationRequest = {
        topic:
          body.source.kind === 'topic'
            ? body.source.topic
            : (page?.title ?? new URL(body.source.url).hostname),
        ...(page ? { sourceText: page.text } : {}),
        ...(page?.title ? { sourceTitle: page.title } : {}),
        tone: body.tone,
        durationSec: body.durationSec,
        language: body.language,
        ...(body.sceneCount !== undefined ? { sceneCount: body.sceneCount } : {}),
        ...(body.audience ? { audience: body.audience } : {}),
      };

      // Only an external model costs credits. Reserve first (402 before any spend upstream).
      const external = !providers.llm.info.local;
      const ref = { refType: LEDGER_REF_TYPE, refId: newId('event') };
      if (external) {
        await chargeCredits(db, {
          workspaceId: auth.workspaceId,
          amount: CREDIT_COSTS.scriptPremium,
          reason: 'script',
          ...ref,
          description: `AI script (${providers.llm.info.name})`,
          createdBy: auth.userId,
        });
      }
      const refund = async (description: string) => {
        if (external)
          await refundCredits(db, { workspaceId: auth.workspaceId, ...ref, description });
      };

      let script: GeneratedScript;
      try {
        script = await providers.llm.generateScript(request);
      } catch (err) {
        await refund('AI script failed — credits refunded');
        if (isAppError(err)) throw err;
        throw new AppError(
          'PROVIDER_ERROR',
          `${providers.llm.info.name} could not write the script. Try again`,
          { provider: providers.llm.info.id },
          { cause: err },
        );
      }

      try {
        const scenes = fitScenes(cleanScenes(script.scenes), limits.maxScenesPerVideo);
        if (scenes.length === 0) {
          throw new AppError(
            'PROVIDER_ERROR',
            `${script.provider.name} returned an empty script. Try again`,
            { provider: script.provider.id },
          );
        }
        await assertContentAllowed(
          providers,
          [
            { text: script.title, context: 'script', language: body.language },
            {
              text: scenes.map((s) => `${s.headline}\n${s.text}`).join('\n'),
              context: 'script',
              language: body.language,
            },
          ],
          { stage: 'result' },
        );
        // Honesty rule: basic mode is whatever a basic provider produced, whoever was asked.
        const basicMode = script.basicMode || script.provider.quality === 'basic';
        if (basicMode || script.provider.local)
          await refund('Script written in basic mode — no charge');
        return {
          title: script.title.trim() || request.topic.slice(0, 120),
          language: body.language,
          scenes,
          provider: script.provider,
          basicMode,
          sourceTitle: page?.title ?? null,
        };
      } catch (err) {
        await refund('AI script not delivered — credits refunded');
        throw err;
      }
    });
  },
});
