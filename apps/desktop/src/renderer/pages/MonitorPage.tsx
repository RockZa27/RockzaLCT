import { useI18n } from '../i18n/I18nProvider';

export function MonitorPage() {
  const { t } = useI18n();
  return <h1>{t('nav.monitor')}</h1>;
}
