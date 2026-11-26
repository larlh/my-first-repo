import { FONT_FAMILIES } from '@parlante/shared';
import type { AspectRatio, BrandKit, FontFamily } from '@parlante/shared';
import { ImagePlus, Plus, Star, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { api, toAppUrl, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  ColorPicker,
  ErrorState,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  cn,
  toast,
  useConfirm,
  useErrorText,
} from '@/ui';
import { AssetPicker } from '@/features/assets/picker';
import { Callout, CompositionPlayer } from '@/features/avatars/kit';
import {
  BRAND_COLOR_ROLES,
  NAME_MAX,
  contrastWarnings,
  draftFromKit,
  draftProblem,
  emptyDraft,
  isDirty,
  kitBody,
} from './lib/kit';
import type { KitDraft } from './lib/kit';
import { brandedSample, logoMediaKey } from './lib/sample';
import type { SampleTexts } from './lib/sample';

const NEW = 'new';
const ASPECTS: readonly AspectRatio[] = ['16:9', '9:16', '1:1'];

function KitPill({
  label,
  selected,
  isDefault,
  onSelect,
  defaultLabel,
}: {
  label: string;
  selected: boolean;
  isDefault: boolean;
  onSelect: () => void;
  defaultLabel: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'inline-flex h-9 max-w-56 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors duration-150',
        selected
          ? 'border-fg bg-inverse text-inverse-fg'
          : 'border-line-strong bg-surface text-fg hover:bg-surface-2',
      )}
    >
      {isDefault && (
        <Star aria-label={defaultLabel} className="size-3.5 shrink-0 fill-current" role="img" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Brand kit (master prompt §3.13): logo, colours and typography, previewed live on a sample
 * scene styled with the same `applyBrandKit` the API runs on a real video.
 */
export default function BrandKitPage() {
  const { t, i18n } = useTranslation('brand-kit');
  const format = useFormat();
  const session = useSession();
  const describe = useErrorText();
  const confirm = useConfirm();
  const canEdit = session.can('editor');
  const uiLocale = i18n.language.startsWith('en') ? 'en' : 'es';
  const [params, setParams] = useSearchParams();

  const kits = useApiQuery(api.brandKits.list);
  const list = useMemo(() => kits.data?.items ?? [], [kits.data]);

  const wanted = params.get('kit');
  const selectedId: string =
    wanted === NEW
      ? NEW
      : (list.find((kit) => kit.id === wanted)?.id ??
        list.find((kit) => kit.isDefault)?.id ??
        list[0]?.id ??
        NEW);
  const selected: BrandKit | null = list.find((kit) => kit.id === selectedId) ?? null;

  const saved: KitDraft = useMemo(
    () => (selected ? draftFromKit(selected) : emptyDraft(t('newName'), list.length === 0)),
    // A new draft only depends on whether it is the first kit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, list.length === 0, t],
  );
  const [draft, setDraft] = useState<KitDraft>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = selected ? isDirty(draft, saved) : true;
  const [touched, setTouched] = useState(false);
  const problem = draftProblem(draft);

  const [aspect, setAspect] = useState<AspectRatio>('16:9');
  const [pickingLogo, setPickingLogo] = useState(false);

  const texts: SampleTexts = useMemo(
    () => ({
      eyebrow: t('sample.eyebrow'),
      title: t('sample.title'),
      subtitle: t('sample.subtitle'),
      body: t('sample.body'),
      script: [t('sample.script1'), t('sample.script2')],
      language: uiLocale,
    }),
    [t, uiLocale],
  );
  const { logoAssetId, colors, fonts } = draft;
  const sample = useMemo(
    () => brandedSample(aspect, texts, { logoAssetId, colors, fonts }),
    [aspect, texts, logoAssetId, colors, fonts],
  );
  const logoKey = logoMediaKey(draft);
  const extraMedia = useMemo(
    () =>
      logoKey && draft.logoUrl
        ? { [logoKey]: { url: draft.logoUrl, kind: 'image' as const } }
        : undefined,
    [logoKey, draft.logoUrl],
  );
  const warnings = contrastWarnings(draft.colors);

  const select = (id: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('kit', id);
        return next;
      },
      { replace: true },
    );
  const switchTo = async (id: string) => {
    if (id === selectedId) return;
    if (selected && dirty) {
      const ok = await confirm({
        title: t('discard.title'),
        description: t('discard.text', { name: selected.name }),
        confirmLabel: t('discard.confirm'),
      });
      if (!ok) return;
    }
    setTouched(false);
    select(id);
  };

  const onSaved = (kit: BrandKit, message: string) => {
    toast.success(message);
    setTouched(false);
    select(kit.id);
  };
  const create = useApiMutation(api.brandKits.create, {
    invalidates: [api.brandKits.list],
    onSuccess: (kit) => onSaved(kit, t('created')),
    onError: (error) => toast.error(t('saveFailed'), { description: describe(error).title }),
  });
  const update = useApiMutation(api.brandKits.update, {
    invalidates: [api.brandKits.list, api.brandKits.get],
    onSuccess: (kit) => onSaved(kit, t('saved')),
    onError: (error) => toast.error(t('saveFailed'), { description: describe(error).title }),
  });
  const remove = useApiMutation(api.brandKits.remove, {
    invalidates: [api.brandKits.list],
    onSuccess: () => {
      toast.success(t('deleted'));
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('kit');
          return next;
        },
        { replace: true },
      );
    },
    onError: (error) => toast.error(t('deleteFailed'), { description: describe(error).title }),
  });
  const saving = create.isPending || update.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem || !canEdit) return;
    if (selected) update.mutate({ params: { brandKitId: selected.id }, body: kitBody(draft) });
    else create.mutate({ body: kitBody(draft) });
  };
  const askDelete = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: t('delete.title', { name: selected.name }),
      description: t('delete.text'),
      confirmLabel: t('delete.confirm'),
      tone: 'danger',
    });
    if (ok) remove.mutate({ params: { brandKitId: selected.id } });
  };

  const patch = (next: Partial<KitDraft>) => setDraft((current) => ({ ...current, ...next }));

  return (
    <>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
        actions={
          canEdit && selectedId !== NEW ? (
            <Button leftIcon={<Plus aria-hidden="true" />} onClick={() => void switchTo(NEW)}>
              {t('new')}
            </Button>
          ) : undefined
        }
      />

      {kits.isPending ? (
        <div className="grid gap-6 lg:grid-cols-2" aria-busy="true">
          <Skeleton className="h-[34rem] rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : kits.isError ? (
        <ErrorState
          error={kits.error}
          onRetry={() => void kits.refetch()}
          retrying={kits.isRefetching}
        />
      ) : (
        <>
          {(list.length > 0 || selectedId === NEW) &&
            list.length + (selectedId === NEW ? 1 : 0) > 1 && (
              <div
                role="group"
                aria-label={t('kits')}
                className="mb-5 flex flex-wrap items-center gap-2"
              >
                {list.map((kit) => (
                  <KitPill
                    key={kit.id}
                    label={kit.name}
                    selected={kit.id === selectedId}
                    isDefault={kit.isDefault}
                    defaultLabel={t('default.badge')}
                    onSelect={() => void switchTo(kit.id)}
                  />
                ))}
                {selectedId === NEW && (
                  <KitPill
                    label={t('unsaved')}
                    selected
                    isDefault={false}
                    defaultLabel={t('default.badge')}
                    onSelect={() => undefined}
                  />
                )}
              </div>
            )}

          {list.length === 0 && (
            <Callout tone="saffron" className="mb-5" title={t('first.title')}>
              {t('first.text')}
            </Callout>
          )}
          {!canEdit && (
            <Callout tone="neutral" className="mb-5">
              {t('readOnly')}
            </Callout>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,11fr)_minmax(0,13fr)]">
            {/* ---- editor ---- */}
            <form
              onSubmit={submit}
              noValidate
              aria-label={t('form')}
              className="flex min-w-0 flex-col gap-7 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6"
            >
              <Input
                label={t('name')}
                name="name"
                value={draft.name}
                maxLength={NAME_MAX}
                required
                disabled={!canEdit}
                error={touched && problem ? t(`problem.${problem}`) : undefined}
                onChange={(event) => patch({ name: event.target.value })}
              />

              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold">{t('logo.title')}</legend>
                <p className="mt-0.5 text-sm text-fg-muted">{t('logo.text')}</p>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <div className="flex h-20 w-36 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-3 p-2 booth-grid text-fg-subtle">
                    {draft.logoUrl ? (
                      <img
                        src={toAppUrl(draft.logoUrl)}
                        alt={t('logo.alt')}
                        className="max-h-full max-w-full object-contain"
                      />
                    ) : (
                      <span className="text-xs text-fg-muted">{t('logo.none')}</span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      leftIcon={<ImagePlus aria-hidden="true" />}
                      disabled={!canEdit}
                      onClick={() => setPickingLogo(true)}
                    >
                      {draft.logoAssetId ? t('logo.change') : t('logo.choose')}
                    </Button>
                    {draft.logoAssetId && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={!canEdit}
                        onClick={() => patch({ logoAssetId: null, logoUrl: null })}
                      >
                        {t('logo.remove')}
                      </Button>
                    )}
                  </div>
                </div>
              </fieldset>

              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold">{t('colors.title')}</legend>
                <p className="mt-0.5 text-sm text-fg-muted">{t('colors.intro')}</p>
                <div className="mt-3 grid gap-x-4 gap-y-4 sm:grid-cols-2">
                  {BRAND_COLOR_ROLES.map((role) => (
                    <ColorPicker
                      key={role}
                      label={t(`colors.${role}.label`)}
                      hint={t(`colors.${role}.hint`)}
                      value={draft.colors[role]}
                      disabled={!canEdit}
                      onChange={(hex) => patch({ colors: { ...draft.colors, [role]: hex } })}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className="min-w-0">
                <legend className="text-sm font-semibold">{t('fonts.title')}</legend>
                <p className="mt-0.5 text-sm text-fg-muted">{t('fonts.text')}</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {(['heading', 'body'] as const).map((slot) => (
                    <Select<FontFamily>
                      key={slot}
                      label={t(`fonts.${slot}`)}
                      value={draft.fonts[slot]}
                      disabled={!canEdit}
                      onValueChange={(family) =>
                        patch({ fonts: { ...draft.fonts, [slot]: family } })
                      }
                      options={FONT_FAMILIES.map((font) => ({
                        value: font.family,
                        textValue: font.family,
                        label: (
                          <span style={{ fontFamily: `'${font.family}'` }}>{font.family}</span>
                        ),
                        description: t(`fonts.kind.${font.kind}`),
                      }))}
                    />
                  ))}
                </div>
              </fieldset>

              <Switch
                checked={draft.isDefault}
                onCheckedChange={(isDefault) => patch({ isDefault })}
                disabled={!canEdit}
                label={t('default.label')}
                description={t('default.text')}
                labelPosition="start"
              />

              {canEdit && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-5">
                  <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
                    {selected ? t('save') : t('create')}
                  </Button>
                  {selected && dirty && (
                    <Button
                      type="button"
                      variant="ghost"
                      leftIcon={<Undo2 aria-hidden="true" />}
                      onClick={() => setDraft(saved)}
                    >
                      {t('revert')}
                    </Button>
                  )}
                  {!selected && list.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setTouched(false);
                        select(list.find((kit) => kit.isDefault)?.id ?? list[0]?.id ?? NEW);
                      }}
                    >
                      {t('cancel')}
                    </Button>
                  )}
                  {selected && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="ml-auto text-danger-text"
                      leftIcon={<Trash2 aria-hidden="true" />}
                      loading={remove.isPending}
                      onClick={() => void askDelete()}
                    >
                      {t('delete.action')}
                    </Button>
                  )}
                </div>
              )}
              {selected && (
                <p className="-mt-3 text-xs text-fg-muted">
                  {dirty
                    ? t('unsavedChanges')
                    : t('updated', { date: format.dateTime(selected.updatedAt) })}
                </p>
              )}
            </form>

            {/* ---- preview ---- */}
            <section
              aria-label={t('preview.title')}
              className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6"
            >
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="eyebrow text-fg-subtle">{t('preview.eyebrow')}</p>
                  <h2 className="text-2xl">{t('preview.title')}</h2>
                </div>
                <SegmentedControl
                  aria-label={t('preview.format')}
                  size="sm"
                  value={aspect}
                  onValueChange={setAspect}
                  options={ASPECTS.map((value) => ({ value, label: value }))}
                />
              </div>

              <CompositionPlayer
                composition={sample}
                label={t('preview.alt', { name: draft.name || t('newName') })}
                extraMedia={extraMedia}
                portraitHeight="min(52dvh, 28rem)"
              />

              <ul className="grid grid-cols-5 gap-2" aria-label={t('preview.swatches')}>
                {BRAND_COLOR_ROLES.map((role) => (
                  <li key={role} className="min-w-0">
                    <span
                      aria-hidden="true"
                      className="block h-9 rounded-md border border-line"
                      style={{ backgroundColor: draft.colors[role] }}
                    />
                    <span className="mt-1 block truncate text-xs font-semibold">
                      {t(`colors.${role}.label`)}
                    </span>
                    <span className="nums block truncate font-mono text-2xs text-fg-muted uppercase">
                      {draft.colors[role]}
                    </span>
                  </li>
                ))}
              </ul>

              {warnings.length > 0 && (
                <Callout
                  tone="warning"
                  icon={<TriangleAlert />}
                  title={t('contrast.title')}
                  role="status"
                >
                  <ul className="list-disc pl-4">
                    {warnings.map((warning) => (
                      <li key={warning.pair}>
                        {t(`contrast.${warning.pair}`, {
                          ratio: format.number(warning.ratio, { maximumFractionDigits: 1 }),
                        })}
                      </li>
                    ))}
                  </ul>
                </Callout>
              )}

              <p className="text-xs text-pretty text-fg-muted">{t('preview.note')}</p>
            </section>
          </div>
        </>
      )}

      <AssetPicker
        open={pickingLogo}
        onOpenChange={setPickingLogo}
        kinds={['image']}
        includeStock={false}
        value={draft.logoAssetId ? { source: 'asset', assetId: draft.logoAssetId } : null}
        title={t('logo.pickerTitle')}
        description={t('logo.pickerText')}
        confirmLabel={t('logo.pickerConfirm')}
        onSelect={(picked) => {
          if (picked.ref.source !== 'asset') return;
          patch({ logoAssetId: picked.ref.assetId, logoUrl: picked.url });
        }}
      />
    </>
  );
}
