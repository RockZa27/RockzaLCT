// PLAN.md phase 8: calibration coefficient MANAGEMENT (NovaLCT: Calibration). Owned by the
// calibration feature; types + methods it adds to DeviceApi. This is NOT camera based measurement:
// it only reads/enables calibration on a receiving card and moves the coefficient data the card
// already holds (download to a file, upload from a file, store to / reload from flash).
// Keep this file free of runtime deps (it is bundled into the renderer as well).
//
// Where an address or value comes from the native package it is cited in
// packages/device/src/features/calibration.ts (CALIBRATION_REGISTERS); this file only holds the
// numbers the renderer and the mock need as well, each with its citation.

import { validateCardIndex, validateReceiverTarget, type ReceiverTarget } from './receiver.js';

/** Which kind of calibration coefficients are applied. CorrectType.d.cts: ChromaCorrection = 0, BrightCorrection = 1. */
export type CalibrationType = 'chroma' | 'brightness';

/** CoefficientSourceType.d.cts: ScanBoardFlash = 0, ModuleFlash = 1, Unknown = 255. */
export type CoefficientSource = 'scan-board-flash' | 'module-flash' | 'unknown';

/**
 * Heuristic look at the first block of the coefficient memory (NOT a library status):
 * `empty` = every byte 0x00, `erased` = every byte 0xFF (the usual state of erased flash), `data` = anything else.
 */
export type CoefficientDataState = 'empty' | 'erased' | 'data';

/** Which coefficient set a flash command works on. CoefType.d.cts: common = 1, MultiLayer = 4 (the only value that changes the address). */
export type CoefficientSet = 'standard' | 'multi-layer';

/**
 * Where the coefficient memory of a receiving card sits and how it is transferred.
 *  - baseAddress / sizeBytes: AddressMapping.d.cts `CoefficientAddr = 117440512` (0x0700_0000) and
 *    `CoefficientOccupancy = 2097152` (0x20_0000); `Scanner_CorrectionDataBase = 117440512` is the same base.
 *    The link to ReadCorrectionDataToScan / WriteCorrectionDataToScan (which take an arbitrary
 *    `registerAddr`) is an inference and UNVERIFIED on hardware.
 *  - blockBytes: 256 = the default `maxLength` of @novastar/codec Session (index.cjs, `maxLength = 256`;
 *    @novastar/net and @novastar/serial do not override it). Every block is therefore exactly one
 *    library request, which is what makes "which blocks were written" exact.
 */
export const COEFFICIENT_REGION = {
  baseAddress: 0x0700_0000,
  sizeBytes: 0x20_0000,
  blockBytes: 256,
} as const;

/**
 * Bit layout of the correction-state byte (register 0x0200_0051, shared by ReadCorrectionState /
 * ReadCorrectionOn / SetCorrectionOn / ReadBrightDarkLineFixState).
 *
 * UNVERIFIED ON HARDWARE. Evidence: SetCorrectionOn_1.cjs builds `isOpenCorrect ? 1 : 0` (bit 0) and
 * `type << 1` (CorrectType 0 = chroma, 1 = brightness, so bit 1) and `!retainClrInfo ? 4 : 0` (bit 2).
 * The generator emits those as a 4-element array (`[0, on, type << 1, !retain ? 4 : 0]`), which looks
 * like a decompiler artefact for ONE byte; this program never sends that 4-byte form and never
 * touches bit 2. SetCorrectionOn (the plain boolean setter) writes `[1]` / `[0]`, consistent with bit 0.
 */
export const CORRECTION_STATE_BITS = { enabled: 0x01, brightnessType: 0x02 } as const;

export type CorrectionStateBits = { [K in keyof typeof CORRECTION_STATE_BITS]: number };

/** Decode the correction-state byte (bit layout: see CORRECTION_STATE_BITS, UNVERIFIED). */
export function decodeCorrectionState(
  raw: number,
  bits: CorrectionStateBits = CORRECTION_STATE_BITS,
): { enabled: boolean; type: CalibrationType } {
  return { enabled: (raw & bits.enabled) !== 0, type: (raw & bits.brightnessType) !== 0 ? 'brightness' : 'chroma' };
}

