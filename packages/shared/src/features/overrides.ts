// Advanced hardware settings: protocol values that could not be verified against real hardware and
// that the owner can therefore correct at run time (no rebuild). Keep this file free of runtime deps
// (it is bundled into the renderer as well).

/**
 * Where the receiving-card position word keeps X.
 *  - 'x-high': X in the high 16 bits, Y in the low 16 bits (bytes 0-1 = Y, 2-3 = X little-endian).
 *    This is what the library's SetEthernetPortScannerXY writes `(x << 16) + y`, the original behaviour.
 *  - 'x-low': X in the low 16 bits, Y in the high 16 bits.
 */
export type ScannerXyOrder = 'x-high' | 'x-low';

export const SCANNER_XY_ORDERS: readonly ScannerXyOrder[] = ['x-high', 'x-low'];

/** Every value that can be overridden. Flat on purpose: easy to diff, merge, export and show. */
export interface HardwareOverrides {
  /** SetKillMode byte that switches blackout on (receiving-card register 0x02000100). 0..255. */
  killOn: number;
  /** SetKillMode byte that switches blackout off. 0..255. */
  killOff: number;
  /** SetLockMode byte that switches freeze on (register 0x02000102). 0..255. */
  lockOn: number;
  /** SetLockMode byte that switches freeze off. 0..255. */
  lockOff: number;
  /** Byte written to the sending card's save register (SetSaveSendCardsParameters). 0..255. */
  saveSender: number;
  /** Byte written to each receiving card's store-to-flash register (SetParameterStore2SpiFlash). 0..255. */
  saveReceiver: number;
  /** Byte written to the calibration flash-erase register (SetCoefficientInSpiFlashErase). 0..255. */
  eraseSpiFlash: number;
  /** Mask of the "calibration enabled" bit in the correction-state byte. A single bit. */
  correctionEnabledBit: number;
  /** Mask of the "brightness (not chroma) calibration" bit in the correction-state byte. A single bit, different from the enabled bit. */
  correctionBrightnessTypeBit: number;
  /** Word order of the receiving-card X/Y position (read and write). */
  scannerXyOrder: ScannerXyOrder;
}

export type HardwareOverrideKey = keyof HardwareOverrides;

/** The values the program shipped with; also what "reset to defaults" restores. */
export const DEFAULT_HARDWARE_OVERRIDES: Readonly<HardwareOverrides> = Object.freeze({
  killOn: 1,
  killOff: 0,
  lockOn: 1,
  lockOff: 0,
  saveSender: 1,
  saveReceiver: 1,
  eraseSpiFlash: 0,
  correctionEnabledBit: 0x01,
  correctionBrightnessTypeBit: 0x02,
  scannerXyOrder: 'x-high',
});

/** Keys in display order. */
export const HARDWARE_OVERRIDE_KEYS: readonly HardwareOverrideKey[] = Object.freeze([
  'killOn',
  'killOff',
  'lockOn',
  'lockOff',
  'saveSender',
  'saveReceiver',
  'eraseSpiFlash',
  'correctionEnabledBit',
  'correctionBrightnessTypeBit',
  'scannerXyOrder',
] as const);

const BYTE_KEYS: readonly HardwareOverrideKey[] = [
  'killOn',
  'killOff',
  'lockOn',
  'lockOff',
  'saveSender',
  'saveReceiver',
  'eraseSpiFlash',
];
const BIT_KEYS: readonly HardwareOverrideKey[] = ['correctionEnabledBit', 'correctionBrightnessTypeBit'];

const isByte = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255;
const isSingleBit = (v: unknown): v is number => isByte(v) && v !== 0 && (v & (v - 1)) === 0;

/** A fresh copy of the defaults. */
export const defaultHardwareOverrides = (): HardwareOverrides => ({ ...DEFAULT_HARDWARE_OVERRIDES });

/**
 * Check a COMPLETE set of overrides. Returns one message per problem (empty = valid):
 * unknown keys, bytes outside 0..255 or not whole numbers, bit masks that are not a single bit or
 * that are equal, xyOrder outside the enum.
 */
export function validateHardwareOverrides(values: unknown): string[] {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return ['overrides must be an object'];
  const rec = values as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(rec)) {
    if (!(HARDWARE_OVERRIDE_KEYS as readonly string[]).includes(key)) errors.push(`${key}: unknown setting`);
  }
  for (const key of BYTE_KEYS) {
    if (!isByte(rec[key])) errors.push(`${key}: must be a whole number from 0 to 255`);
  }
  for (const key of BIT_KEYS) {
    if (!isSingleBit(rec[key])) errors.push(`${key}: must be a single bit (1, 2, 4, 8, 16, 32, 64 or 128)`);
  }
  if (isSingleBit(rec['correctionEnabledBit']) && rec['correctionEnabledBit'] === rec['correctionBrightnessTypeBit']) {
    errors.push('correctionEnabledBit and correctionBrightnessTypeBit must be different bits');
  }
  if (!(SCANNER_XY_ORDERS as readonly unknown[]).includes(rec['scannerXyOrder'])) {
    errors.push("scannerXyOrder: must be 'x-high' or 'x-low'");
  }
  return errors;
}

