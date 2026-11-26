import type { Role } from '@parlante/shared';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/lib/session';
import { EmptyState } from '@/ui';
import { Callout } from './Callout';

/**
 * A whole section reserved to a role. Instead of hiding it, the section explains what it is
 * for, which role it needs and what the caller's role is.
 */
export function LockedSection({ min, what }: { min: Role; what: ReactNode }) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  return (
    <div className="rounded-lg border border-line bg-surface">
      <EmptyState
        icon={<Lock />}
        title={t(`locked.title.${min}`)}
        description={
          <>
            {what}{' '}
            {t('locked.yourRole', {
              role: tShell(`roles.${session.role}`),
              workspace: session.workspace.name,
            })}
          </>
        }
      />
    </div>
  );
}

/**
 * Inline note for a section that is visible but whose actions need a higher role: says who can
 * do it and what the caller's role is. Renders nothing when the caller has the role.
 */
export function RoleNote({ min, children }: { min: Role; children: ReactNode }) {
  const { t } = useTranslation('settings');
  const { t: tShell } = useTranslation('shell');
  const session = useSession();
  if (session.can(min)) return null;
  return (
    <Callout icon={<Lock />} className="mb-5">
      {children} {t('locked.yourRoleShort', { role: tShell(`roles.${session.role}`) })}
    </Callout>
  );
}
