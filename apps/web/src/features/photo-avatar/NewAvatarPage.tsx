import type { Avatar } from '@parlante/shared';
import { Camera, ShieldCheck, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApiQuery, useInvalidateApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PageHeader, ProgressBar, cn } from '@/ui';
import { EnginePanel, LIB_ROUTES, engineCan } from '@/features/avatars/kit';
import { AvatarJob } from './components/AvatarJob';
import { GenerateForm } from './components/GenerateForm';
import { PhotoForm } from './components/PhotoForm';
import { AVATAR_MODES, allowance, countOwnAvatars, modeFromParam } from './lib/form';
import type { AvatarMode } from './lib/form';

const POLL_MS = 2000;

function ModeCard({
  selected,
  icon,
  title,
  text,
  note,
  onSelect,
}: {
  selected: boolean;
  icon: ReactNode;
  title: string;
  text: string;
  note: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 items-start gap-3.5 rounded-xl border bg-surface p-4 text-left transition-[border-color,box-shadow,background-color] duration-150',
        selected
          ? 'border-fg shadow-[inset_0_0_0_1px_var(--fg)]'
          : 'border-line hover:border-line-strong hover:bg-surface-2',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5',
          selected ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="display block text-lg leading-tight">{title}</span>
        <span className="mt-1 block text-sm text-fg-muted">{text}</span>
        <span className="mt-2 flex items-center gap-1.5 text-xs font-semibold">
          <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
          {note}
        </span>
      </span>
    </button>
  );
}

/**
 * Create a photorealistic avatar (master prompt §2b, §3.14): from a photo of a real person —
 * with the mandatory consent declaration — or as a synthetic person from a description. The
 * state of the local engine, its measured speeds and the licence of its models are on the
 * page; so is what to run when it is off.
 */
export default function NewAvatarPage() {
  const { t } = useTranslation('photo-avatar');
  const format = useFormat();
  const session = useSession();
  const invalidate = useInvalidateApi();
  const [params, setParams] = useSearchParams();
  const mode = modeFromParam(params.get('mode'));
  const jobId = params.get('job');

  // The catalogue brings the live engine state and the avatars already made (plan allowance,
  // work in progress).
  const catalogue = useApiQuery(api.avatars.list, undefined, {
    refetchInterval: (query) =>
      query.state.data?.items.some((avatar) => avatar.status === 'processing') ? POLL_MS : false,
  });
  const engine = catalogue.data?.engine ?? null;
  const own = catalogue.data ? countOwnAvatars(catalogue.data.items) : null;
  const room = own === null ? null : allowance(own, session.plan.limits.maxPhotoAvatars);
  const inProgress = (catalogue.data?.items ?? []).filter(
    (avatar) => avatar.status === 'processing' && avatar.id !== jobId,
  );

  const setMode = (next: AvatarMode) =>
    setParams(
      (current) => {
        const copy = new URLSearchParams(current);
        if (next === 'photo') copy.delete('mode');
        else copy.set('mode', next);
        return copy;
      },
      { replace: true },
    );
  const follow = (avatar: Avatar | null) =>
    setParams((current) => {
      const copy = new URLSearchParams(current);
      if (avatar) copy.set('job', avatar.id);
      else copy.delete('job');
      return copy;
    });
  const created = (avatar: Avatar) => {
    void invalidate(api.avatars.list);
    follow(avatar);
  };

  return (
    <>
      <PageHeader
        back={{ to: LIB_ROUTES.avatars, label: t('back') }}
        eyebrow={t('eyebrow')}
        title={t('title')}
        description={t('description')}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          {jobId ? (
            <div className="rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6">
              <AvatarJob avatarId={jobId} engine={engine} onAnother={() => follow(null)} />
            </div>
          ) : (
            <>
              <div
                role="group"
                aria-label={t('mode.label')}
                className="mb-6 grid gap-3 sm:grid-cols-2"
              >
                {AVATAR_MODES.map((value) => (
                  <ModeCard
                    key={value}
                    selected={mode === value}
                    icon={value === 'photo' ? <Camera /> : <Sparkles />}
                    title={t(`mode.${value}.title`)}
                    text={t(`mode.${value}.text`)}
                    note={t(`mode.${value}.note`)}
                    onSelect={() => setMode(value)}
                  />
                ))}
              </div>
              <div className="rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6">
                {mode === 'photo' ? (
                  <PhotoForm
                    canPrepare={engineCan(engine, 'prepare')}
                    allowance={room}
                    onCreated={created}
                  />
                ) : (
                  <GenerateForm
                    engine={engine}
                    canGenerate={engineCan(engine, 'generate') && engineCan(engine, 'prepare')}
                    allowance={room}
                    onCreated={created}
                  />
                )}
              </div>
            </>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
          <EnginePanel
            engine={engine}
            loading={catalogue.isPending}
            onRefresh={() => void catalogue.refetch()}
            refreshing={catalogue.isRefetching}
            needs={mode === 'photo' ? ['prepare'] : ['generate', 'prepare']}
          />
          {catalogue.isError && (
            <p role="alert" className="text-sm text-danger-text">
              {t('engineUnknown')}
            </p>
          )}
          {inProgress.length > 0 && (
            <section
              aria-label={t('queue.title')}
              className="rounded-xl border border-line bg-surface p-4"
            >
              <h2 className="text-base">{t('queue.title')}</h2>
              <ul className="mt-3 flex flex-col gap-3">
                {inProgress.map((avatar) => (
                  <li key={avatar.id} className="min-w-0">
                    <Link
                      to={`${LIB_ROUTES.newAvatar}?job=${avatar.id}`}
                      className="block rounded-md text-sm font-semibold underline-offset-2 hover:underline"
                    >
                      {avatar.name}
                    </Link>
                    <ProgressBar
                      className="mt-1.5"
                      size="sm"
                      value={avatar.progress}
                      label={t('queue.progress', { name: avatar.name })}
                    />
                    <p className="nums mt-1 text-xs text-fg-muted">
                      {Math.round(avatar.progress)} %
                      {avatar.etaSec !== null &&
                        ` · ${t('queue.eta', { time: format.duration(avatar.etaSec * 1000) })}`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
