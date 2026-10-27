import type { TaurusSyncState } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';

export function SyncCard({
  sync,
  locked,
  busy,
  onApply,
}: {
  sync: TaurusSyncState | null;
  /** Writes need the advanced level. */
  locked: boolean;
  busy: boolean;
  onApply(mode: 'synchronous' | 'asynchronous', fallbackToInternal: boolean): void;
}) {
  const { t } = useI18n();
  return (
    <div className="card" data-testid="taurus-sync">
      <h2>{t('taurus.sync.title')}</h2>
      {sync && (
        <p data-testid="taurus-sync-mode">
          {t('taurus.sync.current')}: {t(`taurus.sync.mode.${sync.mode}`)}
          {sync.fallbackToInternal ? ` (${t('taurus.sync.fallback')})` : ''}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={locked || busy} onClick={() => onApply('synchronous', false)}>
          {t('taurus.sync.sync')}
        </button>
        <button type="button" disabled={locked || busy} onClick={() => onApply('synchronous', true)}>
          {t('taurus.sync.syncFallback')}
        </button>
        <button type="button" disabled={locked || busy} onClick={() => onApply('asynchronous', false)}>
          {t('taurus.sync.async')}
        </button>
      </div>
    </div>
  );
}
