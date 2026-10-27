// Pure monitoring logic (PLAN.md phase 7): thresholds, alert evaluation, alert transitions between
// two snapshots, history helpers and CSV export. No runtime deps, no I/O, no clock.
// All values are RAW register bytes (the library defines no scale), thresholds included.

import type {
  MonitorCardReading,
  MonitorPortLinkStatus,
  MonitorSnapshot,
} from './monitorModel.js';

// ---------------------------------------------------------------------------------------------
// Sender port link
// ---------------------------------------------------------------------------------------------

/**
 * Link status of one sender output port from the number of receiving cards the sender counted
 * (`detected`) against the number expected. `expected === null` means unknown: any detected card
 * is "up", none is "idle".
 */
export function portLinkStatus(detected: number, expected: number | null): MonitorPortLinkStatus {
  if (expected === null) return detected > 0 ? 'up' : 'idle';
  if (expected <= 0) return detected > 0 ? 'up' : 'idle';
  if (detected <= 0) return 'down';
  return detected < expected ? 'partial' : 'up';
}

// ---------------------------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------------------------

/** `null` disables a limit. Units are the raw register units (no scale is defined by the library). */
export interface MonitorThresholds {
  /** Raw temperature at/above which a card raises a warning. */
  temperatureWarnRaw: number | null;
  /** Raw temperature at/above which a card raises a critical alert. */
  temperatureCriticalRaw: number | null;
  /** Raw voltage below which a card raises a warning. */
  voltageLowRaw: number | null;
  /** Raw voltage above which a card raises a warning. */
  voltageHighRaw: number | null;
}

/**
 * Starting limits. They are NOT from the library: they assume the raw temperature byte is roughly
 * degrees C (unverified on hardware) and leave voltage unchecked until the user sets limits.
 */
export const DEFAULT_MONITOR_THRESHOLDS: MonitorThresholds = {
  temperatureWarnRaw: 60,
  temperatureCriticalRaw: 75,
  voltageLowRaw: null,
  voltageHighRaw: null,
};

const THRESHOLD_KEYS = ['temperatureWarnRaw', 'temperatureCriticalRaw', 'voltageLowRaw', 'voltageHighRaw'] as const;

/** Problems with a thresholds object (empty array = valid). Every value is a byte (0..255) or null. */
export function validateThresholds(t: MonitorThresholds): string[] {
  const errors: string[] = [];
  for (const key of THRESHOLD_KEYS) {
    const v = t[key];
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      errors.push(`${key} must be an integer 0..255 or empty`);
    }
  }
  if (t.temperatureWarnRaw !== null && t.temperatureCriticalRaw !== null && t.temperatureWarnRaw > t.temperatureCriticalRaw) {
    errors.push('temperatureWarnRaw must not exceed temperatureCriticalRaw');
  }
  if (t.voltageLowRaw !== null && t.voltageHighRaw !== null && t.voltageLowRaw >= t.voltageHighRaw) {
    errors.push('voltageLowRaw must be below voltageHighRaw');
  }
  return errors;
}

/** Parse stored JSON; anything invalid falls back to the defaults (never throws). */
export function parseThresholds(json: string | null | undefined): MonitorThresholds {
  if (!json) return { ...DEFAULT_MONITOR_THRESHOLDS };
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_MONITOR_THRESHOLDS };
    const obj = raw as Record<string, unknown>;
    const out = { ...DEFAULT_MONITOR_THRESHOLDS };
    for (const key of THRESHOLD_KEYS) {
      if (!(key in obj)) continue;
      const v = obj[key];
      if (v === null || (typeof v === 'number' && Number.isFinite(v))) out[key] = v;
    }
    return validateThresholds(out).length === 0 ? out : { ...DEFAULT_MONITOR_THRESHOLDS };
  } catch {
    return { ...DEFAULT_MONITOR_THRESHOLDS };
  }
}

// ---------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------

export type AlertSeverity = 'warning' | 'critical';

export type AlertKind =
  | 'card-offline'
  | 'card-error'
  | 'temperature-high'
  | 'voltage-low'
  | 'voltage-high'
  | 'port-down'
  | 'port-partial'
  | 'sender-error'
  | 'function-card-error';

export interface MonitorAlert {
  /** Stable identity used to match an alert across snapshots, e.g. `card:1:0:temperature`. */
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  portIndex?: number;
  cardIndex?: number;
  /** Offending raw value (temperature / voltage / detected card count). */
  value?: number;
  /** The limit that was crossed (raw), or the expected card count. */
  threshold?: number;
  /** Device error text for offline / error alerts. */
  detail?: string;
  /**
   * True when the card this alert belongs to is offline/in error, so the reading is unknown: the
   * alert is carried over from the last time the card answered, not freshly measured.
   */
  stale?: boolean;
}

/** Alert keys of a card whose reading disappears while the card is offline / in error. */
const isCardReadingAlert = (key: string): boolean => /^card:\d+:\d+:(temperature|voltage)$/.test(key);
const cardStateKeyOf = (key: string): string => key.slice(0, key.lastIndexOf(':')) + ':state';

