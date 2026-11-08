import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeviceError, type Cell, type PixelDisplay, type PixelFrame, type PixelMappingInputs, type PixelMappingStartRequest, type PixelPainter, type UserLevel } from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import {
  PIXEL_MAPPING_DELAYS,
  PIXEL_MAPPING_REGISTERS as REG,
  createDeviceService,
  createNetSessionFactory,
  createPixelMappingFeature,
  type DeviceService,
  type FeatureContext,
  type SessionLease,
} from '../src/index.js';
import type { SessionLike } from '../src/index.js';

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

const hex = (b: ArrayLike<number>): string => Buffer.from(Array.from(b)).toString('hex');

const EXAMPLE: PixelMappingInputs = { moduleWidth: 32, moduleHeight: 16, scanCount: 8, dataGroups: 2, dataDirection: 0 };
const marks = (): Cell[] => [
  ...Array.from({ length: 32 }, (_, x) => ({ x, y: 0 })),
  ...Array.from({ length: 7 }, (_, i) => ({ x: 0, y: i + 1 })),
];

// ---------------------------------------------------------------------------------------------
// Register table: every address re-derived from the generated library files.

describe('register table', () => {
  const nodeRequire = createRequire(import.meta.url);
  const create = (name: string, ...args: unknown[]): { address: number; deviceType: number } => {
    const fn = nodeRequire(`@novastar/native/api/${name}`) as (...a: unknown[]) => { address: number; deviceType: number };
    return fn(...args);
  };
  const bytes = (n: number): Buffer => Buffer.alloc(n);

  it('matches req.address and deviceType of the native Set/Read functions', () => {
    const rd = [0, 0, 0] as const; // addr, port, card
    const wr = [0, 0, 0, false] as const;
    // [register key, native name, extra Set args after (addr, port, card, broadcast), extra Read args after (addr, port, card)]
    const card: Array<[keyof typeof REG, string, unknown[]]> = [
      ['killMode', 'KillMode', [0]],
      ['selfTest', 'SelfTestMode', [0]],
      ['lockMode', 'LockMode', [0]],
      ['smartSetMode', 'SmartSetMode', [0]],
      ['dataDirection', 'DataDirection', [0]],
      ['scanMode', 'ScanMode', [1]],
      ['groupNumInModule', 'GroupNumInModule', [1]],
      ['controlWidth', 'ControlWidth', [1]],
      ['controlHeight', 'ControlHeight', [1]],
      ['physicalTotalDataGroupNum', 'PhysicalTotalDataGroupNum', [1]],
      ['totalPointInTable', 'TotalPointInTable', [1]],
      ['pointNumPerDrive', 'PointNumPerDrive', [1]],
      ['logicalTotalDataGroupNum', 'LogicalTotalDataGroupNum', [1]],
      ['rowsCtrlByDataGroup', 'RowsCtrlByDataGroup', [bytes(8)]],
      ['startPositionOfDataGroup', 'StartPositionOfDataGroup', [bytes(8)]],
      ['parameterReload', 'ParameterReloadFromSpiFlash', [0]],
      ['genLinearRunLineTable', 'GenLinearScanBoardRunLineTable', [0]],
      ['moduleScanSequenceInfo', 'ModuleScanSequenceInfo', [bytes(8)]],
    ];
    for (const [key, name, value] of card) {
      const set = create(`Set${name}`, ...wr, ...value);
      expect(set.address, `Set${name}`).toBe(REG[key].address);
      expect(set.deviceType, `Set${name}`).toBe(1);
      expect(REG[key].target).toBe('card');
    }
    // registers the library only has a setter for
    for (const [key, name] of [
      ['addrExtend', 'AddrExtend'],
      ['logicShiftUnitNumPerSubField', 'LogicShiftUnitNumPerSubField'],
      ['shiftUnitNumPerSubField', 'ShiftUnitNumPerSubField'],
    ] as const) {
      const set = create(`Set${name}`, ...wr, 1);
      expect(set.address, `Set${name}`).toBe(REG[key].address);
      expect(set.deviceType).toBe(1);
    }
    expect(create('SetRealPhysicalGroup', ...wr, 1).address).toBe(REG.realPhysicalGroupNum.address);
    // registers the library only has a reader for (the wizard writes them as plain requests)
    expect(create('ReadDataGroupSequence', ...rd).address).toBe(REG.dataGroupSequence.address);
    for (const [key, name] of [
      ['killMode', 'KillMode'],
      ['selfTest', 'SelfTestMode'],
      ['lockMode', 'LockMode'],
      ['smartSetMode', 'SmartSetMode'],
      ['dataDirection', 'DataDirection'],
      ['scanMode', 'ScanMode'],
      ['groupNumInModule', 'GroupNumInModule'],
      ['controlWidth', 'ControlWidth'],
      ['controlHeight', 'ControlHeight'],
      ['physicalTotalDataGroupNum', 'PhysicalTotalDataGroupNum'],
      ['totalPointInTable', 'TotalPointInTable'],
      ['pointNumPerDrive', 'PointNumPerDrive'],
      ['logicalTotalDataGroupNum', 'LogicalTotalDataGroupNum'],
      ['rowsCtrlByDataGroup', 'RowsCtrlByDataGroup'],
      ['startPositionOfDataGroup', 'StartPositionOfDataGroup'],
      ['moduleScanSequenceInfo', 'ModuleScanSequenceInfo'],
    ] as const) {
      expect(create(`Read${name}`, ...rd).address, `Read${name}`).toBe(REG[key].address);
    }
    // sender registers
    expect(create('SetSenderCardSmartSetMode', 0, false, Buffer.from([1])).address).toBe(REG.senderSmartMode.address);
    expect(create('SetSenderCardSmartSetMode', 0, false, Buffer.from([1])).deviceType).toBe(0);
    expect(create('SetDviOffsetX', 0, false, 0, 0).address).toBe(REG.dviOffsetX.address);
    expect(create('SetDviOffsetY', 0, false, 0, 0).address).toBe(REG.dviOffsetY.address);
    expect(create('ReadDviOffsetX', 0, 0).address).toBe(REG.dviOffsetX.address);
    expect(create('ReadDviOffsetY', 0, 0).address).toBe(REG.dviOffsetY.address);
    // DVI index i sits at + 8*i, so index 0 is the base address the wizard uses
    expect(create('SetDviOffsetX', 0, false, 0, 1).address).toBe(REG.dviOffsetX.address + 8);
    expect(REG.senderSmartMode.target).toBe('sender');
    // every table entry is covered above or below
    const covered = new Set<string>([...card.map((c) => c[0]), 'addrExtend', 'logicShiftUnitNumPerSubField', 'shiftUnitNumPerSubField', 'realPhysicalGroupNum', 'dataGroupSequence', 'senderSmartMode', 'dviOffsetX', 'dviOffsetY', 'moduleRunLineTable']);
    expect([...covered].sort()).toEqual(Object.keys(REG).sort());
  });

  it('point table address and size match AddressMapping', () => {
    const am = nodeRequire('@novastar/native/AddressMapping') as Record<string, number>; // module.exports = the enum
    expect(am.ModuleRunLineTableAddr).toBe(REG.moduleRunLineTable.address);
    expect(am.ModuleRunLineTableOccupancy).toBe(1664);
    expect(am.GenLinearScanBoardRunLineTableAddr).toBe(REG.genLinearRunLineTable.address);
    // The spec text writes the scan sequence as 0x1C000000 next to the decimal 469762304; the decimal
    // (the library's value) is 0x1C000100. 0x1C000000 is 469762048 = Scanner_GropSwapBase, a different thing.
    expect(am.Module_ScanSequenceInfoAddr).toBe(469762304);
    expect(am.Module_ScanSequenceInfoAddr).toBe(REG.moduleScanSequenceInfo.address);
    expect(am.Module_ScanSequenceInfoOccupancy).toBe(128);
    expect(am.Scanner_GropSwapBase).toBe(0x1c000000);
  });

  it('has the documented values (shared with the spec)', () => {
    const addresses = Object.fromEntries(Object.entries(REG).map(([k, v]) => [k, v.address]));
    expect(addresses).toEqual({
      senderSmartMode: 0x02000040,
      dviOffsetX: 0x02000028,
      dviOffsetY: 0x0200002a,
      killMode: 0x02000100,
      selfTest: 0x02000101,
      lockMode: 0x02000102,
      smartSetMode: 0x02000104,
      dataDirection: 0x02000009,
      scanMode: 0x0200000d,
      groupNumInModule: 0x02000010,
      dataGroupSequence: 0x02000011,
      controlWidth: 0x02000017,
      controlHeight: 0x02000019,
      physicalTotalDataGroupNum: 0x0200001b,
      totalPointInTable: 0x0200001d,
      pointNumPerDrive: 0x0200001f,
      logicalTotalDataGroupNum: 0x02000022,
      shiftUnitNumPerSubField: 0x02000032,
      rowsCtrlByDataGroup: 0x02000047,
      startPositionOfDataGroup: 0x02000083,
      addrExtend: 0x020000b5,
      logicShiftUnitNumPerSubField: 0x020000e8,
      realPhysicalGroupNum: 0x020001d6,
      parameterReload: 0x01000010,
      genLinearRunLineTable: 0x01000013,
      moduleRunLineTable: 0x03000000,
      moduleScanSequenceInfo: 0x1c000100,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fake controller: records every request and every pause in one ordered log.

interface Io {
  deviceType: number;
  address: number;
  port: number;
  card: number;
  broadcast: boolean;
  hex: string;
  length: number;
}
type Event =
  | ({ kind: 'read' } & Io)
  | ({ kind: 'write' } & Io)
  | { kind: 'sleep'; ms: number }
  | { kind: 'paint'; display: number; frame: PixelFrame }
  | { kind: 'hide' };

interface Fake {
  log: Event[];
  /** Register memory by `${deviceType}:${address}` per byte. */
  mem: Map<string, number>;
  failOnWrite?: (n: number, address: number) => Error | undefined;
  writes: number;
  maxLength: number;
  ctx: FeatureContext;
  painter: PixelPainter;
  sleep(ms: number): Promise<void>;
  feature: ReturnType<typeof createPixelMappingFeature>;
  held: boolean;
  setLevel(l: UserLevel['level']): void;
}

function makeFake(opts: { level?: UserLevel['level']; lease?: boolean } = {}): Fake {
  const f = {} as Fake;
  f.log = [];
  f.mem = new Map();
  f.writes = 0;
  f.maxLength = 1000;
  f.held = false;
  let level: UserLevel['level'] = opts.level ?? 'advanced';
  f.setLevel = (l) => {
    level = l;
  };
  const key = (dt: number, a: number): string => `${dt}:${a}`;
  const connection = {
    get maxLength() {
      return f.maxLength;
    },
    async send(req: { address: number; deviceType: number; port: number; rcvIndex: number; io: number; length: number; data: Buffer; broadcast?: boolean }) {
      const isWrite = req.io === 1;
      const data = isWrite ? Buffer.from(req.data) : Buffer.alloc(0);
      f.log.push({
        kind: isWrite ? 'write' : 'read',
        deviceType: req.deviceType,
        address: req.address,
        port: req.port,
        card: req.rcvIndex,
        broadcast: req.broadcast === true,
        hex: hex(data),
        length: req.length,
      });
      if (isWrite) {
        f.writes += 1;
        const err = f.failOnWrite?.(f.writes, req.address);
        if (err) throw err;
        data.forEach((b, i) => f.mem.set(key(req.deviceType, req.address + i), b));
        return { data: Buffer.alloc(0) };
      }
      const out = Buffer.alloc(req.length);
      for (let i = 0; i < req.length; i += 1) out[i] = f.mem.get(key(req.deviceType, req.address + i)) ?? 0;
      return { data: out };
    },
  };
  const session = { connection } as unknown as SessionLike;
  const lease: SessionLease = {
    run: (fn) => fn(session),
    held: () => f.held,
    release: () => {
      f.held = false;
    },
  };
  f.painter = {
    async listDisplays(): Promise<PixelDisplay[]> {
      return [{ index: 0, label: 'Display 1', width: 1920, height: 1080, primary: true }];
    },
    async show(display, frame) {
      f.log.push({ kind: 'paint', display, frame });
    },
    async hide() {
      f.log.push({ kind: 'hide' });
    },
  };
  f.sleep = async (ms) => {
    f.log.push({ kind: 'sleep', ms });
  };
  f.ctx = {
    withSession: (_id, fn) => fn(session),
    ...(opts.lease === false
      ? {}
      : {
          acquireExclusive: () => {
            f.held = true;
            return lease;
          },
        }),
    userLevel: () => ({ level }),
    timeoutMs: 1000,
  };
  f.feature = createPixelMappingFeature(f.ctx, { painter: f.painter, sleep: f.sleep });
  return f;
}

const CARD0: PixelMappingStartRequest = {
  target: { scope: 'card', portIndex: 0, cardIndex: 0 },
  reference: { portIndex: 0, cardIndex: 0 },
  inputs: EXAMPLE,
  display: 0,
};

const writesOf = (log: Event[]): Array<[number, number, string]> =>
  log.filter((e): e is Extract<Event, { kind: 'write' }> => e.kind === 'write').map((e) => [e.deviceType, e.address, e.hex]);

/** The geometry block of spec section E for the worked example, as [address, bytes]. */
const E_GEOMETRY: Array<[number, string]> = [
  [0x02000009, '00'],
  [0x02000010, '02'],
  [0x02000047, '0808080808080808'],
  [0x02000083, '0008101820283038'],
  [0x02000011, '10325476'],
  [0x02000017, '2000'],
  [0x02000019, '1000'],
  [0x0200001b, '02'],
  [0x020001d6, '02'],
  [0x0200001d, '2000'],
  [0x020000e8, '2000'],
  [0x02000032, '2000'],
  [0x0200001f, '2000'],
  [0x02000022, '08'],
  [0x02000104, '00'],
  [0x020000b5, '05'],
  [0x0200000d, '08'],
];
const R = 1; // receiving card
const S = 0; // sender

describe('start: the first marking step', () => {
  it('reads the snapshot, then writes the exact bytes in the spec order, with the 100 ms pause', async () => {
    const f = makeFake();
    // what the card and sender hold before
    f.mem.set(`${R}:${0x02000017}`, 128);
    f.mem.set(`${R}:${0x02000104}`, 2);
    f.mem.set(`${S}:${0x02000028}`, 7);
    const res = await f.feature.startPixelMapping('c', CARD0);
    expect(res.ok).toBe(true);
    expect(res.snapshot).toMatchObject({ portIndex: 0, cardIndex: 0, controlWidth: 128, smartSetMode: 2, dviOffsetX: 7, dviOffsetY: 0 });
    expect(res.snapshot.scanSequence).toHaveLength(128);

    const reads = f.log.filter((e) => e.kind === 'read') as Array<Extract<Event, { kind: 'read' }>>;
    expect(reads.map((r) => [r.deviceType, r.address, r.length])).toEqual([
      [R, 0x02000017, 2],
      [R, 0x02000019, 2],
      [R, 0x0200001d, 2],
      [R, 0x0200001f, 2],
      [R, 0x02000010, 1],
      [R, 0x02000104, 1],
      [R, 0x02000047, 8],
      [R, 0x02000083, 8],
      [R, 0x02000011, 4],
      [R, 0x1c000100, 128],
      [S, 0x02000028, 2],
      [S, 0x0200002a, 2],
    ]);
    // all reads happen before the first write
    const firstWrite = f.log.findIndex((e) => e.kind === 'write');
    expect(f.log.slice(0, firstWrite).every((e) => e.kind === 'read')).toBe(true);
    expect(reads.slice(0, 10).every((r) => r.port === 0 && r.card === 0)).toBe(true);

    const rest = f.log.slice(firstWrite).map((e) => (e.kind === 'write' ? `${e.deviceType}:${e.address.toString(16)}:${e.hex}:${e.port}:${e.card}:${e.broadcast}` : e.kind === 'sleep' ? `sleep ${e.ms}` : e.kind));
    expect(rest).toEqual([
      '0:2000040:01:0:0:false', // sender smart mode on
      '0:2000028:0000:0:0:false', // DVI offset X
      '0:200002a:0000:0:0:false', // DVI offset Y
      '1:2000100:00:0:0:false', // kill off
      '1:2000102:00:0:0:false', // lock off
      '1:2000101:00:0:0:false', // self test off (not frozen)
      ...E_GEOMETRY.map(([a, h]) => `1:${a.toString(16)}:${h}:0:0:false`),
      '1:1000013:00:0:0:false',
      'sleep 100',
      '1:1000013:00:0:0:false',
    ]);
    expect(PIXEL_MAPPING_DELAYS.betweenRunLineWrites).toBe(100);
    expect(res.written).toHaveLength(3 + 3 + 17 + 2);
    expect(f.held).toBe(true); // the controller stays locked for the wizard
  });

  it('never writes a chip timing, OE, gamma or save register', () => {
    const f = makeFake();
    return f.feature.startPixelMapping('c', CARD0).then(async () => {
      await f.feature.finishPixelMapping('c', marks());
      const forbidden = [0x0200_0027, 0x0200_0034, 0x0200_004f, 0x0200_0036, 0x0200_003e, 0x0200_0025, 0x0200_0026, 0x0200_000e, 0x0600_0000, 0x0100_0011, 0x0100_0001, 0x0100_009d, 0x0500_0000];
      const addrs = writesOf(f.log).map((w) => w[1]);
      for (const a of forbidden) expect(addrs).not.toContain(a);
      // the only 0x01 command registers written are 0x01000013 (run-line table)
      expect([...new Set(addrs.filter((a) => a >>> 24 === 0x01))]).toEqual([0x01000013]);
    });
  });

  it('lights a pixel by painting, without a single device request', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', { ...CARD0, display: 1, origin: { x: 100, y: 50 } });
    const before = f.log.length;
    const r = await f.feature.lightPixelMappingStep('c', 33);
    // step 33 = phase B, scan 2: n = 64 -> (0, 2) of the control window, shifted by the origin
    expect(f.log.slice(before)).toEqual([{ kind: 'paint', display: 1, frame: { width: 132, height: 114, x: 100, y: 52 } }]);
    expect(r.pixel).toEqual({ x: 100, y: 52 });
  });

  it('step pixels follow n = K*M*c + M*b + a: step 0 -> (0,0), step 31 -> (31,0), step 32 -> (0,1)', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    const frames: PixelFrame[] = [];
    for (const i of [0, 31, 32, 38]) {
      await f.feature.lightPixelMappingStep('c', i);
      frames.push((f.log.at(-1) as Extract<Event, { kind: 'paint' }>).frame);
    }
    expect(frames).toEqual([
      { width: 32, height: 64, x: 0, y: 0 },
      { width: 32, height: 64, x: 31, y: 0 },
      { width: 32, height: 64, x: 0, y: 1 },
      { width: 32, height: 64, x: 0, y: 7 },
    ]);
    await expectCode(f.feature.lightPixelMappingStep('c', 39), 'INVALID_ARGUMENT');
    await expectCode(f.feature.lightPixelMappingStep('c', -1), 'INVALID_ARGUMENT');
    await expectCode(f.feature.lightPixelMappingStep('c', 1.5), 'INVALID_ARGUMENT');
  });

  it('broadcast: needs confirmBroadcast, then goes to port 0xFF / card 0xFFFF with the broadcast flag (sender writes unaffected)', async () => {
    const f = makeFake();
    const all: PixelMappingStartRequest = { ...CARD0, target: { scope: 'all' } };
    await expectCode(f.feature.startPixelMapping('c', all), 'INVALID_ARGUMENT');
    await expectCode(f.feature.startPixelMapping('c', { ...all, confirmBroadcast: false }), 'INVALID_ARGUMENT');
    expect(f.log).toHaveLength(0);
    expect(f.held).toBe(false);
    await f.feature.startPixelMapping('c', { ...all, confirmBroadcast: true });
    const cardWrites = f.log.filter((e): e is Extract<Event, { kind: 'write' }> => e.kind === 'write' && e.deviceType === R);
    expect(cardWrites.length).toBeGreaterThan(20);
    expect(cardWrites.every((w) => w.port === 0xff && w.card === 0xffff && w.broadcast)).toBe(true);
    const senderWrites = f.log.filter((e): e is Extract<Event, { kind: 'write' }> => e.kind === 'write' && e.deviceType === S);
    expect(senderWrites.every((w) => !w.broadcast)).toBe(true);
    // the snapshot is read from the reference card, never by broadcast
    const reads = f.log.filter((e): e is Extract<Event, { kind: 'read' }> => e.kind === 'read' && e.deviceType === R);
    expect(reads.every((r) => r.port === 0 && r.card === 0)).toBe(true);
  });

  it('validates before touching the device', async () => {
    const f = makeFake();
    const bad = async (over: Partial<PixelMappingStartRequest>): Promise<void> => {
      await expectCode(f.feature.startPixelMapping('c', { ...CARD0, ...over }), 'INVALID_ARGUMENT');
      expect(f.log).toHaveLength(0);
      expect(f.held).toBe(false);
    };
    await bad({ inputs: { ...EXAMPLE, dataGroups: 9 } });
    await bad({ inputs: { ...EXAMPLE, scanCount: 65 } });
    await bad({ target: { scope: 'card', portIndex: -1, cardIndex: 0 } });
    await bad({ reference: { portIndex: 0, cardIndex: 1 } });
    await bad({ display: -1 });
    await bad({ origin: { x: 1.5, y: 0 } });
    await bad({ origin: { x: 70000, y: 0 } });
    await expectCode(f.feature.startPixelMapping('c', null as unknown as PixelMappingStartRequest), 'INVALID_ARGUMENT');
  });

  it('refuses to start without a painter, and twice', async () => {
    const f = makeFake();
    const noPainter = createPixelMappingFeature(f.ctx, { sleep: f.sleep });
    await expectCode(noPainter.startPixelMapping('c', CARD0), 'PROTOCOL');
    expect(await noPainter.listPixelDisplays('c')).toEqual([]);
    expect(f.log).toHaveLength(0);
    await f.feature.startPixelMapping('c', CARD0);
    await expectCode(f.feature.startPixelMapping('c', CARD0), 'INVALID_ARGUMENT');
    expect(await f.feature.getPixelMappingStatus('c')).toEqual({ stage: 'marking', stepCount: 39 });
  });
});

describe('finish: the final write', () => {
  it('writes sender off, freeze, geometry, point table, scan sequence, run-line x2, unfreeze, in order', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    const res = await f.feature.finishPixelMapping('c', marks());
    expect(res.ok).toBe(true);
    const table = Array.from({ length: 32 }, (_, i) => `${i.toString(16).padStart(2, '0')}00`).join('');
    const seen = f.log.map((e) => (e.kind === 'write' ? `${e.deviceType}:${e.address.toString(16)}:${e.hex}` : e.kind === 'sleep' ? `sleep ${e.ms}` : e.kind === 'read' ? 'READ' : e.kind));
    expect(seen).toEqual([
      '0:2000040:00', // sender leaves smart mode
      '1:2000101:20', // ParaFreeze
      ...E_GEOMETRY.map(([a, h]) => `1:${a.toString(16)}:${h}`),
      `1:3000000:${table}`, // point table (64 bytes), one chunk at maxLength 1000
      '1:1c000100:0001020304050607', // scan sequence
      '1:1000013:00',
      'sleep 100',
      '1:1000013:00',
      '1:2000100:00', // kill off
      '1:2000102:00', // lock off
      '1:2000101:00', // unfreeze
      'hide', // the marking picture is removed
    ]);
    expect(res.written.at(-1)).toBe('selfTest (unfreeze)');
    expect(f.held).toBe(false); // released
    expect(await f.feature.getPixelMappingStatus('c')).toEqual({ stage: 'idle', stepCount: 0 });
  });

  it('the freeze is the first card write and the unfreeze the last', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    await f.feature.finishPixelMapping('c', marks());
    const cardWrites = writesOf(f.log).filter((w) => w[0] === R);
    expect(cardWrites[0]).toEqual([R, 0x02000101, '20']);
    expect(cardWrites.at(-1)).toEqual([R, 0x02000101, '00']);
  });

  it('sends the point table in the connection\'s own chunks (same mechanism as the .rcfgx import)', async () => {
    const f = makeFake();
    f.maxLength = 20; // tiny chunks: the table needs several
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    await f.feature.finishPixelMapping('c', marks());
    const table = writesOf(f.log).filter(([, a]) => a >= 0x03000000 && a < 0x03000000 + 64);
    expect(table.length).toBeGreaterThan(1);
    expect(table.map((w) => w[2]).join('')).toBe(Array.from({ length: 32 }, (_, i) => `${i.toString(16).padStart(2, '0')}00`).join(''));
    // consecutive addresses, one chunk after the other
    let next = 0x03000000;
    for (const [, a, h] of table) {
      expect(a).toBe(next);
      next += h.length / 2;
    }
    expect(next).toBe(0x03000000 + 64);
  });

  it('a 832-entry table goes out complete in chunks', async () => {
    const f = makeFake();
    f.maxLength = 256;
    const big: PixelMappingInputs = { moduleWidth: 52, moduleHeight: 16, scanCount: 1, dataGroups: 1, dataDirection: 0 };
    await f.feature.startPixelMapping('c', { ...CARD0, inputs: big });
    const cells = Array.from({ length: 832 }, (_, i) => ({ x: i % 52, y: Math.floor(i / 52) }));
    f.log.length = 0;
    expect((await f.feature.finishPixelMapping('c', cells)).ok).toBe(true);
    const table = writesOf(f.log).filter(([, a]) => a >= 0x03000000 && a < 0x03000000 + 1664);
    expect(table.map((w) => w[2]).join('').length / 2).toBe(1664);
    expect(table.length).toBeGreaterThan(1);
  });

  it('restores a sender DVI offset the wizard moved, right after leaving smart mode', async () => {
    const f = makeFake();
    f.mem.set(`${S}:${0x02000028}`, 0x10);
    f.mem.set(`${S}:${0x0200002a}`, 0x20);
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    await f.feature.finishPixelMapping('c', marks());
    expect(writesOf(f.log).slice(0, 3)).toEqual([
      [S, 0x02000040, '00'],
      [S, 0x02000028, '1000'],
      [S, 0x0200002a, '2000'],
    ]);
  });

  it('re-validates the marks and sends nothing when they are bad', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    await expectCode(f.feature.finishPixelMapping('c', marks().slice(0, 38)), 'INVALID_ARGUMENT'); // incomplete
    const dup = marks();
    dup[1] = { x: 0, y: 0 };
    await expectCode(f.feature.finishPixelMapping('c', dup), 'INVALID_ARGUMENT');
    const jumpy = marks();
    jumpy[35] = { x: 0, y: 7 };
    await expectCode(f.feature.finishPixelMapping('c', jumpy), 'INVALID_ARGUMENT');
    await expectCode(f.feature.finishPixelMapping('c', 'x' as unknown as Cell[]), 'INVALID_ARGUMENT');
    expect(f.log).toHaveLength(0);
    expect(await f.feature.getPixelMappingStatus('c')).toMatchObject({ stage: 'marking' }); // still in the wizard
  });
});

describe('cancel / undo', () => {
  it('sender smart mode off, card smart mode off, reload from flash, 200 ms, then clear freeze/kill/lock', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    const res = await f.feature.cancelPixelMapping('c');
    expect(res.ok).toBe(true);
    expect(f.log.map((e) => (e.kind === 'write' ? `${e.deviceType}:${e.address.toString(16)}:${e.hex}:${e.port}:${e.card}:${e.broadcast}` : e.kind === 'sleep' ? `sleep ${e.ms}` : e.kind))).toEqual([
      'hide',
      '0:2000040:00:0:0:false',
      '1:2000104:00:0:0:false',
      '1:1000010:00:0:0:false',
      'sleep 200',
      '1:2000101:00:0:0:false',
      '1:2000100:00:0:0:false',
      '1:2000102:00:0:0:false',
    ]);
    expect(res.steps.map((s) => s.step)).toEqual(['senderSmartMode', 'smartSetMode', 'parameterReload', 'selfTest (unfreeze)', 'killMode', 'lockMode']);
    expect(f.held).toBe(false);
    expect(PIXEL_MAPPING_DELAYS.afterReload).toBe(200);
    // never a save
    expect(writesOf(f.log).map((w) => w[1])).not.toContain(0x01000011);
  });

  it('broadcasts the undo when the wizard broadcast, and restores a moved DVI offset', async () => {
    const f = makeFake();
    f.mem.set(`${S}:${0x02000028}`, 5);
    await f.feature.startPixelMapping('c', { ...CARD0, target: { scope: 'all' }, confirmBroadcast: true });
    f.log.length = 0;
    await f.feature.cancelPixelMapping('c');
    const w = f.log.filter((e): e is Extract<Event, { kind: 'write' }> => e.kind === 'write');
    expect(w.map((x) => [x.deviceType, x.address, x.hex, x.broadcast])).toEqual([
      [S, 0x02000040, '00', false],
      [S, 0x02000028, '0500', false],
      [R, 0x02000104, '00', true],
      [R, 0x01000010, '00', true],
      [R, 0x02000101, '00', true],
      [R, 0x02000100, '00', true],
      [R, 0x02000102, '00', true],
    ]);
  });

  it('with no wizard running it does nothing', async () => {
    const f = makeFake();
    expect(await f.feature.cancelPixelMapping('c')).toEqual({ ok: true, steps: [] });
    expect(f.log).toHaveLength(0);
  });

  it('tries every step even when one fails, reports each, and keeps the wizard locked for a retry', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    f.writes = 0;
    f.failOnWrite = (_n, address) => (address === 0x01000010 ? new Error('no answer') : undefined);
    const res = await f.feature.cancelPixelMapping('c');
    expect(res.ok).toBe(false);
    expect(res.steps.map((s) => [s.step, s.ok])).toEqual([
      ['senderSmartMode', true],
      ['smartSetMode', true],
      ['parameterReload', false],
      ['selfTest (unfreeze)', true],
      ['killMode', true],
      ['lockMode', true],
    ]);
    expect(res.steps[2]!.message).toMatch(/no answer/);
    expect(f.held).toBe(true);
    expect(await f.feature.getPixelMappingStatus('c')).toMatchObject({ stage: 'needs-undo' });
    // retry works and then releases
    f.failOnWrite = undefined;
    expect((await f.feature.cancelPixelMapping('c')).ok).toBe(true);
    expect(f.held).toBe(false);
  });
});

