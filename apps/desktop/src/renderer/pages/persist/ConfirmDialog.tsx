import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

/** Modal yes/no dialog. Nothing happens until the user presses the confirm button. */
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
  /** Keeps the confirm button off until something else (a tick box) is done. */
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
            {t('persist.confirm.cancel')}
          </button>
          <button type="button" className="primary" disabled={confirmDisabled} onClick={onConfirm}>
            {t('persist.confirm.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