/** The byte that enables calibration of `type` (bit layout: see CORRECTION_STATE_BITS, UNVERIFIED). */
export function composeCorrectionState(
  type: CalibrationType,
  bits: CorrectionStateBits = CORRECTION_STATE_BITS,
): number {
  return bits.enabled | (type === 'brightness' ? bits.brightnessType : 0);
}

export function describeCoefficientSource(raw: number): CoefficientSource {
  if (raw === 0) return 'scan-board-flash';
  if (raw === 1) return 'module-flash';
  return 'unknown';
}

/** Classify a block of coefficient memory (heuristic, see CoefficientDataState). */
export function classifyCoefficientBlock(block: Uint8Array): CoefficientDataState {
  if (block.length === 0) return 'empty';
  let zero = true;
  let ff = true;
  for (const b of block) {
    if (b !== 0) zero = false;
    if (b !== 0xff) ff = false;
    if (!zero && !ff) return 'data';
  }
  return zero ? 'empty' : 'erased';
}

/** State of one receiving card's calibration. */
export interface CalibrationCardState {
  portIndex: number;
  cardIndex: number;
  /** Raw correction-state byte (register 0x0200_0051). Also what ReadBrightDarkLineFixState returns (same register). */
  stateRaw: number;
  /** Bit 0 of stateRaw (UNVERIFIED layout, see CORRECTION_STATE_BITS). */
  enabled: boolean;
  /** Bit 1 of stateRaw (UNVERIFIED layout). */
  type: CalibrationType;
  /** Raw CoefficientSource byte; omitted when the card refuses the register. */
  coefficientSourceRaw?: number;
  coefficientSource?: CoefficientSource;
  /** Heuristic from the first block of the coefficient memory; omitted when it cannot be read. */
  coefficientData?: CoefficientDataState;
}

/** One block of coefficient memory, base64 encoded (a plain string survives IPC unchanged). */
export interface CoefficientBlock {
  /** Byte offset inside the coefficient region. */
  offset: number;
  length: number;
  dataBase64: string;
}

/** Something this program deliberately does not offer, with the grep terms that were tried. */
export interface UnsupportedCalibrationFeature {
  id: 'bright-dark-line-fix' | 'area-adjust' | 'slave-flash' | 'iic-flash' | 'camera';
  /** Terms searched in node_modules/@novastar/native/dist (api names, AddressMapping.d.cts, enums). */
  searched: readonly string[];
}

export const CALIBRATION_UNSUPPORTED: readonly UnsupportedCalibrationFeature[] = [
  {
    id: 'bright-dark-line-fix',
    searched: ['BrightDarkLine', 'DarkLine', 'SeamFix', 'Seam', 'LineFix', 'LineBias', 'Bright*Line'],
  },
  { id: 'area-adjust', searched: ['AreaCoefs', 'AreaCoefsOperate', 'AdjustMatrix', 'SetAreaCoefs'] },
  {
    id: 'slave-flash',
    searched: ['Slave', 'SdramToSlaveFlash', 'SlaveFlashToSdram', 'Solidification', 'Factory'],
  },
  { id: 'iic-flash', searched: ['IIcFlash', 'Store2IIcFlash', 'ReloadFromIIcFlash', 'ModuleFlash'] },
  { id: 'camera', searched: ['Camera', 'Measure', 'CIEValue', 'Photograph'] },
];

