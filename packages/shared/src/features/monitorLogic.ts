// Pure monitoring logic (PLAN.md phase 7): thresholds, alert evaluation, alert transitions between
// two snapshots, history helpers and CSV export. No runtime deps, no I/O, no clock.
// Readings are decoded to real units (units.ts) before they are compared with the thresholds.

import { humidityPct, temperatureC, voltageV } from './units.js';
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

/** `null` disables a limit. Real units: degrees C and volts (decoded with units.ts). */
export interface MonitorThresholds {
  /** Temperature (C) at/above which a card raises a warning. */
  temperatureWarnC: number | null;
  /** Temperature (C) at/above which a card raises a critical alert. */
  temperatureCriticalC: number | null;
  /** Receiver supply voltage (V) below which a card raises a warning. */
  voltageLowV: number | null;
  /** Receiver supply voltage (V) above which a card raises a warning. */
  voltageHighV: number | null;
}

/** Starting limits (not from NovaStar): 60 C warning / 70 C critical; supply 4.5 V .. 5.5 V. */
export const DEFAULT_MONITOR_THRESHOLDS: MonitorThresholds = {
  temperatureWarnC: 60,
  temperatureCriticalC: 70,
  voltageLowV: 4.5,
  voltageHighV: 5.5,
};

const THRESHOLD_KEYS = ['temperatureWarnC', 'temperatureCriticalC', 'voltageLowV', 'voltageHighV'] as const;

/** The byte-wide registers bound the representable range: +-127.5 C and 0..12.7 V. */
const TEMP_LIMIT_C = 127.5;
const VOLT_LIMIT_V = 12.7;

/** Problems with a thresholds object (empty array = valid). */
export function validateThresholds(t: MonitorThresholds): string[] {
  const errors: string[] = [];
  for (const key of THRESHOLD_KEYS) {
    const v = t[key];
    if (v === null) continue;
    const max = key.startsWith('temperature') ? TEMP_LIMIT_C : VOLT_LIMIT_V;
    const min = key.startsWith('temperature') ? -TEMP_LIMIT_C : 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      errors.push(`${key} must be a number ${min}..${max} or empty`);
    }
  }
  if (t.temperatureWarnC !== null && t.temperatureCriticalC !== null && t.temperatureWarnC > t.temperatureCriticalC) {
    errors.push('temperatureWarnC must not exceed temperatureCriticalC');
  }
  if (t.voltageLowV !== null && t.voltageHighV !== null && t.voltageLowV >= t.voltageHighV) {
    errors.push('voltageLowV must be below voltageHighV');
  }
  return errors;
}

/**
 * Old (raw register unit) thresholds, stored before real units were known. Converted with the
 * documented scales (temperature byte x 0.5 C, voltage byte x 0.1 V), i.e. the limit keeps firing at
 * the same register value. The old shipped defaults (60 / 75 / off / off) were never a user choice
 * and would turn into a meaningless 30 / 37.5 C, so exactly that combination maps to the new defaults.
 */
const LEGACY_KEYS = ['temperatureWarnRaw', 'temperatureCriticalRaw', 'voltageLowRaw', 'voltageHighRaw'] as const;

