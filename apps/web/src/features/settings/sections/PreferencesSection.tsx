import type { UiLocale } from '@parlante/shared';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LOCALE_NAMES, UI_LOCALES, currentLocale } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import type { ThemePreference } from '@/lib/theme';
import { toast } from '@/ui';
import { ChoiceCards } from '../components/ChoiceCards';
import { Panel, SectionHeader } from '../components/SectionHeader';
import { DictationPreferences } from './DictationPreferences';

/** Miniature of the app in one theme (fixed colours of that theme, whatever is active). */
function ThemeSwatch({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <span
      data-theme={theme}
      aria-hidden="true"
      className="flex h-20 overflow-hidden rounded-md border border-line bg-bg"
    >
      <span className="flex w-1/4 flex-col gap-1 bg-sidebar p-1.5">
        <span className="h-1.5 w-full rounded-full bg-accent" />
        <span className="h-1 w-3/4 rounded-full bg-sidebar-3" />
        <span className="h-1 w-2/3 rounded-full bg-sidebar-3" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-2 w-1/2 rounded-full bg-fg" />
        <span className="h-1.5 w-3/4 rounded-full bg-fg-subtle/50" />
        <span className="mt-auto flex gap-1.5">
          <span className="h-5 flex-1 rounded-sm border border-line bg-surface" />
          <span className="h-5 flex-1 rounded-sm border border-line bg-surface" />
        </span>
      </span>
    </span>
  );
}

function SystemSwatch() {
  return (
    <span aria-hidden="true" className="relative block h-20 overflow-hidden rounded-md">
      <span className="absolute inset-0 [clip-path:polygon(0_0,58%_0,42%_100%,0_100%)]">
        <ThemeSwatch theme="light" />
      </span>
      <span className="absolute inset-0 [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]">
        <ThemeSwatch theme="dark" />
      </span>
      <span className="absolute inset-0 rounded-md border border-line" />
    </span>
  );
}

function LanguageSample({ sample }: { sample: string }) {
  return (
    <span
      aria-hidden="true"
      className="booth-grid flex h-20 items-center justify-center rounded-md border border-line bg-surface-2 px-3 text-fg-muted"
    >
      <span className="display truncate text-2xl text-fg">{sample}</span>
    </span>
  );
}

export default function PreferencesSection() {
  const { t } = useTranslation('settings');
  const session = useSession();
  const { preference, setPreference } = useTheme();
  const [savingLocale, setSavingLocale] = useState(false);
  const locale = currentLocale();

  const changeLocale = async (next: UiLocale) => {
    if (next === locale) return;
    setSavingLocale(true);
    try {
      await session.setLocale(next);
    } catch {
      // The language already changed on this device; only the profile copy failed.
      toast.warning(t('preferences.language.notSaved'));
    } finally {
      setSavingLocale(false);
    }
  };

  const themeIcons: Record<ThemePreference, ReactNode> = {
    system: <Monitor aria-hidden="true" className="size-4" />,
    light: <Sun aria-hidden="true" className="size-4" />,
    dark: <Moon aria-hidden="true" className="size-4" />,
  };

  return (
    <>
      <SectionHeader
        title={t('sections.preferences.title')}
        description={t('sections.preferences.text')}
      />
      <div className="flex flex-col gap-5">
        <Panel
          id="language"
          title={t('preferences.language.title')}
          description={t('preferences.language.text')}
        >
          <ChoiceCards
            legend={t('preferences.language.title')}
            value={locale}
            onChange={(next) => void changeLocale(next)}
            disabled={savingLocale}
            choices={UI_LOCALES.map((code) => ({
              value: code,
              label: LOCALE_NAMES[code],
              description: t(`preferences.language.${code}`),
              visual: <LanguageSample sample={t(`preferences.language.sample.${code}`)} />,
            }))}
          />
        </Panel>
        <Panel
          id="theme"
          title={t('preferences.theme.title')}
          description={t('preferences.theme.text')}
          aside={
            <span className="flex items-center gap-2 text-sm text-fg-muted">
              {themeIcons[preference]}
              {t(`preferences.theme.${preference}.label`)}
            </span>
          }
        >
          <ChoiceCards
            legend={t('preferences.theme.title')}
            value={preference}
            onChange={setPreference}
            choices={[
              {
                value: 'system',
                label: t('preferences.theme.system.label'),
                description: t('preferences.theme.system.text'),
                visual: <SystemSwatch />,
              },
              {
                value: 'light',
                label: t('preferences.theme.light.label'),
                description: t('preferences.theme.light.text'),
                visual: <ThemeSwatch theme="light" />,
              },
              {
                value: 'dark',
                label: t('preferences.theme.dark.label'),
                description: t('preferences.theme.dark.text'),
                visual: <ThemeSwatch theme="dark" />,
              },
            ]}
          />
        </Panel>
        <DictationPreferences />
      </div>
    </>
  );
}
