import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Primary action of the section (create, invite…). */
  actions?: ReactNode;
  /** Badges next to the title. */
  meta?: ReactNode;
}

/** Title block of a settings section: the page `<h1>`, with "Ajustes" as its eyebrow. */
export function SectionHeader({ title, description, actions, meta }: SectionHeaderProps) {
  const { t } = useTranslation('settings');
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="eyebrow mb-2 text-accent-text lg:hidden">{t('title')}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="display text-3xl">{title}</h1>
          {meta}
        </div>
        {description && <p className="mt-2 max-w-2xl text-base text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled block inside a section (card with its own heading). */
export function Panel({
  title,
  description,
  aside,
  children,
  id,
  tone = 'default',
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
  tone?: 'default' | 'danger';
}) {
  return (
    <section
      aria-labelledby={id ? `${id}-title` : undefined}
      className={
        tone === 'danger'
          ? 'rounded-lg border border-danger/40 bg-surface shadow-xs'
          : 'rounded-lg border border-line bg-surface shadow-xs'
      }
    >
      <div className="flex flex-col gap-3 p-5 pb-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-lg leading-6">
            {title}
          </h2>
          {description && <p className="mt-1 max-w-2xl text-sm text-fg-muted">{description}</p>}
        </div>
        {aside && <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
