// Pure model for importing NovaLCT files (.rcfgx receiving-card config, .scr screen config).
// No runtime deps, no I/O (bundled into the renderer too). The RCCB decoder below is a port of
// `decodeScannerBinData` / `ScanBdRecordNoSendParams` from @novastar/screen (MIT, (c) Andrei
// Sarakeev, https://github.com/sarakusha/novastar); only plain DataView reads, no typed-struct.
import type { ReceiverTarget } from './receiver.js';
import { inferLayout, type LayoutHardwareState, type LayoutModel } from './layoutModel.js';
import { layoutHasErrors, validateLayout, describeLayoutIssue } from './layoutModel.js';

// ---------------------------------------------------------------------------------------------
// Errors (returned to the UI as data, never thrown across IPC)

export type NovaFileErrorReason =
  | 'too-large' //          the file is bigger than we are willing to read
  | 'not-zip' //            .rcfgx is not a zip archive we can read
  | 'zip-unsupported' //    encrypted / zip64 / unknown compression / inconsistent sizes
  | 'xml-missing' //        no XML entry in the archive
  | 'xml-invalid' //        the XML does not parse or is not a ScanBoardProperty
  | 'bin-invalid' //        RCCB blob: bad header, length, CRC or record framing
  | 'no-records' //         the archive has no RCCB blob (nothing to send)
  | 'too-many-records'
  | 'record-invalid' //     a record has a bad length / delay
  | 'address-not-allowed' //a record writes outside the receiving-card register space
  | 'scr-invalid'; //       .scr header / CRC / structure

export class NovaFileError extends Error {
  constructor(
    public readonly reason: NovaFileErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'NovaFileError';
  }
}

export type NovaParseFailure = { ok: false; reason: NovaFileErrorReason; message: string };

// ---------------------------------------------------------------------------------------------
// RCCB: the register-write list inside a .rcfgx

/** One register write NovaLCT sends to the receiving card (SendParam of @novastar/screen). */
export interface RcfgxRecord {
  address: number;
  data: Uint8Array;
  /** Wait after this write, milliseconds. */
  delayMs: number;
  /** Non-zero: poll the card's busy register for up to this long (ms) after the delay. */
  pollingTime: number;
  /** Extra wait after polling (low 15 bits, ms); bit 15 is a flag NovaLCT also keeps. */
  pollingWaitTime: number;
}

const RCCB_MAGIC = 'RCCB';
export const RCCB_HEADER_SIZE = 64;
export const RCCB_RECORD_HEADER_SIZE = 32;
const RCCB_CRC_SEED = 0x5555;

/** Sanity limits (the two real files have 41 / 61 records and at most 524 288 bytes in one). */
export const RCFGX_LIMITS = {
  maxRecords: 1024,
  maxRecordBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxDelayMs: 10_000,
  maxTotalDelayMs: 60_000,
  maxPollingMs: 60_000,
} as const;

const sum16 = (bytes: Uint8Array, seed: number): number => {
  let acc = seed;
  for (let i = 0; i < bytes.length; i += 1) acc = (acc + bytes[i]!) & 0xffff;
  return acc;
};

/**
 * Decode the RCCB blob. Throws NovaFileError('bin-invalid' | 'too-many-records' | 'record-invalid').
 * Layout (little endian): header 64 B = "RCCB", u32 total length, u16 CRC (16-bit byte sum of the
 * rest, seed 0x5555), u16 version, 52 reserved; then records of 32 B header = u32 size, u16 num,
 * u32 address, u32 length, u16 delay, u16 pollingTime, u16 pollingWaitTime, 12 reserved; + data.
 */
