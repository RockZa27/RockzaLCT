import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';

export function Toasts() {
  const { t } = useI18n();
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={'toast ' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span>{toast.kind === 'error' && toast.code ? t(`error.${toast.code}`) : toast.text}</span>
          <button type="button" aria-label={t('toast.close')} onClick={() => dismissToast(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
