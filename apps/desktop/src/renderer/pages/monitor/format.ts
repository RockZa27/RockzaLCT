import type { MonitorAlert } from '@rockzalct/shared';
import type { I18n } from '../../i18n/I18nProvider';

/** Localised one-line description of an alert (ports and cards are shown 1-based, like the other pages). */
export function alertMessage(t: I18n['t'], a: MonitorAlert): string {
  return t(`monitor.alert.${a.kind}`, {
    port: (a.portIndex ?? 0) + 1,
    card: (a.cardIndex ?? 0) + 1,
    value: a.value ?? '-',
    limit: a.threshold ?? '-',
  });
}

/** Local date and time for history rows. */
export function formatTime(ms: number, lang: string): string {
  return new Date(ms).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB', { hour12: false });
}

export const bytes = (values: readonly number[] | undefined): string => (values && values.length ? values.join(' ') : '-');

export const fileStamp = (ms: number): string => new Date(ms).toISOString().replace(/[:.]/g, '-');
