import type { AspectRatio } from '@parlante/shared';
import {
  ArrowLeft,
  Check,
  Clapperboard,
  CloudAlert,
  CloudUpload,
  Ellipsis,
  ExternalLink,
  Keyboard,
  LayoutTemplate,
  Redo2,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { JobStatusBadge } from '@/components/JobStatus';
import { useFormat } from '@/lib/format';
import {
  Button,
  DictationButton,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SegmentedControl,
  Spinner,
  Tooltip,
  cn,
  useErrorText,
} from '@/ui';
import {
  selectCanRedo,
  selectCanUndo,
  useEditor,
  usePreviewState,
  useStudio,
} from '../state/context';

const ASPECTS: AspectRatio[] = ['16:9', '9:16', '1:1'];
const ASPECT_KEY = { '16:9': 'wide', '9:16': 'tall', '1:1': 'square' } as const;

/** Small frame glyph in the proportions of a format. */
function AspectGlyph({ aspect }: { aspect: AspectRatio }) {
  const size = aspect === '16:9' ? 'h-2.5 w-4' : aspect === '9:16' ? 'h-4 w-2.5' : 'size-3.5';
  return (
    <span aria-hidden="true" className={cn('rounded-[2px] border-[1.5px] border-current', size)} />
  );
}

function SaveIndicator() {
  const { t } = useTranslation('studio');
  const { save, saver } = useStudio();
  const format = useFormat();
  const describe = useErrorText();
  const { status } = save;
  const failure = status === 'error' ? describe(save.error) : null;
  const text = t(`save.${status}`);
  const hint =
    status === 'saved' && save.savedAt
      ? t('save.savedAt', { time: format.relative(new Date(save.savedAt)) })
      : status === 'error'
        ? (failure?.message ?? failure?.title ?? '')
        : t('save.hint');
  return (
    <div role="status" aria-live="polite" className="flex items-center">
      <Tooltip content={hint}>
        <button
          type="button"
          onClick={() => void saver.flush()}
          disabled={status === 'conflict'}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors hover:bg-fg/8',
            status === 'saved' && 'text-fg-muted',
            status === 'dirty' && 'text-saffron-text',
            status === 'saving' && 'text-fg-muted',
            (status === 'error' || status === 'conflict') && 'text-danger-text',
          )}
        >
          {status === 'saved' && <Check className="size-3.5" aria-hidden="true" />}
          {status === 'dirty' && <CloudUpload className="size-3.5" aria-hidden="true" />}
          {status === 'saving' && <Spinner size="xs" label={null} />}
          {(status === 'error' || status === 'conflict') && (
            <CloudAlert className="size-3.5" aria-hidden="true" />
          )}
          <span data-testid="save-status" data-status={status}>
            {text}
          </span>
          {status === 'error' && <RefreshCw className="size-3" aria-hidden="true" />}
        </button>
      </Tooltip>
    </div>
  );
}

export function TopBar() {
  const { t } = useTranslation('studio');
  const format = useFormat();
  const navigate = useNavigate();
  const { video, store, openDialog } = useStudio();
  const title = useEditor((state) => state.history.present.title);
  const aspect = useEditor((state) => state.history.present.composition.canvas.aspect);
  const canUndo = useEditor(selectCanUndo);
  const canRedo = useEditor(selectCanRedo);
  const { timeline } = usePreviewState();
  const { apply, undo, redo, seal } = store.getState();
  const rendering = video.status === 'queued' || video.status === 'rendering';
  const titleField = useRef<HTMLInputElement>(null);

  return (
    <header
      data-theme="dark"
      className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 text-fg [--ring:var(--saffron)]"
    >
      <IconButton
        label={t('top.back')}
        variant="ghost"
        size="sm"
        tooltipSide="bottom"
        onClick={() => void navigate(`/videos/${video.id}`)}
      >
        <ArrowLeft aria-hidden="true" />
      </IconButton>
      <span className="eyebrow hidden text-accent-text xl:block">{t('top.studio')}</span>
      <input
        ref={titleField}
        aria-label={t('top.titleLabel')}
        value={title}
        maxLength={120}
        placeholder={t('top.untitled')}
        onChange={(event) => apply({ type: 'title.set', title: event.target.value }, 'title')}
        onBlur={seal}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className="display h-9 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-2 text-lg text-fg placeholder:text-fg-subtle hover:border-line-strong focus:border-line-control focus:bg-bg-sunken"
      />
      <DictationButton target={titleField} size="sm" />
      <SaveIndicator />

      <div className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
      <IconButton
        label={`${t('top.undo')} (Ctrl+Z)`}
        variant="ghost"
        size="sm"
        tooltipSide="bottom"
        disabled={!canUndo}
        onClick={undo}
      >
        <Undo2 aria-hidden="true" />
      </IconButton>
      <IconButton
        label={`${t('top.redo')} (Ctrl+Shift+Z)`}
        variant="ghost"
        size="sm"
        tooltipSide="bottom"
        disabled={!canRedo}
        onClick={redo}
      >
        <Redo2 aria-hidden="true" />
      </IconButton>
      <div className="mx-1 h-6 w-px bg-line" aria-hidden="true" />

      <SegmentedControl
        aria-label={t('top.format')}
        size="sm"
        value={aspect}
        onValueChange={(next) => apply({ type: 'aspect.set', aspect: next })}
        options={ASPECTS.map((value) => ({
          value,
          label: value,
          icon: <AspectGlyph aspect={value} />,
          title: t(`top.aspect.${ASPECT_KEY[value]}`),
        }))}
      />
      <Tooltip content={t('top.durationHint')}>
        <span
          tabIndex={0}
          className="nums hidden rounded-md px-2 font-mono text-xs text-fg-muted lg:block"
        >
          {format.clock(timeline.totalMs)}
        </span>
      </Tooltip>

      {rendering && <JobStatusBadge status={video.status} size="sm" />}
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={t('top.more')} variant="ghost" size="sm" tooltipSide="bottom">
            <Ellipsis aria-hidden="true" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            icon={<LayoutTemplate aria-hidden="true" />}
            onSelect={() => openDialog('template')}
          >
            {t('top.saveTemplate')}
          </MenuItem>
          <MenuItem
            icon={<Keyboard aria-hidden="true" />}
            trailing="?"
            onSelect={() => openDialog('shortcuts')}
          >
            {t('top.shortcuts')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<ExternalLink aria-hidden="true" />}
            onSelect={() => void navigate(`/videos/${video.id}`)}
          >
            {t('top.videoPage')}
          </MenuItem>
        </MenuContent>
      </Menu>
      <Button
        variant="primary"
        size="sm"
        leftIcon={<Clapperboard aria-hidden="true" />}
        onClick={() => openDialog('render')}
      >
        {rendering ? t('top.rendering') : t('top.render')}
      </Button>
    </header>
  );
}
