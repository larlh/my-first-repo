import type { AssetKind } from '@parlante/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, PageHeader } from '@/ui';
import { AssetPicker } from './picker';
import type { PickedMedia } from './picker';

interface Slot {
  id: string;
  label: string;
  kinds?: readonly AssetKind[];
  includeStock?: boolean;
}

/* Development-only playground of the reusable picker (`/dev/asset-picker`), in the spirit of
 * `/dev/ui`: shows the slots other features are expected to open and the `MediaRef` each one
 * gets back. Labels are plain identifiers on purpose — this page never ships. */
const SLOTS: Slot[] = [
  { id: 'image', label: 'kinds={["image"]}', kinds: ['image'] },
  { id: 'video', label: 'kinds={["video"]}', kinds: ['video'] },
  { id: 'audio', label: 'kinds={["audio"]}', kinds: ['audio'] },
  {
    id: 'visual',
    label: 'kinds={["image", "video"]} includeStock={false}',
    kinds: ['image', 'video'],
    includeStock: false,
  },
  { id: 'any', label: '(default)' },
];

export default function PickerDemoPage() {
  const { t } = useTranslation('assets');
  const [open, setOpen] = useState<Slot | null>(null);
  const [picked, setPicked] = useState<Record<string, PickedMedia>>({});
  return (
    <>
      <PageHeader
        eyebrow="src/features/assets/picker.ts"
        title={t('picker.title')}
        description="<AssetPicker open onOpenChange onSelect kinds? includeStock? stockCategory? value? />"
      />
      <ul className="flex flex-col gap-3">
        {SLOTS.map((slot) => (
          <li
            key={slot.id}
            className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center"
          >
            <code className="min-w-0 flex-1 font-mono text-xs break-all">{slot.label}</code>
            <code
              data-testid={`picked-${slot.id}`}
              className="min-w-0 flex-1 font-mono text-xs break-all text-fg-muted"
            >
              {picked[slot.id] ? JSON.stringify(picked[slot.id]?.ref) : '—'}
            </code>
            <Button onClick={() => setOpen(slot)}>{t('picker.title')}</Button>
          </li>
        ))}
      </ul>
      <AssetPicker
        open={open !== null}
        onOpenChange={(next) => !next && setOpen(null)}
        kinds={open?.kinds}
        includeStock={open?.includeStock}
        value={open ? (picked[open.id]?.ref ?? null) : null}
        onSelect={(media) => open && setPicked((current) => ({ ...current, [open.id]: media }))}
      />
    </>
  );
}
