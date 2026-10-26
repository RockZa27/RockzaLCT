import { useI18n } from '../i18n/I18nProvider';

export function LayoutPage() {
  const { t } = useI18n();
  return <h1>{t('nav.layout')}</h1>;
}
