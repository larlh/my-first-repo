import { COMPOSITION_LIMITS } from '@parlante/shared';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { IconButton, Input, Textarea } from '@/ui';
import { HEADLINE_MAX_CHARS, SCENE_NAME_MAX_CHARS } from '../lib/script';
import type { DraftScene } from '../lib/script';

export interface SceneCardProps {
  scene: DraftScene;
  index: number;
  count: number;
  /** Position on the running order and estimated length (ms). */
  startMs: number;
  durationMs: number;
  onChange: (patch: Partial<Omit<DraftScene, 'id'>>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

/** One scene of the running order: its place on the clock and its three editable texts. */
export function SceneCard({
  scene,
  index,
  count,
  startMs,
  durationMs,
  onChange,
  onMove,
  onRemove,
}: SceneCardProps) {
  const { t } = useTranslation('script-writer');
  const format = useFormat();
  const number = String(index + 1).padStart(2, '0');
  const silent = scene.text.trim() === '';

  return (
    <li
      data-scene-id={scene.id}
      className="grid min-w-0 gap-x-5 gap-y-3 rounded-xl border border-line bg-surface p-4 shadow-xs sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:p-5"
    >
      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-start sm:justify-start sm:border-r sm:border-line sm:pr-4">
        <p className="flex items-baseline gap-2 sm:flex-col sm:gap-0">
          <span className="eyebrow text-fg-subtle">{t('scene.label')}</span>
          <span className="display nums text-3xl leading-none sm:mt-1 sm:text-4xl">{number}</span>
        </p>
        <p className="nums font-mono text-xs text-fg-muted sm:mt-3">
          <span className="block">{format.clock(startMs)}</span>
          <span className="block text-fg-subtle">
            {silent ? t('scene.silent') : t('scene.approx', { time: format.duration(durationMs) })}
          </span>
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-end gap-2">
          <Input
            label={t('scene.name')}
            value={scene.title}
            onChange={(event) => onChange({ title: event.target.value })}
            maxLength={SCENE_NAME_MAX_CHARS}
            placeholder={t('scene.namePlaceholder', { number: index + 1 })}
            wrapperClassName="min-w-0 flex-1"
          />
          <div className="flex shrink-0">
            <IconButton
              label={t('scene.moveUp', { number: index + 1 })}
              variant="ghost"
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              <ArrowUp aria-hidden="true" />
            </IconButton>
            <IconButton
              label={t('scene.moveDown', { number: index + 1 })}
              variant="ghost"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
            >
              <ArrowDown aria-hidden="true" />
            </IconButton>
            <IconButton
              label={t('scene.remove', { number: index + 1 })}
              variant="ghost"
              disabled={count <= 1}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <Textarea
          label={t('scene.text')}
          value={scene.text}
          onChange={(event) => onChange({ text: event.target.value })}
          rows={4}
          maxLength={COMPOSITION_LIMITS.maxScriptChars}
          showCount
          placeholder={t('scene.textPlaceholder')}
        />
        <Input
          label={t('scene.headline')}
          optionalLabel={t('common.optional')}
          hint={t('scene.headlineHint')}
          value={scene.headline}
          onChange={(event) => onChange({ headline: event.target.value })}
          maxLength={HEADLINE_MAX_CHARS}
        />
      </div>
    </li>
  );
}
