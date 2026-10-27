// "Smart Settings" wizard for one receiving card (NovaLCT: Screen Config > Receiving Card > Smart
// Settings). Owned by the smartSettings feature; types + methods it adds to DeviceApi, plus the pure
// decision logic the wizard uses. Keep this file free of runtime deps (it is bundled into the
// renderer as well).
//
// NOT covered, on purpose: the pixel / point-table mapping (SetModuleScanSequenceInfo,
// SetTotalPointInTable, SetModuleConfigInfo, SetScanner_*Ram*, SetGenLinearScanBoardRunLineTable).
// NovaLCT generates those bytes with a proprietary algorithm that is not in the library, so complex or
// irregular modules still need a module config file made with NovaLCT.

import type { DeviceErrorCode } from '../index.js';
import { RECEIVER_LIMITS, type ModuleProfile, type ReceiverParameters, type ReceiverTarget } from './receiver.js';

export * from './smartNames.js';

// ---------------------------------------------------------------------------------------------
// Values

/**
 * The RGB code register (SetRgbCode.cjs: `red | green << 2 | blue << 4 | virtualRed << 6`, 1 byte).
 * Each field is 2 bits. What a field value MEANS (which data channel goes to which output colour) is
 * UNVERIFIED on hardware; the wizard treats red/green/blue as a permutation of 0..2 (0 = R, 1 = G,
 * 2 = B) and keeps `virtualRed` (0..3) untouched.
 */
export interface RgbCode {
  red: number;
  green: number;
  blue: number;
  virtualRed: number;
}

/** Every register the wizard can write, as the values the wizard works with. */
export interface SmartValues {
  /** Module width in pixels, 1 byte. */
  moduleWidth: number;
  /** Module height in pixels, 1 byte. */
  moduleHeight: number;
  /** ScanTypeEnum value: 1 = static, N = Scan_N (1..128). */
  scanMode: number;
  /** Physical total data groups (the `dataGroups` of a ModuleProfile). */
  dataGroups: number;
  /** ChipTypeEnum value of the LED driver IC. */
  driverIc: number;
  /** DecodeTypeEnum value of the row decoder. */
  decodeType: number;
  /** DataDirectionTypeEnum: 0 = Horizontal, 1 = Vertical. The physical effect is UNVERIFIED on hardware. */
  dataDirection: number;
  /** OEPolarityTypeEnum: 0 = HighEnable, 1 = LowEnable. Which one makes a given module look right is UNVERIFIED. */
  oePolarity: number;
  rgb: RgbCode;
}

export type SmartField = keyof SmartValues;

/** Write order: geometry and driver first, then data direction, then the colour related registers. */
export const SMART_FIELDS: readonly SmartField[] = [
  'moduleWidth',
  'moduleHeight',
  'scanMode',
  'driverIc',
  'decodeType',
  'dataGroups',
  'dataDirection',
  'rgb',
  'oePolarity',
];

/** The revert point: the values read from one card before anything was written. */
export interface SmartSnapshot extends SmartValues {
  portIndex: number;
  cardIndex: number;
}

/** A subset of SmartValues to write. */
export type SmartChanges = Partial<SmartValues>;

export interface SmartWriteOptions {
  /**
   * Revert mode: validate against the register byte widths only (so that a value the card already
   * held, e.g. driver IC 255 = Unknown, can be written back). Default: the stricter wizard limits.
   */
  restore?: boolean;
}

export interface SmartWriteFailure {
  field: SmartField;
  code: DeviceErrorCode;
  message: string;
}

export interface SmartWriteResult {
  /** True when every requested field was written. */
  ok: boolean;
  /** Fields successfully sent, in the order they were written. */
  written: SmartField[];
  /** The field whose write failed (the run stops there; later fields were not attempted). */
  failed?: SmartWriteFailure;
}

export interface SmartSettingsApi {
  /**
   * Read every register the wizard can write from one receiving card. Allowed for every user level.
   * All registers are required: if any read fails the whole call rejects, so a snapshot is never partial.
   */
  readSmartSnapshot(id: string, portIndex: number, cardIndex: number): Promise<SmartSnapshot>;
  /**
   * Write the given fields to one card or broadcast to all (RAM only; this never saves to flash).
   * Advanced level only (DeviceError PERMISSION otherwise, checked first). Invalid arguments reject
   * with INVALID_ARGUMENT before anything is sent. A failure after at least one field was written
   * does not reject: it returns `{ ok: false, written, failed }` so the caller can offer a revert.
   * A failure before anything was written rejects with the DeviceError.
   */
  writeSmartSettings(id: string, target: ReceiverTarget, changes: SmartChanges, options?: SmartWriteOptions): Promise<SmartWriteResult>;
}

