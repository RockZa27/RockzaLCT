import {
  DEFAULT_MONITOR_THRESHOLDS,
  MONITOR_POLL_INTERVALS_S,
  parseThresholds,
  type MonitorPollInterval,
  type MonitorThresholds,
} from '@rockzalct/shared';

const KEY = 'rockzalct.monitor.settings';

export interface MonitorSettings {
  intervalS: MonitorPollInterval;
  thresholds: MonitorThresholds;
  includeBitErrorRate: boolean;
  /** Bus address of a multi-function card; null = do not read one. */
  functionCardAddress: number | null;
}

export const DEFAULT_SETTINGS: MonitorSettings = {
  intervalS: 10,
  thresholds: DEFAULT_MONITOR_THRESHOLDS,
  includeBitErrorRate: false,
  functionCardAddress: null,
};

const isInterval = (v: unknown): v is MonitorPollInterval =>
  typeof v === 'number' && (MONITOR_POLL_INTERVALS_S as readonly number[]).includes(v);

/** Read the saved settings; any problem (no storage, bad JSON, bad values) yields defaults per field. */
export function loadSettings(): MonitorSettings {
  try {
    const text = localStorage.getItem(KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
    const o = raw as Record<string, unknown>;
    const fa = o.functionCardAddress;
    return {
      intervalS: isInterval(o.intervalS) ? o.intervalS : DEFAULT_SETTINGS.intervalS,
      thresholds: parseThresholds(JSON.stringify(o.thresholds ?? null)),
      includeBitErrorRate: o.includeBitErrorRate === true,
      functionCardAddress: typeof fa === 'number' && Number.isInteger(fa) && fa >= 0 && fa <= 255 ? fa : null,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: MonitorSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable: the settings simply do not persist */
  }
}
