import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/dictionary';
import type { TransferProgress } from './useTransfer';

const LABEL: Record<TransferProgress['phase'], MessageKey> = {
  download: 'cal.dl.running',
  backup: 'cal.up.backingUp',
  upload: 'cal.up.uploading',
};

/** Progress of a running transfer with a cancel button. */
export function ProgressBar({ progress, onCancel }: { progress: TransferProgress; onCancel(): void }) {
  const { t } = useI18n();
  return (
    <div data-testid="cal-progress" role="status">
      <p>{t(LABEL[progress.phase], { done: progress.done, total: progress.total })}</p>
      <progress value={progress.done} max={Math.max(1, progress.total)} style={{ width: '100%' }} />
      <div className="row">
        <button type="button" onClick={onCancel}>
          {t('cal.cancel')}
        </button>
      </div>
    </div>
  );
}
