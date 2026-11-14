import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Small label above the title (section, counter). */
  eyebrow?: ReactNode;
  /** Buttons on the right (wrap under the title on phones). */
  actions?: ReactNode;
  /** Back link above the title: `{ to: '/videos', label: 'Vídeos' }`. */
  back?: { to: string; label: string };
  /** Badges next to the title (status, plan). */
  meta?: ReactNode;
  /** Tabs or filters attached under the header. */
  children?: ReactNode;
  className?: string;
}

/** Title block of every page inside the app layout: one `<h1>`, description and actions. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  back,
  meta,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-6 flex flex-col gap-4 sm:mb-8', className)}>
      {back && (
        <Link
          to={back.to}
          className="inline-flex items-center gap-1.5 self-start rounded-xs text-sm font-medium text-fg-muted hover:text-fg"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-2 text-accent-text">{eyebrow}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="display text-3xl sm:text-4xl">{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-2 max-w-2xl text-base text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
