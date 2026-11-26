import type { Video, VideoSummary } from '@parlante/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  api,
  apiClient,
  apiQueryKey,
  isApiError,
  useApiMutation,
  useInvalidateApi,
} from '@/lib/api';
import { Button, ConfirmDialog, Dialog, Input, toast, useErrorText } from '@/ui';
import { ROUTES } from '../lib/routes';

/** The part of a video the actions need (list items and details both have it). */
export type VideoRef = Pick<VideoSummary, 'id' | 'title' | 'status'>;

export interface VideoActionsOptions {
  /** Called right after a video was deleted (the detail page leaves). */
  onRemoved?: (video: VideoRef) => void;
  /** Called with the copy; by default a toast offers to open it. */
  onDuplicated?: (copy: Video) => void;
}

export interface VideoActions {
  rename: (video: VideoRef) => void;
  duplicate: (video: VideoRef) => void;
  remove: (video: VideoRef) => void;
  /** Id of the video being duplicated, if any (for a busy indicator). */
  duplicatingId: string | null;
  /** Dialogs of the actions: render once in the page. */
  dialogs: ReactNode;
}

const TITLE_MAX = 120;

/**
 * Forget the cached detail of a deleted video. If a page is still showing it (the detail page,
 * until its navigation commits) the entry is dropped when that page lets go: removing it under
 * a mounted observer would make it fetch the video again and get a 404.
 */
function dropWhenUnobserved(client: QueryClient, queryKey: QueryKey): void {
  const cache = client.getQueryCache();
  const query = cache.find({ queryKey, exact: true });
  if (!query) return;
  if (query.getObserversCount() === 0) {
    client.removeQueries({ queryKey, exact: true });
    return;
  }
  const unsubscribe = cache.subscribe((event) => {
    if (event.query !== query) return;
    if (event.type === 'removed') unsubscribe();
    else if (event.type === 'observerRemoved' && query.getObserversCount() === 0) {
      unsubscribe();
      client.removeQueries({ queryKey, exact: true });
    }
  });
}

/**
 * Rename, duplicate and delete — shared by the list cards, the detail page and the dashboard
 * so the three behave (and confirm) the same way.
 */
export function useVideoActions(options: VideoActionsOptions = {}): VideoActions {
  const { t } = useTranslation('videos');
  const { onRemoved, onDuplicated } = options;
  const navigate = useNavigate();
  const client = useQueryClient();
  const invalidate = useInvalidateApi();
  const describe = useErrorText();

  /* ---------- rename ---------- */
  const [renaming, setRenaming] = useState<VideoRef | null>(null);
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const update = useApiMutation(api.videos.update, {
    invalidates: [api.videos.list, api.videos.get],
  });

  // The dialog would otherwise start on its close button (the first focusable element): put
  // the caret in the title instead, with the old title selected, once the dialog has mounted.
  const titleInput = useRef<HTMLInputElement | null>(null);
  const renameOpen = renaming !== null;
  useEffect(() => {
    if (!renameOpen) return;
    const id = window.setTimeout(() => {
      titleInput.current?.focus();
      titleInput.current?.select();
    }, 0);
    return () => window.clearTimeout(id);
  }, [renameOpen]);

  const rename = useCallback((video: VideoRef) => {
    setRenaming(video);
    setTitle(video.title);
    setTitleError(null);
  }, []);

  const submitRename = (event: FormEvent) => {
    event.preventDefault();
    if (!renaming) return;
    const next = title.trim();
    if (next === '') {
      setTitleError(t('rename.required'));
      return;
    }
    if (next === renaming.title) {
      setRenaming(null);
      return;
    }
    update.mutate(
      { params: { videoId: renaming.id }, body: { title: next } },
      {
        onSuccess: () => {
          setRenaming(null);
          toast.success(t('rename.done'));
        },
        onError: (error) =>
          setTitleError(
            isApiError(error) && error.fieldErrors.title
              ? error.fieldErrors.title
              : describe(error).title,
          ),
      },
    );
  };

  /* ---------- duplicate ---------- */
  const duplicateMutation = useApiMutation(api.videos.duplicate, {
    invalidates: [api.videos.list],
    onSuccess: (copy) => {
      if (onDuplicated) {
        onDuplicated(copy);
        return;
      }
      toast.success(t('duplicate.done', { title: copy.title }), {
        action: {
          label: t('duplicate.open'),
          onClick: () => void navigate(ROUTES.video(copy.id)),
        },
      });
    },
    onError: (error) => toast.error(t('duplicate.failed'), { description: describe(error).title }),
  });
  const duplicate = useCallback(
    (video: VideoRef) => duplicateMutation.mutate({ params: { videoId: video.id } }),
    [duplicateMutation],
  );

  /* ---------- delete ---------- */
  // `removing` outlives the dialog so its title does not blank out while it closes.
  const [removing, setRemoving] = useState<VideoRef | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useCallback((video: VideoRef) => {
    setRemoving(video);
    setRemoveOpen(true);
  }, []);

  const confirmRemove = async () => {
    if (!removing) return;
    const video = removing;
    try {
      await apiClient.videos.remove({ params: { videoId: video.id } });
    } catch (error) {
      toast.error(t('delete.failed'), { description: describe(error).title });
      throw error; // keeps the dialog open so the user can retry
    }
    onRemoved?.(video);
    dropWhenUnobserved(client, apiQueryKey(api.videos.get, { params: { videoId: video.id } }));
    void invalidate(api.videos.list, api.billing.overview);
    toast.success(t('delete.done', { title: video.title }));
  };

  const dialogs = (
    <>
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title={t('rename.title')}
        size="sm"
        dismissible={!update.isPending}
        footer={
          <>
            <Button onClick={() => setRenaming(null)} disabled={update.isPending}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" type="submit" form="rename-video" loading={update.isPending}>
              {t('rename.save')}
            </Button>
          </>
        }
      >
        <form id="rename-video" onSubmit={submitRename} noValidate>
          <Input
            label={t('rename.label')}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleError(null);
            }}
            ref={titleInput}
            maxLength={TITLE_MAX}
            required
            error={titleError ?? undefined}
          />
        </form>
      </Dialog>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        tone="danger"
        title={t('delete.title', { title: removing?.title ?? '' })}
        description={
          removing?.status === 'queued' || removing?.status === 'rendering'
            ? t('delete.textActive')
            : t('delete.text')
        }
        confirmLabel={t('delete.confirm')}
        onConfirm={confirmRemove}
      />
    </>
  );

  return {
    rename,
    duplicate,
    remove,
    duplicatingId: duplicateMutation.isPending
      ? (duplicateMutation.variables?.params.videoId ?? null)
      : null,
    dialogs,
  };
}