/** Every SmartSettingsApi method name; typed so a missing/extra name is a compile error. */
export const SMART_SETTINGS_METHODS: { [K in keyof SmartSettingsApi]-?: true } = {
  readSmartSnapshot: true,
  writeSmartSettings: true,
};

// ---------------------------------------------------------------------------------------------
// Limits (from register byte widths and enum ranges)

/**
 * Inclusive limits of the stricter "wizard" validation, from @novastar/native: 1-byte registers for
 * everything (SetModuleWidth/Height, SetScanMode, SetDriverType, SetDecodeType, SetDataDirection,
 * SetOEPority, SetPhysicalTotalDataGroupNum), the enum ranges of ChipTypeEnum (0..254, 255 Unknown),
 * DecodeTypeEnum (0..58 with gaps, 255 Unknown), DataDirectionTypeEnum (0..1) and
 * OEPolarityTypeEnum (0..1), and the 2-bit RGB code fields.
 */
export const SMART_LIMITS = {
  size: RECEIVER_LIMITS.size,
  scanMode: RECEIVER_LIMITS.scanMode,
  dataGroups: RECEIVER_LIMITS.dataGroups,
  driverIc: RECEIVER_LIMITS.driverIc,
  /** Highest DecodeTypeEnum member (HX6258). Values 53 and 56 are not defined: see DECODE_TYPE_GAPS. */
  decodeType: { min: 0, max: 58 },
  dataDirection: { min: 0, max: 1 },
  oePolarity: { min: 0, max: 1 },
  /** Colour fields of a wizard-written RGB code: a permutation of 0..2. */
  rgbColor: { min: 0, max: 2 },
  /** virtualRed is a full 2-bit field. */
  virtualRed: { min: 0, max: 3 },
} as const;

export const DECODE_TYPE_GAPS: readonly number[] = [53, 56];

/** Limits used when `restore` is set: just the register widths. */
export const SMART_RESTORE_LIMITS = {
  byte: { min: 0, max: 255 },
  rgbField: { min: 0, max: 3 },
} as const;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const inRange = (v: unknown, r: { readonly min: number; readonly max: number }): v is number =>
  isInt(v) && v >= r.min && v <= r.max;

export const isValidDecodeType = (v: unknown): v is number =>
  inRange(v, SMART_LIMITS.decodeType) && !DECODE_TYPE_GAPS.includes(v);

/** True when red/green/blue are three different values in 0..2. */
export const isRgbPermutation = (c: Pick<RgbCode, 'red' | 'green' | 'blue'>): boolean =>
  new Set([c.red, c.green, c.blue]).size === 3 && [c.red, c.green, c.blue].every((v) => inRange(v, SMART_LIMITS.rgbColor));

// ---------------------------------------------------------------------------------------------
// RGB code <-> register byte

/** SetRgbCode.cjs: `red | green << 2 | blue << 4 | virtualRed << 6`, encoded into 1 byte. */
export function rgbCodeToByte(c: RgbCode): number {
  return (c.red | (c.green << 2) | (c.blue << 4) | (c.virtualRed << 6)) & 0xff;
}

/** Inverse of rgbCodeToByte (the register is read back as that same byte). */
export function byteToRgbCode(b: number): RgbCode {
  return { red: b & 3, green: (b >> 2) & 3, blue: (b >> 4) & 3, virtualRed: (b >> 6) & 3 };
}

// ---------------------------------------------------------------------------------------------
// Validation

const RGB_KEYS = ['red', 'green', 'blue', 'virtualRed'] as const;

function validateRgb(v: unknown, restore: boolean): string | null {
  if (typeof v !== 'object' || v === null) return 'rgb must be an object';
  const o = v as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(RGB_KEYS as readonly string[]).includes(key)) return `unknown rgb field: ${key}`;
  }
  for (const key of RGB_KEYS) {
    const range = restore ? SMART_RESTORE_LIMITS.rgbField : key === 'virtualRed' ? SMART_LIMITS.virtualRed : SMART_LIMITS.rgbColor;
    if (!inRange(o[key], range)) return `rgb.${key} must be an integer ${range.min}..${range.max}, got ${String(o[key])}`;
  }
  if (!restore && !isRgbPermutation(o as unknown as RgbCode)) {
    return 'rgb.red, rgb.green and rgb.blue must be three different values 0..2';
  }
  return null;
}

/**
 * Error message for a set of changes (the stricter wizard limits, or register widths with
 * `restore`), or null. At least one field is required; unknown fields are rejected.
 */
