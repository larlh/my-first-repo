import { CircleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '@/lib/api';
import { useErrorText } from '@/ui';

/**
 * Form-level failure (wrong credentials, too many attempts, no connection) in plain words.
 * It takes focus when it appears so keyboard and screen-reader users land on the reason.
 */
export function FormAlert({ error, children }: { error: ApiError | null; children?: ReactNode }) {
  const describe = useErrorText();
  const node = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error) node.current?.focus();
  }, [error]);
  if (!error) return null;
  const text = describe(error);
  // Domain errors already say everything in their title; validation ones carry useful detail.
  const detail = error.is('VALIDATION_ERROR', 'BAD_REQUEST') ? text.message : '';
  return (
    <div
      ref={node}
      role="alert"
      tabIndex={-1}
      className="flex gap-3 rounded-md bg-danger-soft p-3.5 text-sm text-danger-text outline-offset-2"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">{text.title}</p>
        {detail && <p className="mt-0.5 break-words">{detail}</p>}
        {children}
      </div>
    </div>
  );
}
