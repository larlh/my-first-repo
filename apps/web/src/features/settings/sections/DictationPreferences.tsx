import { LANGUAGES, languageName } from '@parlante/shared';
import type { LanguageCode } from '@parlante/shared';
import { Globe, HardDrive, Mic, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderName } from '@/components/ProviderBadge';
import { dictation, useDictationState } from '@/lib/dictation';
import type { EnginePreference } from '@/lib/dictation';
import { useDictationErrorText } from '@/lib/dictation/text';
import { useFormat } from '@/lib/format';
import { LOCALE_NAMES, currentLocale } from '@/lib/i18n';
import { Badge, BrowserDictationNotice, Button, Select, Switch, toast } from '@/ui';
import { Callout } from '../components/Callout';
import { ChoiceCards } from '../components/ChoiceCards';
import { Panel } from '../components/SectionHeader';

type SpokenLanguage = 'ui' | LanguageCode;

function EngineGlyph({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="booth-grid flex h-14 items-center justify-center rounded-md border border-line bg-surface-2 text-fg-muted [&_svg]:size-6"
    >
      {children}
    </span>
  );
}

/**
 * Dictation preferences: engine (automatic, local, browser), default language of the speech
 * and whether the microphone buttons are shown. Says, for each engine, what leaves the machine.
 * The browser engine can only be selected by accepting its notice here (or from a field).
 */