export function decodeRccb(bytes: Uint8Array): RcfgxRecord[] {
  if (bytes.length < RCCB_HEADER_SIZE) throw new NovaFileError('bin-invalid', 'RCCB blob is shorter than its header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== RCCB_MAGIC) throw new NovaFileError('bin-invalid', 'RCCB header is missing');
  if (view.getUint32(4, true) !== bytes.length) throw new NovaFileError('bin-invalid', 'RCCB length field does not match the blob');
  if (sum16(bytes.subarray(RCCB_HEADER_SIZE), RCCB_CRC_SEED) !== view.getUint16(8, true)) {
    throw new NovaFileError('bin-invalid', 'RCCB CRC mismatch');
  }
  const records: RcfgxRecord[] = [];
  let offset = RCCB_HEADER_SIZE;
  while (offset < bytes.length) {
    if (records.length >= RCFGX_LIMITS.maxRecords) {
      throw new NovaFileError('too-many-records', `more than ${RCFGX_LIMITS.maxRecords} records`);
    }
    if (offset + RCCB_RECORD_HEADER_SIZE > bytes.length) throw new NovaFileError('bin-invalid', `record ${records.length + 1} is truncated`);
    const size = view.getUint32(offset, true);
    const address = view.getUint32(offset + 6, true);
    const length = view.getUint32(offset + 10, true);
    if (length > RCFGX_LIMITS.maxRecordBytes) throw new NovaFileError('record-invalid', `record ${records.length + 1}: ${length} bytes is too long`);
    if (size !== RCCB_RECORD_HEADER_SIZE + length || offset + size > bytes.length) {
      throw new NovaFileError('bin-invalid', `record ${records.length + 1} has an inconsistent size`);
    }
    records.push({
      address,
      data: bytes.slice(offset + RCCB_RECORD_HEADER_SIZE, offset + size),
      delayMs: view.getUint16(offset + 14, true),
      pollingTime: view.getUint16(offset + 16, true),
      pollingWaitTime: view.getUint16(offset + 18, true),
    });
    offset += size;
  }
  return records;
}

// ---------------------------------------------------------------------------------------------
// Address policy

/**
 * High byte (address >>> 24) of the receiving-card register space a .rcfgx may write.
 *
 * DERIVED FROM THE REAL FILES, not from documentation: the union of the high bytes of every record
 * of the two files in test/fixtures (NovaLCT 5.3.0 sample MRV328, and a NovaLCT 5.9.2 file for an
 * NV7516) is 0x01 0x02 0x03 0x04 0x05 0x06 0x0e 0x0f 0x10 0x11 0x16 0x1a 0x1b 0x1c 0x24 0x26 0x28.
 * 0x01 is the control-command space and is handled separately (RCFGX_COMMAND_ADDRESSES); the rest
 * is allowed as plain register / table writes (e.g. 0x02 parameters, 0x03 auto-refresh and point
 * tables, 0x04 run-line table, 0x0e..0x11 gamma/IC tables, 0x1a..0x1c IC registers). Anything else
 * (sender space 0x00, 0x07..0x0d, 0x12..0x15, ...) is rejected: a file that reaches there is not
 * something we have ever seen NovaLCT send.
 */
export const RCFGX_REGISTER_HIGH_BYTES: readonly number[] = [
  0x02, 0x03, 0x04, 0x05, 0x06, 0x0e, 0x0f, 0x10, 0x11, 0x16, 0x1a, 0x1b, 0x1c, 0x24, 0x26, 0x28,
];

/**
 * The only 0x01xxxxxx command records accepted, with their @novastar/native AddressMapping names.
 * All four occur in the real files. 0x01000011 (store parameters to flash) and 0x01000010 (reload
 * from flash) are deliberately NOT here: saving stays the explicit, separately confirmed step.
 * Whether any of these persists something on the card is UNVERIFIED on hardware.
 */
export const RCFGX_COMMAND_ADDRESSES: Readonly<Record<number, string>> = {
  0x0100_0012: 'RecaculateParameter',
  0x0100_0019: 'WriteConfigRegister',
  0x0100_005e: 'ConfigRegisterWrite3',
  0x0100_009d: 'FlashCabinet',
};
/** Command records are short; the real ones are 1 or 11 bytes. */
export const RCFGX_MAX_COMMAND_BYTES = 16;

export type RcfgxRecordKind = 'register' | 'command';

/** null = not allowed. A record must stay inside one 16 MiB region (no carry into the next high byte). */
export function classifyRcfgxRecord(address: number, length: number): RcfgxRecordKind | null {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff_ffff) return null;
  if (!Number.isInteger(length) || length < 1) return null;
  if ((address & 0x00ff_ffff) + length > 0x0100_0000) return null;
  const hi = address >>> 24;
  if (hi === 0x01) {
    return RCFGX_COMMAND_ADDRESSES[address] !== undefined && length <= RCFGX_MAX_COMMAND_BYTES ? 'command' : null;
  }
  return RCFGX_REGISTER_HIGH_BYTES.includes(hi) ? 'register' : null;
}

