import type { AspectRatio } from '@parlante/shared';
import { ArrowRight, LayoutTemplate, PenLine, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, isApiError, useApiMutation, useApiQuery } from '@/lib/api';
import { Button, Input, PageHeader, cn, toast, useErrorText } from '@/ui';
import { ROUTES, useAvailableRoutes } from './lib/routes';
import { starterComposition } from './lib/starter';

const ASPECTS: { value: AspectRatio; key: string; shape: string }[] = [
  { value: '16:9', key: 'landscape', shape: 'w-12 h-[1.6875rem]' },
  { value: '9:16', key: 'portrait', shape: 'w-[1.6875rem] h-12' },
  { value: '1:1', key: 'square', shape: 'size-9' },
];

function Take({
  number,
  icon,
  title,
  text,
  children,
  className,
}: {
  number: string;
  icon: ReactNode;
  title: string;
  text: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'relative flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6',
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between">
        <span
          aria-hidden="true"
          className="flex size-11 items-center justify-center rounded-lg bg-surface-3 text-fg [&_svg]:size-5"
        >
          {icon}
        </span>
        <span aria-hidden="true" className="nums font-mono text-xs font-medium text-fg-subtle">
          {number}
        </span>
      </div>
      <h2 className="text-xl">{title}</h2>
      <p className="mt-1.5 text-sm text-fg-muted">{text}</p>
      <div className="mt-5 flex flex-1 flex-col justify-end gap-4">{children}</div>
    </section>
  );
}

/** Start a video: blank canvas in the chosen shape, a template, or the AI script writer. */
export default function NewVideoPage() {
  const { t, i18n } = useTranslation('videos');
  const navigate = useNavigate();
  const describe = useErrorText();
  const available = useAvailableRoutes();
  const groupId = useId();

  const [aspect, setAspect] = useState<AspectRatio>('16:9');
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);

  // Which LLM would write the script (local heuristic = "modo básico").
  const capabilities = useApiQuery(api.system.capabilities, undefined, {
    enabled: available.scriptWriter,
    staleTime: 60_000,
  });
  const llm = capabilities.data?.active.llm;

  const create = useApiMutation(api.videos.create, {
    invalidates: [api.videos.list],
    onSuccess: (video) => {
      toast.success(t('create.done'));
      void navigate(available.studio ? ROUTES.studio(video.id) : ROUTES.video(video.id));
    },
    onError: (error) => {
      if (isApiError(error) && error.fieldErrors.title) setTitleError(error.fieldErrors.title);
      else toast.error(t('create.failed'), { description: describe(error).title });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTitleError(null);
    const trimmed = title.trim();
    create.mutate({
      body: {
        aspect,
        composition: starterComposition({
          aspect,
          locale: i18n.language,
          script: t('create.blank.sampleScript'),
        }),
        ...(trimmed !== '' ? { title: trimmed } : {}),
      },
    });
  };

  return (
    <>
      <PageHeader
        back={{ to: ROUTES.videos, label: t('list.title') }}
        eyebrow={t('create.eyebrow')}
        title={t('create.title')}
        description={t('create.description')}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Take
          number="01"
          icon={<PenLine />}
          title={t('create.blank.title')}
          text={t('create.blank.text')}
        >
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">{t('create.blank.format')}</legend>
              <div className="grid grid-cols-3 gap-2">
                {ASPECTS.map((option) => (
                  <label key={option.value} className="relative cursor-pointer">
                    <input
                      type="radio"
                      name={`${groupId}-aspect`}
                      value={option.value}
                      checked={aspect === option.value}
                      onChange={() => setAspect(option.value)}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'flex h-full flex-col items-center justify-end gap-2 rounded-lg border border-line-strong bg-surface px-2 pt-3 pb-2.5 text-center transition-colors duration-150',
                        'hover:bg-surface-2 peer-checked:border-fg peer-checked:bg-surface-2 peer-checked:shadow-[inset_0_0_0_1px_var(--fg)]',
                        'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
                      )}
                    >
                      <span className="flex h-12 items-center justify-center">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'rounded-xs border-2 border-fg-subtle bg-surface-3',
                            aspect === option.value && 'border-accent bg-accent-soft',
                            option.shape,
                          )}
                        />
                      </span>
                      <span className="text-xs leading-tight font-semibold">
                        {t(`aspect.${option.key}`)}
                        <span className="nums block font-mono text-2xs font-normal text-fg-subtle">
                          {option.value}
                        </span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Input
              label={t('create.blank.name')}
              optionalLabel={t('common.optional')}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleError(null);
              }}
              maxLength={120}
              placeholder={t('create.blank.namePlaceholder')}
              error={titleError ?? undefined}
            />
            <Button
              variant="primary"
              type="submit"
              block
              loading={create.isPending}
              rightIcon={<ArrowRight aria-hidden="true" />}
            >
              {available.studio ? t('create.blank.action') : t('create.blank.actionNoStudio')}
            </Button>
          </form>
        </Take>

        <Take
          number="02"
          icon={<LayoutTemplate />}
          title={t('create.template.title')}
          text={t('create.template.text')}
        >
          <ul className="flex flex-wrap gap-1.5" aria-label={t('create.template.examples')}>
            {(['explainer', 'ad', 'training', 'news', 'product', 'greeting'] as const).map(
              (key) => (
                <li
                  key={key}
                  className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg-muted"
                >
                  {t(`create.template.kinds.${key}`)}
                </li>
              ),
            )}
          </ul>
          {available.templates ? (
            <Button asChild block rightIcon={<ArrowRight aria-hidden="true" />}>
              <Link to={ROUTES.templates}>{t('create.template.action')}</Link>
            </Button>
          ) : (
            <p className="text-sm text-fg-muted">{t('create.unavailable')}</p>
          )}
        </Take>

        <Take
          number="03"
          icon={<Sparkles />}
          title={t('create.script.title')}
          text={t('create.script.text')}
        >
          {llm && (
            <div className="flex flex-col items-start gap-1.5">
              <ProviderBadge provider={llm} size="sm" />
              {llm.quality === 'basic' && (
                <p className="text-xs text-fg-muted">{t('create.script.basic')}</p>
              )}
            </div>
          )}
          {available.scriptWriter ? (
            <Button asChild block rightIcon={<ArrowRight aria-hidden="true" />}>
              <Link to={ROUTES.scriptWriter}>{t('create.script.action')}</Link>
            </Button>
          ) : (
            <p className="text-sm text-fg-muted">{t('create.unavailable')}</p>
          )}
        </Take>
      </div>
    </>
  );
}
