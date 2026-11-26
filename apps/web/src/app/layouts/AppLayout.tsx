import { Coins, Menu as MenuIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useMatches } from 'react-router-dom';
import { LogoMark } from '@/components/Logo';
import { cn } from '@/lib/cn';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Drawer } from '@/ui';
import { PATHS } from '../paths';
import { Sidebar } from './Sidebar';

export interface RouteHandle {
  width?: 'default' | 'wide' | 'full';
}

const WIDTHS = {
  default: 'mx-auto w-full max-w-[var(--content-max)] px-4 py-6 sm:px-8 sm:py-9 lg:px-10',
  wide: 'mx-auto w-full max-w-[104rem] px-4 py-6 sm:px-8 sm:py-9 lg:px-10',
  full: 'w-full',
} as const;

/**
 * Layout of every signed-in page: fixed ink sidebar from `lg` up; below that a compact top bar
 * and the same sidebar inside a drawer.
 */
export function AppLayout() {
  const { t } = useTranslation('shell');
  const format = useFormat();
  const { credits } = useSession();
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const matches = useMatches();
  const width =
    matches
      .map((match) => (match.handle as RouteHandle | undefined)?.width)
      .filter(Boolean)
      .pop() ?? 'default';

  // Navigating always closes the drawer (links inside it also call onNavigate).
  useEffect(() => setDrawer(false), [location.pathname]);

  return (
    <div className="min-h-dvh bg-bg text-fg lg:pl-[var(--sidebar-w)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[90] focus:rounded-md focus:bg-inverse focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-inverse-fg"
      >
        {t('nav.skip')}
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-w)] lg:block">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-30 flex h-[var(--topbar-h)] items-center gap-2 bg-sidebar px-2 text-sidebar-fg [--ring:var(--saffron)] lg:hidden">
        <button
          type="button"
          aria-label={t('nav.open')}
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
          className="flex size-10 items-center justify-center rounded-md hover:bg-sidebar-2"
        >
          <MenuIcon className="size-5" aria-hidden="true" />
        </button>
        <Link
          to={PATHS.home}
          aria-label={t('nav.home')}
          className="flex items-center gap-2 rounded-sm"
        >
          <LogoMark className="size-7" />
          <span
            className="font-display text-xl leading-none font-extrabold tracking-[-0.045em]"
            style={{ fontStretch: '78%' }}
          >
            Parlante
          </span>
        </Link>
        <span className="flex-1" />
        <span
          className="nums mr-1.5 inline-flex h-8 items-center gap-1.5 rounded-full bg-sidebar-2 px-3 text-sm font-semibold"
          aria-label={t('credits.count', { count: credits })}
        >
          <Coins className="size-4 text-saffron" aria-hidden="true" />
          {format.number(credits)}
        </span>
      </header>

      <Drawer
        open={drawer}
        onOpenChange={setDrawer}
        side="left"
        title={t('nav.label')}
        hideTitle
        bare
        widthClassName="w-[min(18.5rem,100vw-3rem)]"
        className="border-r-0"
      >
        <Sidebar onNavigate={() => setDrawer(false)} />
      </Drawer>

      <main id="main" tabIndex={-1} className={cn('min-w-0 outline-none', WIDTHS[width])}>
        <Outlet />
      </main>
    </div>
  );
}

/** Session-only pages without any chrome (Studio, interactive avatar). */
export function FullscreenLayout() {
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-bg text-fg">
      <Outlet />
    </div>
  );
}
