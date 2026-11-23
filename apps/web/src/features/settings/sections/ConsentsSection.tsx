import type { ConsentKind, ConsentRecord } from '@parlante/shared';
import { Camera, Mic, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useApiInfiniteQuery, useApiMutation } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadMore,
  SegmentedControl,
  Skeleton,
  cn,
  toast,
  useErrorText,
} from '@/ui';
import { Callout } from '../components/Callout';
import { LockedSection } from '../components/RoleGate';
import { SectionHeader } from '../components/SectionHeader';

type KindFilter = 'all' | ConsentKind;

const KIND_ICON = { photo_avatar: Camera, voice_clone: Mic } as const;

/** What a revocation removes, spelled out before confirming (mirrors the API contract). */
function RevokeEffects({ kind }: { kind: ConsentKind }) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <p className="font-semibold">{t('consents.revoke.deletes')}</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-fg-muted">
          <li>{t(`consents.revoke.${kind}.resource`)}</li>
          <li>{t(`consents.revoke.${kind}.files`)}</li>
          <li>{t(`consents.revoke.${kind}.source`)}</li>
          {kind === 'voice_clone' && <li>{t('consents.revoke.voice_clone.external')}</li>}
        </ul>
      </div>
      <div>
        <p className="font-semibold">{t('consents.revoke.keeps')}</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-fg-muted">
          <li>{t('consents.revoke.keepRecord')}</li>
          <li>{t('consents.revoke.keepVideos')}</li>
        </ul>
      </div>
      <p className="text-fg-muted">{t('consents.revoke.after')}</p>
    </div>
  );
}

function ConsentCard({ record }: { record: ConsentRecord }) {
  const { t } = useTranslation('settings');
  const format = useFormat();
  const errorText = useErrorText();
  const [confirming, setConfirming] = useState(false);
  const Icon = KIND_ICON[record.kind];
  const revoked = record.revokedAt !== null;
  const revoke = useApiMutation(api.consents.revoke, {
    invalidates: [api.consents.list],
    onSuccess: () => toast.success(t('consents.revoke.done', { name: record.subjectName })),
    onError: (error) => toast.error(errorText(error).title, { description: error.message }),
  });

  return (
    <li className="rounded-lg border border-line bg-surface shadow-xs">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
        <span
          aria-hidden="true"
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-md',
            revoked ? 'bg-surface-3 text-fg-subtle' : 'bg-info-soft text-info-text',
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h3 className={cn('text-base', revoked && 'text-fg-muted')}>{record.subjectName}</h3>
            <Badge tone="neutral" variant="outline">
              {t(`consents.kind.${record.kind}`)}
            </Badge>
            {revoked ? (
              <Badge tone="danger">
                {t('consents.status.revoked', { date: format.date(record.revokedAt ?? '') })}
              </Badge>
            ) : record.resourceId ? (
              <Badge tone="success" dot>
                {t('consents.status.used')}
              </Badge>
            ) : (
              <Badge tone="warning" dot>
                {t('consents.status.unused')}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-fg-muted">
            {t(`consents.relationship.${record.relationship}`)}
            {' · '}
            {record.user
              ? t('consents.recordedBy', {
                  name: record.user.name,
                  date: format.dateTime(record.createdAt),
                })
              : t('consents.recordedOn', { date: format.dateTime(record.createdAt) })}
          </p>
          {record.resourceId && !revoked && (
            <p className="mt-1 text-sm text-fg-muted">
              {t(`consents.resource.${record.kind}`)}{' '}
              <code className="font-mono text-xs text-fg">{record.resourceId}</code>
            </p>
          )}
          <details className="mt-3">
            <summary className="inline-flex cursor-pointer rounded-xs text-sm font-medium text-accent-text underline-offset-4 hover:underline">
              {t('consents.statement', { version: record.statementVersion })}
            </summary>
            <blockquote className="mt-2 border-l-2 border-line-strong pl-3.5 text-sm text-pretty text-fg-muted">
              {record.statement}
            </blockquote>
          </details>
        </div>
        {!revoked && (
          <Button
            size="sm"
            className="shrink-0 self-start"
            loading={revoke.isPending}
            onClick={() => setConfirming(true)}
          >
            {t('consents.revoke.action')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="danger"
        title={t('consents.revoke.title', { name: record.subjectName })}
        description={t('consents.revoke.text')}
        confirmLabel={t('consents.revoke.confirm')}
        onConfirm={() =>
          revoke.mutateAsync({ params: { consentId: record.id } }).then(() => undefined)
        }
      >
        <RevokeEffects kind={record.kind} />
      </ConfirmDialog>
    </li>
  );
}

function Consents() {
  const { t } = useTranslation('settings');
  const [kind, setKind] = useState<KindFilter>('all');
  const consents = useApiInfiniteQuery(api.consents.list, {
    query: { limit: 20, ...(kind === 'all' ? {} : { kind }) },
  });

  return (
    <>
      <SectionHeader
        title={t('sections.consents.title')}
        description={t('sections.consents.text')}
      />
      <div className="flex flex-col gap-5">
        <Callout tone="info" icon={<ShieldCheck />} title={t('consents.about.title')}>
          {t('consents.about.text')}
        </Callout>

        <SegmentedControl
          aria-label={t('consents.filter.label')}
          value={kind}
          onValueChange={setKind}
          className="self-start"
          options={[
            { value: 'all', label: t('consents.filter.all') },
            { value: 'photo_avatar', label: t('consents.kind.photo_avatar') },
            { value: 'voice_clone', label: t('consents.kind.voice_clone') },
          ]}
        />

        {consents.isPending ? (
          <div className="flex flex-col gap-4" aria-hidden="true">
            <Skeleton className="h-28 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
          </div>
        ) : consents.isError ? (
          <div className="rounded-lg border border-line bg-surface">
            <ErrorState
              size="sm"
              error={consents.error}
              onRetry={() => void consents.refetch()}
              retrying={consents.isRefetching}
            />
          </div>
        ) : consents.items.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState
              icon={<ShieldCheck />}
              title={kind === 'all' ? t('consents.empty.title') : t('consents.empty.filtered')}
              description={t('consents.empty.text')}
            />
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-4" aria-label={t('consents.list')}>
              {consents.items.map((record) => (
                <ConsentCard key={record.id} record={record} />
              ))}
            </ul>
            <LoadMore
              hasMore={consents.hasNextPage}
              loading={consents.isFetchingNextPage}
              onLoadMore={() => void consents.fetchNextPage()}
            />
          </>
        )}
      </div>
    </>
  );
}

export default function ConsentsSection() {
  const { t } = useTranslation('settings');
  const session = useSession();
  if (!session.can('admin')) {
    return (
      <>
        <SectionHeader
          title={t('sections.consents.title')}
          description={t('sections.consents.text')}
        />
        <LockedSection min="admin" what={t('consents.locked')} />
      </>
    );
  }
  return <Consents />;
}
