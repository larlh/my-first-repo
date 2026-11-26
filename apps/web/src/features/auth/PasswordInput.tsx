import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton, Input } from '@/ui';
import type { InputProps } from '@/ui';

/** Password field with a show / hide toggle (the toggle keeps the caret and the value). */
export function PasswordInput(props: Omit<InputProps, 'type' | 'trailing'>) {
  const { t } = useTranslation('auth');
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      type={visible ? 'text' : 'password'}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      trailing={
        <IconButton
          size="sm"
          noTooltip
          label={visible ? t('password.hide') : t('password.show')}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </IconButton>
      }
    />
  );
}
