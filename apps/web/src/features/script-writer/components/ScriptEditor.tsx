import { Clapperboard, Cpu, Link2, Plus, RotateCcw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProviderBadge } from '@/components/ProviderBadge';
import { useFormat } from '@/lib/format';
import { Button, Input } from '@/ui';
import { Notice } from '../kit';
import {
  TITLE_MAX_CHARS,
  canCreateVideo,
  draftTiming,
  insertScene,
  moveScene,
  removeScene,
  updateScene,
} from '../lib/script';
import type { DraftProblems, MakeId, ScriptDraft } from '../lib/script';
import { SceneCard } from './SceneCard';

export interface ScriptEditorProps {
  draft: ScriptDraft;
  onChange: (draft: ScriptDraft) => void;
  problems: DraftProblems;
  /** Plan limits quoted by the warnings. */
  maxScenes: number;
  maxDurationSec: number;
  makeId: MakeId;
  /** Called with the id of a scene that was just added (to move focus to it). */
  onSceneAdded?: (sceneId: string) => void;
  onCreateVideo: () => void;
  onDiscard: () => void;
}

/** The script as a running order ("escaleta"): every scene editable, timed and movable. */
export function ScriptEditor({
  draft,
  onChange,
  problems,
  maxScenes,
  maxDurationSec,
  makeId,
  onSceneAdded,
  onCreateVideo,
  onDiscard,
}: ScriptEditorProps) {
  const { t } = useTranslation('script-writer');
  const format = useFormat();
  const timing = draftTiming(draft);
  const ready = canCreateVideo(problems);

  const addScene = () => {
    const last = draft.scenes[draft.scenes.length - 1];
    const next = insertScene(draft, last?.id ?? null, makeId);
    onChange(next.draft);
    onSceneAdded?.(next.sceneId);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="rounded-xl border border-line bg-surface p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="eyebrow text-fg-subtle">{t('script.eyebrow')}</p>
          <ProviderBadge provider={draft.provider} size="sm" />
          {draft.edited && <span className="text-xs text-fg-muted">{t('script.edited')}</span>}
        </div>
        <Input
          label={t('script.title')}
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value, edited: true })}
          maxLength={TITLE_MAX_CHARS}
          size="lg"
          wrapperClassName="mt-3"
          className="font-display text-lg font-semibold"
          error={problems.untitled ? t('script.untitled') : undefined}
        />
        {draft.sourceTitle && (
          <p className="mt-3 flex min-w-0 items-center gap-2 text-sm text-fg-muted">
            <Link2 aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{t('script.basedOn', { title: draft.sourceTitle })}</span>
          </p>
        )}
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
          <div>
            <dt className="eyebrow text-fg-subtle">{t('script.stats.scenes')}</dt>
            <dd className="display nums mt-1 text-2xl">{draft.scenes.length}</dd>
          </div>
          <div>
            <dt className="eyebrow text-fg-subtle">{t('script.stats.estimated')}</dt>
            <dd className="display nums mt-1 text-2xl">{format.clock(timing.totalMs)}</dd>
          </div>
          <div>
            <dt className="eyebrow text-fg-subtle">{t('script.stats.target')}</dt>
            <dd className="display nums mt-1 text-2xl text-fg-muted">
              {format.clock(draft.targetSec * 1000)}
            </dd>
          </div>
        </dl>
      </div>

      {draft.basicMode && (
        <Notice icon={<Cpu />} title={t('script.basicTitle')}>
          {t('script.basic')}
        </Notice>
      )}

      <ol className="flex min-w-0 flex-col gap-3" aria-label={t('script.scenes')}>
        {draft.scenes.map((scene, index) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            index={index}
            count={draft.scenes.length}
            startMs={timing.startsMs[index] ?? 0}
            durationMs={timing.durationsMs[index] ?? 0}
            onChange={(patch) => onChange(updateScene(draft, scene.id, patch))}
            onMove={(delta) => onChange(moveScene(draft, scene.id, delta))}
            onRemove={() => onChange(removeScene(draft, scene.id))}
          />
        ))}
      </ol>

      <Button
        variant="secondary"
        className="self-start"
        leftIcon={<Plus aria-hidden="true" />}
        onClick={addScene}
        disabled={draft.scenes.length >= maxScenes}
      >
        {t('script.addScene')}
      </Button>

      {(problems.tooManyScenes || problems.tooLong || problems.noNarration) && (
        <Notice tone="warning" icon={<TriangleAlert />} role="status">
          <ul className="flex flex-col gap-1">
            {problems.noNarration && <li>{t('script.problems.noNarration')}</li>}
            {problems.tooManyScenes && (
              <li>{t('script.problems.tooManyScenes', { max: maxScenes })}</li>
            )}
            {problems.tooLong && (
              <li>
                {t('script.problems.tooLong', { max: format.duration(maxDurationSec * 1000) })}
              </li>
            )}
          </ul>
        </Notice>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border sm:bg-surface/95 sm:px-5 sm:shadow-md">
        <p className="min-w-0 flex-1 text-sm text-fg-muted">
          {problems.silentScenes.length > 0 && !problems.noNarration
            ? t('script.silentScenes', { count: problems.silentScenes.length })
            : t('script.next')}
        </p>
        <Button variant="ghost" leftIcon={<RotateCcw aria-hidden="true" />} onClick={onDiscard}>
          {t('script.discard')}
        </Button>
        <Button
          variant="primary"
          leftIcon={<Clapperboard aria-hidden="true" />}
          onClick={onCreateVideo}
          disabled={!ready}
        >
          {t('script.createVideo')}
        </Button>
      </div>
    </div>
  );
}
