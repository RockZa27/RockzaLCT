import type { HardwareOverrideKey, HardwareOverrides } from '@rockzalct/shared';
import type { MessageKey } from '../../i18n/dictionary';

export type OverrideKind = 'byte' | 'bit' | 'xy';
export type OverrideGroup = 'display' | 'save' | 'calibration' | 'layout';

export interface OverrideMeta {
  key: HardwareOverrideKey;
  kind: OverrideKind;
  group: OverrideGroup;
  /** Step number(s) of docs/hardware-test-checklist.md that test this value; null = no step covers it. */
  steps: string | null;
}

/** Display order. Steps cite docs/hardware-test-checklist.md (7 = blackout/freeze, 10 = read layout, 12 = save, 13 = write layout). */
export const OVERRIDE_META: readonly OverrideMeta[] = [
  { key: 'killOn', kind: 'byte', group: 'display', steps: '7 (7a)' },
  { key: 'killOff', kind: 'byte', group: 'display', steps: '7 (7a)' },
  { key: 'lockOn', kind: 'byte', group: 'display', steps: '7 (7b)' },
  { key: 'lockOff', kind: 'byte', group: 'display', steps: '7 (7b)' },
  { key: 'saveSender', kind: 'byte', group: 'save', steps: '12' },
  { key: 'saveReceiver', kind: 'byte', group: 'save', steps: '12' },
  { key: 'eraseSpiFlash', kind: 'byte', group: 'calibration', steps: null },
  { key: 'correctionEnabledBit', kind: 'bit', group: 'calibration', steps: null },
  { key: 'correctionBrightnessTypeBit', kind: 'bit', group: 'calibration', steps: null },
  { key: 'scannerXyOrder', kind: 'xy', group: 'layout', steps: '10, 13' },
];

export const GROUP_ORDER: readonly OverrideGroup[] = ['display', 'save', 'calibration', 'layout'];

export const BIT_CHOICES = [1, 2, 4, 8, 16, 32, 64, 128] as const;

export const labelKey = (key: HardwareOverrideKey): MessageKey => `adv.key.${key}.label` as MessageKey;
export const descKey = (key: HardwareOverrideKey): MessageKey => `adv.key.${key}.desc` as MessageKey;
export const groupKey = (group: OverrideGroup): MessageKey => `adv.group.${group}` as MessageKey;

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

/** Human text of one value, e.g. `1 (0x01)`, `bit 1 (0x02)`, `X in the high 16 bits (default)`. */
export function formatValue(meta: OverrideMeta, value: HardwareOverrides[HardwareOverrideKey], t: Translate): string {
  if (meta.kind === 'xy') return t(`adv.xy.${String(value)}` as MessageKey);
  const n = Number(value);
  if (meta.kind === 'bit' && Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0) {
    return t('adv.bit', { n: Math.log2(n), hex: hex(n) });
  }
  return Number.isInteger(n) && n >= 0 && n <= 255 ? `${n} (0x${hex(n)})` : String(value);
}
