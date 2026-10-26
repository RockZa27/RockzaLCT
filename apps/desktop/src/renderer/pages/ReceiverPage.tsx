import { useI18n } from '../i18n/I18nProvider';

export function ReceiverPage() {
  const { t } = useI18n();
  return <h1>{t('nav.receiver')}</h1>;
}
