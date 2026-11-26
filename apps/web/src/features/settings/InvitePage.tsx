import { CircleAlert, MailCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApiMutation, useApiQuery } from '@/lib/api';
import { useSessionState } from '@/lib/session';
import { AuthShell, PATHS, loginPathFor } from '@/shell';
import { Avatar, Badge, Button, Skeleton, VoiceBars, useErrorText } from '@/ui';
import { Callout } from './components/Callout';

/**
 * Landing page of an invitation link (`/invite/<token>`; the API builds it and the inviter
 * shares it by hand). Signed-in visitors accept with one click; anonymous visitors are sent to
 * sign up (the token travels along and the account joins the workspace) or to sign in.
 */
export default function InvitePage() {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const { token = '' } = useParams();
  const session = useSessionState();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const [failure, setFailure] = useState<string | null>(null);

  const invite = useApiQuery(
    api.members.lookupInvite,
    { params: { token } },
    { enabled: token.length >= 10, retry: false },
  );
  const accept = useApiMutation(api.members.acceptInvite, {
    onSuccess: (info) => {
      session.setSession(info);
      navigate(PATHS.home);
    },
    onError: (error) =>
      setFailure(
        error.is('PLAN_LIMIT_EXCEEDED')
          ? t('invite.full')
          : error.is('INVALID_STATE', 'NOT_FOUND')
            ? t('invite.gone')
            : errorText(error).title,
      ),
  });

  const here = `/invite/${token}`;
  const data = invite.data;
  const unusable = data ? data.expired || data.accepted : false;
  const signedIn = session.status === 'authenticated';
  const otherAccount =
    signedIn && data && session.user ? session.user.email !== data.email.toLowerCase() : false;

  const invalid = token.length < 10 || invite.isError;
  const loading = !invalid && (invite.isPending || session.status === 'loading');

  return (
    <AuthShell
      title={
        invalid
          ? t('invite.invalidTitle')
          : loading || !data
            ? t('invite.loading')
            : t('invite.title', { workspace: data.workspaceName })
      }
      description={invalid ? t('invite.invalidText') : loading ? undefined : t('invite.text')}
    >
      <div className="flex flex-col gap-5">
        {invalid ? (
          <Button asChild className="self-start">
            <Link to={PATHS.home}>{t('invite.home')}</Link>
          </Button>
        ) : loading ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            <VoiceBars label={t('invite.loading')} />
            <Skeleton className="h-20 rounded-lg" />
            <Skeleton className="h-12 rounded-md" />
          </div>
        ) : (
          data && (
            <>
              <div className="flex items-center gap-3.5 rounded-lg border border-line bg-surface p-4">
                <Avatar name={data.workspaceName} shape="rounded" size="lg" decorative />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{data.workspaceName}</p>
                  <p className="truncate text-sm text-fg-muted">{data.email}</p>
                </div>
                <Badge className="ml-auto" tone="saffron">
                  {tShell(`roles.${data.role}`)}
                </Badge>
              </div>

              {unusable ? (
                <>
                  <Callout tone="warning" icon={<CircleAlert />} role="alert">
                    {data.accepted ? t('invite.accepted') : t('invite.expired')}
                  </Callout>
                  <Button asChild className="self-start">
                    <Link to={PATHS.home}>{t('invite.home')}</Link>
                  </Button>
                </>
              ) : signedIn ? (
                <div className="flex flex-col gap-3">
                  {otherAccount && (
                    <Callout tone="warning" icon={<CircleAlert />}>
                      {t('invite.otherAccount', {
                        current: session.user?.email ?? '',
                        invited: data.email,
                      })}
                    </Callout>
                  )}
                  {failure && (
                    <Callout tone="danger" role="alert">
                      {failure}
                    </Callout>
                  )}
                  <Button
                    variant="primary"
                    size="lg"
                    block
                    leftIcon={<MailCheck aria-hidden="true" />}
                    loading={accept.isPending}
                    onClick={() => {
                      setFailure(null);
                      accept.mutate({ body: { token } });
                    }}
                  >
                    {t('invite.accept')}
                  </Button>
                  <p className="text-center text-sm text-fg-muted">
                    {t('invite.roleNote', { role: tShell(`roles.${data.role}`) })}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <Button asChild variant="primary" size="lg" block>
                    <Link to={`${PATHS.register}?invite=${encodeURIComponent(token)}`}>
                      {t('invite.register')}
                    </Link>
                  </Button>
                  <Button asChild size="lg" block>
                    <Link to={loginPathFor(here)}>{t('invite.login')}</Link>
                  </Button>
                  <p className="text-center text-sm text-fg-muted">{t('invite.anonymousNote')}</p>
                </div>
              )}
            </>
          )
        )}
      </div>
    </AuthShell>
  );
}
