import { Send } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JobStatus } from '@/components/JobStatus';
import { ProviderBadge } from '@/components/ProviderBadge';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useJobPolling } from '@/lib/jobs';
import { useSession } from '@/lib/session';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  toast,
} from '@/ui';

/** Strings come from the feature namespace (`example`); shell strings from `shell`. */
export default function ExamplePage() {
  const { t } = useTranslation('example');
  const { t: tShell } = useTranslation('shell');
  const format = useFormat();
  const session = useSession();

  // Typed query: the response type comes from the zod schema of the route.
  const capabilities = useApiQuery(api.system.capabilities);

  // Typed mutation + polling of the job it creates.
  const [jobId, setJobId] = useState<string | null>(null);
  const ping = useApiMutation(api.system.pingWorker, {
    onSuccess: (job) => setJobId(job.jobId),
    onError: () => toast.error(t('ping.failed')),
  });
  const job = useJobPolling(
    api.system.workerPingStatus,
    { params: { jobId: jobId ?? '' } },
    {
      enabled: jobId !== null,
      select: (data) => ({ status: data.state, progress: data.state === 'active' ? 50 : 0 }),
      onSettled: (data, phase) => {
        if (phase === 'completed') {
          toast.success(t('ping.done'), {
            description: t('ping.echo', { echo: data.result?.echo ?? '' }),
          });
        } else toast.error(t('ping.failed'));
      },
    },
  );

  const providers = capabilities.data ? Object.entries(capabilities.data.active) : [];

  return (
    <>
      <PageHeader
        eyebrow="src/features/_example"
        title={t('title')}
        description={t('description')}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('session.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-fg-muted">{t('session.user')}</dt>
              <dd className="truncate font-medium">{session.user.name}</dd>
              <dt className="text-fg-muted">{t('session.workspace')}</dt>
              <dd className="truncate font-medium">{session.workspace.name}</dd>
              <dt className="text-fg-muted">{t('session.role')}</dt>
              <dd className="font-medium">{tShell(`roles.${session.role}`)}</dd>
              <dt className="text-fg-muted">{t('session.plan')}</dt>
              <dd className="font-medium">{session.plan.name}</dd>
              <dt className="text-fg-muted">{t('session.credits')}</dt>
              <dd className="nums font-medium">{format.number(session.credits)}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('ping.title')}</CardTitle>
              <CardDescription>{t('ping.text')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Button
              variant="primary"
              className="self-start"
              leftIcon={<Send aria-hidden="true" />}
              loading={ping.isPending || job.isActive}
              disabled={!session.can('admin')}
              onClick={() => ping.mutate({ body: { echo: 'hola' } })}
            >
              {t('ping.action')}
            </Button>
            {jobId !== null && (
              <JobStatus
                label={t('ping.label')}
                status={job.phase}
                progress={job.progress}
                etaSec={job.etaSec}
                etaEstimated={job.etaEstimated}
              />
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>{t('capabilities.title')}</CardTitle>
              <CardDescription>{t('capabilities.text')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {/* Every view handles its three states: loading, error and empty. */}
            {capabilities.isPending ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : capabilities.isError ? (
              <ErrorState
                size="sm"
                error={capabilities.error}
                onRetry={() => void capabilities.refetch()}
                retrying={capabilities.isRefetching}
              />
            ) : providers.length === 0 ? (
              <EmptyState size="sm" title={t('capabilities.empty')} />
            ) : (
              <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                {providers.map(([capability, provider]) => (
                  <li
                    key={capability}
                    className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0"
                  >
                    <code className="font-mono text-sm">{capability}</code>
                    <ProviderBadge provider={provider} size="sm" />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
