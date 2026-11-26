import { CREDIT_COSTS } from '@parlante/shared';
import type { LanguageCode, ProviderRef, ScriptTone } from '@parlante/shared';
import { Globe, PenLine, Wand2 } from 'lucide-react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { Button, Card, Input, SegmentedControl, Select, Slider, Textarea, cn } from '@/ui';
import { ModeNotice, useLanguageOptions } from '../kit';
import {
  AUDIENCE_MAX_CHARS,
  DURATION_MIN_SEC,
  DURATION_STEP_SEC,
  MAX_SCENE_COUNT,
  TONES,
  TOPIC_MAX_CHARS,
  URL_MAX_CHARS,
} from '../lib/script';
import type { Brief } from '../lib/script';

const AUTO = 'auto';

export interface BriefFormProps {
  brief: Brief;
  onChange: (patch: Partial<Brief>) => void;
  onSubmit: () => void;
  /** LLM that will write the script (undefined while unknown). */
  llm: ProviderRef | undefined;
  /** Longest video the plan allows (seconds): upper bound of the duration slider. */
  maxDurationSec: number;
  pending: boolean;
  /** A script already exists: the action becomes "write again". */
  hasDraft: boolean;
  errors: { topic?: string; url?: string };
  className?: string;
}

/** The brief: what the script is about and how it should sound. */
export function BriefForm({
  brief,
  onChange,
  onSubmit,
  llm,
  maxDurationSec,
  pending,
  hasDraft,
  errors,
  className,
}: BriefFormProps) {
  const { t } = useTranslation('script-writer');
  const format = useFormat();
  const languages = useLanguageOptions();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <Card padded className={cn('min-w-0 rounded-xl sm:p-6', className)}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div>
          <p className="eyebrow text-fg-subtle">{t('brief.eyebrow')}</p>
          <h2 className="mt-1 text-xl">{t('brief.title')}</h2>
        </div>

        <SegmentedControl<Brief['sourceKind']>
          aria-label={t('brief.source.label')}
          value={brief.sourceKind}
          onValueChange={(sourceKind) => onChange({ sourceKind })}
          block
          options={[
            {
              value: 'topic',
              label: t('brief.source.topic'),
              icon: <PenLine aria-hidden="true" />,
            },
            { value: 'url', label: t('brief.source.url'), icon: <Globe aria-hidden="true" /> },
          ]}
        />

        {brief.sourceKind === 'topic' ? (
          <Textarea
            label={t('brief.topic.label')}
            placeholder={t('brief.topic.placeholder')}
            hint={t('brief.topic.hint')}
            value={brief.topic}
            onChange={(event) => onChange({ topic: event.target.value })}
            rows={5}
            maxLength={TOPIC_MAX_CHARS}
            showCount
            required
            error={errors.topic}
          />
        ) : (
          <Input
            type="url"
            inputMode="url"
            autoComplete="url"
            label={t('brief.url.label')}
            placeholder={t('brief.url.placeholder')}
            hint={t('brief.url.hint')}
            value={brief.url}
            onChange={(event) => onChange({ url: event.target.value })}
            maxLength={URL_MAX_CHARS}
            required
            error={errors.url}
          />
        )}

        <Select<ScriptTone>
          label={t('brief.tone.label')}
          value={brief.tone}
          onValueChange={(tone) => onChange({ tone })}
          options={TONES.map((tone) => ({
            value: tone,
            label: t(`brief.tone.options.${tone}.name`),
            description: t(`brief.tone.options.${tone}.text`),
            textValue: t(`brief.tone.options.${tone}.name`),
          }))}
        />

        <Slider
          label={t('brief.duration.label')}
          value={Math.min(brief.durationSec, maxDurationSec)}
          onValueChange={(durationSec) => onChange({ durationSec })}
          min={DURATION_MIN_SEC}
          max={maxDurationSec}
          step={DURATION_STEP_SEC}
          formatValue={(value) => format.duration(value * 1000)}
          hint={t('brief.duration.hint', { max: format.duration(maxDurationSec * 1000) })}
        />

        <Select<LanguageCode>
          label={t('brief.language.label')}
          hint={t('brief.language.hint')}
          value={brief.language}
          onValueChange={(language) => onChange({ language })}
          options={languages}
        />

        <details className="group rounded-lg border border-line bg-surface-2 px-4 py-3">
          <summary className="cursor-pointer rounded-xs text-sm font-semibold select-none">
            {t('brief.more')}
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <Select
              label={t('brief.scenes.label')}
              hint={t('brief.scenes.hint')}
              value={brief.sceneCount === null ? AUTO : String(brief.sceneCount)}
              onValueChange={(value) =>
                onChange({ sceneCount: value === AUTO ? null : Number(value) })
              }
              options={[
                { value: AUTO, label: t('brief.scenes.auto') },
                ...Array.from({ length: MAX_SCENE_COUNT }, (_, index) => ({
                  value: String(index + 1),
                  label: t('brief.scenes.count', { count: index + 1 }),
                })),
              ]}
            />
            <Input
              label={t('brief.audience.label')}
              optionalLabel={t('common.optional')}
              placeholder={t('brief.audience.placeholder')}
              value={brief.audience}
              onChange={(event) => onChange({ audience: event.target.value })}
              maxLength={AUDIENCE_MAX_CHARS}
            />
          </div>
        </details>

        <ModeNotice
          provider={llm}
          basic={t('brief.mode.basic')}
          premium={t('brief.mode.premium', {
            name: llm?.name ?? '',
            count: CREDIT_COSTS.scriptPremium,
          })}
        />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={pending}
          leftIcon={<Wand2 aria-hidden="true" />}
        >
          {pending ? t('brief.writing') : hasDraft ? t('brief.again') : t('brief.submit')}
        </Button>
      </form>
    </Card>
  );
}