export const severityRank = (s: AlertSeverity): number => (s === 'critical' ? 2 : 1);

export const cardKey = (portIndex: number, cardIndex: number): string => `card:${portIndex}:${cardIndex}`;

/** Turn one snapshot into the list of alerts that currently apply, sorted by key. */
export function evaluateSnapshot(
  snapshot: MonitorSnapshot,
  thresholds: MonitorThresholds = DEFAULT_MONITOR_THRESHOLDS,
  previous: readonly MonitorAlert[] = [],
): MonitorAlert[] {
  const alerts: MonitorAlert[] = [];

  if (snapshot.sender.error !== undefined) {
    alerts.push({ key: 'sender:error', kind: 'sender-error', severity: 'warning', detail: snapshot.sender.error });
  }
  for (const p of snapshot.sender.portLinks) {
    if (p.status === 'down') {
      alerts.push({
        key: `port:${p.portIndex}:link`,
        kind: 'port-down',
        severity: 'critical',
        portIndex: p.portIndex,
        value: p.detected,
        ...(p.expected !== null ? { threshold: p.expected } : {}),
      });
    } else if (p.status === 'partial') {
      alerts.push({
        key: `port:${p.portIndex}:link`,
        kind: 'port-partial',
        severity: 'warning',
        portIndex: p.portIndex,
        value: p.detected,
        ...(p.expected !== null ? { threshold: p.expected } : {}),
      });
    }
  }

  // An offline / errored card gives no reading, so its earlier temperature / voltage alerts are
  // kept (marked stale) instead of being reported as cleared. A real clear needs the card back
  // online and inside the limits.
  const carryStale = (base: string): void => {
    for (const a of previous) {
      if (isCardReadingAlert(a.key) && a.key.startsWith(`${base}:`)) alerts.push({ ...a, stale: true });
    }
  };
  for (const c of snapshot.cards) {
    const base = cardKey(c.portIndex, c.cardIndex);
    const where = { portIndex: c.portIndex, cardIndex: c.cardIndex };
    if (c.state === 'offline') {
      alerts.push({ key: `${base}:state`, kind: 'card-offline', severity: 'critical', ...where, ...(c.error ? { detail: c.error } : {}) });
      carryStale(base);
      continue;
    }
    if (c.state === 'error') {
      alerts.push({ key: `${base}:state`, kind: 'card-error', severity: 'warning', ...where, ...(c.error ? { detail: c.error } : {}) });
      carryStale(base);
      continue;
    }
    const t = c.temperatureRaw;
    if (t !== undefined) {
      const crit = thresholds.temperatureCriticalRaw;
      const warn = thresholds.temperatureWarnRaw;
      if (crit !== null && t >= crit) {
        alerts.push({ key: `${base}:temperature`, kind: 'temperature-high', severity: 'critical', ...where, value: t, threshold: crit });
      } else if (warn !== null && t >= warn) {
        alerts.push({ key: `${base}:temperature`, kind: 'temperature-high', severity: 'warning', ...where, value: t, threshold: warn });
      }
    }
    const v = c.voltageRaw;
    if (v !== undefined) {
      if (thresholds.voltageLowRaw !== null && v < thresholds.voltageLowRaw) {
        alerts.push({ key: `${base}:voltage`, kind: 'voltage-low', severity: 'warning', ...where, value: v, threshold: thresholds.voltageLowRaw });
      } else if (thresholds.voltageHighRaw !== null && v > thresholds.voltageHighRaw) {
        alerts.push({ key: `${base}:voltage`, kind: 'voltage-high', severity: 'warning', ...where, value: v, threshold: thresholds.voltageHighRaw });
      }
    }
  }

  if (snapshot.functionCard && snapshot.functionCard.state !== 'online') {
    alerts.push({
      key: 'function-card:state',
      kind: 'function-card-error',
      severity: snapshot.functionCard.state === 'offline' ? 'critical' : 'warning',
      ...(snapshot.functionCard.error ? { detail: snapshot.functionCard.error } : {}),
    });
  }

  return alerts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type AlertTransitionType = 'raised' | 'cleared' | 'escalated' | 'relaxed';

export interface AlertTransition {
  type: AlertTransitionType;
  /** The alert after the change (for `cleared`: the alert that went away). */
  alert: MonitorAlert;
  /** For `escalated` / `relaxed`: the alert before. */
  previous?: MonitorAlert;
}

/**
 * Compare the alert lists of two consecutive snapshots: new alerts are `raised`, vanished ones
 * `cleared`, and an alert whose severity changed is `escalated` / `relaxed`. A changed value at the
 * same severity is not a transition. Output is sorted by key (cleared after the others on a tie).
 */
export function diffAlerts(previous: readonly MonitorAlert[], next: readonly MonitorAlert[]): AlertTransition[] {
  const before = new Map(previous.map((a) => [a.key, a]));
  const after = new Map(next.map((a) => [a.key, a]));
  const out: AlertTransition[] = [];
  for (const [key, alert] of after) {
    const old = before.get(key);
    if (!old) out.push({ type: 'raised', alert });
    else if (severityRank(alert.severity) > severityRank(old.severity)) out.push({ type: 'escalated', alert, previous: old });
    else if (severityRank(alert.severity) < severityRank(old.severity)) out.push({ type: 'relaxed', alert, previous: old });
  }
  for (const [key, alert] of before) {
    if (after.has(key)) continue;
    // The card went offline / into error: its reading is unknown, not back in range.
    if (isCardReadingAlert(key) && after.has(cardStateKeyOf(key))) continue;
    out.push({ type: 'cleared', alert });
  }
  return out.sort((a, b) => (a.alert.key < b.alert.key ? -1 : a.alert.key > b.alert.key ? 1 : 0));
}

/** Card health for colouring: offline beats critical beats warning beats ok. */
export type CardHealth = 'ok' | 'warning' | 'critical' | 'offline';

const HEALTH_RANK: Record<CardHealth, number> = { ok: 0, warning: 1, critical: 2, offline: 3 };

export const worstHealth = (a: CardHealth, b: CardHealth): CardHealth => (HEALTH_RANK[a] >= HEALTH_RANK[b] ? a : b);

export function cardHealth(card: MonitorCardReading, alerts: readonly MonitorAlert[]): CardHealth {
  if (card.state === 'offline') return 'offline';
  const prefix = `${cardKey(card.portIndex, card.cardIndex)}:`;
  let health: CardHealth = 'ok';
  for (const a of alerts) {
    if (a.key.startsWith(prefix)) health = worstHealth(health, a.severity);
  }
  return health;
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

/** A recorded alert transition. */
export interface MonitorAlertEvent extends AlertTransition {
  /** Epoch ms of the snapshot that produced the transition. */
  at: number;
  controllerId: string;
}

/** Append `items` and keep only the newest `cap` entries (cap < 1 keeps nothing). */
export function appendCapped<T>(list: readonly T[], items: readonly T[], cap: number): T[] {
  const merged = [...list, ...items];
  if (cap < 1) return [];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** Turn transitions into history events stamped with the snapshot time. */
export function toAlertEvents(transitions: readonly AlertTransition[], snapshot: MonitorSnapshot): MonitorAlertEvent[] {
  return transitions.map((t) => ({ ...t, at: snapshot.takenAt, controllerId: snapshot.controllerId }));
}

export interface TrendPoint {
  at: number;
  /** null when the card was offline / the reading invalid at that time (a gap in the line). */
  value: number | null;
}

/** Temperature series of one card across snapshots (oldest first). */
export function temperatureSeries(history: readonly MonitorSnapshot[], portIndex: number, cardIndex: number): TrendPoint[] {
  return history.map((s) => {
    const c = s.cards.find((x) => x.portIndex === portIndex && x.cardIndex === cardIndex);
    return { at: s.takenAt, value: c && c.state === 'online' && c.temperatureRaw !== undefined ? c.temperatureRaw : null };
  });
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * Quote a CSV cell when needed (comma, quote, CR/LF) and neutralise spreadsheet formulas
 * (cells starting with = + - @ get a leading apostrophe) so exported device text cannot execute.
 */
export function csvCell(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvRow = (cells: ReadonlyArray<string | number | undefined | null>): string => cells.map(csvCell).join(',');

const iso = (ms: number): string => new Date(ms).toISOString();

/** One row per card per snapshot. Values are raw register bytes (no unit conversion). */
export function readingsToCsv(history: readonly MonitorSnapshot[]): string {
  const lines = [
    csvRow(['time', 'controller', 'port', 'card', 'state', 'temperature_raw', 'humidity_raw', 'voltage_raw', 'error']),
  ];
  for (const s of history) {
    for (const c of s.cards) {
      lines.push(
        csvRow([iso(s.takenAt), s.controllerId, c.portIndex, c.cardIndex, c.state, c.temperatureRaw, c.humidityRaw, c.voltageRaw, c.error]),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

/** One row per alert transition. */
export function alertEventsToCsv(events: readonly MonitorAlertEvent[]): string {
  const lines = [csvRow(['time', 'controller', 'event', 'severity', 'kind', 'port', 'card', 'value_raw', 'threshold_raw', 'detail'])];
  for (const e of events) {
    lines.push(
      csvRow([iso(e.at), e.controllerId, e.type, e.alert.severity, e.alert.kind, e.alert.portIndex, e.alert.cardIndex, e.alert.value, e.alert.threshold, e.alert.detail]),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Selectable polling intervals in seconds; 0 = off. */
export const MONITOR_POLL_INTERVALS_S = [0, 5, 10, 30, 60] as const;
export type MonitorPollInterval = (typeof MONITOR_POLL_INTERVALS_S)[number];
