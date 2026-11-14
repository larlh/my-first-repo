import { Languages, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { changeLocale, toUiLocale } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { IconButton, VoiceBars } from '@/ui';
import { PATHS } from '../paths';

/** Language + theme toggles for pages outside the app layout. */
export function PublicPreferences({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('shell');
  const theme = useTheme();
  const locale = toUiLocale(i18n.resolvedLanguage ?? i18n.language);
  const other = locale === 'es' ? 'en' : 'es';
  return (
    <div className={className}>
      <IconButton
        label={t('prefs.switchLanguage', { language: other === 'es' ? 'Español' : 'English' })}
        onClick={() => void changeLocale(other)}
      >
        <Languages aria-hidden="true" />
      </IconButton>
      <IconButton
        label={theme.theme === 'dark' ? t('prefs.toLight') : t('prefs.toDark')}
        onClick={theme.toggle}
      >
        {theme.theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </IconButton>
    </div>
  );
}

export interface AuthShellProps {
  title: ReactNode;
  description?: ReactNode;
  /** Line under the form ("¿No tienes cuenta? Regístrate"). */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Frame for public pages with a form (login, register, accept invite): the form on paper, and
 * from `lg` up the ink "booth" panel with the brand line. Owned by the shell so every public
 * page shares the identity; the forms themselves belong to features.
 */
export function AuthShell({ title, description, footer, children }: AuthShellProps) {
  const { t } = useTranslation('shell');
  return (
    <div className="grid min-h-dvh bg-bg text-fg lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex min-w-0 flex-col px-5 py-5 sm:px-10">
        <div className="flex items-center justify-between">
          <Link to={PATHS.home} aria-label={t('nav.home')} className="rounded-sm">
            <Logo size="md" />
          </Link>
          <PublicPreferences className="flex items-center gap-1" />
        </div>
        <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="display text-4xl">{title}</h1>
          {description && <p className="mt-3 text-base text-fg-muted">{description}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-6 text-sm text-fg-muted">{footer}</div>}
        </main>
      </div>

      <aside
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-sidebar text-sidebar-fg lg:flex lg:flex-col lg:justify-between lg:p-12"
      >
        <div className="booth-grid absolute inset-0 opacity-40" />
        <div className="relative flex items-center gap-3 text-sm font-semibold text-sidebar-fg-muted">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-70" />
            <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
          </span>
          <span className="eyebrow">{t('brand.onAir')}</span>
        </div>
        <div className="relative">
          <VoiceBars size="lg" label={null} className="mb-8" />
          <p className="display max-w-xl text-5xl xl:text-6xl">
            {t('brand.tagline.before')}{' '}
            <span className="text-accent">{t('brand.tagline.accent')}</span>
            {t('brand.tagline.after')}
          </p>
          <p className="mt-6 max-w-md text-lg text-sidebar-fg-muted">{t('brand.pitch')}</p>
        </div>
        <p className="relative text-sm text-sidebar-fg-muted">{t('brand.offline')}</p>
      </aside>
    </div>
  );
}
