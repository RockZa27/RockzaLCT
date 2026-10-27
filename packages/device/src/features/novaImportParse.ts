// Parsing of NovaLCT files in the main process. .rcfgx: a zip with a ScanBoardProperty XML and an
// optional RCCB blob (see decodeRccb in @rockzalct/shared). .scr: decoded by @novastar/screen.
//
// The zip reader is deliberately minimal (stored + deflate, no zip64, no encryption) and bounds
// every size, because the file comes from outside. The XML is read leniently (only the fields we
// show) with entity expansion off, instead of through the package's strict io-ts codec, so a newer
// NovaLCT that adds fields still opens.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import AddressMapping from '@novastar/native/AddressMapping';
import {
  NovaFileError,
  decodeRccb,
  describeRcfgxRecords,
  groupRcfgxRecords,
  scrToLayout,
  validateRcfgxRecords,
  type NovaParseFailure,
  type RcfgxInfo,
  type RcfgxProperties,
  type RcfgxRecord,
  type ScrInfo,
  type ScrRegion,
  type ScrScreen,
  type ScrScreenKind,
} from '@rockzalct/shared';

export const MAX_RCFGX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_XML_BYTES = 32 * 1024 * 1024;
const MAX_BIN_BYTES = 8 * 1024 * 1024;
const MAX_SCR_FILE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// zip

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

interface ZipEntry {
  name: string;
  data: Buffer;
}

export function readZip(file: Uint8Array, maxEntryBytes: (name: string) => number): ZipEntry[] {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const bad = (m: string): NovaFileError => new NovaFileError('zip-unsupported', m);
  if (buf.length < 22 || (buf.readUInt32LE(0) !== 0x04034b50 && buf.readUInt32LE(0) !== 0x06054b50)) throw new NovaFileError('not-zip', 'not a zip archive');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new NovaFileError('not-zip', 'zip end-of-directory record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || pos === 0xffffffff) throw bad('zip64 is not supported');
  if (count > 64) throw bad('too many entries');
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new NovaFileError('not-zip', 'corrupt zip directory');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw bad('encrypted entries are not supported');
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw bad('zip64 is not supported');
    if (size > maxEntryBytes(name)) throw new NovaFileError('too-large', `entry ${name} is too large`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new NovaFileError('not-zip', 'corrupt zip entry header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + compSize > buf.length) throw new NovaFileError('not-zip', 'zip entry runs past the end of the file');
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new NovaFileError('not-zip', `entry ${name} cannot be decompressed`);
      }
    } else throw bad(`compression method ${method} is not supported`);
    if (data.length !== size) throw bad(`entry ${name} has an inconsistent size`);
    if (crc32(data) !== crc) throw new NovaFileError('not-zip', `entry ${name} fails its CRC check`);
    out.push({ name, data });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// XML

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Node) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);
const int = (v: unknown): number | null => {
  const s = text(v);
  return s !== null && /^-?\d+$/.test(s) ? Number(s) : null;
};
const float = (v: unknown): number | null => {
  const s = text(v);
  return s !== null && Number.isFinite(Number(s)) ? Number(s) : null;
};

export function parseRcfgxProperties(xml: Buffer): RcfgxProperties {
  let doc: Node;
  try {
    doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false }).parse(xml) as Node;
  } catch {
    throw new NovaFileError('xml-invalid', 'the XML cannot be parsed');
  }
  const root = asNode(doc['ScanBoardProperty']);
  if (!root) throw new NovaFileError('xml-invalid', 'the XML is not a ScanBoardProperty');
  const cfg = asNode(root['ConfigFileVersion']);
  const list = asNode(cfg?.['HWProgramVersionList']);
  const versions = list?.['ScanBoardVersionInfo'];
  const first = asNode(Array.isArray(versions) ? versions[0] : versions);
  const m = asNode(root['StandardLedModuleProp']) ?? {};
  return {
    novaLctVersion: text(root['RCFGXVersion']),
    formatVersion: text(root['NewRcfgxVersion']),
    cardModel: text(first?.['ScanBoardName']),
    cardProgramVersion: text(first?.['ProgramVersion']),
    moduleWidth: int(m['ModulePixelCols']),
    moduleHeight: int(m['ModulePixelRows']),
    cabinetWidth: int(root['Width']),
    cabinetHeight: int(root['Height']),
    moduleCols: int(root['ModuleCols']),
    moduleRows: int(root['ModuleRows']),
    chip: text(m['DriverChipType']),
    decoder: text(m['DecType']),
    scan: text(m['ScanType']),
    dataGroups: int(m['DataGroup']),
    physicalDataGroups: int(root['PhysicalDataGroupNum']),
    scanDirection: text(m['DataDirectType']),
    oePolarity: text(m['OEPolarity']),
    refreshNumPerVs: int(root['RefNumPerVs']),
    grayDepth: int(root['GrayDepth']),
    grayMode: text(root['GrayMode']),
    gamma: float(root['GammaValue']),
  };
}

// ---------------------------------------------------------------------------------------------
// known register names

let knownAddresses: Map<number, string[]> | undefined;
/** @novastar/native AddressMapping name(s) of an address, joined with ", "; undefined if unnamed. */
export function knownAddressName(address: number): string | undefined {
  if (!knownAddresses) {
    knownAddresses = new Map();
    for (const [key, value] of Object.entries(AddressMapping as unknown as Record<string, unknown>)) {
      if (typeof value !== 'number') continue;
      const names = knownAddresses.get(value);
      if (names) names.push(key);
      else knownAddresses.set(value, [key]);
    }
  }
  return knownAddresses.get(address)?.join(', ');
}