describe('permission', () => {
  it('normal level: every wizard call that writes or paints is refused first, before anything is read or sent', async () => {
    const f = makeFake({ level: 'normal' });
    await expectCode(f.feature.startPixelMapping('c', CARD0), 'PERMISSION');
    await expectCode(f.feature.startPixelMapping('c', { ...CARD0, inputs: { ...EXAMPLE, dataGroups: 99 } }), 'PERMISSION');
    await expectCode(f.feature.startPixelMapping('c', { ...CARD0, target: { scope: 'all' } }), 'PERMISSION');
    await expectCode(f.feature.lightPixelMappingStep('c', 0), 'PERMISSION');
    await expectCode(f.feature.finishPixelMapping('c', marks()), 'PERMISSION');
    await expectCode(f.feature.cancelPixelMapping('c'), 'PERMISSION');
    expect(f.log).toHaveLength(0);
    expect(f.held).toBe(false);
    // listing displays and the status are harmless
    expect(await f.feature.listPixelDisplays('c')).toHaveLength(1);
    expect(await f.feature.getPixelMappingStatus('c')).toEqual({ stage: 'idle', stepCount: 0 });
  });

  it('calls before start are refused', async () => {
    const f = makeFake();
    await expectCode(f.feature.lightPixelMappingStep('c', 0), 'INVALID_ARGUMENT');
    await expectCode(f.feature.finishPixelMapping('c', marks()), 'INVALID_ARGUMENT');
  });
});

