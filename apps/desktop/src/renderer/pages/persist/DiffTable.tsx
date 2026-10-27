import type { ConfigDiffItem } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';

/** Table of what applying a file would change: where, which value, controller now -> file. */
export function DiffTable({ items }: { items: readonly ConfigDiffItem[] }) {
  const { t } = useI18n();
  const where = (i: ConfigDiffItem): string => {
    if (i.portIndex !== undefined && i.cardIndex !== undefined) {
      return t('persist.target.card', { port: i.portIndex + 1, card: i.cardIndex + 1 });
    }
    if (i.portIndex !== undefined) return t('persist.target.port', { port: i.portIndex + 1 });
    return t('persist.target.screen');
  };
  const value = (v: string | null): string => (v === null ? t('persist.diff.unknown') : v);
  return (
    <table data-testid="diff-table">
      <thead>
        <tr>
          <th>{t('persist.diff.section')}</th>
          <th>{t('persist.diff.target')}</th>
          <th>{t('persist.diff.field')}</th>
          <th>{t('persist.diff.current')}</th>
          <th>{t('persist.diff.file')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((i, n) => (
          <tr key={n}>
            <td>{t(`persist.section.${i.section}` as MessageKey)}</td>
            <td>{where(i)}</td>
            <td>{t(`persist.field.${i.field}` as MessageKey)}</td>
            <td>{value(i.from)}</td>
            <td>{value(i.to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
