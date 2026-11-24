import { COMPOSITION_LIMITS, SHAPE_KINDS, avatarRenderingOf } from '@parlante/shared';
import type { Box, Layer, MediaRef, NewLayerInput, Scene } from '@parlante/shared';
import {
  Circle,
  Film,
  ImagePlus,
  Lock,
  Minus,
  Radio,
  Shapes,
  Square,
  Star,
  Triangle,
  Type,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Badge,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Tooltip,
  cn,
  isLightColor,
} from '@/ui';
import { defaultAvatarBox, paintOrder } from '../model/editor';
import { HANDLES, clampBox, moveBox, resizeBox, snapMove, snapResize } from '../model/geometry';
import type { Guide, Handle } from '../model/geometry';
import { selectScene, useEditor, usePreviewState, useStudio } from '../state/context';
import { AvatarPickerDialog, MediaPickerDialog } from './pickers';
import type { PickedMedia } from './pickers';

const SHAPE_ICONS: Record<(typeof SHAPE_KINDS)[number], ReactNode> = {
  rect: <Square aria-hidden="true" />,
  ellipse: <Circle aria-hidden="true" />,
  triangle: <Triangle aria-hidden="true" />,
  line: <Minus aria-hidden="true" />,
  star: <Star aria-hidden="true" />,
};

const HANDLE_POSITION: Record<Handle, string> = {
  nw: 'left-0 top-0 cursor-nwse-resize',
  n: 'left-1/2 top-0 cursor-ns-resize',
  ne: 'left-full top-0 cursor-nesw-resize',
  e: 'left-full top-1/2 cursor-ew-resize',
  se: 'left-full top-full cursor-nwse-resize',
  s: 'left-1/2 top-full cursor-ns-resize',
  sw: 'left-0 top-full cursor-nesw-resize',
  w: 'left-0 top-1/2 cursor-ew-resize',
};

/** Pixels (on screen) within which a dragged edge snaps to a guide. */
const SNAP_PX = 6;
/** Pointer travel before a press becomes a drag (so a click only selects). */
const DRAG_SLOP_PX = 3;

interface Gesture {
  layerId: string;
  handle: Handle | null;
  startX: number;
  startY: number;
  box: Box;
  rotation: number;
  others: Box[];
  active: boolean;
}