describe('failures', () => {
  it('a snapshot read that fails stops everything: nothing written, nothing locked', async () => {
    const f = makeFake();
    const conn = (f.ctx as { withSession: FeatureContext['withSession'] }).withSession;
    void conn;
    // make reads of the scan sequence fail by replacing the lease
    const lease: SessionLease = {
      run: async (fn) =>
        fn({
          connection: {
            maxLength: 1000,
            send: async (req: { address: number; io: number; length: number }) => {
              f.log.push({ kind: 'read', deviceType: 1, address: req.address, port: 0, card: 0, broadcast: false, hex: '', length: req.length });
              if (req.address === 0x1c000100) throw new DeviceError('TIMEOUT', 'card did not answer');
              return { data: Buffer.alloc(req.length) };
            },
          },
        } as unknown as SessionLike),
      held: () => f.held,
      release: () => {
        f.held = false;
      },
    };
    const feature = createPixelMappingFeature({ ...f.ctx, acquireExclusive: () => ((f.held = true), lease) }, { painter: f.painter, sleep: f.sleep });
    await expectCode(feature.startPixelMapping('c', CARD0), 'TIMEOUT');
    expect(writesOf(f.log)).toEqual([]);
    expect(f.held).toBe(false);
    expect(await feature.getPixelMappingStatus('c')).toEqual({ stage: 'idle', stepCount: 0 });
  });

  it('the very first write failing rejects with the device error and unlocks (nothing to undo)', async () => {
    const f = makeFake();
    f.failOnWrite = () => new DeviceError('TIMEOUT', 'sender did not answer');
    await expectCode(f.feature.startPixelMapping('c', CARD0), 'TIMEOUT');
    expect(f.held).toBe(false);
    expect(await f.feature.getPixelMappingStatus('c')).toEqual({ stage: 'idle', stepCount: 0 });
  });

  it('a failure mid-start stops there, reports what went out and offers the undo', async () => {
    const f = makeFake();
    f.failOnWrite = (n) => (n === 8 ? new DeviceError('TIMEOUT', 'card timeout') : undefined); // 8th write = rowsCtrlByDataGroup? see assertion
    const res = await f.feature.startPixelMapping('c', CARD0);
    expect(res.ok).toBe(false);
    expect(res.failed).toMatchObject({ code: 'TIMEOUT', message: 'card timeout' });
    expect(res.written).toEqual(['senderSmartMode', 'dviOffsetX', 'dviOffsetY', 'killMode', 'lockMode', 'selfTest', 'dataDirection']);
    expect(res.failed!.step).toBe('groupNumInModule');
    // stopped: the failing write was the last request
    expect(writesOf(f.log)).toHaveLength(8);
    expect(f.held).toBe(true);
    expect(await f.feature.getPixelMappingStatus('c')).toMatchObject({ stage: 'needs-undo' });
    // while the card is in a mixed state, lighting and finishing are refused; only the undo is offered
    await expectCode(f.feature.lightPixelMappingStep('c', 0), 'INVALID_ARGUMENT');
    await expectCode(f.feature.finishPixelMapping('c', marks()), 'INVALID_ARGUMENT');
    f.failOnWrite = undefined;
    const undo = await f.feature.cancelPixelMapping('c');
    expect(undo.ok).toBe(true);
    expect(f.held).toBe(false);
  });

  it('a failure mid-finish stops there (no unfreeze, no further tables), reports, and the undo clears the freeze', async () => {
    const f = makeFake();
    await f.feature.startPixelMapping('c', CARD0);
    f.log.length = 0;
    f.failOnWrite = (_n, address) => (address === 0x1c000100 ? new DeviceError('PROTOCOL', 'bad ack') : undefined);
    const res = await f.feature.finishPixelMapping('c', marks());
    expect(res.ok).toBe(false);
    expect(res.failed).toMatchObject({ step: 'moduleScanSequenceInfo', code: 'PROTOCOL' });
    expect(res.written.slice(0, 2)).toEqual(['senderSmartMode', 'selfTest (freeze)']);
    expect(res.written).toContain('moduleRunLineTable');
    expect(res.written).not.toContain('genLinearRunLineTable');
    const addrs = writesOf(f.log).map((w) => w[1]);
    expect(addrs.at(-1)).toBe(0x1c000100); // stopped at the failure
    expect(f.held).toBe(true);
    expect(f.log.some((e) => e.kind === 'hide')).toBe(false);
    f.failOnWrite = undefined;
    f.log.length = 0;
    const undo = await f.feature.cancelPixelMapping('c');
    expect(undo.ok).toBe(true);
    expect(writesOf(f.log).slice(-3)).toEqual([[R, 0x02000101, '00'], [R, 0x02000100, '00'], [R, 0x02000102, '00']]);
  });

  it('a broadcast partial failure is reported the same way', async () => {
    const f = makeFake();
    f.failOnWrite = (n) => (n === 10 ? new Error('line down') : undefined);
    const res = await f.feature.startPixelMapping('c', { ...CARD0, target: { scope: 'all' }, confirmBroadcast: true });
    expect(res.ok).toBe(false);
    expect(res.failed?.code).toBe('PROTOCOL');
    expect(res.written).toHaveLength(9);
  });

  it('a painter error is a PROTOCOL error and leaves the wizard usable', async () => {
    const f = makeFake();
    const broken = createPixelMappingFeature(f.ctx, {
      painter: { ...f.painter, show: async () => Promise.reject(new Error('no such display')) },
      sleep: f.sleep,
    });
    await broken.startPixelMapping('c', CARD0);
    await expectCode(broken.lightPixelMappingStep('c', 0), 'PROTOCOL');
    expect(await broken.getPixelMappingStatus('c')).toMatchObject({ stage: 'marking' });
  });

  it('works with a context that has no lease support (plain per-call sessions)', async () => {
    const f = makeFake({ lease: false });
    const res = await f.feature.startPixelMapping('c', CARD0);
    expect(res.ok).toBe(true);
    expect((await f.feature.finishPixelMapping('c', marks())).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the device service and the simulator: the controller is locked while the wizard owns it.

describe('against the simulator (service, lease, real codec framing)', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;
  const painted: PixelFrame[] = [];
  const painter: PixelPainter = {
    listDisplays: async () => [{ index: 0, label: 'Display 1', width: 1920, height: 1080, primary: true }],
    show: async (_d, frame) => {
      painted.push(frame);
    },
    hide: async () => {},
  };

  beforeAll(async () => {
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });
  afterEach(async () => {
    await service.dispose();
  });

  const mem = (port: number, card: number) => sim.state.receivingCards.find((c) => c.portIndex === port && c.cardIndex === card)!.memory;

  const fresh = async (advanced = true): Promise<void> => {
    painted.length = 0;
    service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 600,
      pixelPainter: painter,
    });
    id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await service.connect(id);
    if (advanced) expect(await service.login('admin')).toBe(true);
  };

  it('runs the whole flow, locks other commands while it owns the controller, and releases it', async () => {
    await fresh();
    const res = await service.startPixelMapping(id, { ...CARD0, target: { scope: 'card', portIndex: 1, cardIndex: 1 }, reference: { portIndex: 1, cardIndex: 1 } });
    expect(res.ok).toBe(true);
    // geometry landed on exactly that card, the sender is in smart mode
    expect(mem(1, 1).read(0x02000017, 2).toString('hex')).toBe('2000');
    expect(mem(1, 1).read(0x02000083, 8).toString('hex')).toBe('0008101820283038');
    expect(mem(0, 0).read(0x02000017, 2).toString('hex')).toBe('0000');
    expect(sim.state.sendingCard.read(0x02000040, 1)[0]).toBe(1);

    // every other command is refused while the wizard owns the controller
    await expectCode(service.getBrightness(id), 'PROTOCOL');
    await expectCode(service.readSmartSnapshot(id, 1, 1), 'PROTOCOL');
    await expectCode(service.startPixelMapping(id, CARD0), 'INVALID_ARGUMENT');
    expect(await service.getPixelMappingStatus(id)).toEqual({ stage: 'marking', stepCount: 39 });

    await service.lightPixelMappingStep(id, 32);
    expect(painted.at(-1)).toEqual({ width: 32, height: 64, x: 0, y: 1 });

    const fin = await service.finishPixelMapping(id, marks());
    expect(fin.ok).toBe(true);
    expect(mem(1, 1).read(0x03000000, 64).toString('hex')).toBe(Array.from({ length: 32 }, (_, i) => `${i.toString(16).padStart(2, '0')}00`).join(''));
    expect(mem(1, 1).read(0x1c000100, 8).toString('hex')).toBe('0001020304050607');
    expect(mem(1, 1).read(0x02000101, 1)[0]).toBe(0); // unfrozen
    expect(sim.state.sendingCard.read(0x02000040, 1)[0]).toBe(0);
    expect(mem(0, 0).read(0x03000000, 4).toString('hex')).toBe('00000000'); // other cards untouched

    // released: normal commands work again
    await service.getBrightness(id);
    expect(await service.getPixelMappingStatus(id)).toEqual({ stage: 'idle', stepCount: 0 });
  });

  it('cancel undoes, releases and writes no save command', async () => {
    await fresh();
    await service.startPixelMapping(id, CARD0);
    await expectCode(service.getBrightness(id), 'PROTOCOL');
    const res = await service.cancelPixelMapping(id);
    expect(res.ok).toBe(true);
    expect(sim.state.sendingCard.read(0x02000040, 1)[0]).toBe(0);
    expect(mem(0, 0).read(0x02000104, 1)[0]).toBe(0);
    expect(mem(0, 0).read(0x01000010, 1)[0]).toBe(0);
    await service.getBrightness(id);
  });

  it('a broadcast reaches every card', async () => {
    await fresh();
    const res = await service.startPixelMapping(id, { ...CARD0, target: { scope: 'all' }, confirmBroadcast: true });
    expect(res.ok).toBe(true);
    for (const c of sim.state.receivingCards) expect(c.memory.read(0x0200001d, 2).toString('hex')).toBe('2000');
    await service.cancelPixelMapping(id);
  });

  it('normal level is refused with nothing sent', async () => {
    await fresh(false);
    const before = sim.state.requestCount;
    await expectCode(service.startPixelMapping(id, CARD0), 'PERMISSION');
    await expectCode(service.cancelPixelMapping(id), 'PERMISSION');
    expect(sim.state.requestCount).toBe(before);
    expect(await service.listPixelDisplays(id)).toHaveLength(1);
  });

  it('disconnecting ends the hold', async () => {
    await fresh();
    await service.startPixelMapping(id, CARD0);
    await service.disconnect(id);
    await service.connect(id);
    await service.getBrightness(id);
    expect(await service.getPixelMappingStatus(id)).toEqual({ stage: 'idle', stepCount: 0 });
  });
});
