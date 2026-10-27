import type { MonitorAlert, MonitorAlertEvent } from '@rockzalct/shared';
import { useI18n } from '../../i18n/I18nProvider';
import { alertMessage, formatTime } from './format';

export function AlertPanel({
  alerts,
  events,
  onClear,
  onExportAlerts,
}: {
  alerts: readonly MonitorAlert[];
  events: readonly MonitorAlertEvent[];
  onClear(): void;
  onExportAlerts(): void;
}) {
  const { t, lang } = useI18n();
  // Newest first.
  const rows = [...events].reverse();
  return (
    <div className="card" data-testid="alert-panel">
      <h2>{t('monitor.alerts')}</h2>
      {alerts.length === 0 ? (
        <p className="muted" data-testid="alerts-none">
          {t('monitor.alerts.none')}
        </p>
      ) : (
        <ul className="mon-alerts" data-testid="alerts-active">
          {alerts.map((a) => (
            <li key={a.key} className={a.severity} data-testid={`alert-${a.key}`}>
              <strong className={`mon-sev-${a.severity}`}>{t(`monitor.severity.${a.severity}`)}</strong>{' '}
              {alertMessage(t, a)}
            </li>
          ))}
        </ul>
      )}

      <h3>{t('monitor.history')}</h3>
      {rows.length === 0 ? (
        <p className="muted" data-testid="history-none">
          {t('monitor.history.none')}
        </p>
      ) : (
        <div className="mon-history">
          <table data-testid="history-table">
            <thead>
              <tr>
                <th>{t('monitor.history.col.time')}</th>
                <th>{t('monitor.history.col.event')}</th>
                <th>{t('monitor.history.col.severity')}</th>
                <th>{t('monitor.history.col.message')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.at}-${e.alert.key}-${e.type}-${i}`} data-testid="history-row">
                  <td>{formatTime(e.at, lang)}</td>
                  <td>{t(`monitor.event.${e.type}`)}</td>
                  <td>{t(`monitor.severity.${e.alert.severity}`)}</td>
                  <td>{alertMessage(t, e.alert)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button type="button" onClick={onExportAlerts} disabled={rows.length === 0}>
          {t('monitor.export.alerts')}
        </button>
        <button type="button" onClick={onClear} disabled={rows.length === 0}>
          {t('monitor.history.clear')}
        </button>
      </div>
    </div>
  );
}