export interface CalibrationApi {
  /** Read the calibration state of one receiving card. Allowed at both user levels. */
  getCalibrationState(id: string, portIndex: number, cardIndex: number): Promise<CalibrationCardState>;
  /**
   * Turn calibration on or off for one card or (broadcast) all cards. `type` (chroma / brightness) is
   * only used when enabling; without it the plain on/off command is used. Allowed at both user levels.
   */
  setCalibrationEnabled(id: string, target: ReceiverTarget, enabled: boolean, type?: CalibrationType): Promise<void>;
  /** Read up to COEFFICIENT_REGION.blockBytes of coefficient memory from a card (one library request). */
  readCoefficientBlock(id: string, portIndex: number, cardIndex: number, offset: number, length: number): Promise<CoefficientBlock>;
  /**
   * Write up to COEFFICIENT_REGION.blockBytes of coefficient memory to ONE card (one library
   * request, so it either was written or it was not). Advanced user level only (DeviceError PERMISSION,
   * checked before anything is sent).
   */
  writeCoefficientBlock(id: string, portIndex: number, cardIndex: number, offset: number, dataBase64: string): Promise<void>;
  /** Copy the card's active coefficients into its flash. Advanced only. */
  saveCoefficientsToFlash(id: string, portIndex: number, cardIndex: number, set?: CoefficientSet): Promise<void>;
  /** Replace the card's active coefficients with the ones in its flash. Advanced only. */
  reloadCoefficientsFromFlash(id: string, portIndex: number, cardIndex: number, set?: CoefficientSet): Promise<void>;
  /** Erase the coefficients stored in the card's SPI flash. Advanced only. The command value is UNVERIFIED (see device feature). */
  eraseCoefficientsInFlash(id: string, portIndex: number, cardIndex: number): Promise<void>;
}

/** Every CalibrationApi method name; typed so a missing/extra name is a compile error. */
export const CALIBRATION_METHODS: { [K in keyof CalibrationApi]-?: true } = {
  getCalibrationState: true,
  setCalibrationEnabled: true,
  readCoefficientBlock: true,
  writeCoefficientBlock: true,
  saveCoefficientsToFlash: true,
  reloadCoefficientsFromFlash: true,
  eraseCoefficientsInFlash: true,
};

// --- validation shared by the real device, the mock and the UI -----------------------------------

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Error message for a card address, or null. */
export const validateCalibrationCard = (portIndex: unknown, cardIndex: unknown): string | null =>
  validateCardIndex(portIndex, cardIndex);

/** Error message for a calibration target, or null. */
export const validateCalibrationTarget = (target: unknown): string | null => validateReceiverTarget(target);

/** Error message for a (offset, length) range inside the coefficient region, or null. `maxLength` defaults to the region size. */
export function validateCoefficientRange(
  offset: unknown,
  length: unknown,
  maxLength: number = COEFFICIENT_REGION.sizeBytes,
): string | null {
  if (!isInt(offset) || offset < 0) return 'offset must be a non-negative integer';
  if (!isInt(length) || length < 1) return 'length must be a positive integer';
  if (length > maxLength) return `length must be at most ${maxLength} bytes`;
  if (offset + length > COEFFICIENT_REGION.sizeBytes) {
    return `offset + length must not exceed the ${COEFFICIENT_REGION.sizeBytes} byte coefficient region`;
  }
  return null;
}

/** Error message for the argument of a single block transfer (at most one library request), or null. */
export const validateCoefficientBlockRange = (offset: unknown, length: unknown): string | null =>
  validateCoefficientRange(offset, length, COEFFICIENT_REGION.blockBytes);

// --- base64 and CRC-32 (pure, no Buffer / atob so it runs in main, renderer and tests) --------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i += 1) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let line = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    line += B64[b0 >> 2]! + B64[((b0 & 3) << 4) | (b1 >> 4)]!;
    line += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
    line += i + 2 < bytes.length ? B64[b2 & 63]! : '=';
    if (line.length >= 8192) {
      parts.push(line);
      line = '';
    }
  }
  parts.push(line);
  return parts.join('');
}

