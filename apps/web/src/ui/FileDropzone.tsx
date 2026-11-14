import { Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';

export interface FileRejection {
  file: File;
  reason: 'type' | 'size' | 'count';
}

/** `accept` entries: MIME types (`image/png`), wildcards (`video/*`) or extensions (`.srt`). */
export function fileMatchesAccept(file: File, accept: readonly string[] | undefined): boolean {
  if (!accept || accept.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

/** Split a selection into accepted files and rejections (type, size, count). */
export function validateFiles(
  files: readonly File[],
  rules: { accept?: readonly string[]; maxSizeBytes?: number; multiple?: boolean },
): { accepted: File[]; rejected: FileRejection[] } {
  const accepted: File[] = [];
  const rejected: FileRejection[] = [];
  for (const file of files) {
    if (!fileMatchesAccept(file, rules.accept)) rejected.push({ file, reason: 'type' });
    else if (rules.maxSizeBytes !== undefined && file.size > rules.maxSizeBytes) {
      rejected.push({ file, reason: 'size' });
    } else if (!rules.multiple && accepted.length >= 1) rejected.push({ file, reason: 'count' });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export interface FileDropzoneProps {
  /** Called with the files that passed validation (never empty). */
  onFiles: (files: File[]) => void;
  /** Called with the files that did not pass (optional: an inline message is always shown). */
  onReject?: (rejections: FileRejection[]) => void;
  accept?: readonly string[];
  maxSizeBytes?: number;
  multiple?: boolean;
  disabled?: boolean;
  /** Main line; defaults to "Arrastra un archivo o haz clic para elegirlo". */
  title?: ReactNode;
  /** Second line: what is accepted (formats, limits). A size limit is appended automatically. */
  description?: ReactNode;
  icon?: ReactNode;
  /** Smaller, single-row layout for forms. */
  compact?: boolean;
  /** External error (e.g. the upload failed). */
  error?: ReactNode;
  /** Replaces the idle content (e.g. a progress bar while uploading). */
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
}

/**
 * Drop area + file picker. It is a real button: Enter/Space open the system dialog, and files
 * can be dropped anywhere on it. Type, size and count are validated before `onFiles`; the
 * server re-validates everything (never trust the client check).
 */
export function FileDropzone({
  onFiles,
  onReject,
  accept,
  maxSizeBytes,
  multiple = false,
  disabled = false,
  title,
  description,
  icon,
  compact = false,
  error,
  children,
  className,
  'aria-label': ariaLabel,
}: FileDropzoneProps) {
  const { t } = useTranslation('shell');
  const input = useRef<HTMLInputElement | null>(null);
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<FileRejection | null>(null);
  const depth = useRef(0);

  const handle = (list: FileList | null) => {
    if (!list || list.length === 0 || disabled) return;
    const { accepted, rejected } = validateFiles(Array.from(list), {
      accept,
      maxSizeBytes,
      multiple,
    });
    setRejection(rejected[0] ?? null);
    if (rejected.length > 0) onReject?.(rejected);
    if (accepted.length > 0) onFiles(accepted);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    handle(event.dataTransfer.files);
  };

  const rejectionText = rejection
    ? rejection.reason === 'type'
      ? t('ui.dropzone.rejectType', { name: rejection.file.name })
      : rejection.reason === 'size'
        ? t('ui.dropzone.rejectSize', {
            name: rejection.file.name,
            max: formatBytes(maxSizeBytes ?? 0),
          })
        : t('ui.dropzone.rejectCount')
    : null;
  const message = error ?? rejectionText;
  const limit =
    maxSizeBytes !== undefined
      ? t('ui.dropzone.maxSize', { max: formatBytes(maxSizeBytes) })
      : null;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={message ? `${id}-error` : undefined}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();
          depth.current += 1;
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
        data-dragging={dragging || undefined}
        className={cn(
          'group flex w-full min-w-0 items-center rounded-lg border-2 border-dashed border-line-strong bg-surface-2 text-fg transition-colors duration-150',
          'hover:border-fg-muted hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60',
          'data-[dragging]:border-accent data-[dragging]:bg-accent-soft',
          compact
            ? 'gap-3 px-4 py-3 text-left'
            : 'flex-col justify-center gap-2 px-6 py-9 text-center',
          message && 'border-danger',
        )}
      >
        {children ?? (
          <>
            <span
              aria-hidden="true"
              className={cn(
                'flex shrink-0 items-center justify-center rounded-full bg-surface text-fg-muted shadow-xs transition-transform duration-200 ease-out-expo',
                'group-hover:-translate-y-0.5 group-data-[dragging]:-translate-y-1 group-data-[dragging]:text-accent-text',
                compact ? 'size-9 [&_svg]:size-4' : 'size-12 [&_svg]:size-5',
              )}
            >
              {icon ?? <Upload />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">
                {dragging
                  ? t('ui.dropzone.drop')
                  : (title ?? t(multiple ? 'ui.dropzone.titleMany' : 'ui.dropzone.title'))}
              </span>
              {(description || limit) && (
                <span className="mt-0.5 block text-sm text-fg-muted">
                  {description}
                  {description && limit ? ' · ' : ''}
                  {limit}
                </span>
              )}
            </span>
          </>
        )}
      </button>
      <input
        ref={input}
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        accept={accept?.join(',')}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          handle(event.target.files);
          // Allow picking the same file again.
          event.target.value = '';
        }}
      />
      {message && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-danger-text">
          {message}
        </p>
      )}
    </div>
  );
}
