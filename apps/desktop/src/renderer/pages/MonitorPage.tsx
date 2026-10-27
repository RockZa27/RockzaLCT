import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MONITOR_POLL_INTERVALS_S,
  alertEventsToCsv,
  cardHealth,
  evaluateSnapshot,
  readingsToCsv,
  type CardHealth,
  type MonitorCardReading,
  type MonitorCardRef,
  type MonitorPollInterval,
  type MonitorSnapshotOptions,
} from '@rockzalct/shared';
import { decodeError } from '../../common/ipcError';
import { useI18n } from '../i18n/I18nProvider';
import { useApp } from '../state/AppContext';
import { AlertPanel } from './monitor/AlertPanel';
import { CardDetail } from './monitor/CardDetail';
import { CardGrid } from './monitor/CardGrid';
import { SenderPanel } from './monitor/SenderPanel';
import { SettingsPanel } from './monitor/SettingsPanel';
import { downloadText } from './monitor/download';
import { fileStamp, formatTime } from './monitor/format';
import { MONITOR_CSS } from './monitor/monitorStyles';
import { loadSettings, saveSettings, type MonitorSettings } from './monitor/settings';
import { clearEvents, getSession, ingest } from './monitor/store';

const isHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;

/**
 * NovaLCT "Monitoring". Read-only, so available at every user level. Polls readMonitorSnapshot on
 * the chosen interval while a controller is connected and the window is visible; history, alert
 * events and the last snapshot are kept in memory (see monitor/store.ts), thresholds and options in
 * localStorage.
 */