/** Strict base64 decode (canonical padding, no whitespace). Returns null for malformed input. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  let pad = 0;
  if (text.endsWith('==')) pad = 2;
  else if (text.endsWith('=')) pad = 1;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let acc = 0;
    for (let j = 0; j < 4; j += 1) {
      const ch = text.charCodeAt(i + j);
      const last = i + 4 === text.length;
      let v: number;
      if (ch === 61 /* = */) {
        if (!last || j < 4 - pad) return null;
        v = 0;
      } else {
        v = ch < 128 ? B64_LOOKUP[ch]! : -1;
        if (v < 0) return null;
      }
      acc = (acc << 6) | v;
    }
    // Canonical encoding: the bits discarded with the padding must be zero.
    if (i + 4 === text.length && pad === 1 && (acc & 0xc0) !== 0) return null;
    if (i + 4 === text.length && pad === 2 && (acc & 0xf000) !== 0) return null;
    if (o < out.length) out[o++] = (acc >> 16) & 0xff;
    if (o < out.length) out[o++] = (acc >> 8) & 0xff;
    if (o < out.length) out[o++] = acc & 0xff;
  }
  return out;
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3, as in zip/png) as 8 lowercase hex digits. An integrity check, not a security feature. */
export function crc32Hex(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

// --- coefficient file ------------------------------------------------------------------------------

export const COEFFICIENT_FILE_FORMAT = 'rockzalct.calibration-coefficients';
export const COEFFICIENT_FILE_VERSION = 1;

/**
 * Our own coefficient backup file (the NovaLCT coefficient formats are not documented and are not read).
 * JSON header + base64 data. `region.offset` / `region.length` locate the bytes inside the card's
 * coefficient memory (region.baseAddress is stored so a future layout change is detected).
 */
export interface CoefficientFile {
  format: typeof COEFFICIENT_FILE_FORMAT;
  version: typeof COEFFICIENT_FILE_VERSION;
  savedAt: string;
  controller: { model: string; firmwareVersion: string };
  card: { portIndex: number; cardIndex: number };
  region: { baseAddress: number; offset: number; length: number };
  checksum: { algorithm: 'crc32'; value: string };
  encoding: 'base64';
  data: string;
}

export interface CoefficientFileError {
  field: string;
  message: string;
}

export function buildCoefficientFile(input: {
  controller: { model: string; firmwareVersion: string };
  portIndex: number;
  cardIndex: number;
  offset: number;
  data: Uint8Array;
  savedAt?: Date;
}): CoefficientFile {
  return {
    format: COEFFICIENT_FILE_FORMAT,
    version: COEFFICIENT_FILE_VERSION,
    savedAt: (input.savedAt ?? new Date()).toISOString(),
    controller: { model: input.controller.model, firmwareVersion: input.controller.firmwareVersion },
    card: { portIndex: input.portIndex, cardIndex: input.cardIndex },
    region: { baseAddress: COEFFICIENT_REGION.baseAddress, offset: input.offset, length: input.data.length },
    checksum: { algorithm: 'crc32', value: crc32Hex(input.data) },
    encoding: 'base64',
    data: bytesToBase64(input.data),
  };
}

export const serializeCoefficientFile = (file: CoefficientFile): string => `${JSON.stringify(file, null, 2)}\n`;

export type ParsedCoefficientFile =
  | { ok: true; file: CoefficientFile; bytes: Uint8Array }
  | { ok: false; errors: CoefficientFileError[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate an already-parsed JSON value as a coefficient file (header, sizes, checksum, base64). */
export function validateCoefficientFile(value: unknown): ParsedCoefficientFile {
  const errors: CoefficientFileError[] = [];
  const fail = (field: string, message: string): void => void errors.push({ field, message });
  if (!isRecord(value)) return { ok: false, errors: [{ field: '', message: 'file must be a JSON object' }] };
  if (value.format !== COEFFICIENT_FILE_FORMAT) {
    return { ok: false, errors: [{ field: 'format', message: `format must be "${COEFFICIENT_FILE_FORMAT}"` }] };
  }
  if (value.version !== COEFFICIENT_FILE_VERSION) {
    return {
      ok: false,
      errors: [{ field: 'version', message: `unsupported version ${String(value.version)} (this program reads ${COEFFICIENT_FILE_VERSION})` }],
    };
  }
  if (typeof value.savedAt !== 'string' || Number.isNaN(Date.parse(value.savedAt))) fail('savedAt', 'savedAt must be an ISO date');

  const controller = isRecord(value.controller) ? value.controller : null;
  if (!controller || typeof controller.model !== 'string' || typeof controller.firmwareVersion !== 'string') {
    fail('controller', 'controller.model and controller.firmwareVersion must be strings');
  }
  const card = isRecord(value.card) ? value.card : null;
  if (!card) fail('card', 'card must be an object');
  else {
    const bad = validateCardIndex(card.portIndex, card.cardIndex);
    if (bad) fail('card', bad.replace(/^target\./, 'card.'));
  }
  const region = isRecord(value.region) ? value.region : null;
  let length = 0;
  if (!region) fail('region', 'region must be an object');
  else {
    if (region.baseAddress !== COEFFICIENT_REGION.baseAddress) {
      fail('region.baseAddress', `region.baseAddress must be ${COEFFICIENT_REGION.baseAddress}`);
    }
    const bad = validateCoefficientRange(region.offset, region.length);
    if (bad) fail('region', `region.${bad}`);
    else length = region.length as number;
  }
  const checksum = isRecord(value.checksum) ? value.checksum : null;
  if (!checksum || checksum.algorithm !== 'crc32' || typeof checksum.value !== 'string' || !/^[0-9a-f]{8}$/.test(checksum.value)) {
    fail('checksum', 'checksum must be {"algorithm":"crc32","value":"<8 lowercase hex digits>"}');
  }
  if (value.encoding !== 'base64') fail('encoding', 'encoding must be "base64"');
  let bytes: Uint8Array | null = null;
  if (typeof value.data !== 'string') fail('data', 'data must be a base64 string');
  else {
    bytes = base64ToBytes(value.data);
    if (!bytes) fail('data', 'data is not valid base64');
  }
  if (bytes && region && errors.every((e) => e.field !== 'region')) {
    if (bytes.length !== length) fail('data', `data holds ${bytes.length} bytes but region.length is ${length}`);
    else if (checksum && checksum.value !== crc32Hex(bytes)) {
      fail('checksum', 'checksum does not match the data (the file is damaged)');
    }
  }
  if (errors.length > 0 || !bytes) return { ok: false, errors };
  return { ok: true, file: value as unknown as CoefficientFile, bytes };
}

export function parseCoefficientFileJson(text: string): ParsedCoefficientFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ field: '', message: 'file is not valid JSON' }] };
  }
  return validateCoefficientFile(value);
}

