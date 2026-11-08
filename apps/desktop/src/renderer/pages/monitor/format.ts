import { fanRpm, humidityPct, smokeAlarm, temperatureC, voltageV, type MonitorAlert } from '@rockzalct/shared';
import type { I18n } from '../../i18n/I18nProvider';

/** Localised one-line description of an alert (ports and cards are shown 1-based, like the other pages). */
export function alertMessage(t: I18n['t'], a: MonitorAlert): string {
  const unit = a.kind === 'temperature-high' ? ' °C' : a.kind === 'voltage-low' || a.kind === 'voltage-high' ? ' V' : '';
  const fmt = (n: number | undefined): string => (n === undefined ? '-' : unit ? `${n.toFixed(1)}${unit}` : String(n));
  return t(`monitor.alert.${a.kind}`, {
    port: (a.portIndex ?? 0) + 1,
    card: (a.cardIndex ?? 0) + 1,
    value: fmt(a.value),
    limit: fmt(a.threshold),
  });
}

/** A decoded reading as display text plus the raw bytes it came from (null text = invalid / absent). */
export interface Shown {
  text: string | null;
  raw: string | null;
}

const hex = (b: number): string => `0x${(b & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;

export const showTemp = (flags: number | undefined, mag: number | undefined): Shown => {
  if (mag === undefined) return { text: null, raw: null };
  const f = flags ?? 0x80;
  const c = temperatureC(f, mag);
  return { text: c === null ? null : `${c.toFixed(1)} °C`, raw: `${hex(f)} ${hex(mag)}` };
};
export const showHumidity = (b: number | undefined): Shown => {
  if (b === undefined) return { text: null, raw: null };
  const h = humidityPct(b);
  return { text: h === null ? null : `${h} %RH`, raw: hex(b) };
};
export const showVoltage = (b: number | undefined): Shown => {
  if (b === undefined) return { text: null, raw: null };
  const v = voltageV(b);
  return { text: v === null ? null : `${v.toFixed(1)} V`, raw: hex(b) };
};
export const showFan = (b: number): Shown => {
  const r = fanRpm(b);
  return { text: r === null ? null : `${r} rpm`, raw: hex(b) };
};
export const showSmoke = (b: number | undefined): { alarm: boolean | null; raw: string | null } =>
  b === undefined ? { alarm: null, raw: null } : { alarm: smokeAlarm(b), raw: hex(b) };

/** Display text for a list of decoded bytes (invalid entries as '-'), and the raw bytes joined. */
export const showList = (values: readonly number[] | undefined, one: (b: number) => Shown): Shown => {
  if (!values || values.length === 0) return { text: null, raw: null };
  const items = values.map(one);
  return { text: items.map((i) => i.text ?? '-').join(' · '), raw: items.map((i) => i.raw).join(' ') };
};

/** Local date and time for history rows. */
export function formatTime(ms: number, lang: string): string {
  return new Date(ms).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { hour12: false });
}

export const bytes = (values: readonly number[] | undefined): string => (values && values.length ? values.join(' ') : '-');

export const fileStamp = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-');
