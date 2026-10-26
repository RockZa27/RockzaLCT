import type { LayoutIssue } from '@rockzalct/shared';
import type { I18n } from '../../i18n/I18nProvider';

/** Distinct colours for the port chains (readable on the dark panel). */
export const PORT_COLORS = [
  '#4f9cff',
  '#ff9f43',
  '#3ecf8e',
  '#ff6b9d',
  '#b388ff',
  '#ffd54f',
  '#26c6da',
  '#ef5350',
  '#9ccc65',
  '#8d6e63',
  '#f06292',
  '#7986cb',
] as const;

export const portColor = (port: number): string => PORT_COLORS[((port % PORT_COLORS.length) + PORT_COLORS.length) % PORT_COLORS.length]!;

/** Localised one-line text for a validation issue (ports and cabinets are shown 1-based). */
export function issueText(t: I18n['t'], issue: LayoutIssue): string {
  return t(`layout.issue.${issue.code}`, {
    port: (issue.port ?? 0) + 1,
    row: (issue.cabinet?.row ?? 0) + 1,
    col: (issue.cabinet?.col ?? 0) + 1,
    row2: (issue.other?.row ?? 0) + 1,
    col2: (issue.other?.col ?? 0) + 1,
    pixels: issue.params?.pixels ?? 0,
    capacity: issue.params?.capacity ?? 0,
    count: issue.params?.count ?? 0,
    max: issue.params?.max ?? 0,
    missing: issue.params?.missing ?? 0,
  });
}

/** Parse a number input; null for empty / non-numeric, otherwise clamped to an integer in [min, max]. */
export function parseIntField(raw: string, min: number, max: number): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}
