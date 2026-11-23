import type { Resolution } from '@parlante/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Rocket, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, apiClient, isApiError, useApiMutation } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button, Input, PageHeader, SegmentedControl, Spinner, toast, useErrorText } from '@/ui';
import {
  CreditCost,
  Notice,
  Step,
  TOOL_ROUTES,
  canAfford,
  useAvailableRoutes,
} from '@/features/script-writer/kit';
import { DataStep } from './components/DataStep';
import { MappingTable } from './components/MappingTable';
import { RowsPreview } from './components/RowsPreview';
import { SourceStep } from './components/SourceStep';
import type { BatchSource } from './components/SourceStep';
import {
  allowedResolutions,
  checkBatch,
  mapRows,
  reconcileMapping,
  unusedColumns,
} from './lib/batch';
import type { Mapping } from './lib/batch';
import { CsvError, parseCsv, toCsv } from './lib/csv';
import type { ParsedCsv } from './lib/csv';

const NAME_MAX = 120;

function readCsv(text: string): { parsed: ParsedCsv | null; error: CsvError | null } {
  if (text.trim() === '') return { parsed: null, error: null };
  try {
    return { parsed: parseCsv(text), error: null };
  } catch (err) {
    return { parsed: null, error: err instanceof CsvError ? err : new CsvError('malformed') };
  }
}

/**
 * New personalised batch (master prompt §3.15): a video with `{{variables}}`, a CSV, the
 * mapping of columns to variables, every row checked, the estimated cost and the launch.
 */