export function MonitorPage() {
  const { t, lang } = useI18n();
  const { api, connectedId, info, pushInfo } = useApp();

  const [settings, setSettingsState] = useState<MonitorSettings>(loadSettings);
  const [session, setSession] = useState(() => getSession(connectedId));
  const [selected, setSelected] = useState<MonitorCardRef | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [halted, setHalted] = useState(false);
  const [hidden, setHidden] = useState(isHidden);

  // Latest values for the polling callbacks, which must not be re-created on every render.
  const latest = useRef({ connectedId, info, settings, t });
  latest.current = { connectedId, info, settings, t };
  const inFlight = useRef(false);

  const updateSettings = useCallback((next: MonitorSettings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    const { connectedId: id, info: current, settings: s } = latest.current;
    if (!id || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const options: MonitorSnapshotOptions = {};
      if (current) options.cards = current.receivingCards.map((c) => ({ portIndex: c.portIndex, cardIndex: c.cardIndex }));
      if (s.includeBitErrorRate) options.includeBitErrorRate = true;
      if (s.functionCardAddress !== null) options.functionCardAddress = s.functionCardAddress;
      const snapshot = await api.readMonitorSnapshot(id, options);
      if (latest.current.connectedId !== id) return; // disconnected / switched meanwhile
      if (snapshot) {
        setSession(ingest(id, snapshot, latest.current.settings.thresholds));
        setErrorMessage(null);
      }
    } catch (e) {
      if (latest.current.connectedId !== id) return;
      const err = decodeError(e);
      setErrorMessage(latest.current.t('monitor.error', { message: latest.current.t(`error.${err.code}`) }));
      // The connection is gone: stop polling until the user asks again.
      if (err.code === 'NOT_CONNECTED' || err.code === 'NOT_FOUND') setHalted(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [api]);

  // Page visibility: no polling while the window is hidden or minimised.
  useEffect(() => {
    const onChange = (): void => setHidden(isHidden());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // A different controller (or none): load its remembered history and start clean.
  useEffect(() => {
    setSession(getSession(connectedId));
    setSelected(null);
    setErrorMessage(null);
    setHalted(false);
  }, [connectedId]);

  const active = connectedId !== null && !hidden && !halted;

  // Read once as soon as polling becomes possible (page opened, window shown again, ...).
  useEffect(() => {
    if (active) void poll();
  }, [active, poll]);

  // Then repeat on the interval, scheduling the next run only after the previous one finished.
  const intervalS = settings.intervalS;
  useEffect(() => {
    if (!active || intervalS === 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      await poll();
      if (!stopped) timer = setTimeout(() => void loop(), intervalS * 1000);
    };
    timer = setTimeout(() => void loop(), intervalS * 1000);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, intervalS, poll]);

  const last = session.history.length ? session.history[session.history.length - 1]! : undefined;
  // Evaluated on every render so a threshold change shows immediately.
  const alerts = useMemo(() => (last ? evaluateSnapshot(last, settings.thresholds) : []), [last, settings.thresholds]);
  const healthOf = useCallback((c: MonitorCardReading): CardHealth => cardHealth(c, alerts), [alerts]);

  const counts = useMemo(() => {
    const c = { online: 0, offline: 0, warning: 0, critical: 0 };
    for (const card of last?.cards ?? []) {
      if (card.state === 'offline') c.offline += 1;
      else if (card.state === 'online') c.online += 1;
      const h = cardHealth(card, alerts);
      if (h === 'warning') c.warning += 1;
      if (h === 'critical') c.critical += 1;
    }
    return c;
  }, [last, alerts]);

  const selectedCard =
    last?.cards.find((c) => selected && c.portIndex === selected.portIndex && c.cardIndex === selected.cardIndex) ??
    (selected === null ? (last?.cards[0] ?? null) : null);

  const manualRefresh = (): void => {
    setHalted(false);
    void poll();
  };

  const exportReadings = (): void => {
    if (session.history.length === 0) return;
    downloadText(`rockzalct-readings-${fileStamp(Date.now())}.csv`, readingsToCsv(session.history));
  };
  const exportAlerts = (): void => {
    downloadText(`rockzalct-alerts-${fileStamp(Date.now())}.csv`, alertEventsToCsv(session.events));
  };

  const disabled = connectedId === null;
  let pollingNote: string;
  if (intervalS === 0) pollingNote = t('monitor.polling.off');
  else if (hidden) pollingNote = t('monitor.polling.hidden');
  else pollingNote = t('monitor.polling.on', { seconds: intervalS });

  return (
    <section className="mon">
      <style>{MONITOR_CSS}</style>
      <h1>{t('monitor.title')}</h1>
      {disabled && <p className="muted">{t('monitor.needConnect')}</p>}
      <p className="muted">{t('monitor.readOnly')}</p>

      <div className="mon-toolbar">
        <label className="field">
          {t('monitor.interval')}
          <select
            value={intervalS}
            disabled={disabled}
            aria-label={t('monitor.interval')}
            onChange={(e) => updateSettings({ ...settings, intervalS: Number(e.target.value) as MonitorPollInterval })}
          >
            {MONITOR_POLL_INTERVALS_S.map((s) => (
              <option key={s} value={s}>
                {t(`monitor.interval.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary" disabled={disabled || busy} onClick={manualRefresh}>
          {t('monitor.refresh')}
        </button>
        <button type="button" disabled={disabled || session.history.length === 0} onClick={exportReadings}>
          {t('monitor.export.readings')}
        </button>
      </div>
      <p className="muted" data-testid="polling-note">
        {disabled ? '' : pollingNote}
      </p>
      {errorMessage && (
        <p className="field-error" role="alert" data-testid="monitor-error">
          {errorMessage}
        </p>
      )}

      {!disabled && !last && <p className="muted">{t('monitor.noData')}</p>}

      {!disabled && last && (
        <>
          <p className="muted" data-testid="last-update">
            {t('monitor.lastUpdate', { time: formatTime(last.takenAt, lang), requests: last.requestCount })}
          </p>
          <div className="mon-summary" data-testid="summary" aria-label={t('monitor.summary')}>
            <span className="mon-chip" data-testid="count-online">
              {t('monitor.summary.online')}: {counts.online}
            </span>
            <span className="mon-chip" data-testid="count-offline">
              {t('monitor.summary.offline')}: {counts.offline}
            </span>
            <span className="mon-chip" data-testid="count-warning">
              {t('monitor.summary.warning')}: {counts.warning}
            </span>
            <span className="mon-chip" data-testid="count-critical">
              {t('monitor.summary.critical')}: {counts.critical}
            </span>
          </div>

          <div className="mon-layout">
            <div>
              <div className="card">
                <h2>{t('monitor.grid')}</h2>
                <CardGrid cards={last.cards} healthOf={healthOf} selected={selectedCard} onSelect={setSelected} />
              </div>
              <SenderPanel sender={last.sender} functionCard={last.functionCard} />
              <AlertPanel
                alerts={alerts}
                events={session.events}
                onExportAlerts={exportAlerts}
                onClear={() => {
                  if (connectedId) setSession(clearEvents(connectedId));
                }}
              />
            </div>
            <div>
              <CardDetail card={selectedCard} history={session.history} />
            </div>
          </div>
        </>
      )}

      <SettingsPanel settings={settings} onChange={updateSettings} onSaved={() => pushInfo(t('monitor.settings.saved'))} />
      <p className="muted">{t('monitor.rawNote')}</p>
    </section>
  );
}
