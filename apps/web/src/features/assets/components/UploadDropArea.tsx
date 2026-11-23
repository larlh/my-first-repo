import { Upload } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DragEvent, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/ui';

export interface UploadDropAreaHandle {
  /** Open the system file dialog. */
  open: () => void;
}

export interface UploadDropAreaProps {
  onFiles: (files: File[]) => void;
  /** `accept` attribute of the file dialog. Dropped files are NOT filtered here: the upload
   * queue checks every file and lists the refused ones with their reason. */
  accept: readonly string[];
  title: ReactNode;
  description?: ReactNode;
  /** One-row layout (above a populated grid, inside the picker). */
  compact?: boolean;
  /** Also accept files dropped anywhere on the window, showing a full-page target. */
  pageDrop?: boolean;
  pageDropLabel?: string;
  /** Render only the hidden input and the page target (the caller has its own button). */
  hidden?: boolean;
  ref?: Ref<UploadDropAreaHandle>;
  className?: string;
}

function hasFiles(event: { dataTransfer: DataTransfer | null }): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * Drop target + file dialog for several files at once. A real button (Enter / Space open the
 * dialog). Unlike the kit `FileDropzone` it does not pre-filter: every chosen file goes to the
 * upload queue, which reports per file why something was refused.
 */
export function UploadDropArea({
  onFiles,
  accept,
  title,
  description,
  compact = false,
  pageDrop = false,
  pageDropLabel,
  hidden = false,
  ref,
  className,
}: UploadDropAreaProps) {
  const { t } = useTranslation('assets');
  const input = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pageDragging, setPageDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useImperativeHandle(ref, () => ({ open: () => input.current?.click() }), []);

  useEffect(() => {
    if (!pageDrop) return;
    let pageDepth = 0;
    const enter = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      pageDepth += 1;
      setPageDragging(true);
    };
    const over = (event: globalThis.DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      pageDepth = Math.max(0, pageDepth - 1);
      if (pageDepth === 0) setPageDragging(false);
    };
    const drop = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      pageDepth = 0;
      setPageDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) handler.current(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [pageDrop]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    // With page-wide drop the window listener (the event bubbles to it) takes the files.
    if (pageDrop) return;
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  const active = dragging || pageDragging;

  return (
    <>
      {!hidden && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            depth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setDragging(false);
          }}
          onDrop={onDrop}
          data-dragging={active || undefined}
          className={cn(
            'group flex w-full min-w-0 items-center rounded-lg border-2 border-dashed border-line-strong bg-surface-2 text-fg transition-colors duration-150',
            'hover:border-fg-muted hover:bg-surface-3 data-[dragging]:border-accent data-[dragging]:bg-accent-soft',
            compact
              ? 'gap-3.5 px-4 py-3.5 text-left'
              : 'flex-col justify-center gap-3 px-6 py-12 text-center',
            className,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full bg-surface text-fg-muted shadow-xs transition-transform duration-200 ease-out-expo',
              'group-hover:-translate-y-0.5 group-data-[dragging]:-translate-y-1 group-data-[dragging]:text-accent-text',
              compact ? 'size-10 [&_svg]:size-[1.125rem]' : 'size-14 [&_svg]:size-6',
            )}
          >
            <Upload />
          </span>
          <span className="min-w-0">
            <span className={cn('block font-semibold', compact ? 'text-sm' : 'text-lg')}>
              {active ? t('upload.dropNow') : title}
            </span>
            {description && (
              <span className="mt-0.5 block text-sm text-pretty text-fg-muted">{description}</span>
            )}
          </span>
        </button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        accept={accept.join(',')}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Allow picking the same file again.
          event.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
      {pageDrop && pageDragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6"
        >
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent bg-surface px-10 py-12 text-center shadow-lg">
            <span className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-fg">
              <Upload className="size-6" />
            </span>
            <p className="display text-2xl">{pageDropLabel ?? t('upload.dropNow')}</p>
          </div>
        </div>
      )}
    </>
  );
}
