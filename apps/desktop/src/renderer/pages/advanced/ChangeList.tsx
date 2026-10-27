import type { HardwareOverrideKey, HardwareOverrides } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { OVERRIDE_META, formatValue, labelKey } from './meta';

export interface Change {
  key: HardwareOverrideKey;
  from: HardwareOverrides[HardwareOverrideKey];
  to: HardwareOverrides[HardwareOverrideKey];
}

/** "label: old -> new" for every value that changes; shown in the confirmation dialogs. */
export function ChangeList({ changes, testId }: { changes: readonly Change[]; testId: string }) {
  const { t } = useI18n();
  return (
    <ul data-testid={testId}>
      {changes.map((c) => {
        const meta = OVERRIDE_META.find((m) => m.key === c.key)!;
        return (
          <li key={c.key}>
            {t('adv.change', {
              label: t(labelKey(c.key)),
              from: formatValue(meta, c.from, t),
              to: formatValue(meta, c.to, t),
            })}
          </li>
        );
      })}
    </ul>
  );
}