export const hex32 = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/** Throws NovaFileError when any record is unusable. Checks everything before anything is sent. */
export function validateRcfgxRecords(records: readonly RcfgxRecord[]): void {
  if (records.length === 0) throw new NovaFileError('no-records', 'the file has no register writes');
  if (records.length > RCFGX_LIMITS.maxRecords) throw new NovaFileError('too-many-records', `more than ${RCFGX_LIMITS.maxRecords} records`);
  let total = 0;
  let totalDelay = 0;
  records.forEach((r, i) => {
    const n = i + 1;
    if (r.data.length < 1 || r.data.length > RCFGX_LIMITS.maxRecordBytes) {
      throw new NovaFileError('record-invalid', `record ${n}: ${r.data.length} bytes is not allowed`);
    }
    if (classifyRcfgxRecord(r.address, r.data.length) === null) {
      throw new NovaFileError('address-not-allowed', `record ${n}: ${hex32(r.address)} (${r.data.length} bytes) is outside the receiving-card register space`);
    }
    if (r.delayMs > RCFGX_LIMITS.maxDelayMs) throw new NovaFileError('record-invalid', `record ${n}: delay ${r.delayMs} ms is too long`);
    if (r.pollingTime > RCFGX_LIMITS.maxPollingMs) throw new NovaFileError('record-invalid', `record ${n}: polling time ${r.pollingTime} ms is too long`);
    total += r.data.length;
    totalDelay += r.delayMs;
  });
  if (total > RCFGX_LIMITS.maxTotalBytes) throw new NovaFileError('record-invalid', `${total} bytes in total is too much`);
  if (totalDelay > RCFGX_LIMITS.maxTotalDelayMs) throw new NovaFileError('record-invalid', `total delay ${totalDelay} ms is too long`);
}

// ---------------------------------------------------------------------------------------------
// What the UI shows

export interface RcfgxRecordInfo {
  /** 0-based position in the file (= send order). */
  index: number;
  address: number;
  length: number;
  delayMs: number;
  pollingTime: number;
  pollingWaitTime: number;
  kind: RcfgxRecordKind;
  /** @novastar/native AddressMapping name(s), when known. */
  name?: string;
  /** Command records only (<= 16 bytes): the data, lowercase hex. */
  dataHex?: string;
}

export interface RcfgxAddressGroup {
  address: number;
  name?: string;
  kind: RcfgxRecordKind;
  count: number;
  bytes: number;
}

/** Per-address totals in order of first appearance. */
export function groupRcfgxRecords(records: readonly RcfgxRecordInfo[]): RcfgxAddressGroup[] {
  const out = new Map<number, RcfgxAddressGroup>();
  for (const r of records) {
    const g = out.get(r.address);
    if (g) {
      g.count += 1;
      g.bytes += r.length;
    } else {
      out.set(r.address, { address: r.address, kind: r.kind, count: 1, bytes: r.length, ...(r.name ? { name: r.name } : {}) });
    }
  }
  return [...out.values()];
}

/** Module / cabinet properties read from the XML. Every field is null when the file does not have it. */
export interface RcfgxProperties {
  /** `RCFGXVersion`, e.g. "NovaLCT V5.9.2-10/26/2026 12:00:40 PM". */
  novaLctVersion: string | null;
  /** `NewRcfgxVersion` (file format), e.g. "2.0". */
  formatVersion: string | null;
  /** `ScanBoardName`: the receiving-card model the file was made for. */
  cardModel: string | null;
  /** `ProgramVersion` of the receiving card the file was made with. */
  cardProgramVersion: string | null;
  moduleWidth: number | null;
  moduleHeight: number | null;
  cabinetWidth: number | null;
  cabinetHeight: number | null;
  moduleCols: number | null;
  moduleRows: number | null;
  /** `DriverChipType`. */
  chip: string | null;
  /** `DecType` (row decoder). */
  decoder: string | null;
  /** `ScanType`, e.g. "Scan_32". */
  scan: string | null;
  dataGroups: number | null;
  physicalDataGroups: number | null;
  scanDirection: string | null;
  oePolarity: string | null;
  refreshNumPerVs: number | null;
  grayDepth: number | null;
  grayMode: string | null;
  gamma: number | null;
}

export interface RcfgxInfo {
  /** Handle for sendRcfgx: the records stay in the main process. */
  fileId: string;
  fileName: string;
  fileSize: number;
  properties: RcfgxProperties;
  recordCount: number;
  totalBytes: number;
  totalDelayMs: number;
  records: RcfgxRecordInfo[];
  groups: RcfgxAddressGroup[];
  /** The 0x01xxxxxx command records, in send order (subset of `records`). */
  commandRecords: RcfgxRecordInfo[];
}

