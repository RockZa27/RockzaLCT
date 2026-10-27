import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

/** Modal yes/no dialog. Nothing happens until the user presses the confirm button; the default focus is "go back". */
export function ConfirmDialog({
  title,
  children,
  onConfirm,
  onCancel,
  confirmDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onConfirm(): void;
  onCancel(): void;
  confirmDisabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
        <div className="row end">
          <button type="button" autoFocus onClick={onCancel}>
            {t('cal.confirm.cancel')}
          </button>
          <button type="button" className="primary" disabled={confirmDisabled} onClick={onConfirm}>
            {t('cal.confirm.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
