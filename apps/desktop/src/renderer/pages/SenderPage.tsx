import { useI18n } from '../i18n/I18nProvider';

export function SenderPage() {
  const { t } = useI18n();
  return <h1>{t('nav.sender')}</h1>;
}