export function DictationPreferences() {
  const { t } = useTranslation('settings');
  const state = useDictationState();
  const providerName = useProviderName();
  const errorText = useDictationErrorText();
  const format = useFormat();
  const [notice, setNotice] = useState(false);
  const [checking, setChecking] = useState(false);
  if (!state.ready) return null;

  const { preferences, capabilities, browserSupported } = state;
  const local = capabilities?.local ?? null;
  const locale = currentLocale();

  const chooseEngine = (engine: EnginePreference) => {
    if (engine === preferences.engine) return;
    if (engine === 'browser' && preferences.browserConsentAt === null) {
      // Not selected until the notice is accepted.
      setNotice(true);
      return;
    }
    dictation.setPreferences({ engine });
    toast.success(t('preferences.dictation.saved'));
  };

  const recheck = async () => {
    setChecking(true);
    try {
      await dictation.refreshCapabilities();
    } finally {
      setChecking(false);
    }
  };

  const localNote =
    local === null ? (
      <Badge variant="outline" size="sm">
        {t('preferences.dictation.engine.localChecking')}
      </Badge>
    ) : local.available ? (
      <Badge tone="success" size="sm" dot>
        {local.provider
          ? `${t('preferences.dictation.engine.localReady')} · ${providerName(local.provider)}`
          : t('preferences.dictation.engine.localReady')}
      </Badge>
    ) : (
      <Badge tone="warning" size="sm" dot>
        {t('preferences.dictation.engine.localMissing')}
      </Badge>
    );

  const languageOptions: { value: SpokenLanguage; label: string }[] = [
    {
      value: 'ui',
      label: t('preferences.dictation.language.ui', { language: LOCALE_NAMES[locale] }),
    },
    ...LANGUAGES.map((language) => ({
      value: language.code,
      label: languageName(language.code, locale),
    })),
  ];

  return (
    <Panel
      id="dictation"
      title={t('preferences.dictation.title')}
      description={t('preferences.dictation.text')}
      aside={<Mic aria-hidden="true" className="size-4 text-fg-muted" />}
    >
      <div className="flex flex-col gap-6" data-dictation-preferences="">
        <ChoiceCards<EnginePreference>
          legend={t('preferences.dictation.engine.legend')}
          value={preferences.engine}
          onChange={chooseEngine}
          choices={[
            {
              value: 'auto',
              label: t('preferences.dictation.engine.auto.label'),
              description: t('preferences.dictation.engine.auto.text'),
              visual: (
                <EngineGlyph>
                  <Sparkles />
                </EngineGlyph>
              ),
            },
            {
              value: 'local',
              label: t('preferences.dictation.engine.local.label'),
              description: t('preferences.dictation.engine.local.text'),
              note: localNote,
              visual: (
                <EngineGlyph>
                  <HardDrive />
                </EngineGlyph>
              ),
            },
            {
              value: 'browser',
              label: t('preferences.dictation.engine.browser.label'),
              description: t('preferences.dictation.engine.browser.text'),
              disabled: !browserSupported && preferences.engine !== 'browser',
              note: !browserSupported ? (
                <Badge variant="outline" size="sm">
                  {t('preferences.dictation.engine.browserMissing')}
                </Badge>
              ) : preferences.browserConsentAt !== null ? (
                <Badge tone="info" size="sm">
                  {t('preferences.dictation.engine.browserAccepted')}
                </Badge>
              ) : (
                <Badge tone="warning" size="sm">
                  {t('preferences.dictation.engine.browserNeedsNotice')}
                </Badge>
              ),
              visual: (
                <EngineGlyph>
                  <Globe />
                </EngineGlyph>
              ),
            },
          ]}
        />

        {local !== null && !local.available && (
          <Callout
            tone="warning"
            role="status"
            title={t('preferences.dictation.localProblem')}
            action={
              <Button
                size="sm"
                variant="secondary"
                loading={checking}
                leftIcon={<RefreshCw aria-hidden="true" />}
                onClick={() => void recheck()}
              >
                {t('preferences.dictation.recheck')}
              </Button>
            }
          >
            {errorText({ code: 'engine_unavailable', reasonCode: local.reasonCode ?? 'unknown' })}
          </Callout>
        )}

        <section aria-labelledby="dictation-leaves-title">
          <h3 id="dictation-leaves-title" className="text-sm font-semibold">
            {t('preferences.dictation.leaves.title')}
          </h3>
          <dl className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface-2 p-3.5">
              <dt className="flex items-center gap-2 text-sm font-semibold">
                <HardDrive aria-hidden="true" className="size-4 text-fg-muted" />
                {t('preferences.dictation.leaves.local')}
              </dt>
              <dd className="mt-1.5 text-sm text-fg-muted">
                {t('preferences.dictation.leaves.localText')}
              </dd>
            </div>
            <div className="rounded-lg border border-line bg-surface-2 p-3.5">
              <dt className="flex items-center gap-2 text-sm font-semibold">
                <Globe aria-hidden="true" className="size-4 text-fg-muted" />
                {t('preferences.dictation.leaves.browser')}
              </dt>
              <dd className="mt-1.5 text-sm text-fg-muted">
                {t('preferences.dictation.leaves.browserText')}
              </dd>
            </div>
          </dl>
        </section>

        <Select<SpokenLanguage>
          label={t('preferences.dictation.language.label')}
          hint={t('preferences.dictation.language.hint')}
          value={preferences.language}
          onValueChange={(language) => {
            dictation.setPreferences({ language });
            toast.success(t('preferences.dictation.saved'));
          }}
          options={languageOptions}
          wrapperClassName="max-w-md"
        />

        <Switch
          checked={preferences.showButtons}
          onCheckedChange={(showButtons) => {
            dictation.setPreferences({ showButtons });
            toast.success(t('preferences.dictation.saved'));
          }}
          label={t('preferences.dictation.show.label')}
          description={t('preferences.dictation.show.text')}
        />

        {preferences.browserConsentAt !== null && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            {t('preferences.dictation.consent.given', {
              date: format.dateTime(preferences.browserConsentAt),
            })}
            <Button
              variant="link"
              onClick={() => {
                dictation.setPreferences({
                  browserConsentAt: null,
                  engine: preferences.engine === 'browser' ? 'auto' : preferences.engine,
                });
                toast.success(t('preferences.dictation.consent.withdrawn'));
              }}
            >
              {t('preferences.dictation.consent.withdraw')}
            </Button>
          </p>
        )}
      </div>

      <BrowserDictationNotice
        open={notice}
        onCancel={() => setNotice(false)}
        onAccept={() => {
          setNotice(false);
          dictation.acceptBrowserEngine(null);
          toast.success(t('preferences.dictation.saved'));
        }}
      />
    </Panel>
  );
}
