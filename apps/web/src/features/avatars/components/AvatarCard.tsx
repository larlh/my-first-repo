import type { Avatar } from '@parlante/shared';
import { Camera, CircleAlert, Sparkles, Zap } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toAppUrl } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { Badge, ProgressBar, cn } from '@/ui';
import { AvatarStage } from '../kit';
import { avatarOrigin } from '../lib/filters';
import type { AvatarOrigin } from '../lib/filters';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Backdrop of an avatar window: paper tinted with the character's own outfit colour, lit from
 * above like a booth. Falls back to the plain surface when the catalogue gives no colour.
 */
export function backdropStyle(avatar: Pick<Avatar, 'traits'>): CSSProperties {
  const tint = [avatar.traits.outfit, avatar.traits.accent].find(
    (value): value is string => typeof value === 'string' && HEX.test(value),
  );
  if (!tint) return {};
  return {
    backgroundImage: `radial-gradient(120% 85% at 50% 0%, color-mix(in srgb, ${tint} 34%, var(--surface)) 0%, color-mix(in srgb, ${tint} 18%, var(--surface-3)) 72%)`,
  };
}

const ORIGIN_ICON: Record<AvatarOrigin, typeof Zap> = {
  instant: Zap,
  stockPhotoreal: Sparkles,
  photo: Camera,
  generated: Sparkles,
};

/** "Instantáneo 2D" / "Fotorrealista…" pill: says how the avatar is animated. */
export function OriginBadge({
  avatar,
  size = 'sm',
  className,
}: {
  avatar: Pick<Avatar, 'kind' | 'rendering'>;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { t } = useTranslation('avatars');
  const origin = avatarOrigin(avatar);
  const Icon = ORIGIN_ICON[origin];
  return (
    <Badge
      tone={origin === 'instant' ? 'neutral' : 'saffron'}
      variant="solid"
      size={size}
      icon={<Icon aria-hidden="true" />}
      className={className}
    >
      {t(`origin.${origin}`)}
    </Badge>
  );
}

export interface AvatarCardProps {
  avatar: Avatar;
  /** Position in its shelf, shown as a casting number. */
  index: number;
  onOpen: (avatar: Avatar) => void;
}

/**
 * One avatar of the library as a booth window. Instant (2D) avatars are alive: they breathe
 * and blink, and mouth a sample line while hovered or focused — drawn by the same rig as the
 * exported video. Photorealistic ones show their portrait; own avatars in preparation show
 * the progress the API reports.
 */
export function AvatarCard({ avatar, index, onOpen }: AvatarCardProps) {
  const { t, i18n } = useTranslation('avatars');
  const format = useFormat();
  const [engaged, setEngaged] = useState(false);
  const instant = avatar.rendering === 'instant';
  const processing = avatar.status === 'processing';
  const failed = avatar.status === 'failed';
  const traits = [
    avatar.style ? t(`style.${avatar.style}`) : null,
    avatar.ageGroup ? t(`age.${avatar.ageGroup}`) : null,
  ].filter(Boolean);

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => onOpen(avatar)}
        onPointerEnter={() => setEngaged(true)}
        onPointerLeave={() => setEngaged(false)}
        onFocus={() => setEngaged(true)}
        onBlur={() => setEngaged(false)}
        aria-label={t('card.open', { name: avatar.name })}
        className={cn(
          'group relative flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface text-left shadow-xs',
          'transition-[border-color,box-shadow,transform] duration-150 ease-standard hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md',
        )}
      >
        <div
          className="relative aspect-[4/5] w-full overflow-hidden bg-surface-3 text-fg-subtle"
          style={instant ? backdropStyle(avatar) : undefined}
        >
          {instant ? (
            <>
              <span aria-hidden="true" className="absolute inset-0 booth-grid opacity-60" />
              <AvatarStage
                avatar={avatar}
                mode={engaged ? 'demo' : 'idle'}
                demoLocale={i18n.language.startsWith('en') ? 'en' : 'es'}
                label={t('card.live', { name: avatar.name })}
                className="absolute inset-x-0 top-[6%] bottom-0"
              />
            </>
          ) : avatar.thumbnailUrl || avatar.imageUrl ? (
            <img
              src={toAppUrl(avatar.thumbnailUrl ?? avatar.imageUrl)}
              alt={t('card.portrait', { name: avatar.name })}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-standard group-hover:scale-[1.03]"
            />
          ) : (
            <span
              aria-hidden="true"
              className={cn('absolute inset-0 booth-grid', processing && 'shimmer')}
            />
          )}

          <span
            aria-hidden="true"
            className={cn(
              'nums absolute top-2.5 left-3 font-mono text-2xs font-medium tracking-wider',
              instant ? 'text-fg-muted' : 'text-on-media/80',
            )}
          >
            {String(index + 1).padStart(2, '0')}
          </span>
          <OriginBadge avatar={avatar} className="absolute top-2.5 right-2.5" />

          {processing && (
            <div className="absolute inset-x-0 bottom-0 bg-media/85 px-3 py-2.5 text-on-media">
              <ProgressBar
                value={avatar.progress}
                label={t('card.preparing', { name: avatar.name })}
                size="sm"
              />
              <p className="nums mt-1.5 text-xs" role="status">
                {t('card.progress', { percent: Math.round(avatar.progress) })}
                {avatar.etaSec !== null &&
                  ` · ${t('card.eta', { time: format.duration(avatar.etaSec * 1000) })}`}
              </p>
            </div>
          )}
          {failed && (
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-danger px-3 py-2 text-sm font-semibold text-danger-fg">
              <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
              {t('card.failed')}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-0.5 px-3.5 pt-3 pb-3.5">
          <p className="display truncate text-lg leading-tight">{avatar.name}</p>
          <p className="truncate text-xs text-fg-muted">
            {traits.length > 0 ? traits.join(' · ') : t(`gender.${avatar.gender}`)}
          </p>
        </div>
      </button>
    </li>
  );
}