// ---------------------------------------------------------------------------------------------
// .rcfgx

export interface ParsedRcfgx {
  info: RcfgxInfo;
  /** Validated; kept in the main process only. */
  records: RcfgxRecord[];
}

const failure = (err: unknown): NovaParseFailure => {
  if (err instanceof NovaFileError) return { ok: false, reason: err.reason, message: err.message };
  return { ok: false, reason: 'xml-invalid', message: err instanceof Error ? err.message : String(err) };
};

export function parseRcfgx(file: { name: string; bytes: Uint8Array }): { ok: true; parsed: ParsedRcfgx } | NovaParseFailure {
  try {
    if (file.bytes.length > MAX_RCFGX_FILE_BYTES) throw new NovaFileError('too-large', 'the file is too large');
    const entries = readZip(file.bytes, (name) => (/\.xml$/i.test(name) ? MAX_XML_BYTES : MAX_BIN_BYTES));
    const xml = entries.find((e) => /\.xml$/i.test(e.name)) ?? entries[0];
    if (!xml) throw new NovaFileError('xml-missing', 'the archive has no XML entry');
    const bin = entries.find((e) => /\.bin$/i.test(e.name)) ?? entries.find((e) => e !== xml);
    const properties = parseRcfgxProperties(xml.data);
    if (!bin) throw new NovaFileError('no-records', 'the archive has no RCCB blob (no register writes to send)');
    const records = decodeRccb(bin.data);
    validateRcfgxRecords(records);
    const infos = describeRcfgxRecords(records, knownAddressName);
    const fileId = createHash('sha256').update(file.bytes).digest('hex').slice(0, 24);
    const info: RcfgxInfo = {
      fileId,
      fileName: file.name,
      fileSize: file.bytes.length,
      properties,
      recordCount: records.length,
      totalBytes: records.reduce((n, r) => n + r.data.length, 0),
      totalDelayMs: records.reduce((n, r) => n + r.delayMs, 0),
      records: infos,
      groups: groupRcfgxRecords(infos),
      commandRecords: infos.filter((r) => r.kind === 'command'),
    };
    return { ok: true, parsed: { info, records } };
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------------------------
// .scr

type ScreenLib = typeof import('@novastar/screen');
let screenLib: Promise<ScreenLib> | undefined;

/**
 * Load @novastar/screen on first use (it pulls the whole native codec set, ~0.6 s). typed-struct,
 * which it uses, sets its string helpers only after its own `import('debug')` / `import('iconv-lite')`
 * resolve (build/node.mjs), so a decode straight after the import throws "getString is not a
 * function". parseScr retries that specific error until the set-up has run.
 */
export function loadScreenLib(): Promise<ScreenLib> {
  screenLib ??= import('@novastar/screen');
  screenLib.catch(() => {
    screenLib = undefined; // allow a retry
  });
  return screenLib;
}

const KINDS: Record<number, ScrScreenKind> = { 0: 'simple', 1: 'standard', 2: 'complex', 3: 'irregular' };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function mapRegion(r: Node): ScrRegion {
  const points = r['ScreenPointList'];
  return {
    senderIndex: num(r['SenderIndex']),
    portIndex: num(r['PortIndex']),
    connectIndex: num(r['ConnectIndex']),
    x: num(r['X']),
    y: num(r['Y']),
    width: num(r['Width']),
    height: num(r['Height']),
    hasPointList: Array.isArray(points) && points.length > 0,
  };
}

export async function parseScr(file: { name: string; bytes: Uint8Array }): Promise<{ ok: true; info: ScrInfo } | NovaParseFailure> {
  try {
    if (file.bytes.length > MAX_SCR_FILE_BYTES) throw new NovaFileError('too-large', 'the file is too large');
    const lib = await loadScreenLib();
    let cfg: ReturnType<ScreenLib['decodeScreenConfig']>;
    const buf = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
    for (let attempt = 0; ; attempt++) {
      try {
        cfg = lib.decodeScreenConfig(buf);
        break;
      } catch (err) {
        // typed-struct still initialising (see loadScreenLib): wait for it, up to ~2 s in total.
        if (err instanceof TypeError && err.message.includes('getString') && attempt < 20) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        throw new NovaFileError('scr-invalid', err instanceof Error ? err.message : String(err));
      }
    }
    const screens: ScrScreen[] = (cfg.screens as unknown as Node[]).map((s) => {
      const regions = Array.isArray(s['ScannerRegionList']) ? (s['ScannerRegionList'] as Node[]).map(mapRegion) : [];
      const adjust = asNode(s['ScrAdjustParams']);
      return {
        kind: KINDS[num(s['Type'])] ?? 'unknown',
        x: num(s['X']),
        y: num(s['Y']),
        cols: num(s['ScanBdCols']),
        rows: num(s['ScanBdRows']),
        name: text(adjust?.['ScreenName']) ?? '',
        regions,
      };
    });
    const dvi = cfg.dviInfo as unknown as Node;
    const info: ScrInfo = {
      fileName: file.name,
      fileSize: file.bytes.length,
      version: num(cfg.version),
      dvi: { cols: num(dvi['DviPortCols']), rows: num(dvi['DviPortRows']), width: num(dvi['GraphicsWidth']), height: num(dvi['GraphicsHeight']) },
      screens,
      layout: scrToLayout(screens),
    };
    return { ok: true, info };
  } catch (err) {
    return failure(err);
  }
}
