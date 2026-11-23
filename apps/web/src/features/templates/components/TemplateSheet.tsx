import {
  TEMPLATE_CATEGORIES,
  applyVariables,
  collectAvatarIds,
  estimateCompositionDurationMs,
  usesPhotorealAvatars,
} from '@parlante/shared';
import type { Template, TemplateCategory } from '@parlante/shared';
import { getStockAvatarMeta } from '@parlante/renderer';
import { Clapperboard, Pencil, Trash2, VolumeX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Input,
  Select,
  Skeleton,
  Textarea,
  cn,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { CompositionPlayer } from '@/features/avatars/kit';

function EditForm({ template, onDone }: { template: Template; onDone: () => void }) {
  const { t } = useTranslation('templates');
  const describe = useErrorText();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [category, setCategory] = useState<TemplateCategory>(template.category);
  const save = useApiMutation(api.templates.update, {
    invalidates: [api.templates.list, api.templates.get],
    onSuccess: () => {
      toast.success(t('sheet.saved'));
      onDone();
    },
    onError: (error) => toast.error(t('sheet.saveFailed'), { description: describe(error).title }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    save.mutate({
      params: { templateId: template.id },
      body: { name: name.trim(), description: description.trim(), category },
    });
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface-2 p-4"
    >
      <Input
        label={t('sheet.name')}
        value={name}
        maxLength={120}
        required
        autoFocus
        onChange={(event) => setName(event.target.value)}
      />
      <Textarea
        label={t('sheet.description')}
        value={description}
        maxLength={300}
        rows={3}
        showCount
        onChange={(event) => setDescription(event.target.value)}
      />
      <Select
        label={t('sheet.category')}
        value={category}
        onValueChange={setCategory}
        options={TEMPLATE_CATEGORIES.map((value) => ({ value, label: t(`category.${value}`) }))}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="solid" loading={save.isPending}>
          {t('sheet.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('sheet.cancel')}
        </Button>
      </div>
    </form>
  );
}

export interface TemplateSheetProps {
  /** Template to preview; null closes the sheet. */
  template: Template | null;
  onClose: () => void;
  /** Create a draft from the template (the page owns the mutation and the navigation). */
  onUse: (template: Template, title: string) => void;
  using: boolean;
  canUse: boolean;
}

/**
 * Preview of one template: its scenes drawn with the real renderer (silent, estimated
 * timing), what it contains, and "use template". Custom templates can be edited and deleted.
 */
export function TemplateSheet({ template, onClose, onUse, using, canUse }: TemplateSheetProps) {
  const { t } = useTranslation('templates');
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const confirm = useConfirm();

  const [shown, setShown] = useState<Template | null>(template);
  useEffect(() => {
    if (template) setShown(template);
  }, [template]);
  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState(false);
  const [scene, setScene] = useState(0);
  const [seek, setSeek] = useState<{ sceneIndex: number; nonce: number } | null>(null);
  const templateId = template?.id ?? null;
  useEffect(() => {
    setTitle('');
    setEditing(false);
    setScene(0);
    setSeek(null);
  }, [templateId]);

  const detail = useApiQuery(
    api.templates.get,
    { params: { templateId: shown?.id ?? '' } },
    { enabled: template !== null && shown !== null },
  );
  const remove = useApiMutation(api.templates.remove, {
    invalidates: [api.templates.list],
    onSuccess: () => {
      toast.success(t('sheet.deleted'));
      onClose();
    },
    onError: (error) =>
      toast.error(t('sheet.deleteFailed'), { description: describe(error).title }),
  });

  // Templates carry `{{variables}}`: the preview shows them with their example values.
  const source = detail.data?.composition ?? null;
  const composition = useMemo(() => (source ? applyVariables(source, {}) : null), [source]);

  if (!shown) return null;
  const current = shown;
  const variables = source?.variables ?? [];
  const custom = current.kind === 'custom';
  const canEdit = custom && session.can('editor');
  const avatarNames = composition
    ? collectAvatarIds(composition).map((id) => getStockAvatarMeta(id)?.name ?? id)
    : [];

  const askDelete = async () => {
    const ok = await confirm({
      title: t('sheet.deleteTitle', { name: current.name }),
      description: t('sheet.deleteText'),
      confirmLabel: t('sheet.delete'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { templateId: current.id } });
  };

  return (
    <Dialog
      open={template !== null}
      onOpenChange={(open) => !open && onClose()}
      title={current.name}
      description={current.description || undefined}
      size="xl"
      footer={
        <form
          className="flex w-full flex-col gap-2 sm:flex-row sm:items-end sm:justify-end"
          onSubmit={(event) => {
            event.preventDefault();
            onUse(current, title.trim());
          }}
        >
          <Input
            aria-label={t('sheet.videoTitle')}
            placeholder={t('sheet.videoTitlePlaceholder', { name: current.name })}
            value={title}
            maxLength={120}
            disabled={!canUse}
            onChange={(event) => setTitle(event.target.value)}
            wrapperClassName="min-w-0 sm:w-72"
          />
          <Button
            type="submit"
            variant="primary"
            leftIcon={<Clapperboard aria-hidden="true" />}
            disabled={!canUse}
            loading={using}
          >
            {t('use')}
          </Button>
        </form>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0">
          {detail.isPending ? (
            <Skeleton className="aspect-video w-full rounded-xl" />
          ) : detail.isError || !composition ? (
            <ErrorState
              size="sm"
              error={detail.error}
              onRetry={() => void detail.refetch()}
              retrying={detail.isRefetching}
            />
          ) : (
            <>
              <CompositionPlayer
                composition={composition}
                label={t('sheet.preview', { name: current.name })}
                onScene={setScene}
                seekTo={seek}
              />
              <p className="mt-2 flex items-start gap-2 text-xs text-pretty text-fg-muted">
                <VolumeX aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                {usesPhotorealAvatars(composition) ? t('sheet.silentPhotoreal') : t('sheet.silent')}
              </p>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={custom ? 'saffron' : 'neutral'}>{t(`kind.${current.kind}`)}</Badge>
            <Badge tone="neutral" variant="outline">
              {t(`category.${current.category}`)}
            </Badge>
            <Badge tone="neutral" variant="outline" className="nums font-mono">
              {current.aspect}
            </Badge>
          </div>

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-fg-muted">{t('sheet.scenes')}</dt>
              <dd className="nums">{current.sceneCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">{t('sheet.duration')}</dt>
              <dd className="nums">
                {composition
                  ? `≈ ${format.duration(Math.round(estimateCompositionDurationMs(composition) / 1000) * 1000)}`
                  : '—'}
              </dd>
            </div>
            {avatarNames.length > 0 && (
              <div className="col-span-2">
                <dt className="text-xs text-fg-muted">{t('sheet.avatars')}</dt>
                <dd>{[...new Set(avatarNames)].join(' · ')}</dd>
              </div>
            )}
            {current.tags.length > 0 && (
              <div className="col-span-2">
                <dt className="text-xs text-fg-muted">{t('sheet.tags')}</dt>
                <dd>{current.tags.join(' · ')}</dd>
              </div>
            )}
            {current.createdAt && (
              <div className="col-span-2">
                <dt className="text-xs text-fg-muted">{t('sheet.created')}</dt>
                <dd>{format.date(current.createdAt)}</dd>
              </div>
            )}
          </dl>

          {composition && (
            <div>
              <h3 className="mb-2 text-base">{t('sheet.script')}</h3>
              <ol className="flex flex-col gap-1.5">
                {composition.scenes.map((item, index) => {
                  const text =
                    item.script.kind === 'tts'
                      ? item.script.text
                      : item.script.kind === 'audio'
                        ? item.script.transcript
                        : '';
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={scene === index ? 'step' : undefined}
                        onClick={() => setSeek({ sceneIndex: index, nonce: Date.now() })}
                        className={cn(
                          'flex w-full min-w-0 gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150',
                          scene === index
                            ? 'border-fg bg-surface-2'
                            : 'border-line hover:border-line-strong',
                        )}
                      >
                        <span className="nums mt-0.5 font-mono text-xs text-fg-subtle">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold">
                            {item.name || t('sheet.scene', { number: index + 1 })}
                          </span>
                          <span className="line-clamp-2 text-xs text-fg-muted">
                            {text.trim() || t('sheet.noNarration')}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {variables.length > 0 && (
            <div>
              <h3 className="mb-1 text-base">{t('sheet.variables')}</h3>
              <p className="mb-2 text-xs text-fg-muted">{t('sheet.variablesHint')}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {variables.map((variable) => (
                  <li key={variable.name} className="flex min-w-0 items-baseline gap-2">
                    <code className="shrink-0 rounded-xs bg-surface-3 px-1.5 py-0.5 font-mono text-xs">
                      {`{{${variable.name}}}`}
                    </code>
                    <span className="min-w-0 truncate text-fg-muted">
                      {variable.label || variable.name}
                      {variable.defaultValue ? ` · ${variable.defaultValue}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canEdit && (
            <div className="border-t border-line pt-4">
              {editing ? (
                <EditForm template={current} onDone={() => setEditing(false)} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    leftIcon={<Pencil aria-hidden="true" />}
                    onClick={() => setEditing(true)}
                  >
                    {t('sheet.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger-text"
                    leftIcon={<Trash2 aria-hidden="true" />}
                    loading={remove.isPending}
                    onClick={() => void askDelete()}
                  >
                    {t('sheet.delete')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
