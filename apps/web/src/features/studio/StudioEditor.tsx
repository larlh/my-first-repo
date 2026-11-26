import type { Video } from '@parlante/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import {
  api,
  apiClient,
  apiQueryKey,
  invalidateApi,
  isApiError,
  toAppUrl,
  useApiQuery,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { VoiceBars } from '@/ui';
import { Inspector } from './components/Inspector';
import { ScenePanel } from './components/ScenePanel';
import { Stage } from './components/Stage';
import { TopBar } from './components/TopBar';
import { Transport } from './components/Transport';
import {
  ConflictDialog,
  RenderDialog,
  SaveTemplateDialog,
  ShortcutsDialog,
} from './components/dialogs';
import { Autosaver } from './model/autosave';
import type { AutosaveSnapshot } from './model/autosave';
import { clampBox } from './model/geometry';
import { previewComposition } from './model/timing';
import { PreviewEngine } from './preview/engine';
import { StudioContext, createStudioStore, selectComposition } from './state/context';
import type { StudioContextValue, StudioDialog } from './state/context';
import { useStudioLibrary } from './state/library';

interface Machinery {
  engine: PreviewEngine;
  saver: Autosaver;
}

const isField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The editor itself. `initial` seeds the document once; afterwards the store is the truth and
 * the server copy is only consulted for render status, outputs and revision conflicts.
 */