export default function NewBatchPage() {
  const { t } = useTranslation('batch');
  const session = useSession();
  const navigate = useNavigate();
  const describe = useErrorText();
  const available = useAvailableRoutes();
  const limits = session.plan.limits;

  const [source, setSource] = useState<BatchSource | null>(null);
  const [text, setText] = useState('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [resolution, setResolution] = useState<Resolution>('720p');
  const [failure, setFailure] = useState<ApiError | null>(null);

  const { parsed, error: csvError } = useMemo(() => readCsv(text), [text]);
  const variables = useMemo(() => source?.variables ?? [], [source]);
  const columns = useMemo(() => parsed?.columns ?? [], [parsed]);

  // Keep the mapping in step with the video and the CSV (keeps the person's own choices).
  useEffect(() => {
    setMapping((current) => reconcileMapping(current, variables, columns));
  }, [variables, columns]);
  useEffect(() => {
    if (!nameTouched && source) {
      setName(t('new.defaultName', { title: source.title }).slice(0, NAME_MAX));
    }
  }, [source, nameTouched, t]);

  const onSource = useCallback((next: BatchSource | null) => {
    setSource(next);
    setFailure(null);
  }, []);

  const rows = useMemo(
    () => (parsed ? mapRows(parsed.rows, mapping, variables) : []),
    [parsed, mapping, variables],
  );
  const check = useMemo(
    () =>
      checkBatch({
        variables,
        mapping,
        rows: parsed?.rows ?? [],
        maxRows: limits.maxBatchRows,
      }),
    [variables, mapping, parsed, limits.maxBatchRows],
  );
  const ignored = parsed ? unusedColumns(parsed.columns, mapping) : [];
  const mappedVariables = useMemo(
    () => variables.filter((variable) => mapping[variable.name]).map((variable) => variable.name),
    [variables, mapping],
  );

  // The server works out the cost from the rows exactly as they will be sent.
  const canEstimate = source !== null && check.ok && mappedVariables.length > 0;
  const csvForServer = useMemo(
    () => (canEstimate ? toCsv(mappedVariables, rows) : ''),
    [canEstimate, mappedVariables, rows],
  );
  const estimate = useQuery({
    queryKey: ['batch-preview', source?.videoId, resolution, csvForServer],
    queryFn: ({ signal }) =>
      apiClient.batches.preview(
        { body: { sourceVideoId: source?.videoId ?? '', csv: csvForServer, resolution } },
        { signal },
      ),
    enabled: canEstimate,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const cost = canEstimate && estimate.data ? estimate.data.estimatedCredits : null;

  const create = useApiMutation(api.batches.create, {
    invalidates: [api.batches.list, api.videos.list],
    onSuccess: (job) => {
      toast.success(t('new.launched', { count: job.total }));
      void navigate(TOOL_ROUTES.batchJob(job.id));
    },
    onError: (error) => setFailure(error),
  });

  const resolutions = allowedResolutions(limits.maxResolution);
  const ready =
    canEstimate && name.trim() !== '' && cost !== null && canAfford(cost, session.credits);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!source || !ready) return;
    setFailure(null);
    create.mutate({
      body: { name: name.trim(), sourceVideoId: source.videoId, rows, resolution },
    });
  };

  const failureText = failure ? describe(failure) : null;
  const failureLimit =
    failure && isApiError(failure) && failure.code === 'PLAN_LIMIT_EXCEEDED'
      ? (failure.details as { limit?: string } | undefined)?.limit
      : undefined;
  const estimateError = estimate.error ? describe(estimate.error) : null;

  return (
    <>
      <PageHeader
        back={{ to: TOOL_ROUTES.batch, label: t('list.title') }}
        eyebrow={t('new.eyebrow')}
        title={t('new.title')}
        description={t('new.description')}
      />

      <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-5">
        <Step number="01" title={t('new.source.title')} description={t('new.source.text')}>
          <SourceStep source={source} onChange={onSource} />
        </Step>

        <Step number="02" title={t('new.data.title')} description={t('new.data.text')}>
          <DataStep
            text={text}
            onText={setText}
            parsed={parsed}
            error={csvError}
            variables={variables}
          />
        </Step>

        <Step number="03" title={t('new.mapping.title')} description={t('new.mapping.text')}>
          {!source || variables.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('new.mapping.needSource')}</p>
          ) : !parsed ? (
            <p className="text-sm text-fg-muted">{t('new.mapping.needData')}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              <MappingTable
                variables={variables}
                columns={columns}
                mapping={mapping}
                onChange={setMapping}
                sample={parsed.rows[0]}
              />
              {check.unmapped.length > 0 && (
                <Notice tone="danger" role="alert" icon={<TriangleAlert />}>
                  {t('new.mapping.unmapped', {
                    count: check.unmapped.length,
                    names: check.unmapped.map((item) => `{{${item}}}`).join(', '),
                  })}
                </Notice>
              )}
              {ignored.length > 0 && (
                <p className="text-sm text-fg-muted">
                  {t('new.mapping.ignored', { count: ignored.length, names: ignored.join(', ') })}
                </p>
              )}
            </div>
          )}
        </Step>

        <Step
          number="04"
          title={t('new.rows.title')}
          description={t('new.rows.text')}
          aside={
            parsed ? (
              <span className="nums font-mono text-xs text-fg-muted">
                {t('new.rows.count', { rows: parsed.rows.length, max: limits.maxBatchRows })}
              </span>
            ) : undefined
          }
        >
          {!source || !parsed || variables.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('new.rows.empty')}</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {check.overLimit && (
                <Notice tone="danger" role="alert" icon={<TriangleAlert />}>
                  {t('new.rows.overLimit', { rows: parsed.rows.length, max: limits.maxBatchRows })}
                </Notice>
              )}
              {check.badRows.length > 0 && (
                <Notice tone="danger" role="alert" icon={<TriangleAlert />}>
                  {t('new.rows.bad', {
                    count: check.badRows.length,
                    rows: check.badRows
                      .slice(0, 8)
                      .map((index) => index + 1)
                      .join(', '),
                  })}
                </Notice>
              )}
              <RowsPreview
                variables={variables}
                rows={rows}
                issues={check.issues}
                maxRows={limits.maxBatchRows}
                composition={source.composition}
              />
            </div>
          )}
        </Step>

        <Step number="05" title={t('new.launch.title')} description={t('new.launch.text')}>
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Input
                label={t('new.launch.name')}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
                maxLength={NAME_MAX}
                required
              />
              <div>
                <p aria-hidden="true" className="mb-1.5 text-sm font-semibold">
                  {t('new.launch.resolution')}
                </p>
                <SegmentedControl<Resolution>
                  aria-label={t('new.launch.resolution')}
                  value={resolution}
                  onValueChange={setResolution}
                  options={(['720p', '1080p'] as const).map((value) => ({
                    value,
                    label: value,
                    disabled: !resolutions.includes(value),
                  }))}
                />
              </div>
            </div>
            {!resolutions.includes('1080p') && (
              <p className="text-sm text-fg-muted">{t('new.launch.resolutionLimit')}</p>
            )}

            <CreditCost
              cost={cost}
              estimated
              pending={
                canEstimate && estimate.isFetching ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner size="sm" label={null} />
                    {t('new.launch.estimating')}
                  </span>
                ) : (
                  t('new.launch.costPending')
                )
              }
              detail={t('new.launch.costDetail')}
            />
            {estimateError && canEstimate && (
              <Notice
                tone="danger"
                role="alert"
                icon={<TriangleAlert />}
                title={estimateError.title}
              >
                {estimateError.message}
              </Notice>
            )}

            {failureText && failure && (
              <Notice
                tone="danger"
                role="alert"
                icon={<TriangleAlert />}
                title={t('new.failed')}
                action={
                  failure.code === 'INSUFFICIENT_CREDITS' && available.billing ? (
                    <Button asChild size="sm" variant="secondary">
                      <Link to={TOOL_ROUTES.billing}>{t('new.buy')}</Link>
                    </Button>
                  ) : undefined
                }
              >
                {failure.code === 'CONTENT_BLOCKED'
                  ? t('new.errors.blocked')
                  : failureLimit === 'maxVideoDurationSec'
                    ? t('new.errors.tooLong')
                    : failureLimit === 'maxScenesPerVideo'
                      ? t('new.errors.tooManyScenes')
                      : failureText.message || failureText.title}
              </Notice>
            )}

            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={create.isPending}
                disabled={!ready}
                leftIcon={<Rocket aria-hidden="true" />}
              >
                {parsed && check.ok
                  ? t('new.launch.submit', { count: parsed.rows.length })
                  : t('new.launch.submitNone')}
              </Button>
              <Button asChild variant="ghost">
                <Link to={TOOL_ROUTES.batch}>{t('common.cancel')}</Link>
              </Button>
            </div>
          </div>
        </Step>
      </form>
    </>
  );
}