function useFit(aspect: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 360 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const availableW = Math.max(120, element.clientWidth - 48);
      const availableH = Math.max(90, element.clientHeight - 40);
      const width = Math.min(availableW, availableH * aspect);
      setSize({ width: Math.round(width), height: Math.round(width / aspect) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [aspect]);
  return { ref, size };
}

function AddLayerBar({ scene }: { scene: Scene }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const canvas = useEditor((state) => state.history.present.composition.canvas);
  const [picker, setPicker] = useState<'image' | 'video' | 'avatar' | null>(null);
  const full = scene.layers.length >= COMPOSITION_LIMITS.maxLayersPerScene;
  const add = (layer: NewLayerInput) =>
    store.getState().apply({ type: 'layer.add', sceneId: scene.id, layer });
  const ratio = canvas.width / canvas.height;

  const addText = () => {
    const onLight =
      scene.background.type === 'color' && isLightColor(scene.background.color.slice(0, 7));
    add({
      type: 'text',
      name: t('layer.type.text'),
      text: t('stage.newText'),
      box: { x: 0.08, y: 0.1, w: ratio < 1 ? 0.84 : 0.5, h: 0.16 },
      style: {
        fontFamily: 'Poppins',
        fontSize: ratio < 1 ? 0.045 : 0.07,
        fontWeight: 700,
        align: 'left',
        color: onLight ? '#1b1424' : '#ffffff',
      },
    });
  };
  const addMedia = (kind: 'image' | 'video') => (picked: PickedMedia) => {
    const mediaRatio = picked.width && picked.height ? picked.width / picked.height : 16 / 9;
    // Half the canvas wide, in the proportions of the file.
    let w = 0.5;
    let h = (w * ratio) / mediaRatio;
    if (h > 0.8) {
      h = 0.8;
      w = (h * mediaRatio) / ratio;
    }
    const box = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
    const src: MediaRef = picked.ref;
    add(
      kind === 'image'
        ? { type: 'image', name: picked.name.slice(0, 80), src, box, fit: 'contain' }
        : { type: 'video', name: picked.name.slice(0, 80), src, box, fit: 'cover' },
    );
  };

  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label={t('stage.addLabel')}>
      <Button
        size="sm"
        variant="ghost"
        disabled={full}
        aria-label={t('stage.addText')}
        title={t('stage.addText')}
        leftIcon={<Type aria-hidden="true" />}
        onClick={addText}
      >
        <span className="hidden xl:inline">{t('stage.addText')}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={full}
        aria-label={t('stage.addImage')}
        title={t('stage.addImage')}
        leftIcon={<ImagePlus aria-hidden="true" />}
        onClick={() => setPicker('image')}
      >
        <span className="hidden xl:inline">{t('stage.addImage')}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={full}
        aria-label={t('stage.addVideo')}
        title={t('stage.addVideo')}
        leftIcon={<Film aria-hidden="true" />}
        onClick={() => setPicker('video')}
      >
        <span className="hidden xl:inline">{t('stage.addVideo')}</span>
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={full}
            aria-label={t('stage.addShape')}
            title={t('stage.addShape')}
            leftIcon={<Shapes aria-hidden="true" />}
          >
            <span className="hidden xl:inline">{t('stage.addShape')}</span>
          </Button>
        </MenuTrigger>
        <MenuContent align="start">
          {SHAPE_KINDS.map((shape) => (
            <MenuItem
              key={shape}
              icon={SHAPE_ICONS[shape]}
              onSelect={() => {
                const h = shape === 'line' ? 0.02 : 0.3;
                const w = shape === 'line' ? 0.4 : 0.3 / ratio;
                add({
                  type: 'shape',
                  name: t(`shape.kind.${shape}`),
                  shape,
                  fill: '#ff5b2e',
                  box: { x: (1 - w) / 2, y: (1 - h) / 2, w, h },
                });
              }}
            >
              {t(`shape.kind.${shape}`)}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Button
        size="sm"
        variant="ghost"
        disabled={full}
        aria-label={t('stage.addAvatar')}
        title={t('stage.addAvatar')}
        leftIcon={<UserRound aria-hidden="true" />}
        onClick={() => setPicker('avatar')}
      >
        <span className="hidden xl:inline">{t('stage.addAvatar')}</span>
      </Button>

      <MediaPickerDialog
        kind={picker === 'video' ? 'video' : 'image'}
        open={picker === 'image' || picker === 'video'}
        onOpenChange={(open) => !open && setPicker(null)}
        onPick={(picked) => {
          addMedia(picker === 'video' ? 'video' : 'image')(picked);
          setPicker(null);
        }}
      />
      <AvatarPickerDialog
        open={picker === 'avatar'}
        onOpenChange={(open) => !open && setPicker(null)}
        value={null}
        onPick={(avatar) => {
          add({
            type: 'avatar',
            name: avatar.name.slice(0, 80),
            avatarId: avatar.id,
            box: defaultAvatarBox(canvas),
          });
          setPicker(null);
        }}
      />
    </div>
  );
}

/**
 * The stage: the live canvas (drawn by the preview engine with `renderFrame`) and, on top of
 * it while paused, the direct-manipulation overlay — one hit box per layer, selection frame,
 * resize handles and snap guides.
 */
export function Stage() {
  const { t } = useTranslation('studio');
  const { engine, store } = useStudio();
  const scene = useEditor(selectScene);
  const canvasSize = useEditor((state) => state.history.present.composition.canvas);
  const selectedId = useEditor((state) => state.selection.layerId);
  const { playing, preparing } = usePreviewState();
  const { ref, size } = useFit(canvasSize.width / canvasSize.height);
  const [guides, setGuides] = useState<Guide[]>([]);
  const gesture = useRef<Gesture | null>(null);
  const overlay = useRef<HTMLDivElement>(null);

  const attach = useCallback(
    (canvas: HTMLCanvasElement | null) => engine.attachCanvas(canvas),
    [engine],
  );
  useEffect(() => () => engine.attachCanvas(null), [engine]);

  const begin = (event: ReactPointerEvent, layer: Layer, handle: Handle | null) => {
    if (event.button !== 0 || !scene) return;
    event.stopPropagation();
    store.getState().select({ layerId: layer.id });
    if (layer.locked) return;
    gesture.current = {
      layerId: layer.id,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      box: layer.box,
      rotation: layer.rotation,
      others: scene.layers.filter((l) => l.id !== layer.id && l.visible).map((l) => l.box),
      active: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
  };

  const move = (event: ReactPointerEvent) => {
    const current = gesture.current;
    const rect = overlay.current?.getBoundingClientRect();
    if (!current || !scene || !rect || rect.width === 0) return;
    const px = event.clientX - current.startX;
    const py = event.clientY - current.startY;
    if (!current.active && Math.hypot(px, py) < DRAG_SLOP_PX) return;
    current.active = true;
    const dx = px / rect.width;
    const dy = py / rect.height;
    const threshold = { x: SNAP_PX / rect.width, y: SNAP_PX / rect.height };
    const snapping = !event.altKey && current.rotation === 0;
    let box: Box;
    let lines: Guide[] = [];
    if (current.handle === null) {
      box = moveBox(current.box, dx, dy);
      if (snapping) ({ box, guides: lines } = snapMove(box, current.others, threshold));
    } else {
      box = resizeBox(current.box, current.handle, dx, dy, {
        rotation: current.rotation,
        canvas: canvasSize,
        keepRatio: event.shiftKey,
      });
      if (snapping && !event.shiftKey) {
        ({ box, guides: lines } = snapResize(box, current.handle, current.others, threshold));
      }
    }
    setGuides(lines);
    store.getState().apply(
      {
        type: 'layer.patch',
        sceneId: scene.id,
        layerId: current.layerId,
        patch: { box: clampBox(box) },
      },
      `${current.layerId}:drag`,
    );
  };

  const end = () => {
    if (!gesture.current) return;
    gesture.current = null;
    setGuides([]);
    store.getState().seal();
  };

  const busy = playing || preparing;
  const layers = scene ? paintOrder(scene).filter((layer) => layer.visible) : [];
  const photoreal = scene?.layers.some(
    (layer) => layer.type === 'avatar' && avatarRenderingOf(layer.avatarId) === 'photoreal',
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3">
        {scene ? <AddLayerBar scene={scene} /> : <span />}
        <div className="flex shrink-0 items-center gap-2">
          {photoreal && (
            <Tooltip content={t('stage.standInHint')}>
              <Badge tabIndex={0} tone="saffron" size="sm">
                {t('stage.standIn')}
              </Badge>
            </Tooltip>
          )}
          {busy ? (
            <Badge
              tone="accent"
              variant="solid"
              size="sm"
              dot
              pulse
              icon={<Radio aria-hidden="true" />}
            >
              {preparing ? t('stage.preparing') : t('stage.onAir')}
            </Badge>
          ) : (
            <Tooltip content={t('stage.liveHint')}>
              <Badge
                tabIndex={0}
                tone="neutral"
                variant="outline"
                size="sm"
                className="hidden xl:inline-flex"
              >
                {t('stage.live')}
              </Badge>
            </Tooltip>
          )}
        </div>
      </div>

      <div
        ref={ref}
        className="booth-grid relative grid min-h-0 flex-1 place-items-center overflow-hidden"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) store.getState().select({ layerId: null });
        }}
      >
        <div
          className="relative shadow-lg ring-1 ring-line-strong"
          style={{ width: size.width, height: size.height }}
        >
          <canvas
            ref={attach}
            data-testid="stage-canvas"
            aria-label={t('stage.canvasLabel')}
            role="img"
            className="block h-full w-full bg-media"
          />
          <div
            ref={overlay}
            data-testid="stage-overlay"
            className={cn('absolute inset-0', busy && 'pointer-events-none opacity-0')}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) store.getState().select({ layerId: null });
            }}
          >
            {layers.map((layer) => {
              const selected = layer.id === selectedId;
              const name = layer.name || t(`layer.type.${layer.type}`);
              return (
                <div
                  key={layer.id}
                  className="absolute"
                  style={{
                    left: `${layer.box.x * 100}%`,
                    top: `${layer.box.y * 100}%`,
                    width: `${layer.box.w * 100}%`,
                    height: `${layer.box.h * 100}%`,
                    transform: layer.rotation ? `rotate(${layer.rotation}deg)` : undefined,
                    zIndex: selected ? 2 : 1,
                  }}
                >
                  <button
                    type="button"
                    data-layer-id={layer.id}
                    data-layer-type={layer.type}
                    aria-label={t('stage.layerLabel', { name })}
                    aria-pressed={selected}
                    onPointerDown={(event) => begin(event, layer, null)}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                    onFocus={() => store.getState().select({ layerId: layer.id })}
                    className={cn(
                      'absolute inset-0 touch-none rounded-[1px] outline-offset-0 focus-visible:outline-none',
                      layer.locked ? 'cursor-default' : 'cursor-move',
                      selected
                        ? 'outline-2 outline-accent'
                        : 'outline-1 outline-transparent hover:outline-info',
                    )}
                  />
                  {selected && layer.locked && (
                    <span className="absolute -top-6 left-0 flex items-center gap-1 rounded-sm bg-inverse px-1.5 py-0.5 text-2xs font-medium text-inverse-fg">
                      <Lock className="size-3" aria-hidden="true" />
                      {t('layer.locked')}
                    </span>
                  )}
                  {selected &&
                    !layer.locked &&
                    HANDLES.map((handle) => (
                      <span
                        key={handle}
                        data-handle={handle}
                        aria-hidden="true"
                        onPointerDown={(event) => begin(event, layer, handle)}
                        onPointerMove={move}
                        onPointerUp={end}
                        onPointerCancel={end}
                        className={cn(
                          'absolute size-2.5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-[2px] border-[1.5px] border-accent bg-surface shadow-xs',
                          HANDLE_POSITION[handle],
                        )}
                      />
                    ))}
                </div>
              );
            })}
            {guides.map((guide) => (
              <span
                key={`${guide.axis}${guide.at}`}
                data-guide={guide.axis}
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute z-10 bg-saffron',
                  guide.axis === 'x' ? 'top-0 h-full w-px' : 'left-0 h-px w-full',
                )}
                style={
                  guide.axis === 'x'
                    ? { left: `${guide.at * 100}%` }
                    : { top: `${guide.at * 100}%` }
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