export function validateSmartChanges(changes: unknown, options: SmartWriteOptions = {}): string | null {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return 'changes must be an object';
  const c = changes as Record<string, unknown>;
  const restore = options.restore === true;
  for (const key of Object.keys(c)) {
    if (!(SMART_FIELDS as readonly string[]).includes(key)) return `unknown field: ${key}`;
  }
  const scalar = (field: Exclude<SmartField, 'rgb'>, range: { readonly min: number; readonly max: number }): string | null => {
    const v = c[field];
    if (v === undefined) return null;
    const r = restore ? SMART_RESTORE_LIMITS.byte : range;
    if (!inRange(v, r)) return `${field} must be an integer ${r.min}..${r.max}, got ${String(v)}`;
    if (!restore && field === 'decodeType' && !isValidDecodeType(v)) return `decodeType ${String(v)} is not a DecodeTypeEnum value`;
    return null;
  };
  const checks = [
    scalar('moduleWidth', SMART_LIMITS.size),
    scalar('moduleHeight', SMART_LIMITS.size),
    scalar('scanMode', SMART_LIMITS.scanMode),
    scalar('dataGroups', SMART_LIMITS.dataGroups),
    scalar('driverIc', SMART_LIMITS.driverIc),
    scalar('decodeType', SMART_LIMITS.decodeType),
    scalar('dataDirection', SMART_LIMITS.dataDirection),
    scalar('oePolarity', SMART_LIMITS.oePolarity),
    c.rgb === undefined ? null : validateRgb(c.rgb, restore),
  ];
  for (const bad of checks) if (bad) return bad;
  if (SMART_FIELDS.every((f) => c[f] === undefined)) return 'no values to write';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Diff

const sameValue = (a: SmartValues[SmartField], b: SmartValues[SmartField]): boolean =>
  typeof a === 'object' && typeof b === 'object'
    ? RGB_KEYS.every((k) => a[k] === b[k])
    : a === b;

export interface SmartDiffEntry {
  field: SmartField;
  before: SmartValues[SmartField];
  after: SmartValues[SmartField];
}

/** The fields whose value differs between `before` and `after`, in SMART_FIELDS order. */
export function diffSmartValues(before: SmartValues, after: SmartValues): SmartDiffEntry[] {
  return SMART_FIELDS.filter((f) => !sameValue(before[f], after[f])).map((field) => ({ field, before: before[field], after: after[field] }));
}

/** The changes that turn `from` into `to` (only the differing fields). */
export function smartChangesBetween(from: SmartValues, to: SmartValues): SmartChanges {
  const out: Record<string, unknown> = {};
  for (const d of diffSmartValues(from, to)) out[d.field] = d.after;
  return out as SmartChanges;
}

/** The values of a snapshot without its card address. */
export function smartValuesOf(s: SmartValues): SmartValues {
  return {
    moduleWidth: s.moduleWidth,
    moduleHeight: s.moduleHeight,
    scanMode: s.scanMode,
    dataGroups: s.dataGroups,
    driverIc: s.driverIc,
    decodeType: s.decodeType,
    dataDirection: s.dataDirection,
    oePolarity: s.oePolarity,
    rgb: { ...s.rgb },
  };
}

// ---------------------------------------------------------------------------------------------
// Module profile <-> wizard values

/**
 * Prefill the "module basics" from a library profile: width, height, scan, data groups and (when the
 * profile has one) the driver IC. Decode type, data direction, OE polarity and RGB code are not part
 * of a profile and keep `base`'s values.
 */
export function smartValuesFromProfile(profile: ModuleProfile, base: SmartValues): SmartValues {
  return {
    ...smartValuesOf(base),
    moduleWidth: profile.width,
    moduleHeight: profile.height,
    scanMode: profile.scanMode,
    dataGroups: profile.dataGroups,
    ...(profile.driverIc !== undefined ? { driverIc: profile.driverIc } : {}),
  };
}

/**
 * A library profile with the wizard's module basics and the card's other (non-wizard) parameters.
 * `params` is a fresh read of the same card. Decode type, data direction, OE polarity and RGB code
 * cannot be stored in a ModuleProfile and are left out.
 */
export function profileFromSmartValues(name: string, values: SmartValues, params: ReceiverParameters): ModuleProfile {
  const profile: ModuleProfile = {
    name,
    width: values.moduleWidth,
    height: values.moduleHeight,
    scanMode: values.scanMode,
    dataGroups: values.dataGroups,
    refNumPerVs: params.refNumPerVs,
    gamma: params.gamma,
    grayDepth: params.grayDepth,
    grayRealize: params.grayRealize,
    grayMode: params.grayMode,
  };
  if (values.driverIc <= RECEIVER_LIMITS.driverIc.max) profile.driverIc = values.driverIc;
  if (params.icPerGroup !== undefined) profile.icPerGroup = params.icPerGroup;
  return profile;
}

// ---------------------------------------------------------------------------------------------
// Step 3: RGB order

export type ColorName = 'red' | 'green' | 'blue';
export const COLOR_INDEX: Readonly<Record<ColorName, number>> = { red: 0, green: 1, blue: 2 };
export const COLOR_NAMES: readonly ColorName[] = ['red', 'green', 'blue'];

/** What the operator saw while the card was sent a solid red / green / blue; `none` = black or another colour. */
export type ColorObservation = ColorName | 'none';
export type RgbObservations = Record<ColorName, ColorObservation>;

export type RgbComputation =
  | {
      ok: true;
      /** The code to write: the current virtualRed is kept. */
      code: RgbCode;
      /** True when the observations already show the right colours (no change needed). */
      unchanged: boolean;
      /** True when `current` was not a permutation of 0..2, so the default 0,1,2 was used as the base. */
      baseAssumed: boolean;
    }
  | { ok: false; reason: 'invalid-observation' };

const defaultRgb = (virtualRed: number): RgbCode => ({ red: 0, green: 1, blue: 2, virtualRed });

/**
 * Which way the 3-colour permutation is read. Both give the same answer for the common cases (two
 * colours swapped) and differ only for the two 3-cycles, so a wizard that cannot know the card's
 * convention tries `normal` first and offers `inverse` if the colours are still wrong afterwards.
 *
 * `normal` (UNVERIFIED on hardware): the card sends data channel X to output slot `r[X]` (r = the
 * code's red/green/blue fields), the module wiring maps slot k to colour W[k], so the colour seen for
 * X is T[X] = W[r[X]]. We want W[r'[X]] = X, which gives r'[X] = r[T^-1[X]].
 *
 * `inverse` (UNVERIFIED): the fields name the data channel feeding each slot instead (slot X gets
 * data channel r[X]); then T[X] = W[r^-1[X]] and the answer is r'[X] = T[r[X]].
 */
export type RgbConvention = 'normal' | 'inverse';

/**
 * Compute the RGB code from what the operator saw while the card held `current`. virtualRed is kept.
 */
export function computeRgbCode(current: RgbCode, observed: RgbObservations, convention: RgbConvention = 'normal'): RgbComputation {
  const T = COLOR_NAMES.map((c) => observed[c]);
  if (T.some((o) => o === 'none')) return { ok: false, reason: 'invalid-observation' };
  const seen = T.map((o) => COLOR_INDEX[o as ColorName]);
  if (new Set(seen).size !== 3) return { ok: false, reason: 'invalid-observation' };

  const baseAssumed = !isRgbPermutation(current);
  const base = baseAssumed ? defaultRgb(current.virtualRed) : current;
  const r = [base.red, base.green, base.blue];
  let next: number[];
  if (convention === 'normal') {
    const tInverse: number[] = [0, 0, 0];
    seen.forEach((colour, x) => {
      tInverse[colour] = x;
    });
    next = [0, 1, 2].map((x) => r[tInverse[x]!]!);
  } else {
    next = [0, 1, 2].map((x) => seen[r[x]!]!);
  }
  const code: RgbCode = { red: next[0]!, green: next[1]!, blue: next[2]!, virtualRed: current.virtualRed };
  const unchanged = seen.every((c, x) => c === x) && !baseAssumed;
  return { ok: true, code, unchanged, baseAssumed };
}

// ---------------------------------------------------------------------------------------------
// Step 4: OE polarity

/** What the operator saw while the card showed solid white. */
export type OeObservation = 'normal' | 'inverted';

export type OeDecision =
  | { ok: true; value: number; change: boolean }
  | { ok: false; reason: 'invalid-current' };

/**
 * `normal` keeps the current polarity; `inverted` (white looks dark / the picture looks inverted)
 * toggles it. The toggle direction needs no knowledge of which value is "right": there are only two
 * (OEPolarityTypeEnum HighEnable 0 / LowEnable 1). Which physical symptom each value produces is
 * UNVERIFIED on hardware, hence the wizard re-checks after writing.
 */
export function decideOePolarity(current: number, observed: OeObservation): OeDecision {
  if (!inRange(current, SMART_LIMITS.oePolarity)) return { ok: false, reason: 'invalid-current' };
  return observed === 'normal' ? { ok: true, value: current, change: false } : { ok: true, value: 1 - current, change: true };
}

// ---------------------------------------------------------------------------------------------
// Basics step helper

/** Field names that belong to the "module basics" step. */
export const SMART_BASIC_FIELDS: readonly SmartField[] = ['moduleWidth', 'moduleHeight', 'scanMode', 'driverIc', 'decodeType', 'dataGroups', 'dataDirection'];

/** The module-basics part of two value sets as changes (only the differing basics). */
export function basicChanges(from: SmartValues, to: SmartValues): SmartChanges {
  const all = smartChangesBetween(from, to) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of SMART_BASIC_FIELDS) if (all[f] !== undefined) out[f] = all[f];
  return out as SmartChanges;
}
