import { COMPOSITION_LIMITS } from '@parlante/shared';
import type { Scene } from '@parlante/shared';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, Copy, Ellipsis, MicOff, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  VoiceBars,
  cn,
  useConfirm,
} from '@/ui';
import { sceneDurationInfo } from '../model/timing';
import { selectComposition, useEditor, usePreviewState, useStudio } from '../state/context';

const THUMB_WIDTH = 224;

function SceneThumb({ sceneId }: { sceneId: string }) {
  const { engine } = useStudio();
  const { version } = usePreviewState();
  const canvasSize = useEditor((state) => state.history.present.composition.canvas);
  const ref = useRef<HTMLCanvasElement>(null);
  const height = Math.round((THUMB_WIDTH * canvasSize.height) / canvasSize.width);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const frame = requestAnimationFrame(() => engine.drawThumbnail(canvas, sceneId));
    return () => cancelAnimationFrame(frame);
  }, [engine, sceneId, version, height]);
  return (
    <canvas
      ref={ref}
      width={THUMB_WIDTH}
      height={height}
      aria-hidden="true"
      className="h-full w-full object-contain"
    />
  );
}

interface SceneItemProps {
  scene: Scene;
  index: number;
  count: number;
  selected: boolean;
  playing: boolean;
}

function SceneItem({ scene, index, count, selected, playing }: SceneItemProps) {
  const { t } = useTranslation('studio');
  const format = useFormat();
  const confirm = useConfirm();
  const { store } = useStudio();
  const { runtime } = usePreviewState();
  const { apply, select } = store.getState();
  const sortable = useSortable({ id: scene.id });
  const info = sceneDurationInfo(scene, runtime.scenes[scene.id]);
  const name = scene.name || t('scenes.unnamed', { number: index + 1 });
  const silent =
    scene.script.kind === 'none' ||
    (scene.script.kind === 'tts' && scene.script.text.trim() === '');

  const remove = async () => {
    const hasContent = !silent || scene.layers.length > 1;
    if (
      hasContent &&
      !(await confirm({
        title: t('scenes.deleteTitle', { name }),
        description: t('scenes.deleteText'),
        confirmLabel: t('scenes.delete'),
        tone: 'danger',
      }))
    ) {
      return;
    }
    apply({ type: 'scene.remove', sceneId: scene.id });
  };

  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn('group relative', sortable.isDragging && 'z-10 opacity-80')}
    >
      <button
        type="button"
        {...sortable.attributes}
        {...sortable.listeners}
        aria-current={selected ? 'true' : undefined}
        aria-label={t('scenes.itemLabel', { number: index + 1, name })}
        onClick={() => select({ sceneId: scene.id })}
        className={cn(
          'flex w-full touch-none flex-col gap-1.5 rounded-lg border p-1.5 text-left transition-colors',
          selected
            ? 'border-accent bg-accent-soft'
            : 'border-transparent hover:border-line-strong hover:bg-surface-2',
        )}
      >
        <span className="relative block aspect-video w-full overflow-hidden rounded-md bg-media">
          <SceneThumb sceneId={scene.id} />
          <span className="nums absolute top-1 left-1 grid size-5 place-items-center rounded-sm bg-media/80 font-display text-xs font-bold text-on-media">
            {index + 1}
          </span>
          {playing && (
            <span className="absolute right-1 bottom-1 rounded-sm bg-surface px-1.5 py-1 shadow-sm">
              <VoiceBars size="sm" label={null} />
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 px-0.5 pr-6">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{name}</span>
          {silent && <MicOff className="size-3 shrink-0 text-fg-subtle" aria-hidden="true" />}
          <span className="nums shrink-0 font-mono text-2xs text-fg-muted">
            {info.estimated ? '≈ ' : ''}
            {format.clock(info.durationMs)}
          </span>
        </span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={t('scenes.actions', { name })}
            className="absolute right-1.5 bottom-1.5 grid size-6 place-items-center rounded-md text-fg-muted hover:bg-fg/8 hover:text-fg"
          >
            <Ellipsis className="size-4" aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent align="start" side="right">
          <MenuItem
            icon={<Copy aria-hidden="true" />}
            disabled={count >= COMPOSITION_LIMITS.maxScenes}
            onSelect={() =>
              apply({
                type: 'scene.duplicate',
                sceneId: scene.id,
                name: t('common.copyOf', { name }),
              })
            }
          >
            {t('scenes.duplicate')}
          </MenuItem>
          <MenuItem
            icon={<ArrowUp aria-hidden="true" />}
            disabled={index === 0}
            onSelect={() => apply({ type: 'scene.move', sceneId: scene.id, toIndex: index - 1 })}
          >
            {t('scenes.moveUp')}
          </MenuItem>
          <MenuItem
            icon={<ArrowDown aria-hidden="true" />}
            disabled={index === count - 1}
            onSelect={() => apply({ type: 'scene.move', sceneId: scene.id, toIndex: index + 1 })}
          >
            {t('scenes.moveDown')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            tone="danger"
            icon={<Trash2 aria-hidden="true" />}
            disabled={count <= 1}
            onSelect={() => void remove()}
          >
            {t('scenes.delete')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

/** Scene list: select, add, duplicate, delete and reorder (drag, menu or keyboard). */
export function ScenePanel() {
  const { t } = useTranslation('studio');
  const session = useSession();
  const { store } = useStudio();
  const scenes = useEditor((state) => selectComposition(state).scenes);
  const selectedId = useEditor((state) => state.selection.sceneId);
  const { playingSceneId } = usePreviewState();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const planLimit = session.plan.limits.maxScenesPerVideo;
  const full = scenes.length >= COMPOSITION_LIMITS.maxScenes;

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const toIndex = scenes.findIndex((scene) => scene.id === over.id);
    if (toIndex !== -1) {
      store.getState().apply({ type: 'scene.move', sceneId: String(active.id), toIndex });
    }
  };

  return (
    <nav
      aria-label={t('scenes.title')}
      className="flex w-52 shrink-0 flex-col border-r border-line bg-surface"
    >
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        <h2 className="eyebrow text-fg-muted">{t('scenes.title')}</h2>
        <span className="nums font-mono text-2xs text-fg-subtle">{scenes.length}</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={scenes.map((scene) => scene.id)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
            {scenes.map((scene, index) => (
              <SceneItem
                key={scene.id}
                scene={scene}
                index={index}
                count={scenes.length}
                selected={playingSceneId ? playingSceneId === scene.id : selectedId === scene.id}
                playing={playingSceneId === scene.id}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="shrink-0 border-t border-line p-2">
        {scenes.length > planLimit && (
          <p className="mb-2 rounded-md bg-warning-soft px-2 py-1.5 text-2xs text-warning-text">
            {t('scenes.planLimit', { count: planLimit, plan: session.plan.name })}
          </p>
        )}
        <Button
          block
          size="sm"
          leftIcon={<Plus aria-hidden="true" />}
          disabled={full}
          onClick={() =>
            store.getState().apply({
              type: 'scene.add',
              afterSceneId: selectedId,
              name: t('scenes.defaultName', { number: scenes.length + 1 }),
            })
          }
        >
          {t('scenes.add')}
        </Button>
      </div>
    </nav>
  );
}
