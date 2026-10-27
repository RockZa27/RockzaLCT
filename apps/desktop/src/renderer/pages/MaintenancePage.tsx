import { useI18n } from '../i18n/I18nProvider';

export function MaintenancePage() {
  const { t } = useI18n();
  return <h1>{t('nav.maintenance')}</h1>;
}
