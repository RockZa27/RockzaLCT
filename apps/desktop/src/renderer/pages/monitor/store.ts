import {
  appendCapped,
  diffAlerts,
  evaluateSnapshot,
  toAlertEvents,
  type MonitorAlert,
  type MonitorAlertEvent,
  type MonitorSnapshot,
  type MonitorThresholds,
} from '@rockzalct/shared';

/** In-memory history limits (oldest entries are dropped first). */
export const SNAPSHOT_HISTORY_CAP = 500;
export const ALERT_EVENT_CAP = 200;

/**
 * What the monitoring page remembers for one controller. It lives at module level (not in React
 * state) so the history survives navigating to another page and back; it is never persisted.
 */
export interface MonitorSession {
  history: readonly MonitorSnapshot[];
  events: readonly MonitorAlertEvent[];
  /** Alerts of the newest ingested snapshot as evaluated then; the base for the next diff. */
  alerts: readonly MonitorAlert[];
}

const EMPTY: MonitorSession = { history: [], events: [], alerts: [] };
const sessions = new Map<string, MonitorSession>();

export const getSession = (id: string | null): MonitorSession => (id ? (sessions.get(id) ?? EMPTY) : EMPTY);

/** Add a snapshot: record it, diff its alerts against the previous snapshot's and log the changes. */
export function ingest(id: string, snapshot: MonitorSnapshot, thresholds: MonitorThresholds): MonitorSession {
  const prev = getSession(id);
  const alerts = evaluateSnapshot(snapshot, thresholds);
  const events = toAlertEvents(diffAlerts(prev.alerts, alerts), snapshot);
  const next: MonitorSession = {
    history: appendCapped(prev.history, [snapshot], SNAPSHOT_HISTORY_CAP),
    events: appendCapped(prev.events, events, ALERT_EVENT_CAP),
    alerts,
  };
  sessions.set(id, next);
  return next;
}

export function clearEvents(id: string): MonitorSession {
  const next = { ...getSession(id), events: [] };
  sessions.set(id, next);
  return next;
}

/** Forget everything (tests). */
export function resetMonitorStore(): void {
  sessions.clear();
}
