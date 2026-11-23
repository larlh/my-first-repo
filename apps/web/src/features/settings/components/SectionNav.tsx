import { ArrowUpRight, BookOpen, Lock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, useLocation } from 'react-router-dom';
import { useSession } from '@/lib/session';
import { cn } from '@/ui';
import { apiDocsUrl } from '../lib/urls';
import { SECTIONS, SECTION_GROUPS } from '../sections';
import type { SectionDef } from '../sections';

const LINK =
  'group relative flex shrink-0 items-center gap-2.5 rounded-md px-3 text-sm font-medium whitespace-nowrap text-fg-muted ' +
  'transition-colors duration-150 hover:bg-fg/6 hover:text-fg [&_svg]:size-4 [&_svg]:shrink-0';
const ACTIVE = 'bg-surface text-fg shadow-xs ring-1 ring-line hover:bg-surface';

function SectionLink({ section, compact }: { section: SectionDef; compact: boolean }) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  const locked = section.minRole !== undefined && !session.can(section.minRole);
  return (
    <NavLink
      to={section.path}
      className={({ isActive }) => cn(LINK, compact ? 'h-9' : 'h-10', isActive && ACTIVE)}
    >
      {({ isActive }) => (
        <>
          {!compact && (
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-accent transition-opacity',
                isActive ? 'opacity-100' : 'opacity-0',
              )}
            />
          )}
          <section.icon aria-hidden="true" className={cn(isActive && 'text-accent-text')} />
          <span className="min-w-0 flex-1 truncate">{t(`sections.${section.id}.label`)}</span>
          {locked && section.minRole && (
            <>
              <Lock aria-hidden="true" className="size-3.5! text-fg-subtle" />
              <span className="sr-only">
                {t('nav.needsRole', { role: tShell(`roles.${section.minRole}`) })}
              </span>
            </>
          )}
        </>
      )}
    </NavLink>
  );
}

function DocsLink({ compact }: { compact: boolean }) {
  const { t } = useTranslation('settings');
  return (
    <a
      href={apiDocsUrl()}
      target="_blank"
      rel="noreferrer"
      className={cn(LINK, compact ? 'h-9' : 'h-10')}
    >
      <BookOpen aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{t('nav.docs')}</span>
      <ArrowUpRight aria-hidden="true" className="size-3.5! text-fg-subtle" />
      <span className="sr-only">{t('nav.newTab')}</span>
    </a>
  );
}

/**
 * Navigation between settings sections: a sticky grouped column from `lg` up, a horizontally
 * scrollable strip below. Both are the same links (`aria-current` marks the active one).
 */
export function SectionNav() {
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();
  const strip = useRef<HTMLDivElement | null>(null);

  // On phones the strip scrolls sideways: keep the active section in view.
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const box = strip.current;
    if (!active || !box) return;
    box.scrollLeft = active.offsetLeft - (box.clientWidth - active.offsetWidth) / 2;
  }, [pathname]);

  return (
    <nav aria-label={t('nav.label')} className="min-w-0">
      {/* Phones and tablets: one scrollable row. */}
      <div
        ref={strip}
        className="relative -mx-4 overflow-x-auto px-4 pb-1 sm:-mx-8 sm:px-8 lg:hidden"
      >
        <ul className="flex w-max gap-1 rounded-lg bg-surface-3 p-1">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <SectionLink section={section} compact />
            </li>
          ))}
          <li>
            <DocsLink compact />
          </li>
        </ul>
      </div>

      {/* Desktop: grouped column. */}
      <div className="sticky top-9 hidden lg:block">
        <p className="display mb-5 px-3 text-2xl">{t('title')}</p>
        <div className="flex flex-col gap-5">
          {SECTION_GROUPS.map((group) => (
            <div key={group}>
              <p className="eyebrow mb-1.5 px-3 text-fg-subtle">{t(`nav.groups.${group}`)}</p>
              <ul className="flex flex-col gap-0.5">
                {SECTIONS.filter((section) => section.group === group).map((section) => (
                  <li key={section.id}>
                    <SectionLink section={section} compact={false} />
                  </li>
                ))}
                {group === 'developers' && (
                  <li>
                    <DocsLink compact={false} />
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}
