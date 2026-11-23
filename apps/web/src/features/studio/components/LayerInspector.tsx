import {
  ANIMATION_TYPES,
  COMPOSITION_LIMITS,
  FONT_FAMILY_NAMES,
  FONT_WEIGHTS,
  SHAPE_KINDS,
  avatarRenderingOf,
  mediaRefKey,
} from '@parlante/shared';
import type { Animation, Fit, FontWeight, Layer, LayerRole, Scene } from '@parlante/shared';
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Film,
  ImageIcon,
  Lock,
  LockOpen,
  Shapes,
  Trash2,
  Type,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  EmptyState,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Textarea,
  cn,
} from '@/ui';
import { paintOrder } from '../model/editor';
import type { LayerOrder, LayerPatch } from '../model/editor';
import { centreBox, clampBox } from '../model/geometry';
import { selectLayer, selectScene, useEditor, useStudio } from '../state/context';
import { ColorField, NumberField, Pair, Section } from './controls';
import { AvatarPickerDialog, AvatarThumb, MediaPickerDialog, PhotorealNotice } from './pickers';

const FITS: Fit[] = ['cover', 'contain', 'fill'];
const ROLES: (LayerRole | 'none')[] = [
  'none',
  'title',
  'subtitle',
  'body',
  'caption',
  'logo',
  'accent',
];
const pct = (value: number) => `${Math.round(value * 100)} %`;

const TYPE_ICONS: Record<Layer['type'], ReactNode> = {
  avatar: <UserRound aria-hidden="true" />,
  text: <Type aria-hidden="true" />,
  image: <ImageIcon aria-hidden="true" />,
  video: <Film aria-hidden="true" />,
  shape: <Shapes aria-hidden="true" />,
};

type Patch = (patch: LayerPatch, key?: string) => void;

