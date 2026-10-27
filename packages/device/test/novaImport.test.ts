import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Request, ResponseError, Packet } from '@novastar/codec';
import {
  DeviceError,
  NOVA_IMPORT_METHODS,
  RCFGX_REGISTER_HIGH_BYTES,
  classifyRcfgxRecord,
  compareCardModel,
  scrToLayout,
  type ScrRegion,
  type ScrScreen,
  decodeRccb,
  validateRcfgxRecords,
  type NovaImportApi,
  type RcfgxInfo,
  type RcfgxRecord,
  type ReceiverTarget,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import {
  createDeviceService,
  createNetSessionFactory,
  createNovaImportFeature,
  knownAddressName,
  parseRcfgx,
  readZip,
  type SessionFactory,
  type SessionLike,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, 'fixtures', 'novalct', name)));
const SAMPLE = 'Q8_ICND2153_40x40.rcfgx';
const USER = 'user_NV7516_64x128_2x5.rcfgx';
const SCR = 'test.scr';

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

// ---------------------------------------------------------------------------------------------
// A tiny zip writer so the rejection tests can build archives (stored or deflate).

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean; badCrc?: boolean }>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const body = e.deflate ? deflateRawSync(e.data) : Buffer.from(e.data);
    const crc = e.badCrc ? 1 : crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const MIN_XML = '<?xml version="1.0"?><ScanBoardProperty><RCFGXVersion>NovaLCT V1</RCFGXVersion></ScanBoardProperty>';

