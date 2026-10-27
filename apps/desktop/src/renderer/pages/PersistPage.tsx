import { useI18n } from '../i18n/I18nProvider';

export function PersistPage() {
  const { t } = useI18n();
  return <h1>{t('nav.persist')}</h1>;
}
