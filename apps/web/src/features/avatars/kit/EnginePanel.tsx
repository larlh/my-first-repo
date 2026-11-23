import { Check, Copy, Minus, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { Button, Dialog, Skeleton, cn, toast } from '@/ui';
import {
  ENGINE_MODELS_DOC,
  ENGINE_OPERATIONS,
  ENGINE_START_COMMAND,
  animationSeconds,
  engineCan,
  engineHealth,
  nonCommercialModels,
  portraitSeconds,
} from './engine';
import type { EngineHealth, EngineOperation, EngineStatus } from './engine';

const LED: Record<EngineHealth, string> = {
  ready: 'bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_30%,transparent)]',
  partial: 'bg-saffron shadow-[0_0_0_3px_color-mix(in_srgb,var(--saffron)_30%,transparent)]',
  off: 'bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_30%,transparent)]',
  unknown: 'bg-on-media/40',
};

/** Seconds of video used for the worked example ("a 10 s video takes…"). */
const EXAMPLE_VIDEO_SEC = 10;

function StartCommand() {
  const { t } = useTranslation('avatars');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ENGINE_START_COMMAND);
      toast.success(t('kit.engine.copied'));
    } catch {
      toast.error(t('kit.engine.copyFailed'));
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-on-media/20 bg-on-media/5 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-sm">
        <span aria-hidden="true" className="mr-2 text-on-media/50 select-none">
          $
        </span>
        {ENGINE_START_COMMAND}
      </code>
      <Button
        size="sm"
        variant="ghost"
        className="text-on-media hover:bg-on-media/10"
        leftIcon={<Copy aria-hidden="true" />}
        onClick={() => void copy()}
      >
        {t('kit.engine.copy')}
      </Button>
    </div>
  );
}

export interface EnginePanelProps {
  /** `Capabilities.avatarEngine` (or `engine` of `GET /api/avatars`); null = not reported. */
  engine: EngineStatus | null | undefined;
  loading?: boolean;
  /** Re-read the state (after starting the engine). */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Operations this screen needs: listed first and flagged when missing. */
  needs?: readonly EngineOperation[];
  className?: string;
}

/**
 * State of the local neural engine as a piece of rack hardware: status LED, what it can do
 * right now, the speeds it MEASURED on this machine, the licence of every model and what to
 * run when it is off. Always dark, in both themes.
 */