/** Build an RCCB blob from records (same layout the decoder reads). */
function makeRccb(records: Array<{ address: number; data: number[]; delay?: number; polling?: number; wait?: number }>, over: { crc?: number; length?: number; magic?: string } = {}): Uint8Array {
  const parts: Buffer[] = [];
  for (const r of records) {
    const h = Buffer.alloc(32);
    h.writeUInt32LE(32 + r.data.length, 0);
    h.writeUInt16LE(1, 4);
    h.writeUInt32LE(r.address, 6);
    h.writeUInt32LE(r.data.length, 10);
    h.writeUInt16LE(r.delay ?? 0, 14);
    h.writeUInt16LE(r.polling ?? 0, 16);
    h.writeUInt16LE(r.wait ?? 0, 18);
    parts.push(h, Buffer.from(r.data));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(64);
  head.write(over.magic ?? 'RCCB', 0, 'ascii');
  head.writeUInt32LE(over.length ?? 64 + body.length, 4);
  let sum = 0x5555;
  for (const b of body) sum = (sum + b) & 0xffff;
  head.writeUInt16LE(over.crc ?? sum, 8);
  head.writeUInt16LE(1001, 10);
  return new Uint8Array(Buffer.concat([head, body]));
}
const rcfgx = (bin: Uint8Array | null, xml = MIN_XML): Uint8Array =>
  makeZip([{ name: 'a.xml', data: Buffer.from(xml) }, ...(bin ? [{ name: 'a.bin', data: bin }] : [])]);

const ok = (name: string, bytes: Uint8Array): { info: RcfgxInfo; records: RcfgxRecord[] } => {
  const res = parseRcfgx({ name, bytes });
  if (!res.ok) throw new Error(`${res.reason}: ${res.message}`);
  return res.parsed;
};

// ---------------------------------------------------------------------------------------------

describe('API table', () => {
  it('lists every NovaImportApi method', () => {
    expect(Object.keys(NOVA_IMPORT_METHODS).sort()).toEqual(['getRcfgxProgress', 'parseRcfgxFile', 'parseScreenFile', 'sendRcfgx']);
  });
});

describe('.rcfgx parsing: sample file (NovaLCT 5.3.0, MRV328)', () => {
  const { info, records } = ok(SAMPLE, fixture(SAMPLE));

  it('reads the header values', () => {
    expect(info.properties).toMatchObject({
      novaLctVersion: 'NovaLCT V5.3.0-14.09.2021 18:16:22',
      cardModel: 'MRV328',
      cardProgramVersion: '4.5.3.0',
      moduleWidth: 40,
      moduleHeight: 40,
      cabinetWidth: 200,
      cabinetHeight: 320,
      moduleCols: 5,
      moduleRows: 8,
      chip: 'Chip_ICN2053',
      decoder: 'ICN2012WEA',
      scan: 'Scan_5',
      dataGroups: 2,
      physicalDataGroups: 16,
      refreshNumPerVs: 359,
      grayDepth: 16,
      grayMode: 'Normallight',
      gamma: 28,
    });
  });

  it('counts records, bytes and delays exactly', () => {
    expect(info.recordCount).toBe(41);
    expect(records).toHaveLength(41);
    expect(info.totalBytes).toBe(6598);
    expect(info.totalDelayMs).toBe(25 + 2000);
    expect(info.fileSize).toBe(142152);
  });

  it('keeps file order and names the known addresses', () => {
    expect(info.records[0]).toMatchObject({ index: 0, address: 0x0200_0101, length: 1, delayMs: 25, kind: 'register' });
    expect(info.records[0]!.name).toContain('SelfTestMode');
    expect(info.records[1]).toMatchObject({ address: 0x0300_0800, length: 2048 });
    expect(info.records[40]).toMatchObject({ address: 0x0100_0012, length: 1, delayMs: 2000, kind: 'command', dataHex: '00' });
    expect(knownAddressName(0x0100_009d)).toContain('FlashCabinet');
  });

  it('lists the command records in order', () => {
    expect(info.commandRecords.map((r) => [r.address, r.length])).toEqual([
      [0x0100_0019, 11],
      [0x0100_0019, 11],
      [0x0100_005e, 11],
      [0x0100_005e, 11],
      [0x0100_009d, 1],
      [0x0100_0012, 1],
    ]);
  });

  it('groups by address', () => {
    expect(info.groups.length).toBeLessThan(41);
    const g = info.groups.find((x) => x.address === 0x0200_0101)!;
    expect(g.count).toBe(3);
    expect(g.bytes).toBe(3);
    expect(info.groups.reduce((n, x) => n + x.bytes, 0)).toBe(6598);
    expect(info.groups.reduce((n, x) => n + x.count, 0)).toBe(41);
  });

  it('exposes a stable file id and keeps data out of the summary', () => {
    expect(info.fileId).toMatch(/^[0-9a-f]{24}$/);
    expect(ok(SAMPLE, fixture(SAMPLE)).info.fileId).toBe(info.fileId);
    expect(JSON.stringify(info).length).toBeLessThan(40_000);
  });
});

describe('.rcfgx parsing: user file (NovaLCT 5.9.2, NV7516, 512 KiB record)', () => {
  const t0 = Date.now();
  const { info, records } = ok(USER, fixture(USER));
  const elapsed = Date.now() - t0;

  it('parses the 1 MB XML quickly', () => {
    expect(elapsed).toBeLessThan(3000);
  });

  it('reads the header values', () => {
    expect(info.properties).toMatchObject({
      novaLctVersion: 'NovaLCT V5.9.2-10/26/2026 12:00:40 PM',
      formatVersion: '2.0',
      cardModel: 'NV7516',
      cardProgramVersion: '1.3.3.45',
      moduleWidth: 64,
      moduleHeight: 128,
      cabinetWidth: 128,
      cabinetHeight: 640,
      moduleCols: 2,
      moduleRows: 5,
      decoder: 'HX6158H',
      scan: 'Scan_32',
      scanDirection: 'Vertical',
      oePolarity: 'HighEnable',
      dataGroups: 2,
      physicalDataGroups: 32,
      refreshNumPerVs: 64,
      grayDepth: 13,
    });
  });

  it('has 61 records, 532 212 bytes, one of 524 288 bytes at 0x04000000', () => {
    expect(info.recordCount).toBe(61);
    expect(info.totalBytes).toBe(532212);
    const big = records.filter((r) => r.data.length === 524288);
    expect(big).toHaveLength(1);
    expect(big[0]!.address).toBe(0x0400_0000);
    expect(info.totalDelayMs).toBe(25 * 4 + 2000);
  });

  it('command records: FlashCabinet then Recalculate last', () => {
    expect(info.commandRecords.map((r) => [r.address, r.delayMs])).toEqual([
      [0x0100_009d, 25],
      [0x0100_0012, 2000],
    ]);
    expect(info.records.at(-1)!.address).toBe(0x0100_0012);
  });

  it('every address of both real files is inside the allowlist', () => {
    const seen = new Set([...records, ...ok(SAMPLE, fixture(SAMPLE)).records].map((r) => r.address >>> 24));
    expect([...seen].sort((a, b) => a - b)).toEqual([0x01, ...RCFGX_REGISTER_HIGH_BYTES].sort((a, b) => a - b).filter((h) => seen.has(h)));
    expect([...seen].sort((a, b) => a - b)).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0e, 0x0f, 0x10, 0x11, 0x16, 0x1a, 0x1b, 0x1c, 0x24, 0x26, 0x28]);
  });
});

