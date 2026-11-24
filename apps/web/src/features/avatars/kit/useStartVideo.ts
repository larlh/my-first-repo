import { DEFAULT_STOCK_AVATAR_ID } from '@parlante/renderer';
import { baseLanguage, compositionFromScript, defaultVoiceId } from '@parlante/shared';
import type { Composition, Video } from '@parlante/shared';
import { useNavigate } from 'react-router-dom';
import { api, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useDefaultVoice } from '@/lib/voices';
import { draftPath, useAvailableRoutes } from './routes';

/* "Use in a video": the library creates a one-scene draft with the chosen avatar and/or voice
 * through the same script → Composition layout the script writer and the public API use
 * (`compositionFromScript`), then opens it in the Studio. */

export interface StartVideoInput {
  /** Title of the draft. */
  title: string;
  /** Narration of the first scene (the person rewrites it in the Studio). */
  text: string;
  /** UI language, used when no voice fixes the narration language. */
  locale: string;
  avatarId?: string;
  voice?: { id: string; language: string };
  /** Voice for the narration when `voice` is not given (default: the local one). */
  defaultVoiceId?: string;
}

/** The draft document for an avatar and/or a voice (pure; tested). */
export function starterComposition(input: StartVideoInput): Composition {
  const language = input.voice?.language ?? baseLanguage(input.locale) ?? 'es';
  return compositionFromScript([{ text: input.text, title: input.title }], {
    avatarId: input.avatarId ?? DEFAULT_STOCK_AVATAR_ID,
    voiceId: input.voice?.id ?? input.defaultVoiceId ?? defaultVoiceId(language),
    language,
  });
}

export interface StartVideo {
  start: (input: StartVideoInput) => void;
  isPending: boolean;
  /** Where the draft opens; false when no feature that shows a video is mounted. */
  canOpen: boolean;
}

export function useStartVideo(options: {
  onCreated?: (video: Video) => void;
  onError?: (error: ApiError) => void;
}): StartVideo {
  const navigate = useNavigate();
  const available = useAvailableRoutes();
  const defaultVoice = useDefaultVoice();
  const create = useApiMutation(api.videos.create, {
    invalidates: [api.videos.list],
    onSuccess: (video) => {
      options.onCreated?.(video);
      const path = draftPath(available, video.id);
      if (path) void navigate(path);
    },
    onError: (error) => options.onError?.(error),
  });
  return {
    start: (input) => {
      // Without a chosen voice the draft starts with the one the server recommends.
      const language = baseLanguage(input.locale) ?? 'es';
      const withVoice = input.voice
        ? input
        : { ...input, defaultVoiceId: input.defaultVoiceId ?? defaultVoice(language) };
      create.mutate({
        body: { title: input.title.slice(0, 120), composition: starterComposition(withVoice) },
      });
    },
    isPending: create.isPending,
    canOpen: available.studio || available.video,
  };
}
