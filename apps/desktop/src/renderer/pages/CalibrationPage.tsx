import { useI18n } from '../i18n/I18nProvider';

export function CalibrationPage() {
  const { t } = useI18n();
  return <h1>{t('nav.calibration')}</h1>;
}