/** Layers of the scene, topmost first: select, show / hide, lock. */
function LayerList({ scene, selectedId }: { scene: Scene; selectedId: string | null }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const { apply, select } = store.getState();
  const layers = [...paintOrder(scene)].reverse();
  if (layers.length === 0) {
    return <EmptyState size="sm" title={t('layer.empty')} description={t('layer.emptyText')} />;
  }
  return (
    <ul className="flex flex-col gap-0.5" aria-label={t('layer.list')}>
      {layers.map((layer) => {
        const name = layer.name || t(`layer.type.${layer.type}`);
        const patch = (value: LayerPatch) =>
          apply({ type: 'layer.patch', sceneId: scene.id, layerId: layer.id, patch: value });
        return (
          <li
            key={layer.id}
            className={cn(
              'flex items-center gap-1 rounded-md pr-1',
              layer.id === selectedId ? 'bg-accent-soft' : 'hover:bg-surface-2',
            )}
          >
            <button
              type="button"
              aria-current={layer.id === selectedId ? 'true' : undefined}
              onClick={() => select({ layerId: layer.id })}
              className={cn(
                'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle',
                !layer.visible && 'opacity-50',
              )}
            >
              {TYPE_ICONS[layer.type]}
              <span className="truncate">{name}</span>
            </button>
            <IconButton
              size="sm"
              label={layer.visible ? t('layer.hide', { name }) : t('layer.show', { name })}
              onClick={() => patch({ visible: !layer.visible })}
            >
              {layer.visible ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
            </IconButton>
            <IconButton
              size="sm"
              label={layer.locked ? t('layer.unlock', { name }) : t('layer.lock', { name })}
              onClick={() => patch({ locked: !layer.locked })}
            >
              {layer.locked ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

function AnimationFields({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: Animation | undefined;
  onChange: (next: Animation | undefined, key?: string) => void;
  onCommit: () => void;
}) {
  const { t } = useTranslation('studio');
  const type = value?.type ?? 'none';
  return (
    <div className="flex flex-col gap-2">
      <Select
        size="sm"
        label={label}
        value={type}
        onValueChange={(next) =>
          onChange(
            next === 'none'
              ? undefined
              : {
                  type: next,
                  durationMs: value?.durationMs ?? 400,
                  delayMs: value?.delayMs ?? 0,
                  easing: value?.easing ?? 'ease-out',
                },
          )
        }
        options={ANIMATION_TYPES.map((kind) => ({
          value: kind,
          label: t(`animation.type.${kind}`),
        }))}
      />
      {value && type !== 'none' && (
        <Slider
          aria-label={t('animation.duration')}
          min={100}
          max={2000}
          step={50}
          value={value.durationMs}
          formatValue={(ms) => `${(ms / 1000).toFixed(2)} s`}
          onValueChange={(durationMs) => onChange({ ...value, durationMs }, 'duration')}
          onValueCommit={onCommit}
        />
      )}
    </div>
  );
}

function CommonFields({ layer, scene, patch }: { layer: Layer; scene: Scene; patch: Patch }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const { apply, seal } = store.getState();
  const name = layer.name || t(`layer.type.${layer.type}`);
  const box = (next: Partial<Layer['box']>, key: string) =>
    patch({ box: clampBox({ ...layer.box, ...next }) }, key);
  const order = (direction: LayerOrder) =>
    apply({ type: 'layer.order', sceneId: scene.id, layerId: layer.id, order: direction });
  return (
    <>
      <Section
        title={t('layer.arrange')}
        aside={
          <div className="flex">
            <IconButton
              size="sm"
              label={t('layer.duplicate')}
              disabled={scene.layers.length >= COMPOSITION_LIMITS.maxLayersPerScene}
              onClick={() =>
                apply({
                  type: 'layer.duplicate',
                  sceneId: scene.id,
                  layerId: layer.id,
                  name: t('common.copyOf', { name }),
                })
              }
            >
              <Copy aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              label={t('layer.delete')}
              onClick={() => apply({ type: 'layer.remove', sceneId: scene.id, layerId: layer.id })}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        }
      >
        <Input
          size="sm"
          label={t('layer.name')}
          maxLength={80}
          value={layer.name}
          placeholder={t(`layer.type.${layer.type}`)}
          onChange={(event) => patch({ name: event.target.value }, 'name')}
          onBlur={seal}
        />
        <div className="grid grid-cols-4 gap-2">
          <NumberField
            label="X"
            min={-2}
            max={3}
            scale={100}
            digits={1}
            value={layer.box.x}
            onChange={(x) => box({ x }, 'x')}
            onCommit={seal}
          />
          <NumberField
            label="Y"
            min={-2}
            max={3}
            scale={100}
            digits={1}
            value={layer.box.y}
            onChange={(y) => box({ y }, 'y')}
            onCommit={seal}
          />
          <NumberField
            label={t('layer.width')}
            min={0.01}
            max={4}
            scale={100}
            digits={1}
            value={layer.box.w}
            onChange={(w) => box({ w }, 'w')}
            onCommit={seal}
          />
          <NumberField
            label={t('layer.height')}
            min={0.01}
            max={4}
            scale={100}
            digits={1}
            value={layer.box.h}
            onChange={(h) => box({ h }, 'h')}
            onCommit={seal}
          />
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            size="sm"
            variant="secondary"
            label={t('layer.centreH')}
            onClick={() => patch({ box: centreBox(layer.box, 'x') })}
          >
            <AlignCenterHorizontal aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label={t('layer.centreV')}
            onClick={() => patch({ box: centreBox(layer.box, 'y') })}
          >
            <AlignCenterVertical aria-hidden="true" />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
          <IconButton
            size="sm"
            variant="secondary"
            label={t('layer.toFront')}
            onClick={() => order('front')}
          >
            <ArrowUpToLine aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label={t('layer.forward')}
            onClick={() => order('forward')}
          >
            <ChevronUp aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label={t('layer.backward')}
            onClick={() => order('backward')}
          >
            <ChevronDown aria-hidden="true" />
          </IconButton>
          <IconButton
            size="sm"
            variant="secondary"
            label={t('layer.toBack')}
            onClick={() => order('back')}
          >
            <ArrowDownToLine aria-hidden="true" />
          </IconButton>
        </div>
        <Slider
          label={t('layer.rotation')}
          min={-180}
          max={180}
          step={1}
          value={layer.rotation}
          formatValue={(value) => `${value}°`}
          onValueChange={(rotation) => patch({ rotation }, 'rotation')}
          onValueCommit={seal}
        />
        <Slider
          label={t('layer.opacity')}
          min={0}
          max={1}
          step={0.05}
          value={layer.opacity}
          formatValue={pct}
          onValueChange={(opacity) => patch({ opacity }, 'opacity')}
          onValueCommit={seal}
        />
      </Section>
      <Section title={t('animation.title')}>
        <AnimationFields
          label={t('animation.enter')}
          value={layer.enter}
          onChange={(enter, key) => patch({ enter }, key ? `enter:${key}` : undefined)}
          onCommit={seal}
        />
        <AnimationFields
          label={t('animation.exit')}
          value={layer.exit}
          onChange={(exit, key) => patch({ exit }, key ? `exit:${key}` : undefined)}
          onCommit={seal}
        />
        <Select
          size="sm"
          label={t('layer.role')}
          hint={t('layer.roleHint')}
          value={layer.role ?? 'none'}
          onValueChange={(role) => patch({ role: role === 'none' ? undefined : role })}
          options={ROLES.map((role) => ({ value: role, label: t(`layer.roles.${role}`) }))}
        />
      </Section>
    </>
  );
}

function AvatarFields({
  layer,
  patch,
}: {
  layer: Extract<Layer, { type: 'avatar' }>;
  patch: Patch;
}) {
  const { t } = useTranslation('studio');
  const { library } = useStudio();
  const [open, setOpen] = useState(false);
  const avatar = library.avatarById(layer.avatarId);
  return (
    <Section title={t('avatar.title')}>
      <div className="flex items-center gap-3">
        <AvatarThumb avatar={avatar ?? layer.avatarId} className="size-12 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{avatar?.name ?? layer.avatarId}</p>
          <Button size="sm" variant="link" className="text-xs" onClick={() => setOpen(true)}>
            {t('avatar.change')}
          </Button>
        </div>
      </div>
      {avatarRenderingOf(layer.avatarId) === 'photoreal' && <PhotorealNotice />}
      <SegmentedControl
        aria-label={t('avatar.framing')}
        size="sm"
        block
        value={layer.framing}
        onValueChange={(framing) => patch({ framing })}
        options={(['closeup', 'bust', 'half'] as const).map((framing) => ({
          value: framing,
          label: t(`avatar.framings.${framing}`),
        }))}
      />
      <Select
        size="sm"
        label={t('avatar.shape')}
        value={layer.shape}
        onValueChange={(shape) =>
          patch({ shape, backdrop: shape === 'none' ? null : (layer.backdrop ?? '#ffc233') })
        }
        options={(['none', 'circle', 'rounded'] as const).map((shape) => ({
          value: shape,
          label: t(`avatar.shapes.${shape}`),
        }))}
      />
      {layer.shape !== 'none' && (
        <ColorField
          label={t('avatar.backdrop')}
          value={layer.backdrop ?? '#ffc233'}
          onChange={(backdrop) => patch({ backdrop }, 'backdrop')}
        />
      )}
      <Switch
        size="sm"
        labelPosition="start"
        label={t('avatar.flip')}
        checked={layer.flip}
        onCheckedChange={(flip) => patch({ flip })}
      />
      <AvatarPickerDialog
        open={open}
        onOpenChange={setOpen}
        value={layer.avatarId}
        onPick={(picked) => {
          patch({ avatarId: picked.id, name: picked.name.slice(0, 80) });
          setOpen(false);
        }}
      />
    </Section>
  );
}

function TextFields({ layer, scene }: { layer: Extract<Layer, { type: 'text' }>; scene: Scene }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const { apply, seal } = store.getState();
  const { style } = layer;
  const set = (patch: Partial<typeof style>, key?: string) =>
    apply(
      { type: 'layer.style', sceneId: scene.id, layerId: layer.id, patch },
      key ? `${layer.id}:style:${key}` : undefined,
    );
  return (
    <Section title={t('text.title')}>
      <Textarea
        label={t('text.content')}
        rows={3}
        maxLength={COMPOSITION_LIMITS.maxTextChars}
        value={layer.text}
        onChange={(event) =>
          apply(
            {
              type: 'layer.patch',
              sceneId: scene.id,
              layerId: layer.id,
              patch: { text: event.target.value },
            },
            `${layer.id}:text`,
          )
        }
        onBlur={seal}
      />
      <Pair>
        <Select
          size="sm"
          label={t('text.font')}
          value={style.fontFamily}
          onValueChange={(fontFamily) => set({ fontFamily })}
          options={FONT_FAMILY_NAMES.map((family) => ({ value: family, label: family }))}
        />
        <Select
          size="sm"
          label={t('text.weight')}
          value={String(style.fontWeight)}
          onValueChange={(weight) => set({ fontWeight: Number(weight) as FontWeight })}
          options={FONT_WEIGHTS.map((weight) => ({
            value: String(weight),
            label: t(`text.weights.${weight}`),
          }))}
        />
      </Pair>
      <Slider
        label={t('text.size')}
        min={0.015}
        max={0.3}
        step={0.0025}
        value={style.fontSize}
        formatValue={(value) => `${(value * 100).toFixed(1)} %`}
        onValueChange={(fontSize) => set({ fontSize }, 'size')}
        onValueCommit={seal}
      />
      <div className="flex items-end gap-2">
        <ColorField
          compact
          label={t('text.color')}
          value={style.color}
          onChange={(color) => set({ color }, 'color')}
        />
        <SegmentedControl
          aria-label={t('text.align')}
          size="sm"
          value={style.align}
          onValueChange={(align) => set({ align })}
          options={[
            {
              value: 'left',
              label: '',
              icon: <AlignLeft aria-hidden="true" />,
              title: t('text.aligns.left'),
            },
            {
              value: 'center',
              label: '',
              icon: <AlignCenter aria-hidden="true" />,
              title: t('text.aligns.center'),
            },
            {
              value: 'right',
              label: '',
              icon: <AlignRight aria-hidden="true" />,
              title: t('text.aligns.right'),
            },
          ]}
        />
        <Select
          size="sm"
          aria-label={t('text.vertical')}
          wrapperClassName="min-w-0 flex-1"
          value={style.verticalAlign}
          onValueChange={(verticalAlign) => set({ verticalAlign })}
          options={(['top', 'middle', 'bottom'] as const).map((value) => ({
            value,
            label: t(`text.verticals.${value}`),
          }))}
        />
      </div>
      <Slider
        label={t('text.lineHeight')}
        min={0.8}
        max={2}
        step={0.05}
        value={style.lineHeight}
        formatValue={(value) => value.toFixed(2)}
        onValueChange={(lineHeight) => set({ lineHeight }, 'lineHeight')}
        onValueCommit={seal}
      />
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Switch
          size="sm"
          label={t('text.italic')}
          checked={style.italic}
          onCheckedChange={(italic) => set({ italic })}
        />
        <Switch
          size="sm"
          label={t('text.uppercase')}
          checked={style.uppercase}
          onCheckedChange={(uppercase) => set({ uppercase })}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Switch
          size="sm"
          label={t('text.background')}
          checked={style.background !== null}
          onCheckedChange={(on) =>
            set({ background: on ? { color: '#1b1424cc', padding: 0.015, radius: 0.01 } : null })
          }
        />
        {style.background && (
          <ColorField
            compact
            label={t('text.backgroundColor')}
            value={style.background.color}
            onChange={(color) =>
              set({ background: style.background ? { ...style.background, color } : null }, 'bg')
            }
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Switch
          size="sm"
          label={t('text.stroke')}
          checked={style.stroke !== null}
          onCheckedChange={(on) => set({ stroke: on ? { color: '#000000', width: 0.004 } : null })}
        />
        {style.stroke && (
          <ColorField
            compact
            label={t('text.strokeColor')}
            value={style.stroke.color}
            onChange={(color) =>
              set({ stroke: style.stroke ? { ...style.stroke, color } : null }, 'stroke')
            }
          />
        )}
      </div>
      <Switch
        size="sm"
        label={t('text.shadow')}
        checked={style.shadow !== null}
        onCheckedChange={(on) =>
          set({
            shadow: on ? { color: '#00000080', blur: 0.01, offsetX: 0, offsetY: 0.004 } : null,
          })
        }
      />
    </Section>
  );
}

function MediaFields({
  layer,
  patch,
}: {
  layer: Extract<Layer, { type: 'image' | 'video' }>;
  patch: Patch;
}) {
  const { t } = useTranslation('studio');
  const { store, library } = useStudio();
  const { seal } = store.getState();
  const [open, setOpen] = useState(false);
  const key = mediaRefKey(layer.src);
  const name = library.mediaName(key);
  const settled = !library.assets.isPending && !library.stock.isPending;
  return (
    <Section title={t(`layer.type.${layer.type}`)}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center gap-2.5 rounded-md border border-line-control bg-surface px-2.5 text-left text-sm hover:bg-surface-2"
      >
        <span className="min-w-0 flex-1 truncate">
          {name ??
            (settled ? (
              <span className="text-danger-text">{t('media.missing')}</span>
            ) : (
              t('media.loading')
            ))}
        </span>
        <span className="text-xs font-semibold text-accent-text">{t('media.change')}</span>
      </button>
      <Select
        size="sm"
        label={t('fit.label')}
        value={layer.fit}
        onValueChange={(fit) => patch({ fit })}
        options={FITS.map((fit) => ({ value: fit, label: t(`fit.${fit}`) }))}
      />
      <Slider
        label={t('layer.radius')}
        min={0}
        max={0.5}
        step={0.01}
        value={layer.radius}
        formatValue={pct}
        onValueChange={(radius) => patch({ radius }, 'radius')}
        onValueCommit={seal}
      />
      {layer.type === 'video' && (
        <>
          <Slider
            label={t('background.volume')}
            min={0}
            max={1}
            step={0.05}
            value={layer.volume}
            formatValue={(value) => (value === 0 ? t('common.muted') : pct(value))}
            onValueChange={(volume) => patch({ volume }, 'volume')}
            onValueCommit={seal}
          />
          <Switch
            size="sm"
            labelPosition="start"
            label={t('common.loop')}
            checked={layer.loop}
            onCheckedChange={(loop) => patch({ loop })}
          />
        </>
      )}
      <MediaPickerDialog
        kind={layer.type}
        open={open}
        onOpenChange={setOpen}
        onPick={(picked) => {
          patch({ src: picked.ref });
          setOpen(false);
        }}
      />
    </Section>
  );
}

function ShapeFields({ layer, patch }: { layer: Extract<Layer, { type: 'shape' }>; patch: Patch }) {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const { seal } = store.getState();
  return (
    <Section title={t('shape.title')}>
      <Select
        size="sm"
        label={t('shape.kindLabel')}
        value={layer.shape}
        onValueChange={(shape) => patch({ shape })}
        options={SHAPE_KINDS.map((shape) => ({ value: shape, label: t(`shape.kind.${shape}`) }))}
      />
      <div className="flex items-center justify-between gap-2">
        <Switch
          size="sm"
          label={t('shape.fill')}
          checked={layer.fill !== null}
          onCheckedChange={(on) => patch({ fill: on ? '#ff5b2e' : null })}
        />
        {layer.fill !== null && (
          <ColorField
            compact
            label={t('shape.fillColor')}
            value={layer.fill}
            onChange={(fill) => patch({ fill }, 'fill')}
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <Switch
          size="sm"
          label={t('shape.stroke')}
          checked={layer.stroke !== null}
          onCheckedChange={(on) =>
            patch({ stroke: on ? { color: '#ffffff', width: 0.006 } : null })
          }
        />
        {layer.stroke && (
          <ColorField
            compact
            label={t('shape.strokeColor')}
            value={layer.stroke.color}
            onChange={(color) =>
              patch({ stroke: layer.stroke ? { ...layer.stroke, color } : null }, 'stroke')
            }
          />
        )}
      </div>
      {layer.stroke && (
        <Slider
          label={t('shape.strokeWidth')}
          min={0.001}
          max={0.05}
          step={0.001}
          value={layer.stroke.width}
          formatValue={(value) => `${(value * 100).toFixed(1)} %`}
          onValueChange={(width) =>
            patch({ stroke: layer.stroke ? { ...layer.stroke, width } : null }, 'strokeWidth')
          }
          onValueCommit={seal}
        />
      )}
      {layer.shape === 'rect' && (
        <Slider
          label={t('layer.radius')}
          min={0}
          max={0.5}
          step={0.01}
          value={layer.radius}
          formatValue={pct}
          onValueChange={(radius) => patch({ radius }, 'radius')}
          onValueCommit={seal}
        />
      )}
    </Section>
  );
}

/** "Layers" tab: the layer stack of the scene and the properties of the selected layer. */
export function LayerInspector() {
  const { t } = useTranslation('studio');
  const { store } = useStudio();
  const scene = useEditor(selectScene);
  const layer = useEditor(selectLayer);
  if (!scene) return null;
  const { apply } = store.getState();
  const patch: Patch = (value, key) => {
    if (!layer) return;
    apply(
      { type: 'layer.patch', sceneId: scene.id, layerId: layer.id, patch: value },
      key ? `${layer.id}:${key}` : undefined,
    );
  };
  return (
    <>
      <Section title={t('layer.list')}>
        <LayerList scene={scene} selectedId={layer?.id ?? null} />
      </Section>
      {layer ? (
        <div key={layer.id}>
          {layer.type === 'avatar' && <AvatarFields layer={layer} patch={patch} />}
          {layer.type === 'text' && <TextFields layer={layer} scene={scene} />}
          {(layer.type === 'image' || layer.type === 'video') && (
            <MediaFields layer={layer} patch={patch} />
          )}
          {layer.type === 'shape' && <ShapeFields layer={layer} patch={patch} />}
          <CommonFields layer={layer} scene={scene} patch={patch} />
        </div>
      ) : (
        scene.layers.length > 0 && (
          <p className="px-4 py-4 text-sm text-fg-muted">{t('layer.pickOne')}</p>
        )
      )}
    </>
  );
}