export function EnginePanel({
  engine,
  loading = false,
  onRefresh,
  refreshing = false,
  needs = ENGINE_OPERATIONS,
  className,
}: EnginePanelProps) {
  const { t } = useTranslation('avatars');
  const format = useFormat();
  const health = engineHealth(engine);
  const portrait = portraitSeconds(engine);
  const perSecond = engine?.secondsPerVideoSecond ?? null;
  const example = animationSeconds(engine, EXAMPLE_VIDEO_SEC);
  const restricted = nonCommercialModels(engine);
  const blocked = needs.filter((operation) => !engineCan(engine, operation));

  return (
    <section
      aria-label={t('kit.engine.title')}
      className={cn(
        'overflow-hidden rounded-xl bg-media text-on-media [--ring:var(--saffron)]',
        className,
      )}
    >
      <header className="flex items-center gap-3 border-b border-on-media/15 px-4 py-3 sm:px-5">
        <span
          aria-hidden="true"
          className={cn('size-2.5 shrink-0 rounded-full', LED[health])}
          data-engine-health={health}
        />
        <div className="min-w-0 flex-1">
          <p className="eyebrow text-on-media/60">{t('kit.engine.title')}</p>
          <p className="display text-lg leading-tight" role="status">
            {loading ? t('kit.engine.checking') : t(`kit.engine.health.${health}`)}
            {engine?.available && engine.device && (
              <span className="ml-2 font-mono text-xs font-medium text-on-media/60 uppercase">
                {t(`kit.engine.device.${engine.device}`)}
              </span>
            )}
          </p>
        </div>
        {onRefresh && (
          <Button
            size="sm"
            variant="ghost"
            className="text-on-media hover:bg-on-media/10"
            leftIcon={<RefreshCw aria-hidden="true" />}
            loading={refreshing}
            onClick={onRefresh}
          >
            {t('kit.engine.refresh')}
          </Button>
        )}
      </header>

      {loading ? (
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <Skeleton className="h-4 w-2/3 bg-on-media/15" />
          <Skeleton className="h-4 w-1/2 bg-on-media/15" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4 text-sm sm:p-5">
          {health !== 'ready' && (
            <div className="flex flex-col gap-3" role="note">
              <p className="text-pretty">
                {health === 'unknown'
                  ? t('kit.engine.unknownText')
                  : health === 'off'
                    ? t('kit.engine.offText')
                    : t('kit.engine.partialText')}
              </p>
              {engine?.reason && (
                <p className="rounded-md border border-on-media/20 px-3 py-2 font-mono text-xs break-words text-on-media/80">
                  <span className="mr-1.5 text-on-media/50">{t('kit.engine.reason')}</span>
                  {engine.reason}
                </p>
              )}
              <div>
                <p className="mb-1.5 font-semibold">{t('kit.engine.howTo')}</p>
                <StartCommand />
                <p className="mt-1.5 text-xs text-pretty text-on-media/60">
                  {t('kit.engine.howToHint')}
                </p>
              </div>
            </div>
          )}

          <ul className="flex flex-col gap-1.5" aria-label={t('kit.engine.canDo')}>
            {ENGINE_OPERATIONS.map((operation) => {
              const ok = engineCan(engine, operation);
              return (
                <li key={operation} className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-full',
                      ok ? 'bg-success text-on-media' : 'bg-on-media/15 text-on-media/70',
                    )}
                  >
                    {ok ? (
                      <Check className="size-3" strokeWidth={3} />
                    ) : (
                      <Minus className="size-3" strokeWidth={3} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 font-semibold">
                    {t(`kit.engine.operation.${operation}`)}
                  </span>
                  <span className="shrink-0 text-xs text-on-media/60">
                    {ok ? t('kit.engine.available') : t('kit.engine.unavailable')}
                    {!ok && blocked.includes(operation) && ` · ${t('kit.engine.neededHere')}`}
                  </span>
                </li>
              );
            })}
          </ul>

          {engine?.available && (
            <dl className="grid gap-3 border-t border-on-media/15 pt-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-on-media/60">{t('kit.engine.portraitSpeed')}</dt>
                <dd className="nums font-mono text-base">
                  {portrait === null
                    ? t('kit.engine.notMeasured')
                    : `≈ ${format.duration(portrait * 1000)}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-on-media/60">{t('kit.engine.animationSpeed')}</dt>
                <dd className="nums font-mono text-base">
                  {perSecond === null
                    ? t('kit.engine.notMeasured')
                    : t('kit.engine.perVideoSecond', {
                        time: format.duration(perSecond * 1000),
                      })}
                </dd>
                {example !== null && (
                  <dd className="mt-0.5 text-xs text-on-media/60">
                    {t('kit.engine.example', {
                      video: format.duration(EXAMPLE_VIDEO_SEC * 1000),
                      time: format.duration(example * 1000),
                    })}
                  </dd>
                )}
              </div>
              <p className="text-xs text-on-media/60 sm:col-span-2">
                {t(`kit.engine.measured.${engine.device ?? 'cpu'}`)}
              </p>
            </dl>
          )}

          {restricted.length > 0 && (
            <div
              role="note"
              className="flex gap-3 rounded-lg bg-saffron px-3.5 py-3 text-saffron-fg"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-[1.125rem] shrink-0" />
              <div className="min-w-0">
                <p className="font-semibold">{t('kit.engine.nonCommercialTitle')}</p>
                <p className="text-pretty">
                  {t('kit.engine.nonCommercialText', {
                    models: restricted.map((model) => model.id).join(', '),
                  })}
                </p>
              </div>
            </div>
          )}

          {engine && engine.models.length > 0 && (
            <details className="group border-t border-on-media/15 pt-3">
              <summary className="cursor-pointer text-sm font-semibold select-none">
                {t('kit.engine.models', { count: engine.models.length })}
              </summary>
              <ul className="mt-3 flex flex-col gap-2">
                {engine.models.map((model) => (
                  <li
                    key={model.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-md border border-on-media/15 px-3 py-2 text-xs"
                  >
                    <span className="truncate font-mono text-sm">{model.id}</span>
                    <span
                      className={cn(
                        'justify-self-end rounded-xs px-1.5 py-0.5 font-semibold',
                        model.commercialUse
                          ? 'bg-on-media/10 text-on-media'
                          : 'bg-saffron text-saffron-fg',
                      )}
                    >
                      {model.commercialUse
                        ? t('kit.engine.commercialOk')
                        : t('kit.engine.commercialNo')}
                    </span>
                    <span className="text-on-media/60">
                      {t(`kit.engine.role.${model.role}`)} · {model.license}
                    </span>
                    <span className="justify-self-end text-on-media/60">
                      {model.downloaded
                        ? t('kit.engine.downloaded')
                        : t('kit.engine.notDownloaded')}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-on-media/60">
                {t('kit.engine.modelsDoc', { doc: ENGINE_MODELS_DOC })}
              </p>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export interface EngineStripProps extends Omit<EnginePanelProps, 'className'> {
  className?: string;
}

/** One-line summary of the engine for library pages; opens the full panel in a dialog. */
export function EngineStrip({ className, ...panel }: EngineStripProps) {
  const { t } = useTranslation('avatars');
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const { engine, loading } = panel;
  const health = engineHealth(engine);
  const perSecond = engine?.secondsPerVideoSecond ?? null;
  const restricted = nonCommercialModels(engine).length > 0;

  return (
    <>
      <div
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-media px-3.5 py-2.5 text-sm text-on-media [--ring:var(--saffron)]',
          className,
        )}
      >
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', LED[health])} />
        <p className="min-w-0 flex-1 basis-56" role="status">
          <span className="font-semibold">{t('kit.engine.title')}: </span>
          {loading ? t('kit.engine.checking') : t(`kit.engine.strip.${health}`)}
          {!loading && engine?.available && perSecond !== null && (
            <span className="nums text-on-media/70">
              {' · '}
              {t('kit.engine.stripSpeed', { time: format.duration(perSecond * 1000) })}
            </span>
          )}
          {!loading && restricted && (
            <span className="ml-2 rounded-xs bg-saffron px-1.5 py-0.5 text-xs font-semibold text-saffron-fg">
              {t('kit.engine.nonCommercialShort')}
            </span>
          )}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="text-on-media hover:bg-on-media/10"
          onClick={() => setOpen(true)}
        >
          {health === 'ready' ? t('kit.engine.details') : t('kit.engine.fix')}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('kit.engine.dialogTitle')}
        description={t('kit.engine.dialogText')}
        size="lg"
      >
        <EnginePanel {...panel} />
      </Dialog>
    </>
  );
}
