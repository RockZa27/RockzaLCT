import { CALIBRATION_UNSUPPORTED } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';

/** What this page deliberately does not do, and the library search terms behind each decision. */
export function UnsupportedSection() {
  const { t } = useI18n();
  return (
    <div className="card" data-testid="cal-unsupported">
      <h2>{t('cal.unsupported.title')}</h2>
      <p className="muted">{t('cal.unsupported.intro')}</p>
      <ul>
        {CALIBRATION_UNSUPPORTED.map((u) => (
          <li key={u.id}>
            {t(`cal.unsupported.${u.id}` as MessageKey)}
            <div className="muted">{t('cal.unsupported.searched', { terms: u.searched.join(', ') })}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