/** `base` with the (already known-good or not yet validated) `partial` applied. Does not validate. */
export function mergeHardwareOverrides(
  base: Readonly<HardwareOverrides>,
  partial: Partial<HardwareOverrides> | undefined,
): HardwareOverrides {
  const out: HardwareOverrides = { ...base };
  if (typeof partial !== 'object' || partial === null) return out;
  for (const key of Object.keys(partial)) {
    const v = (partial as Record<string, unknown>)[key];
    // defineProperty so a key such as "__proto__" becomes a plain (unknown) property that validation rejects.
    if (v !== undefined) Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export type HardwareOverridesResult =
  | { ok: true; values: HardwareOverrides }
  | { ok: false; errors: string[] };

/** Merge `partial` onto `base` and validate the result as a whole (the bit masks depend on each other). */
export function resolveHardwareOverrides(
  base: Readonly<HardwareOverrides>,
  partial: unknown,
): HardwareOverridesResult {
  if (partial !== undefined && (typeof partial !== 'object' || partial === null || Array.isArray(partial))) {
    return { ok: false, errors: ['overrides must be an object'] };
  }
  const values = mergeHardwareOverrides(base, partial as Partial<HardwareOverrides> | undefined);
  const errors = validateHardwareOverrides(values);
  return errors.length === 0 ? { ok: true, values } : { ok: false, errors };
}

/** The keys whose value differs between `from` and `to`. */
export function diffHardwareOverrides(
  from: Readonly<HardwareOverrides>,
  to: Readonly<HardwareOverrides>,
): { key: HardwareOverrideKey; from: HardwareOverrides[HardwareOverrideKey]; to: HardwareOverrides[HardwareOverrideKey] }[] {
  return HARDWARE_OVERRIDE_KEYS.filter((k) => from[k] !== to[k]).map((key) => ({ key, from: from[key], to: to[key] }));
}

// ---------------------------------------------------------------------------------------------
// Export / import file

export const HARDWARE_OVERRIDES_FORMAT = 'rockzalct.hardware-overrides';
export const HARDWARE_OVERRIDES_VERSION = 1;

export interface HardwareOverridesFile {
  format: typeof HARDWARE_OVERRIDES_FORMAT;
  version: typeof HARDWARE_OVERRIDES_VERSION;
  values: HardwareOverrides;
  note?: string;
}

/** The text of an export file (pretty printed JSON). */
export function serializeHardwareOverrides(values: Readonly<HardwareOverrides>, note?: string): string {
  const file: HardwareOverridesFile = {
    format: HARDWARE_OVERRIDES_FORMAT,
    version: HARDWARE_OVERRIDES_VERSION,
    values: { ...values },
    ...(note !== undefined && note !== '' ? { note } : {}),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

export type ParsedHardwareOverrides =
  | { ok: true; values: HardwareOverrides; note?: string }
  | { ok: false; errors: string[] };

/**
 * Parse and validate an export file. A setting missing from `values` takes its default; an unknown
 * setting, a wrong format/version or an invalid value rejects the whole file (nothing is applied).
 */
export function parseHardwareOverridesJson(text: string): ParsedHardwareOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not a JSON file'] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['not a hardware-overrides file'] };
  const file = raw as Record<string, unknown>;
  if (file['format'] !== HARDWARE_OVERRIDES_FORMAT) return { ok: false, errors: [`format must be "${HARDWARE_OVERRIDES_FORMAT}"`] };
  if (file['version'] !== HARDWARE_OVERRIDES_VERSION) {
    return { ok: false, errors: [`unsupported version ${String(file['version'])} (this program reads version ${HARDWARE_OVERRIDES_VERSION})`] };
  }
  if (file['note'] !== undefined && typeof file['note'] !== 'string') return { ok: false, errors: ['note must be text'] };
  if (file['values'] === undefined) return { ok: false, errors: ['values is missing'] };
  const resolved = resolveHardwareOverrides(DEFAULT_HARDWARE_OVERRIDES, file['values']);
  if (!resolved.ok) return resolved;
  return typeof file['note'] === 'string' ? { ok: true, values: resolved.values, note: file['note'] } : { ok: true, values: resolved.values };
}

// ---------------------------------------------------------------------------------------------
// DeviceApi part

export interface OverridesApi {
  /** The overrides currently in effect (a copy). Any user level. */
  getHardwareOverrides(): Promise<HardwareOverrides>;
  /**
   * ADVANCED (PERMISSION otherwise). Change some overrides; the rest keep their value. The merged
   * result is validated as a whole (INVALID_ARGUMENT, nothing changed). Applies to the very next
   * command, no reconnect needed. Returns the new values.
   */
  setHardwareOverrides(partial: Partial<HardwareOverrides>): Promise<HardwareOverrides>;
  /** ADVANCED. Back to DEFAULT_HARDWARE_OVERRIDES. */
  resetHardwareOverrides(): Promise<HardwareOverrides>;
}

/** Every OverridesApi method name; typed so a missing/extra name is a compile error. */
export const OVERRIDES_METHODS: { [K in keyof OverridesApi]-?: true } = {
  getHardwareOverrides: true,
  setHardwareOverrides: true,
  resetHardwareOverrides: true,
};