/** Error message when `file` must not be written to the card (port, card); null when it may. */
export function checkCoefficientFileTarget(
  file: CoefficientFile,
  portIndex: number,
  cardIndex: number,
  options: { allowOtherCard?: boolean } = {},
): string | null {
  if (!options.allowOtherCard && (file.card.portIndex !== portIndex || file.card.cardIndex !== cardIndex)) {
    return `the file was saved from port ${file.card.portIndex + 1} / card ${file.card.cardIndex + 1}, not port ${portIndex + 1} / card ${cardIndex + 1}`;
  }
  return null;
}

// --- chunked transfer with progress, cancellation and exact partial-write reporting ------------------

export interface CoefficientRange {
  offset: number;
  length: number;
}

/** Split [offset, offset + length) into blocks of at most `blockBytes`. */
export function planCoefficientBlocks(
  offset: number,
  length: number,
  blockBytes: number = COEFFICIENT_REGION.blockBytes,
): CoefficientRange[] {
  const out: CoefficientRange[] = [];
  for (let at = 0; at < length; at += blockBytes) out.push({ offset: offset + at, length: Math.min(blockBytes, length - at) });
  return out;
}

/** Merge adjacent ranges (input in transfer order). */
export function mergeCoefficientRanges(ranges: readonly CoefficientRange[]): CoefficientRange[] {
  const out: CoefficientRange[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && last.offset + last.length === r.offset) last.length += r.length;
    else out.push({ ...r });
  }
  return out;
}

export interface CoefficientTransferOptions {
  /** Called after every block. */
  onProgress?(done: number, total: number): void;
  /** Polled before every block; return true to stop. Blocks already transferred stay reported. */
  isCancelled?(): boolean;
}