function migrateLegacy(obj: Record<string, unknown>): MonitorThresholds | null {
  if (!LEGACY_KEYS.some((k) => k in obj) || THRESHOLD_KEYS.some((k) => k in obj)) return null;
  const num = (k: (typeof LEGACY_KEYS)[number]): number | null => {
    const v = obj[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const [tw, tc, vl, vh] = LEGACY_KEYS.map(num) as [number | null, number | null, number | null, number | null];
  if (tw === 60 && tc === 75 && vl === null && vh === null) return { ...DEFAULT_MONITOR_THRESHOLDS };
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    temperatureWarnC: tw === null ? null : tw * 0.5,
    temperatureCriticalC: tc === null ? null : tc * 0.5,
    voltageLowV: vl === null ? null : round1(vl * 0.1),
    voltageHighV: vh === null ? null : round1(vh * 0.1),
  };
}

/** Parse stored JSON (current or legacy raw format); anything invalid falls back to the defaults (never throws). */
export function parseThresholds(json: string | null | undefined): MonitorThresholds {
  if (!json) return { ...DEFAULT_MONITOR_THRESHOLDS };
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_MONITOR_THRESHOLDS };
    const obj = raw as Record<string, unknown>;
    const legacy = migrateLegacy(obj);
    if (legacy) return validateThresholds(legacy).length === 0 ? legacy : { ...DEFAULT_MONITOR_THRESHOLDS };
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
  /** Offending value: degrees C (temperature), volts (voltage) or the detected card count. */
  value?: number;
  /** The limit that was crossed (C / V), or the expected card count. */
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

/** Card temperature in C, or null when the reading is absent / flagged invalid. A missing flags byte means valid, positive. */
export function cardTemperatureC(c: { temperatureRaw?: number; temperatureFlagsRaw?: number }): number | null {
  return c.temperatureRaw === undefined ? null : temperatureC(c.temperatureFlagsRaw ?? 0x80, c.temperatureRaw);
}

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
    const t = cardTemperatureC(c);
    if (t !== null) {
      const crit = thresholds.temperatureCriticalC;
      const warn = thresholds.temperatureWarnC;
      if (crit !== null && t >= crit) {
        alerts.push({ key: `${base}:temperature`, kind: 'temperature-high', severity: 'critical', ...where, value: t, threshold: crit });
      } else if (warn !== null && t >= warn) {
        alerts.push({ key: `${base}:temperature`, kind: 'temperature-high', severity: 'warning', ...where, value: t, threshold: warn });
      }
    }
    const v = c.voltageRaw === undefined ? null : voltageV(c.voltageRaw);
    if (v !== null) {
      if (thresholds.voltageLowV !== null && v < thresholds.voltageLowV) {
        alerts.push({ key: `${base}:voltage`, kind: 'voltage-low', severity: 'warning', ...where, value: v, threshold: thresholds.voltageLowV });
      } else if (thresholds.voltageHighV !== null && v > thresholds.voltageHighV) {
        alerts.push({ key: `${base}:voltage`, kind: 'voltage-high', severity: 'warning', ...where, value: v, threshold: thresholds.voltageHighV });
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

/** Temperature series (degrees C) of one card across snapshots (oldest first). */
export function temperatureSeries(history: readonly MonitorSnapshot[], portIndex: number, cardIndex: number): TrendPoint[] {
  return history.map((s) => {
    const c = s.cards.find((x) => x.portIndex === portIndex && x.cardIndex === cardIndex);
    return { at: s.takenAt, value: c && c.state === 'online' ? cardTemperatureC(c) : null };
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

/** One row per card per snapshot: real units plus the raw bytes they were decoded from. */
export function readingsToCsv(history: readonly MonitorSnapshot[]): string {
  const lines = [
    csvRow([
      'time', 'controller', 'port', 'card', 'state',
      'temperature_c', 'humidity_pct', 'voltage_v',
      'temperature_raw', 'temperature_flags_raw', 'humidity_raw', 'voltage_raw', 'error',
    ]),
  ];
  for (const s of history) {
    for (const c of s.cards) {
      const hum = c.humidityRaw === undefined ? null : humidityPct(c.humidityRaw);
      const volt = c.voltageRaw === undefined ? null : voltageV(c.voltageRaw);
      lines.push(
        csvRow([
          iso(s.takenAt), s.controllerId, c.portIndex, c.cardIndex, c.state,
          cardTemperatureC(c), hum, volt,
          c.temperatureRaw, c.temperatureFlagsRaw, c.humidityRaw, c.voltageRaw, c.error,
        ]),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

/** One row per alert transition. */
export function alertEventsToCsv(events: readonly MonitorAlertEvent[]): string {
  const lines = [csvRow(['time', 'controller', 'event', 'severity', 'kind', 'port', 'card', 'value', 'threshold', 'detail'])];
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