export function StudioEditor({ initial }: { initial: Video }) {
  const { t } = useTranslation('studio');
  const session = useSession();
  const client = useQueryClient();
  const videoId = initial.id;
  const [store] = useState(() =>
    createStudioStore({ title: initial.title, composition: initial.composition }),
  );
  const [machinery, setMachinery] = useState<Machinery | null>(null);
  const [save, setSave] = useState<AutosaveSnapshot>({
    status: 'saved',
    error: null,
    baseRevision: initial.revision,
    conflictRevision: null,
    savedAt: null,
  });
  const [dialog, setDialog] = useState<StudioDialog>(null);
  const untitled = useRef(t('top.untitled'));
  useEffect(() => {
    untitled.current = t('top.untitled');
  }, [t]);
  const watermark = session.plan.limits.watermark;
  const revisionRef = useRef(initial.revision);

  // Engine and autosaver live exactly as long as the mounted editor (StrictMode-safe).
  useEffect(() => {
    const engine = new PreviewEngine({
      synthesize: (body) => apiClient.voices.synthesize({ body }),
      toUrl: toAppUrl,
      watermark,
    });
    const saver = new Autosaver({
      baseRevision: revisionRef.current,
      read: () => store.getState().history.present,
      save: async (payload) => {
        const video = await apiClient.videos.update({
          params: { videoId },
          body: {
            title: payload.title.trim().slice(0, 120) || untitled.current,
            composition: payload.composition,
            baseRevision: payload.baseRevision,
          },
        });
        client.setQueryData(apiQueryKey(api.videos.get, { params: { videoId } }), video);
        return { revision: video.revision };
      },
      conflictOf: (error) => {
        if (!isApiError(error) || !error.is('REVISION_CONFLICT')) return null;
        const current = (error.details as { currentRevision?: unknown } | undefined)
          ?.currentRevision;
        return typeof current === 'number' ? current : true;
      },
      onChange: (snapshot) => {
        revisionRef.current = snapshot.baseRevision;
        setSave(snapshot);
      },
    });
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.history.present !== previous.history.present) saver.notifyChange();
    });
    saver.notifyChange();
    setMachinery({ engine, saver });
    return () => {
      unsubscribe();
      void saver.flush();
      saver.dispose();
      engine.dispose();
      void invalidateApi(client, api.videos.list);
    };
  }, [client, store, videoId, watermark]);

  // Server copy: render status and outputs (the render dialog polls the same query).
  const server = useApiQuery(
    api.videos.get,
    { params: { videoId } },
    { initialData: initial, staleTime: Infinity, refetchOnWindowFocus: false },
  );
  const video = server.data ?? initial;

  const composition = useStore(store, selectComposition);
  const library = useStudioLibrary(composition);
  const preview = useMemo(() => previewComposition(composition), [composition]);
  const engine = machinery?.engine ?? null;
  const saver = machinery?.saver ?? null;

  useEffect(() => {
    engine?.setDocument(preview);
  }, [engine, preview]);
  useEffect(() => {
    engine?.setResources(library.media, library.avatars.items);
  }, [engine, library.media, library.avatars.items]);

  // The paused playhead rests on the selected scene, except right after scrubbing to it.
  const sceneId = useStore(store, (state) => state.selection.sceneId);
  const keepFrame = useRef<string | null>(null);
  useEffect(() => {
    if (!engine || !sceneId) return;
    if (keepFrame.current === sceneId) {
      keepFrame.current = null;
      return;
    }
    engine.park(sceneId);
  }, [engine, sceneId]);

  const selectKeepingFrame = useCallback(
    (id: string | null) => {
      if (!id || id === store.getState().selection.sceneId) return;
      keepFrame.current = id;
      store.getState().select({ sceneId: id });
    },
    [store],
  );

  const playback = useMemo(() => {
    if (!engine) return null;
    const active = () => engine.getState().playing || engine.getState().preparing;
    const lastScene = () => {
      const scenes = store.getState().history.present.composition.scenes;
      return scenes[scenes.length - 1]?.id ?? null;
    };
    const finishOn = (id: string | null) => () => {
      if (!id) return;
      if (store.getState().selection.sceneId === id) engine.park(id);
      else store.getState().select({ sceneId: id });
    };
    const stop = () => {
      const under = engine.sceneAt();
      engine.pause();
      selectKeepingFrame(under);
    };
    return {
      playScene: () => {
        if (active()) return stop();
        const id = store.getState().selection.sceneId;
        const timing = engine.getState().timeline.scenes.find((s) => s.sceneId === id);
        if (timing) void engine.play(timing.startMs, timing.endMs, finishOn(id));
      },
      playAll: () => {
        if (active()) return stop();
        void engine.play(0, engine.getState().timeline.totalMs, finishOn(lastScene()));
      },
      scrub: (tMs: number) => {
        engine.seek(tMs);
        selectKeepingFrame(engine.sceneAt());
      },
      togglePlay: () => {
        if (active()) return stop();
        const { timeline } = engine.getState();
        const id = store.getState().selection.sceneId;
        const parkedOn = timeline.scenes.find((s) => s.sceneId === id);
        const from =
          engine.sceneAt() === id && parkedOn && engine.isParked()
            ? parkedOn.startMs
            : engine.getTime();
        void engine.play(from, timeline.totalMs, finishOn(lastScene()));
      },
    };
  }, [engine, selectKeepingFrame, store]);

  /* ---------- keyboard shortcuts ---------- */
  useEffect(() => {
    if (!playback || !saver) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const state = store.getState();
      const inDialog = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
      if (mod && key === 's') {
        event.preventDefault();
        void saver.flush();
        return;
      }
      if (inDialog) return;
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        state.redo();
        return;
      }
      if (mod && key === 'enter') {
        event.preventDefault();
        setDialog('render');
        return;
      }
      const field = isField(event.target);
      const { sceneId: scene, layerId } = state.selection;
      if (mod && key === 'd' && !field) {
        event.preventDefault();
        const current = state.history.present.composition.scenes.find((s) => s.id === scene);
        const layer = current?.layers.find((l) => l.id === layerId);
        if (layer) {
          state.apply({
            type: 'layer.duplicate',
            sceneId: scene,
            layerId: layer.id,
            name: t('common.copyOf', { name: layer.name || t(`layer.type.${layer.type}`) }),
          });
        } else if (current) {
          state.apply({
            type: 'scene.duplicate',
            sceneId: scene,
            name: t('common.copyOf', { name: current.name }),
          });
        }
        return;
      }
      if (field || mod || event.altKey) return;
      const onButton = event.target instanceof HTMLElement && event.target.closest('button, a');
      if (event.key === ' ' && !onButton) {
        event.preventDefault();
        if (event.shiftKey) playback.playScene();
        else playback.togglePlay();
        return;
      }
      if (event.key === '?') {
        setDialog('shortcuts');
        return;
      }
      const scenes = state.history.present.composition.scenes;
      const index = scenes.findIndex((s) => s.id === scene);
      if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        const next = scenes[index + (event.key === 'PageDown' ? 1 : -1)];
        if (next) state.select({ sceneId: next.id });
        return;
      }
      const layer = scenes[index]?.layers.find((l) => l.id === layerId);
      if (!layer) return;
      if (event.key === 'Escape') {
        state.select({ layerId: null });
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        if (!layer.locked) state.apply({ type: 'layer.remove', sceneId: scene, layerId: layer.id });
      } else if (event.key === ']' || event.key === '[') {
        state.apply({
          type: 'layer.order',
          sceneId: scene,
          layerId: layer.id,
          order: event.key === ']' ? 'forward' : 'backward',
        });
      } else if (event.key.startsWith('Arrow') && !layer.locked) {
        event.preventDefault();
        const { width, height } = state.history.present.composition.canvas;
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        state.apply(
          {
            type: 'layer.patch',
            sceneId: scene,
            layerId: layer.id,
            patch: {
              box: clampBox({
                ...layer.box,
                x: layer.box.x + dx / width,
                y: layer.box.y + dy / height,
              }),
            },
          },
          `${layer.id}:nudge`,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback, saver, store, t]);

  // Leaving with unsaved changes: ask the browser to confirm.
  useEffect(() => {
    if (!saver) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!saver.dirty) return;
      void saver.flush();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [saver]);

  const value = useMemo<StudioContextValue | null>(
    () =>
      engine && saver && playback
        ? { video, store, engine, saver, save, library, openDialog: setDialog, ...playback }
        : null,
    [video, store, engine, saver, save, library, playback],
  );

  if (!value) {
    return (
      <div className="grid h-dvh place-items-center bg-bg">
        <VoiceBars size="lg" label={t('load.loading')} />
      </div>
    );
  }

  return (
    <StudioContext.Provider value={value}>
      <div className="flex h-dvh min-w-[64rem] flex-col overflow-hidden bg-bg text-fg">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <ScenePanel />
          <main className="flex min-w-0 flex-1 flex-col bg-bg-sunken" aria-label={t('stage.label')}>
            <Stage />
            <Transport />
          </main>
          <Inspector />
        </div>
      </div>
      <RenderDialog open={dialog === 'render'} onOpenChange={(open) => !open && setDialog(null)} />
      <SaveTemplateDialog
        open={dialog === 'template'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <ShortcutsDialog
        open={dialog === 'shortcuts'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <ConflictDialog />
    </StudioContext.Provider>
  );
}