export interface CoefficientTransferResult {
  /** True only when every byte was transferred. */
  ok: boolean;
  cancelled: boolean;
  totalBytes: number;
  doneBytes: number;
  /** Contiguous ranges that WERE transferred, in order. For an upload these are exactly the ranges now changed on the card. */
  ranges: CoefficientRange[];
  /** The block that failed (no later block was attempted). */
  failed?: { offset: number; length: number; code: string; message: string };
}

/** Transport of one block; implemented over the DeviceApi by `coefficientIoFromApi`. */
export interface CoefficientIo {
  read(offset: number, length: number): Promise<Uint8Array>;
  write(offset: number, data: Uint8Array): Promise<void>;
}

export function coefficientIoFromApi(
  api: Pick<CalibrationApi, 'readCoefficientBlock' | 'writeCoefficientBlock'>,
  id: string,
  portIndex: number,
  cardIndex: number,
): CoefficientIo {
  return {
    async read(offset, length) {
      const block = await api.readCoefficientBlock(id, portIndex, cardIndex, offset, length);
      const bytes = base64ToBytes(block.dataBase64);
      if (!bytes || bytes.length !== length) throw Object.assign(new Error('the card returned a block of the wrong size'), { code: 'PROTOCOL' });
      return bytes;
    },
    write: (offset, data) => api.writeCoefficientBlock(id, portIndex, cardIndex, offset, bytesToBase64(data)),
  };
}

function failure(e: unknown): { code: string; message: string } {
  const code = isRecord(e) && typeof e.code === 'string' ? e.code : 'PROTOCOL';
  return { code, message: e instanceof Error ? e.message : String(e) };
}

/** Read [offset, offset + length) block by block. `data` holds the bytes read so far (a prefix when not `ok`). */
export async function downloadCoefficients(
  io: CoefficientIo,
  offset: number,
  length: number,
  options: CoefficientTransferOptions = {},
): Promise<CoefficientTransferResult & { data: Uint8Array }> {
  const bad = validateCoefficientRange(offset, length);
  if (bad) throw new RangeError(bad);
  const data = new Uint8Array(length);
  const done: CoefficientRange[] = [];
  const result: CoefficientTransferResult & { data: Uint8Array } = {
    ok: false,
    cancelled: false,
    totalBytes: length,
    doneBytes: 0,
    ranges: [],
    data,
  };
  for (const block of planCoefficientBlocks(offset, length)) {
    if (options.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    try {
      data.set(await io.read(block.offset, block.length), block.offset - offset);
    } catch (e) {
      result.failed = { ...block, ...failure(e) };
      break;
    }
    done.push(block);
    result.doneBytes += block.length;
    options.onProgress?.(result.doneBytes, length);
  }
  result.ranges = mergeCoefficientRanges(done);
  result.ok = result.doneBytes === length;
  if (!result.ok) result.data = data.subarray(0, result.doneBytes);
  return result;
}

/**
 * Write `data` at `offset` block by block, in order, stopping at the first failure or cancellation.
 * The result lists exactly which ranges were written; nothing beyond them was attempted.
 */
export async function uploadCoefficients(
  io: CoefficientIo,
  offset: number,
  data: Uint8Array,
  options: CoefficientTransferOptions = {},
): Promise<CoefficientTransferResult> {
  const bad = validateCoefficientRange(offset, data.length);
  if (bad) throw new RangeError(bad);
  const done: CoefficientRange[] = [];
  const result: CoefficientTransferResult = { ok: false, cancelled: false, totalBytes: data.length, doneBytes: 0, ranges: [] };
  for (const block of planCoefficientBlocks(offset, data.length)) {
    if (options.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    try {
      await io.write(block.offset, data.subarray(block.offset - offset, block.offset - offset + block.length));
    } catch (e) {
      result.failed = { ...block, ...failure(e) };
      break;
    }
    done.push(block);
    result.doneBytes += block.length;
    options.onProgress?.(result.doneBytes, data.length);
  }
  result.ranges = mergeCoefficientRanges(done);
  result.ok = result.doneBytes === data.length;
  return result;
}