describe('.rcfgx rejection', () => {
  const fails = (bytes: Uint8Array, reason: string): void => {
    const res = parseRcfgx({ name: 'x.rcfgx', bytes });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe(reason);
  };
  const good = [{ address: 0x0200_0100, data: [1] }];

  it('accepts a minimal valid archive (stored and deflate)', () => {
    expect(parseRcfgx({ name: 'a', bytes: rcfgx(makeRccb(good)) }).ok).toBe(true);
    const deflated = makeZip([
      { name: 'a.xml', data: Buffer.from(MIN_XML), deflate: true },
      { name: 'a.bin', data: makeRccb(good), deflate: true },
    ]);
    expect(parseRcfgx({ name: 'a', bytes: deflated }).ok).toBe(true);
  });

  it('rejects things that are not zips', () => {
    fails(new Uint8Array([1, 2, 3, 4, 5]), 'not-zip');
    fails(new TextEncoder().encode('PK\x03\x04 but nothing else, padded padded padded'), 'not-zip');
    fails(new Uint8Array(0), 'not-zip');
  });

  it('rejects a zip entry with a bad CRC or a lying size', () => {
    fails(makeZip([{ name: 'a.xml', data: Buffer.from(MIN_XML), badCrc: true }]), 'not-zip');
  });

  it('rejects an archive without XML or without records', () => {
    fails(makeZip([]), 'xml-missing');
    fails(rcfgx(null), 'no-records');
    fails(rcfgx(makeRccb([])), 'no-records');
  });

  it('rejects XML that is not a ScanBoardProperty', () => {
    fails(rcfgx(makeRccb(good), '<Other/>'), 'xml-invalid');
    fails(rcfgx(makeRccb(good), 'not xml at all <<<'), 'xml-invalid');
  });

  it('rejects a damaged RCCB blob: magic, length, CRC, framing', () => {
    fails(rcfgx(makeRccb(good, { magic: 'XXXX' })), 'bin-invalid');
    fails(rcfgx(makeRccb(good, { length: 999 })), 'bin-invalid');
    fails(rcfgx(makeRccb(good, { crc: 1 })), 'bin-invalid');
    const trunc = makeRccb(good).slice(0, 70);
    fails(rcfgx(trunc), 'bin-invalid');
    const bytes = fixture(SAMPLE);
    const sample = readZip(bytes, () => 1 << 26).find((e) => e.name.endsWith('.bin'))!.data;
    const flipped = new Uint8Array(sample);
    flipped[200] = flipped[200]! ^ 0xff; // payload bit flip: the 16-bit sum no longer matches
    expect(() => decodeRccb(flipped)).toThrow(/CRC/);
  });

  it('rejects addresses outside the receiving-card register space, before anything else', () => {
    for (const address of [0x0000_0000, 0x0000_1234, 0x0700_0000, 0x0d00_0000, 0x1200_0000, 0x3000_0000, 0xff00_0000]) {
      fails(rcfgx(makeRccb([{ address, data: [1] }])), 'address-not-allowed');
    }
  });

  it('rejects unknown or dangerous 0x01 commands, including store-to-flash and reload', () => {
    for (const address of [0x0100_0011, 0x0100_0010, 0x0100_0001, 0x0100_0000, 0x0100_0013]) {
      fails(rcfgx(makeRccb([{ address, data: [1] }])), 'address-not-allowed');
    }
    fails(rcfgx(makeRccb([{ address: 0x0100_0012, data: new Array(17).fill(0) }])), 'address-not-allowed');
  });

  it('rejects a record that would run past its 16 MiB region', () => {
    fails(rcfgx(makeRccb([{ address: 0x04ff_ffff, data: [1, 2] }])), 'address-not-allowed');
  });

  it('rejects an absurd delay', () => {
    fails(rcfgx(makeRccb([{ address: 0x0200_0100, data: [1], delay: 60000 }])), 'record-invalid');
  });

  it('classifyRcfgxRecord distinguishes registers and commands', () => {
    expect(classifyRcfgxRecord(0x0200_0100, 1)).toBe('register');
    expect(classifyRcfgxRecord(0x0100_0012, 1)).toBe('command');
    expect(classifyRcfgxRecord(0x0100_0011, 1)).toBeNull();
    expect(classifyRcfgxRecord(0x0200_0100, 0)).toBeNull();
    expect(() => validateRcfgxRecords([])).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// .scr

describe('.scr parsing', () => {
  const api = createNovaImportFeature({ withSession: async () => undefined as never, userLevel: () => ({ level: 'normal' }), timeoutMs: 1 });

  it('reads the sample screen and converts it to a layout', async () => {
    const res = await api.parseScreenFile({ name: SCR, bytes: fixture(SCR) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.info.version).toBe(1006);
    expect(res.info.dvi).toEqual({ cols: 1, rows: 1, width: 128, height: 7 });
    expect(res.info.screens).toHaveLength(1);
    const s = res.info.screens[0]!;
    expect(s).toMatchObject({ kind: 'standard', cols: 5, rows: 3 });
    expect(s.regions).toHaveLength(15);
    expect(s.regions[4]).toMatchObject({ senderIndex: 0, portIndex: 1, connectIndex: 1, x: 40, y: 40, width: 40, height: 40 });
    expect(res.info.layout.ok).toBe(true);
    if (!res.info.layout.ok) return;
    const m = res.info.layout.model;
    expect(m.screen).toMatchObject({ kind: 'standard', rows: 3, cols: 5, cabinetWidth: 40, cabinetHeight: 40 });
    expect(m.ports.map((p) => [p.port, p.cabinets.length])).toEqual([[0, 5], [1, 5], [2, 5]]);
    expect(m.ports[1]!.cabinets[0]).toEqual({ row: 1, col: 0 });
    expect(m.ports[1]!.cabinets[1]).toEqual({ row: 1, col: 1 });
  });

  it('rejects a bad header, a bad CRC and a truncated file', async () => {
    const good = fixture(SCR);
    const badHeader = new Uint8Array(good);
    badHeader[0] = badHeader[0]! ^ 0xff;
    const badCrc = new Uint8Array(good);
    badCrc[300] = badCrc[300]! ^ 0x55; // inside the CRC-covered screen info (the trailing adjust block is not covered by the file CRC)
    for (const bytes of [badHeader, badCrc, good.slice(0, 40), new Uint8Array(0)]) {
      const res = await api.parseScreenFile({ name: 'x.scr', bytes });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('scr-invalid');
    }
  });

  it('refuses a file that is not { name, bytes }', async () => {
    await expectCode(api.parseScreenFile({ name: 'x', bytes: 'nope' } as never), 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------
// sendRcfgx with a fake session

interface Sent {
  address: number;
  bytes: Buffer;
  destination: number;
  port: number;
  rcvIndex: number;
  broadcast: boolean | undefined;
  deviceType: number;
  tag: string | undefined;
}

function fakeSession(opts: { maxLength?: number; failAtSend?: number; busyPolls?: number; log?: string[] } = {}) {
  const sent: Sent[] = [];
  const polls: number[] = [];
  let busy = opts.busyPolls ?? 0;
  let n = 0;
  const connection = {
    maxLength: opts.maxLength ?? 256,
    async send(req: Request<boolean>) {
      if (opts.failAtSend !== undefined && n === opts.failAtSend) {
        n += 1;
        throw new ResponseError(new Packet(Packet.baseSize), 'fake');
      }
      n += 1;
      sent.push({
        address: req.address,
        bytes: Buffer.from(req.data.subarray(0, req.length)),
        destination: req.destination,
        port: req.port,
        rcvIndex: req.rcvIndex,
        broadcast: req.broadcast,
        deviceType: req.deviceType,
        tag: req.tag,
      });
      opts.log?.push(`send ${req.address.toString(16)}+${req.length}`);
    },
    async trySend(req: Request<boolean>) {
      polls.push(req.address);
      opts.log?.push('poll');
      if (busy > 0) {
        busy -= 1;
        return { ack: 1 };
      }
      return { ack: 0 };
    },
  };
  return { session: { connection } as unknown as SessionLike, sent, polls };
}

function makeApi(level: 'normal' | 'advanced', session: SessionLike, sleeps: number[] = [], log?: string[]) {
  const withSession = async <T,>(_id: string, fn: (s: SessionLike) => Promise<T>): Promise<T> => fn(session);
  return createNovaImportFeature(
    { withSession, userLevel: () => ({ level }), timeoutMs: 1 },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
        log?.push(`sleep ${ms}`);
      },
    },
  );
}

const CARD: ReceiverTarget = { scope: 'card', portIndex: 1, cardIndex: 2 };
const OPTS = { confirmCardModel: 'MRV328', acknowledgeCommands: true };

/** The exact sequence the sample file must produce: (address, bytes) per chunk, from the raw records. */
function expectedChunks(records: RcfgxRecord[], maxLength: number): Array<{ address: number; bytes: Buffer }> {
  return records.flatMap((r) => {
    const out: Array<{ address: number; bytes: Buffer }> = [];
    for (let off = 0; off < r.data.length; off += maxLength) {
      out.push({ address: r.address + off, bytes: Buffer.from(r.data.subarray(off, off + maxLength)) });
    }
    return out;
  });
}

describe('sendRcfgx', () => {
  const sampleBytes = fixture(SAMPLE);
  const sampleRecords = ok(SAMPLE, sampleBytes).records;

  async function load(api: NovaImportApi, name: string, bytes: Uint8Array): Promise<RcfgxInfo> {
    const res = await api.parseRcfgxFile({ name, bytes });
    if (!res.ok) throw new Error(res.message);
    return res.info;
  }

  it('requires the advanced level', async () => {
    const { session, sent } = fakeSession();
    const api = makeApi('normal', session);
    const info = await load(api, SAMPLE, sampleBytes);
    await expectCode(api.sendRcfgx('c', info.fileId, CARD, OPTS), 'PERMISSION');
    expect(sent).toHaveLength(0);
  });

  it('sends every record in file order to one card with the exact addresses and bytes', async () => {
    const { session, sent } = fakeSession();
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    const res = await api.sendRcfgx('c', info.fileId, CARD, OPTS);
    expect(res).toMatchObject({ ok: true, recordsTotal: 41, recordsWritten: 41, bytesTotal: 6598, bytesWritten: 6598, commandRecordsWritten: 6 });
    const want = expectedChunks(sampleRecords, 256);
    expect(sent.map((s) => ({ address: s.address, bytes: s.bytes }))).toEqual(want);
    for (const s of sent) {
      expect(s).toMatchObject({ destination: 0, port: 1, rcvIndex: 2, broadcast: false, deviceType: 1 });
    }
    expect(sent[0]!.address).toBe(0x0200_0101);
    expect(sent.at(-1)!).toMatchObject({ address: 0x0100_0012, bytes: Buffer.from([0]) });
    // 2048-byte table at 0x03000800 is cut by the connection's own maxLength into 8 chunks
    const table = sent.filter((s) => s.address >= 0x0300_0800 && s.address < 0x0300_0800 + 2048 && s.tag?.startsWith('rcfgx:1'));
    expect(table).toHaveLength(8);
    expect(table.map((s) => s.address)).toEqual(Array.from({ length: 8 }, (_, i) => 0x0300_0800 + i * 256));
  });

  it('honours the connection maxLength (never an invented chunk size)', async () => {
    const { session, sent } = fakeSession({ maxLength: 100 });
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    await api.sendRcfgx('c', info.fileId, CARD, OPTS);
    expect(Math.max(...sent.map((s) => s.bytes.length))).toBe(100);
    expect(sent.map((s) => ({ address: s.address, bytes: s.bytes }))).toEqual(expectedChunks(sampleRecords, 100));
  });

  it('honours each record delay, in order, right after that record', async () => {
    const log: string[] = [];
    const { session } = fakeSession({ log });
    const api = makeApi('advanced', session, [], log);
    const info = await load(api, SAMPLE, sampleBytes);
    await api.sendRcfgx('c', info.fileId, CARD, OPTS);
    const sleeps = log.filter((l) => l.startsWith('sleep'));
    expect(sleeps).toEqual(['sleep 25', 'sleep 2000']);
    expect(log.indexOf('sleep 25')).toBe(1); // after the first (1 byte) write
    expect(log.at(-1)).toBe('sleep 2000'); // the recalculate command is last and waits 2 s
    expect(log.at(-2)).toBe('send 1000012+1');
  });

  it('broadcasts with port 0xFF / card 0xFFFF and the broadcast flag', async () => {
    const { session, sent } = fakeSession();
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    const res = await api.sendRcfgx('c', info.fileId, { scope: 'all' }, OPTS);
    expect(res.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(41);
    for (const s of sent) expect(s).toMatchObject({ destination: 0, port: 0xff, rcvIndex: 0xffff, broadcast: true });
  });

  it('sends the 512 KiB record in consecutive-address chunks of the connection size, with progress', async () => {
    const { session, sent } = fakeSession();
    const api = makeApi('advanced', session);
    const info = await load(api, USER, fixture(USER));
    const opts = { confirmCardModel: 'nv7516', acknowledgeCommands: true };
    const res = await api.sendRcfgx('c', info.fileId, CARD, opts);
    expect(res).toMatchObject({ ok: true, recordsTotal: 61, recordsWritten: 61, bytesWritten: 532212 });
    const big = sent.filter((s) => s.address >= 0x0400_0000 && s.address < 0x0400_0000 + 524288);
    expect(big).toHaveLength(2048);
    expect(big[0]!.address).toBe(0x0400_0000);
    expect(big[2047]!.address).toBe(0x0400_0000 + 2047 * 256);
    const reassembled = Buffer.concat(big.map((s) => s.bytes));
    const rec = ok(USER, fixture(USER)).records.find((r) => r.data.length === 524288)!;
    expect(reassembled.equals(Buffer.from(rec.data))).toBe(true);
    const progress = await api.getRcfgxProgress('c');
    expect(progress).toMatchObject({ running: false, recordsDone: 61, recordsTotal: 61, bytesDone: 532212, bytesTotal: 532212, failed: false });
  });

  it('refuses without the model confirmation or the command acknowledgement, and sends nothing', async () => {
    const { session, sent } = fakeSession();
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    await expectCode(api.sendRcfgx('c', info.fileId, CARD, { confirmCardModel: 'NV7516', acknowledgeCommands: true }), 'INVALID_ARGUMENT');
    await expectCode(api.sendRcfgx('c', info.fileId, CARD, { confirmCardModel: '', acknowledgeCommands: true }), 'INVALID_ARGUMENT');
    await expectCode(api.sendRcfgx('c', info.fileId, CARD, { confirmCardModel: 'MRV328', acknowledgeCommands: false }), 'INVALID_ARGUMENT');
    await expectCode(api.sendRcfgx('c', info.fileId, CARD, undefined as never), 'INVALID_ARGUMENT');
    expect(sent).toHaveLength(0);
  });

  it('refuses bad targets and unknown file ids', async () => {
    const { session, sent } = fakeSession();
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    await expectCode(api.sendRcfgx('c', info.fileId, { scope: 'card', portIndex: 255, cardIndex: 0 }, OPTS), 'INVALID_ARGUMENT');
    await expectCode(api.sendRcfgx('c', info.fileId, { scope: 'x' } as never, OPTS), 'INVALID_ARGUMENT');
    await expectCode(api.sendRcfgx('c', 'deadbeef', CARD, OPTS), 'INVALID_ARGUMENT');
    expect(sent).toHaveLength(0);
  });

  it('stops at the first failure and reports exactly how many records were written', async () => {
    // send #0 .. : record 0 (1 chunk), record 1 (2048 bytes = 8 chunks) ... fail on the 5th send = inside record 1
    const { session, sent } = fakeSession({ failAtSend: 4 });
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    const res = await api.sendRcfgx('c', info.fileId, CARD, OPTS);
    expect(res.ok).toBe(false);
    expect(res.recordsWritten).toBe(1);
    expect(res.bytesWritten).toBe(1);
    expect(res.failed).toMatchObject({ recordIndex: 1, address: 0x0300_0800, code: 'PROTOCOL' });
    expect(sent).toHaveLength(4); // nothing after the failed chunk
    expect(await api.getRcfgxProgress('c')).toMatchObject({ running: false, failed: true, recordsDone: 1 });
  });

  it('reports a failure on the very first record as zero written', async () => {
    const { session } = fakeSession({ failAtSend: 0 });
    const api = makeApi('advanced', session);
    const info = await load(api, SAMPLE, sampleBytes);
    const res = await api.sendRcfgx('c', info.fileId, CARD, OPTS);
    expect(res).toMatchObject({ ok: false, recordsWritten: 0, bytesWritten: 0, failed: { recordIndex: 0 } });
  });

  it('polls the busy register for a polling record, then waits 1000 + wait ms', async () => {
    const log: string[] = [];
    const { session, polls } = fakeSession({ busyPolls: 2, log });
    const bin = makeRccb([{ address: 0x0200_0100, data: [7], delay: 5, polling: 3000, wait: 0x8000 | 50 }]);
    const api = makeApi('advanced', session, [], log);
    const res = await api.parseRcfgxFile({ name: 'p.rcfgx', bytes: rcfgx(bin) });
    if (!res.ok) throw new Error(res.message);
    const sent = await api.sendRcfgx('c', res.info.fileId, CARD, { confirmCardModel: '', acknowledgeCommands: false });
    expect(sent.ok).toBe(true);
    expect(polls).toEqual([0x0200_0001, 0x0200_0001, 0x0200_0001]);
    expect(log).toEqual(['send 2000100+1', 'sleep 5', 'poll', 'sleep 200', 'poll', 'sleep 200', 'poll', 'sleep 1050']);
    // broadcasting a polling record is refused
    await expectCode(api.sendRcfgx('c', res.info.fileId, { scope: 'all' }, { confirmCardModel: '', acknowledgeCommands: false }), 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------
// through the service: no other command while a file is being sent

describe('service integration', () => {
  function serviceWith(session: SessionLike): ReturnType<typeof createDeviceService> {
    const factory: SessionFactory = { open: async () => session };
    return createDeviceService({ sessionFactory: factory, serialDiscovery: false });
  }
  const base = (over: Record<string, unknown>) =>
    ({
      ReadControllerModelId: async () => 0x660,
      ReadSender_McuProgramEdition: async () => 0x01000000,
      ReadSender_FPGAProgramEdition: async () => 0x01000000,
      ReadScanerCountOfSenderCard: async () => Buffer.from([0]),
      ReadNumberOfCardOrScanBoardInPort: async () => 0,
      ReadScanner_McuProgramEdition: async () => 0,
      ReadAllBrightnessInfo: async () => Buffer.from([255, 255, 255, 255, 255]),
      close: () => true,
      ...over,
    }) as unknown as SessionLike;

  it('refuses other commands (PROTOCOL busy) and a second send while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sends = 0;
    const session = base({
      connection: {
        maxLength: 256,
        async send() {
          sends += 1;
          if (sends === 1) await gate;
        },
        async trySend() {
          return { ack: 0 };
        },
      },
    });
    const svc = serviceWith(session);
    const [found] = await svc.discover({ netHosts: ['10.0.0.1'] });
    const id = found!.id;
    await svc.connect(id);
    await svc.login('admin');
    const parsed = await svc.parseRcfgxFile({ name: SAMPLE, bytes: fixture(SAMPLE) });
    if (!parsed.ok) throw new Error(parsed.message);
    const running = svc.sendRcfgx(id, parsed.info.fileId, CARD, OPTS);
    await new Promise((r) => setTimeout(r, 20));
    await expectCode(svc.getBrightness(id), 'PROTOCOL');
    await expectCode(svc.sendRcfgx(id, parsed.info.fileId, CARD, OPTS), 'PROTOCOL');
    expect(await svc.getRcfgxProgress(id)).toMatchObject({ running: true });
    release();
    const res = await running;
    expect(res.ok).toBe(true);
    expect(await svc.getBrightness(id)).toBeTruthy(); // free again
  });

  it('is rejected for H series ids and needs a connected controller', async () => {
    const svc = serviceWith(base({}));
    await expectCode(svc.sendRcfgx('hseries:1.2.3.4:6000', 'x', CARD, OPTS), 'INVALID_ARGUMENT');
    const [found] = await svc.discover({ netHosts: ['10.0.0.1'] });
    await svc.login('admin');
    const parsed = await svc.parseRcfgxFile({ name: SAMPLE, bytes: fixture(SAMPLE) });
    if (!parsed.ok) throw new Error(parsed.message);
    await expectCode(svc.sendRcfgx(found!.id, parsed.info.fileId, CARD, OPTS), 'NOT_CONNECTED');
  });
});

// ---------------------------------------------------------------------------------------------
// pure helpers

describe('scrToLayout', () => {
  const region = (port: number, connect: number, x: number, y: number, w = 40, h = 40, extra: Partial<ScrRegion> = {}): ScrRegion => ({
    senderIndex: 0, portIndex: port, connectIndex: connect, x, y, width: w, height: h, hasPointList: false, ...extra,
  });
  const screen = (regions: ScrRegion[], kind: ScrScreen['kind'] = 'standard'): ScrScreen => ({ kind, x: 0, y: 0, cols: 2, rows: 1, name: '', regions });
  const two = [region(0, 0, 0, 0), region(0, 1, 40, 0)];

  it('maps a one-row, one-port screen', () => {
    const res = scrToLayout([screen(two)]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model.ports).toEqual([{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }]);
  });

  it('keeps the chain order of the file (snake wiring)', () => {
    const snake = [region(0, 0, 0, 0), region(0, 1, 40, 0), region(0, 2, 40, 40), region(0, 3, 0, 40)];
    const res = scrToLayout([screen(snake)]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.model.ports[0]!.cabinets).toEqual([{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }, { row: 1, col: 0 }]);
  });

  const reasons = (screens: ScrScreen[]): string[] => {
    const res = scrToLayout(screens);
    return res.ok ? ['ok'] : res.reasons;
  };

  it('leaves everything that does not map cleanly read-only, with a reason', () => {
    expect(reasons([])).toEqual(['no-screens']);
    expect(reasons([screen(two), screen(two)])).toEqual(['several-screens']);
    expect(reasons([screen(two, 'complex')])).toEqual(['not-standard']);
    expect(reasons([screen(two, 'irregular')])).toEqual(['not-standard']);
    expect(reasons([screen(two, 'simple')])).toEqual(['not-standard']);
    expect(reasons([screen([region(0, 0, 0, 0), region(0, 1, 40, 0, 40, 40, { senderIndex: 1 })])])).toEqual(['several-senders']);
    expect(reasons([screen([region(0, 0, 0, 0, 40, 40, { hasPointList: true })])])).toEqual(['point-list']);
    expect(reasons([screen([region(0, 0, 0, 0), region(0, 2, 40, 0)])])).toEqual(['bad-chain']);
    expect(reasons([screen([region(0, 0, 0, 0), region(0, 1, 40, 7)])])).toEqual(['not-a-grid']);
    expect(reasons([screen([region(0, 0, 0, 0, 40, 40), region(0, 1, 40, 0, 40, 60)])])).toEqual(['not-standard']);
  });
});

describe('model comparison and send checks', () => {
  it('compares file and card models; unreadable models are unknown', () => {
    expect(compareCardModel('MRV328', 'MRV328')).toBe('match');
    expect(compareCardModel('MRV328', 'mrv328 (mock)')).toBe('match');
    expect(compareCardModel('MRV328', 'NV7516')).toBe('mismatch');
    expect(compareCardModel('MRV328', 'Unknown')).toBe('unknown');
    expect(compareCardModel('MRV328', 'Unknown (0x0660)')).toBe('unknown');
    expect(compareCardModel(null, 'A5s')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// the real codec over TCP against the simulator (chunking, acknowledgements, broadcast)

describe('against the simulator', () => {
  let sim: SimulatorHandle;
  beforeAll(async () => {
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });
  const mem = (port: number, card: number) => sim.state.receivingCards.find((c) => c.portIndex === port && c.cardIndex === card)!.memory;

  async function connect() {
    const svc = createDeviceService({ sessionFactory: createNetSessionFactory(), serialDiscovery: false });
    const id = `net:127.0.0.1:${sim.port}`;
    await svc.discover({ netHosts: [`127.0.0.1:${sim.port}`] });
    await svc.connect(id);
    await svc.login('admin');
    return { svc, id };
  }
  /** Replay the records in a local memory: what each address must hold afterwards. */
  const finalImage = (records: RcfgxRecord[]): Map<number, number> => {
    const image = new Map<number, number>();
    for (const r of records) r.data.forEach((b, i) => image.set(r.address + i, b));
    return image;
  };
  const matches = (m: { read(a: number, n: number): Buffer }, image: Map<number, number>): number => {
    let bad = 0;
    for (const [addr, value] of image) if (m.read(addr, 1)[0] !== value) bad += 1;
    return bad;
  };

  it('writes the sample to ONE card only', async () => {
    const { svc, id } = await connect();
    try {
      const parsed = ok(SAMPLE, fixture(SAMPLE));
      const info = await svc.parseRcfgxFile({ name: SAMPLE, bytes: fixture(SAMPLE) });
      if (!info.ok) throw new Error(info.message);
      const res = await svc.sendRcfgx(id, info.info.fileId, { scope: 'card', portIndex: 1, cardIndex: 1 }, OPTS);
      expect(res).toMatchObject({ ok: true, recordsWritten: 41, bytesWritten: 6598 });
      const image = finalImage(parsed.records);
      expect(matches(mem(1, 1), image)).toBe(0);
      for (const [p, c] of [[0, 0], [1, 0], [0, 1]] as const) expect(matches(mem(p, c), image)).toBeGreaterThan(100);
    } finally {
      await svc.dispose();
    }
  }, 30_000);

  it('writes the 512 KiB file to one card through the real codec chunking', async () => {
    const { svc, id } = await connect();
    try {
      const parsed = ok(USER, fixture(USER));
      const info = await svc.parseRcfgxFile({ name: USER, bytes: fixture(USER) });
      if (!info.ok) throw new Error(info.message);
      const res = await svc.sendRcfgx(id, info.info.fileId, { scope: 'card', portIndex: 0, cardIndex: 1 }, { confirmCardModel: 'NV7516', acknowledgeCommands: true });
      expect(res).toMatchObject({ ok: true, recordsWritten: 61, bytesWritten: 532212 });
      expect(matches(mem(0, 1), finalImage(parsed.records))).toBe(0);
      expect(matches(mem(0, 0), finalImage(parsed.records))).toBeGreaterThan(1000);
    } finally {
      await svc.dispose();
    }
  }, 60_000);

  it('broadcasts to every card (chunks keep the broadcast flag; ~50 ms pause per chunk)', async () => {
    const { svc, id } = await connect();
    try {
      const parsed = ok(SAMPLE, fixture(SAMPLE));
      const info = await svc.parseRcfgxFile({ name: SAMPLE, bytes: fixture(SAMPLE) });
      if (!info.ok) throw new Error(info.message);
      const res = await svc.sendRcfgx(id, info.info.fileId, { scope: 'all' }, OPTS);
      expect(res).toMatchObject({ ok: true, recordsWritten: 41, bytesWritten: 6598 });
      const image = finalImage(parsed.records);
      for (const c of sim.state.receivingCards) expect(matches(c.memory, image)).toBe(0);
    } finally {
      await svc.dispose();
    }
  }, 60_000);
});
