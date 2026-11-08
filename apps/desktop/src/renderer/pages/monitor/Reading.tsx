import { useI18n } from '../../i18n/I18nProvider';
import type { Shown } from './format';

/** Decoded value with the raw register bytes kept visible as secondary text (and as a tooltip). */
export function Reading({ shown, empty }: { shown: Shown; empty?: string }) {
  const { t } = useI18n();
  const text = shown.text ?? empty ?? (shown.raw === null ? '-' : t('monitor.detail.invalid'));
  return (
    <span title={shown.raw === null ? undefined : t('monitor.rawTitle', { raw: shown.raw })}>
      {text}
      {shown.raw !== null && <span className="muted"> ({t('monitor.rawShort', { raw: shown.raw })})</span>}
    </span>
  );
}
