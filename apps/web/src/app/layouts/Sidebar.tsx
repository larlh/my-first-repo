import { PLANS } from '@parlante/shared';
import type { UiLocale } from '@parlante/shared';
import {
  Check,
  ChevronsUpDown,
  Coins,
  Languages,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Sun,
  SunMoon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { isApiError } from '@/lib/api';
import { apiClient } from '@/lib/api/instance';
import { cn } from '@/lib/cn';
import { useFormat } from '@/lib/format';
import { LOCALE_NAMES, UI_LOCALES, toUiLocale } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import {
  Avatar,
  Button,
  Dialog,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  toast,
  useErrorText,
} from '@/ui';
import { SIDEBAR_SECTIONS, hasRoute } from '../features';
import type { ResolvedNavItem } from '../features';
import { PATHS } from '../paths';
import { useRegistry } from '../RegistryContext';

/* The sidebar is ink in both themes; inside it the focus ring switches to saffron so it stays
 * visible (`[--ring:…]` re-scopes the global focus colour). */

function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation('shell');
  const session = useSession();
  const describe = useErrorText();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTo = async (workspaceId: string) => {
    if (workspaceId === session.workspace.id) return;
    try {
      await session.switchWorkspace(workspaceId);
      onNavigate?.();
    } catch (err) {
      toast.error(t('workspace.switchFailed'), { description: describe(err).title });
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('workspace.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const workspace = await apiClient.workspaces.create({ body: { name: trimmed } });
      await session.switchWorkspace(workspace.id);
      setCreating(false);
      setName('');
      toast.success(t('workspace.created', { name: workspace.name }));
      onNavigate?.();
    } catch (err) {
      setError(
        isApiError(err) && err.fieldErrors.name ? err.fieldErrors.name : describe(err).title,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={t('workspace.switcher', { name: session.workspace.name })}
            className="flex w-full items-center gap-2.5 rounded-md border border-sidebar-line bg-sidebar-2 p-2 text-left transition-colors duration-150 hover:bg-sidebar-3"
          >
            <Avatar name={session.workspace.name} shape="rounded" size="sm" decorative />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-sidebar-fg">
                {session.workspace.name}
              </span>
              <span className="block truncate text-xs text-sidebar-fg-muted">
                {t('workspace.planAndRole', {
                  plan: PLANS[session.workspace.plan].name,
                  role: t(`roles.${session.role}`),
                })}
              </span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-sidebar-fg-muted" aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent
          align="start"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-60"
        >
          <MenuLabel>{t('workspace.yours')}</MenuLabel>
          {session.workspaces.map((workspace) => (
            <MenuItem
              key={workspace.id}
              onSelect={() => void switchTo(workspace.id)}
              icon={<Avatar name={workspace.name} shape="rounded" size="xs" decorative />}
              trailing={
                workspace.id === session.workspace.id ? (
                  <Check className="text-accent-text" aria-label={t('workspace.current')} />
                ) : (
                  t(`roles.${workspace.role}`)
                )
              }
            >
              {workspace.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<Plus aria-hidden="true" />} onSelect={() => setCreating(true)}>
            {t('workspace.create')}
          </MenuItem>
        </MenuContent>
      </Menu>

      <Dialog
        open={creating}
        onOpenChange={(open) => {
          setCreating(open);
          if (!open) setError(null);
        }}
        title={t('workspace.createTitle')}
        description={t('workspace.createText')}
        size="sm"
        dismissible={!busy}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={busy}>
              {t('ui.cancel')}
            </Button>
            <Button variant="primary" type="submit" form="create-workspace" loading={busy}>
              {t('workspace.createAction')}
            </Button>
          </>
        }
      >
        <form
          id="create-workspace"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Input
            label={t('workspace.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            autoFocus
            required
            error={error ?? undefined}
            placeholder={t('workspace.namePlaceholder')}
          />
        </form>
      </Dialog>
    </>
  );
}

/** Credit balance of the active workspace, with the plan's monthly grant as the scale. */
export function CreditsMeter({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation('shell');
  const format = useFormat();
  const { credits, plan } = useSession();
  const registry = useRegistry();
  const ratio = plan.monthlyCredits > 0 ? Math.min(1, credits / plan.monthlyCredits) : 0;
  const low = credits <= Math.max(2, plan.monthlyCredits * 0.1);
  const linked = hasRoute(registry, PATHS.billing);

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow text-sidebar-fg-muted">{t('credits.title')}</span>
        <span className="rounded-full bg-sidebar-3 px-2 py-0.5 text-2xs font-semibold text-sidebar-fg">
          {plan.name}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <Coins className="size-4 shrink-0 translate-y-0.5 text-saffron" aria-hidden="true" />
        <span className="display nums text-2xl text-sidebar-fg">{format.number(credits)}</span>
        <span className="truncate text-xs text-sidebar-fg-muted">
          {t('credits.ofMonthly', { total: format.number(plan.monthlyCredits) })}
        </span>
      </div>
      <div
        role="meter"
        aria-label={t('credits.meter')}
        aria-valuemin={0}
        aria-valuemax={plan.monthlyCredits}
        aria-valuenow={Math.min(credits, plan.monthlyCredits)}
        aria-valuetext={t('credits.count', { count: credits })}
        className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-sidebar-3"
      >
        <span
          className={cn('block h-full rounded-full', low ? 'bg-accent' : 'bg-saffron')}
          style={{ width: `${Math.max(ratio * 100, credits > 0 ? 4 : 0)}%` }}
        />
      </div>
      {low && <p className="mt-2 text-xs text-sidebar-fg-muted">{t('credits.low')}</p>}
    </>
  );

  const frame = 'block rounded-lg border border-sidebar-line bg-sidebar-2 p-3';
  return linked ? (
    <Link
      to={PATHS.billing}
      onClick={onNavigate}
      aria-label={t('credits.manage', { count: credits })}
      className={cn(frame, 'transition-colors duration-150 hover:bg-sidebar-3')}
    >
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}

const THEME_ICONS: Record<ThemePreference, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/** Language and theme pickers as sub-menus of the user menu. */
export function PreferenceMenuItems() {
  const { t, i18n } = useTranslation('shell');
  const session = useSession();
  const theme = useTheme();
  const describe = useErrorText();
  const locale = toUiLocale(i18n.resolvedLanguage ?? i18n.language);
  return (
    <>
      <MenuSub>
        <MenuSubTrigger icon={<Languages aria-hidden="true" />}>
          {t('prefs.language')}
        </MenuSubTrigger>
        <MenuSubContent>
          <MenuRadioGroup
            value={locale}
            onValueChange={(next) => {
              session.setLocale(next as UiLocale).catch((err: unknown) => {
                toast.error(t('prefs.languageNotSaved'), { description: describe(err).title });
              });
            }}
          >
            {UI_LOCALES.map((code) => (
              <MenuRadioItem key={code} value={code} lang={code}>
                {LOCALE_NAMES[code]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
      <MenuSub>
        <MenuSubTrigger icon={<SunMoon aria-hidden="true" />}>{t('prefs.theme')}</MenuSubTrigger>
        <MenuSubContent>
          <MenuRadioGroup
            value={theme.preference}
            onValueChange={(next) => theme.setPreference(next as ThemePreference)}
          >
            {(['system', 'light', 'dark'] as const).map((value) => {
              const Icon = THEME_ICONS[value];
              return (
                <MenuRadioItem key={value} value={value}>
                  <span className="inline-flex items-center gap-2">
                    <Icon className="text-fg-muted" aria-hidden="true" />
                    {t(`prefs.themes.${value}`)}
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
    </>
  );
}

function UserMenu({
  accountItems,
  onNavigate,
}: {
  accountItems: ResolvedNavItem[];
  onNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const describe = useErrorText();

  const logout = async () => {
    try {
      await session.logout();
      await navigate(PATHS.login, { replace: true });
    } catch (err) {
      toast.error(t('user.logoutFailed', { ns: 'shell' }), { description: describe(err).title });
    }
  };

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('user.menu', { ns: 'shell', name: session.user.name })}
          className="flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors duration-150 hover:bg-sidebar-2"
        >
          <Avatar name={session.user.name} size="sm" decorative />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-sidebar-fg">
              {session.user.name}
            </span>
            <span className="block truncate text-xs text-sidebar-fg-muted">
              {session.user.email}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-sidebar-fg-muted" aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuContent
        side="top"
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-60"
      >
        {accountItems.map((item) => {
          const Icon = item.icon;
          return (
            <MenuItem
              key={item.to}
              icon={<Icon aria-hidden="true" />}
              onSelect={() => {
                onNavigate?.();
                void navigate(item.to);
              }}
            >
              {t(item.labelKey, { ns: item.featureId })}
            </MenuItem>
          );
        })}
        {accountItems.length > 0 && <MenuSeparator />}
        <PreferenceMenuItems />
        <MenuSeparator />
        <MenuItem icon={<LogOut aria-hidden="true" />} onSelect={() => void logout()}>
          {t('user.logout', { ns: 'shell' })}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export interface SidebarProps {
  /** Called after any navigation (closes the mobile drawer). */
  onNavigate?: () => void;
  className?: string;
}

/** Brand, workspace switcher, primary action, navigation from the manifests, credits, user. */
export function Sidebar({ onNavigate, className }: SidebarProps) {
  const { t } = useTranslation();
  const session = useSession();
  const registry = useRegistry();
  const items = registry.nav.filter((item) => !item.minRole || session.can(item.minRole));
  const cta = items.find((item) => item.cta);
  const accountItems = items.filter((item) => item.section === 'account');

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col gap-4 bg-sidebar p-3 text-sidebar-fg [--ring:var(--saffron)]',
        className,
      )}
    >
      <Link
        to={PATHS.home}
        onClick={onNavigate}
        aria-label={t('nav.home', { ns: 'shell' })}
        className="mx-1 mt-1.5 self-start rounded-sm"
      >
        <Logo size="md" />
      </Link>

      <WorkspaceSwitcher onNavigate={onNavigate} />

      {cta && (
        <Button asChild variant="primary" block leftIcon={<cta.icon aria-hidden="true" />}>
          <Link to={cta.to} onClick={onNavigate}>
            {t(cta.labelKey, { ns: cta.featureId })}
          </Link>
        </Button>
      )}

      <nav
        aria-label={t('nav.label', { ns: 'shell' })}
        className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
      >
        {SIDEBAR_SECTIONS.map((section) => {
          const sectionItems = items.filter((item) => item.section === section && !item.cta);
          if (sectionItems.length === 0) return null;
          const heading = section === 'main' ? null : t(`nav.sections.${section}`, { ns: 'shell' });
          return (
            <div key={section} className="mb-4 last:mb-0">
              {heading && <p className="eyebrow mb-1.5 px-2.5 text-sidebar-fg-muted">{heading}</p>}
              <ul className="flex flex-col gap-0.5">
                {sectionItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            'group relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium transition-colors duration-150',
                            isActive
                              ? 'bg-sidebar-2 text-sidebar-fg'
                              : 'text-sidebar-fg-muted hover:bg-sidebar-2 hover:text-sidebar-fg',
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            <span
                              aria-hidden="true"
                              className={cn(
                                'absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-accent transition-opacity duration-150',
                                isActive ? 'opacity-100' : 'opacity-0',
                              )}
                            />
                            <Icon
                              className={cn('size-[1.125rem] shrink-0', isActive && 'text-accent')}
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {t(item.labelKey, { ns: item.featureId })}
                            </span>
                          </>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2">
        <CreditsMeter onNavigate={onNavigate} />
        <UserMenu accountItems={accountItems} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