export type RcfgxParseResult = { ok: true; info: RcfgxInfo } | NovaParseFailure;

export interface NovaFileInput {
  name: string;
  bytes: Uint8Array;
}

/** Builds the record list the UI shows (never includes register data except for command records). */
export function describeRcfgxRecords(records: readonly RcfgxRecord[], nameOf: (address: number) => string | undefined): RcfgxRecordInfo[] {
  return records.map((r, index) => {
    const kind = classifyRcfgxRecord(r.address, r.data.length) ?? 'register';
    const name = nameOf(r.address);
    return {
      index,
      address: r.address,
      length: r.data.length,
      delayMs: r.delayMs,
      pollingTime: r.pollingTime,
      pollingWaitTime: r.pollingWaitTime,
      kind,
      ...(name ? { name } : {}),
      ...(kind === 'command' ? { dataHex: [...r.data].map((b) => b.toString(16).padStart(2, '0')).join('') } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Sending

export type RcfgxTarget = ReceiverTarget;

export interface SendRcfgxOptions {
  /**
   * The user's statement of which receiving-card model the target is. Must equal the file's
   * `cardModel` (case-insensitive) when the file names one. The library cannot read the card model,
   * so this is the only check there is.
   */
  confirmCardModel: string;
  /** Must be true when the file contains command (0x01...) records. */
  acknowledgeCommands: boolean;
}

export interface SendRcfgxFailure {
  recordIndex: number;
  address: number;
  code: 'NOT_CONNECTED' | 'TIMEOUT' | 'PROTOCOL' | 'PERMISSION' | 'INVALID_ARGUMENT' | 'NOT_FOUND';
  message: string;
}

export interface SendRcfgxResult {
  ok: boolean;
  fileId: string;
  recordsTotal: number;
  recordsWritten: number;
  bytesTotal: number;
  bytesWritten: number;
  commandRecordsWritten: number;
  failed?: SendRcfgxFailure;
}

export interface RcfgxProgress {
  fileId: string;
  running: boolean;
  recordsTotal: number;
  recordsDone: number;
  bytesTotal: number;
  bytesDone: number;
  /** Record being written / waited for (0-based), or null before the first and after the last. */
  currentIndex: number | null;
  currentAddress: number | null;
  /** The last send ended with a failure. */
  failed: boolean;
}

/** Why a send must be refused given the options and the parsed file; null when fine. */
export function checkRcfgxSend(
  info: Pick<RcfgxInfo, 'properties' | 'commandRecords' | 'records'>,
  target: RcfgxTarget,
  options: unknown,
): string | null {
  if (typeof options !== 'object' || options === null) return 'options must be an object';
  const o = options as Partial<SendRcfgxOptions>;
  const model = info.properties.cardModel;
  if (model) {
    if (typeof o.confirmCardModel !== 'string' || o.confirmCardModel.trim().toLowerCase() !== model.toLowerCase()) {
      return `the receiving-card model must be confirmed as ${model}`;
    }
  }
  if (info.commandRecords.length > 0 && o.acknowledgeCommands !== true) {
    return `the file has ${info.commandRecords.length} command record(s); they must be acknowledged`;
  }
  if (target.scope === 'all' && info.records.some((r) => r.pollingTime > 0)) {
    return 'records that poll the card cannot be broadcast; choose one card';
  }
  return null;
}

/** Pause the codec adds after every chunk of a broadcast (no acknowledgement to wait for). */
export const BROADCAST_CHUNK_PAUSE_MS = 50;
/** Default data bytes per packet of a connection (@novastar/codec Connection.maxLength). */
export const DEFAULT_PACKET_BYTES = 256;

/**
 * Rough time a send takes: the sum of the records' delays, plus for a broadcast one 50 ms pause per
 * packet (a 512 KiB record alone is ~100 s). To one card each packet waits for its acknowledgement
 * instead, which is much faster but depends on the link, so only the delays are counted.
 */
export function estimateRcfgxMs(records: readonly Pick<RcfgxRecordInfo, 'length' | 'delayMs'>[], broadcast: boolean): number {
  let ms = 0;
  for (const r of records) {
    ms += r.delayMs;
    if (broadcast) ms += Math.ceil(r.length / DEFAULT_PACKET_BYTES) * BROADCAST_CHUNK_PAUSE_MS;
  }
  return ms;
}

/** How the file's card model compares with the model a connected card reports. */
export type CardModelMatch = 'match' | 'mismatch' | 'unknown';

/** Card models the library cannot name come out as "Unknown", "Unknown (0x....)" or empty. */
export function compareCardModel(fileModel: string | null, cardModel: string | undefined): CardModelMatch {
  if (!fileModel || !cardModel || /^unknown\b/i.test(cardModel.trim())) return 'unknown';
  const norm = (s: string): string => s.replace(/\s*\(mock\)\s*$/i, '').trim().toLowerCase();
  return norm(fileModel) === norm(cardModel) ? 'match' : 'mismatch';
}

// ---------------------------------------------------------------------------------------------
// .scr: screen configuration

export interface ScrRegion {
  senderIndex: number;
  portIndex: number;
  /** Position of the receiving card on its port's chain (0-based). */
  connectIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The region carries an irregular point list. */
  hasPointList: boolean;
}

export type ScrScreenKind = 'simple' | 'standard' | 'complex' | 'irregular' | 'unknown';

export interface ScrScreen {
  kind: ScrScreenKind;
  x: number;
  y: number;
  /** Cabinet grid size as stored in the file. */
  cols: number;
  rows: number;
  name: string;
  regions: ScrRegion[];
}

export type ScrLayoutReason =
  | 'no-screens'
  | 'several-screens'
  | 'several-senders'
  | 'not-standard' //   complex / irregular screen type
  | 'point-list' //     irregular point list on a region
  | 'bad-chain' //      duplicate or gapped card positions on a port
  | 'not-a-grid' //     the regions do not line up in a rows x cols grid
  | 'invalid'; //       the converted layout has validation errors

export type ScrLayoutConversion =
  | { ok: true; model: LayoutModel }
  | { ok: false; reasons: ScrLayoutReason[]; details: string[] };

export interface ScrInfo {
  fileName: string;
  fileSize: number;
  /** `version` of the screen-info block. */
  version: number;
  dvi: { cols: number; rows: number; width: number; height: number };
  screens: ScrScreen[];
  layout: ScrLayoutConversion;
}

export type ScrParseResult = { ok: true; info: ScrInfo } | NovaParseFailure;

/**
 * Convert a parsed .scr to our layout model where it maps cleanly: exactly one screen on one
 * sending card, a standard (non-complex, non-irregular) screen, regions that form a cabinet grid,
 * and per port a gap-free chain 0..n-1. The reconstruction goes through inferLayout, so a grid is
 * accepted only when it reproduces every region's rectangle exactly.
 */
export function scrToLayout(screens: readonly ScrScreen[]): ScrLayoutConversion {
  const fail = (reasons: ScrLayoutReason[], details: string[] = []): ScrLayoutConversion => ({ ok: false, reasons, details });
  if (screens.length === 0) return fail(['no-screens']);
  if (screens.length > 1) return fail(['several-screens']);
  const screen = screens[0]!;
  if (screen.kind !== 'standard') return fail(['not-standard']); // simple (one card), complex, irregular
  if (screen.regions.length === 0) return fail(['no-screens']);
  if (new Set(screen.regions.map((r) => r.senderIndex)).size > 1) return fail(['several-senders']);
  if (screen.regions.some((r) => r.hasPointList)) return fail(['point-list']);

  const byPort = new Map<number, number[]>();
  for (const r of screen.regions) byPort.set(r.portIndex, [...(byPort.get(r.portIndex) ?? []), r.connectIndex]);
  for (const [port, idx] of byPort) {
    const sorted = [...idx].sort((a, b) => a - b);
    if (sorted.some((v, i) => v !== i)) return fail(['bad-chain'], [`port ${port + 1}`]);
  }

  const ports = [...byPort.keys()].sort((a, b) => a - b);
  const hw: LayoutHardwareState = {
    complexScreen: false,
    ports: ports.map((port) => ({ port, enabled: true, x: 0, y: 0, width: 0, height: 0 })),
    cards: screen.regions.map((r) => ({
      port: r.portIndex,
      index: r.connectIndex,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      cabinetNumber: 0,
    })),
  };
  const inferred = inferLayout(hw);
  if (!inferred.model || inferred.issues.length > 0) return fail(['not-a-grid']);
  if (inferred.model.screen.kind !== 'standard' || inferred.model.screen.overrides.length > 0) return fail(['not-standard']);
  const issues = validateLayout(inferred.model);
  if (layoutHasErrors(issues)) {
    return fail(['invalid'], issues.filter((i) => i.severity === 'error').slice(0, 5).map(describeLayoutIssue));
  }
  return { ok: true, model: inferred.model };
}
