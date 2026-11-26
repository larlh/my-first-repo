import { ArrowUpRight, BookOpen, Braces } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui';
import { apiBaseUrl, apiDocsUrl, openApiUrl } from '../lib/urls';
import { Panel } from './SectionHeader';

/** Where the public API is documented: the OpenAPI pages served by the API itself. */
export function ApiDocsPanel() {
  const { t } = useTranslation('settings');
  return (
    <Panel
      id="api-docs"
      title={t('docs.title')}
      description={t('docs.text')}
      aside={
        <>
          <Button
            asChild
            variant="solid"
            leftIcon={<BookOpen aria-hidden="true" />}
            rightIcon={<ArrowUpRight aria-hidden="true" />}
          >
            <a href={apiDocsUrl()} target="_blank" rel="noreferrer">
              {t('docs.open')}
            </a>
          </Button>
          <Button
            asChild
            leftIcon={<Braces aria-hidden="true" />}
            rightIcon={<ArrowUpRight aria-hidden="true" />}
          >
            <a href={openApiUrl()} target="_blank" rel="noreferrer">
              {t('docs.spec')}
            </a>
          </Button>
        </>
      }
    >
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-fg-muted">{t('docs.baseUrl')}</dt>
          <dd className="mt-0.5 font-mono text-xs break-all">{apiBaseUrl()}/v1</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-muted">{t('docs.auth')}</dt>
          <dd className="mt-0.5 font-mono text-xs break-all">Authorization: Bearer plk_…</dd>
        </div>
      </dl>
    </Panel>
  );
}
