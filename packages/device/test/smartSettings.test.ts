import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Packet, ResponseError, TimeoutError, Request } from '@novastar/codec';
import { DeviceError, rgbCodeToByte, type ReceiverTarget } from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { createDeviceService, createNetSessionFactory, type DeviceService, type SessionFactory, type SessionLike } from '../src/index.js';
import { SMART_REGISTERS as R } from '../src/features/smartSettings.js';

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

const CARD: ReceiverTarget = { scope: 'card', portIndex: 0, cardIndex: 0 };
const RGB = { red: 2, green: 0, blue: 1, virtualRed: 1 };

describe('register table', () => {
  // The addresses are re-derived from the generated library files, not retyped.
  const nodeRequire = createRequire(import.meta.url);
  const addressOf = (name: string, ...args: unknown[]): number => {
    const create = nodeRequire(`@novastar/native/api/${name}`) as (...a: unknown[]) => { address: number; deviceType: number };
    const req = create(...args);
    expect(req.deviceType, name).toBe(1); // receiving card
    return req.address;
  };

  it('matches req.address of every generated Read/Set function used', () => {
    const read = [0, 0, 0] as const;
    const set = [0, 0, 0, false] as const;
    const expected: Array<[keyof typeof R, string, unknown[]]> = [
      ['dataDirection', 'DataDirection', [0]],
      ['moduleWidth', 'ModuleWidth', [1]],
      ['moduleHeight', 'ModuleHeight', [1]],
      ['driverIc', 'DriverType', [1]],
      ['scanMode', 'ScanMode', [1]],
      ['oePolarity', 'OEPority', [0]],
      ['decodeType', 'DecodeType', [1]],
      ['dataGroups', 'PhysicalTotalDataGroupNum', [1]],
    ];
    for (const [key, name, value] of expected) {
      expect(addressOf(`Read${name}`, ...read), `Read${name}`).toBe(R[key]);
      expect(addressOf(`Set${name}`, ...set, ...value), `Set${name}`).toBe(R[key]);
    }
    expect(addressOf('ReadRgbCode', ...read)).toBe(R.rgbCode);
    expect(addressOf('SetRgbCode', ...set, 0, 1, 2, 0)).toBe(R.rgbCode);
  });

  it('has the documented values', () => {
    expect(R).toEqual({
      dataDirection: 33554441,
      moduleWidth: 33554442,
      moduleHeight: 33554443,
      driverIc: 33554444,
      scanMode: 33554445,
      oePolarity: 33554446,
      decodeType: 33554447,
      dataGroups: 33554459,
      rgbCode: 33554524,
    });
  });
});

describe('against the simulator', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;

  beforeAll(async () => {
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });
  afterEach(async () => {
    await service.dispose();
  });

  const mem = (port: number, card: number) =>
    sim.state.receivingCards.find((c) => c.portIndex === port && c.cardIndex === card)!.memory;
  const byte = (port: number, card: number, addr: number): number => mem(port, card).read(addr, 1)[0]!;

  const fresh = async (advanced = false): Promise<void> => {
    for (const c of sim.state.receivingCards) for (const addr of Object.values(R)) c.memory.write(addr, Buffer.alloc(2));
    service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 600,
    });
    id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await service.connect(id);
    if (advanced) expect(await service.login('admin')).toBe(true);
  };

  it('reads a snapshot of the addressed card only, normal level included', async () => {
    await fresh();
    const m = mem(1, 1);
    m.writeU8(R.moduleWidth, 64);
    m.writeU8(R.moduleHeight, 32);
    m.writeU8(R.scanMode, 16);
    m.writeU8(R.driverIc, 33);
    m.writeU8(R.decodeType, 3);
    m.writeU8(R.dataGroups, 8);
    m.writeU8(R.dataDirection, 1);
    m.writeU8(R.oePolarity, 1);
    m.writeU8(R.rgbCode, rgbCodeToByte(RGB));
    mem(0, 0).writeU8(R.moduleWidth, 128);

    expect(await service.readSmartSnapshot(id, 1, 1)).toEqual({
      portIndex: 1,
      cardIndex: 1,
      moduleWidth: 64,
      moduleHeight: 32,
      scanMode: 16,
      dataGroups: 8,
      driverIc: 33,
      decodeType: 3,
      dataDirection: 1,
      oePolarity: 1,
      rgb: RGB,
    });
    expect((await service.readSmartSnapshot(id, 0, 0)).moduleWidth).toBe(128);
  });

  it('refuses writes at normal level without touching the device (permission before validation)', async () => {
    await fresh();
    const before = sim.state.requestCount;
    await expectCode(service.writeSmartSettings(id, CARD, { oePolarity: 1 }), 'PERMISSION');
    await expectCode(service.writeSmartSettings(id, { scope: 'all' }, { oePolarity: 1 }), 'PERMISSION');
    await expectCode(service.writeSmartSettings(id, CARD, { oePolarity: 99 }), 'PERMISSION');
    await expectCode(service.writeSmartSettings(id, CARD, { oePolarity: 1 }, { restore: true }), 'PERMISSION');
    expect(sim.state.requestCount).toBe(before);
    expect(byte(0, 0, R.oePolarity)).toBe(0);
  });

  it('writes the exact bytes to exactly one card, in order, and reads them back', async () => {
    await fresh(true);
    const res = await service.writeSmartSettings(id, { scope: 'card', portIndex: 1, cardIndex: 0 }, {
      oePolarity: 1,
      rgb: RGB,
      dataDirection: 1,
      dataGroups: 12,
      decodeType: 7,
      driverIc: 40,
      scanMode: 24,
      moduleHeight: 48,
      moduleWidth: 96,
    });
    expect(res).toEqual({
      ok: true,
      written: ['moduleWidth', 'moduleHeight', 'scanMode', 'driverIc', 'decodeType', 'dataGroups', 'dataDirection', 'rgb', 'oePolarity'],
    });
    expect(byte(1, 0, R.moduleWidth)).toBe(96);
    expect(byte(1, 0, R.moduleHeight)).toBe(48);
    expect(byte(1, 0, R.scanMode)).toBe(24);
    expect(byte(1, 0, R.driverIc)).toBe(40);
    expect(byte(1, 0, R.decodeType)).toBe(7);
    expect(byte(1, 0, R.dataGroups)).toBe(12);
    expect(byte(1, 0, R.dataDirection)).toBe(1);
    expect(byte(1, 0, R.rgbCode)).toBe(0b01_01_00_10);
    expect(byte(1, 0, R.oePolarity)).toBe(1);
    for (const [p, c] of [[0, 0], [0, 1], [1, 1]] as const) {
      for (const addr of Object.values(R)) expect(byte(p, c, addr)).toBe(0);
    }
    expect(await service.readSmartSnapshot(id, 1, 0)).toMatchObject({ moduleWidth: 96, decodeType: 7, oePolarity: 1, rgb: RGB });
  });

  it('writes only the fields given', async () => {
    await fresh(true);
    mem(0, 0).writeU8(R.moduleWidth, 10);
    expect(await service.writeSmartSettings(id, CARD, { oePolarity: 1 })).toEqual({ ok: true, written: ['oePolarity'] });
    expect(byte(0, 0, R.oePolarity)).toBe(1);
    expect(byte(0, 0, R.moduleWidth)).toBe(10);
  });

  it('broadcasts to every card with scope all', async () => {
    await fresh(true);
    await service.writeSmartSettings(id, { scope: 'all' }, { oePolarity: 1, rgb: RGB });
    for (let i = 0; i < 100 && byte(1, 1, R.rgbCode) === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    for (const [p, c] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      expect(byte(p, c, R.oePolarity)).toBe(1);
      expect(byte(p, c, R.rgbCode)).toBe(rgbCodeToByte(RGB));
    }
  });

  it('restore mode writes values the wizard limits refuse', async () => {
    await fresh(true);
    const raw = { driverIc: 255, decodeType: 255, scanMode: 0, oePolarity: 255, dataDirection: 255, rgb: { red: 3, green: 3, blue: 3, virtualRed: 3 } };
    await expectCode(service.writeSmartSettings(id, CARD, raw), 'INVALID_ARGUMENT');
    expect((await service.writeSmartSettings(id, CARD, raw, { restore: true })).ok).toBe(true);
    expect(byte(0, 0, R.driverIc)).toBe(255);
    expect(byte(0, 0, R.decodeType)).toBe(255);
    expect(byte(0, 0, R.scanMode)).toBe(0);
    expect(byte(0, 0, R.oePolarity)).toBe(255);
    expect(byte(0, 0, R.dataDirection)).toBe(255);
    expect(byte(0, 0, R.rgbCode)).toBe(0xff);
  });

  it('validates arguments before any I/O and maps id / connection errors', async () => {
    await fresh(true);
    const before = sim.state.requestCount;
    await expectCode(service.readSmartSnapshot(id, -1, 0), 'INVALID_ARGUMENT');
    await expectCode(service.readSmartSnapshot(id, 255, 0), 'INVALID_ARGUMENT'); // would alias the broadcast port
    await expectCode(service.readSmartSnapshot(id, 0, 1.5), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, CARD, {}), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, CARD, { oePolarity: 2 }), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, CARD, { decodeType: 53 }), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, CARD, { rgb: { red: 0, green: 0, blue: 0, virtualRed: 0 } }), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, CARD, { bogus: 1 } as never), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, { scope: 'card', portIndex: 255, cardIndex: 0 }, { oePolarity: 1 }), 'INVALID_ARGUMENT');
    await expectCode(service.writeSmartSettings(id, { scope: 'x' } as never, { oePolarity: 1 }), 'INVALID_ARGUMENT');
    // a mix of valid and invalid fields writes nothing at all
    await expectCode(service.writeSmartSettings(id, CARD, { moduleWidth: 10, oePolarity: 9 }), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);
    expect(byte(0, 0, R.moduleWidth)).toBe(0);

    await expectCode(service.readSmartSnapshot('net:9.9.9.9:5200', 0, 0), 'NOT_FOUND');
    await expectCode(service.writeSmartSettings('nope', CARD, { oePolarity: 1 }), 'NOT_FOUND');
    await service.disconnect(id);
    await expectCode(service.readSmartSnapshot(id, 0, 0), 'NOT_CONNECTED');
    await expectCode(service.writeSmartSettings(id, CARD, { oePolarity: 1 }), 'NOT_CONNECTED');
  });

  it('reports a card that is not on the chain as a protocol error', async () => {
    await fresh();
    await expectCode(service.readSmartSnapshot(id, 1, 7), 'PROTOCOL');
  });
});

describe('with a fake session', () => {
  type Calls = Array<[string, ...unknown[]]>;

  function fake(overrides: Partial<Record<string, unknown>> = {}): { session: SessionLike; calls: Calls } {
    const calls: Calls = [];
    const rec =
      (name: string, ret: unknown) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return ret;
      };
    const base: Record<string, unknown> = {
      ReadControllerModelId: async () => 0x660,
      ReadSender_McuProgramEdition: async () => 0x01000000,
      ReadSender_FPGAProgramEdition: async () => 0x01000000,
      ReadScanerCountOfSenderCard: async () => Buffer.from([0]),
      ReadNumberOfCardOrScanBoardInPort: async () => 0,
      ReadScanner_McuProgramEdition: async () => 0,
      close: () => true,
    };
    const reads: Record<string, number> = {
      ReadModuleWidth: 40, ReadModuleHeight: 20, ReadScanMode: 8, ReadPhysicalTotalDataGroupNum: 4,
      ReadDriverType: 5, ReadDecodeType: 1, ReadDataDirection: 1, ReadOEPority: 1, ReadRgbCode: 0b11_10_01_00,
    };
    for (const [k, v] of Object.entries(reads)) base[k] = rec(k, v);
    for (const k of ['SetModuleWidth', 'SetModuleHeight', 'SetScanMode', 'SetPhysicalTotalDataGroupNum', 'SetDriverType', 'SetDecodeType', 'SetDataDirection', 'SetOEPority', 'SetRgbCode']) {
      base[k] = rec(k, undefined);
    }
    for (const [k, v] of Object.entries(overrides)) base[k] = v;
    return { session: base as unknown as SessionLike, calls };
  }

  async function setup(session: SessionLike): Promise<{ svc: DeviceService; id: string }> {
    const factory: SessionFactory = { open: async () => session };
    const svc = createDeviceService({ sessionFactory: factory, serialDiscovery: false });
    const [found] = await svc.discover({ netHosts: ['10.0.0.1'] });
    await svc.connect(found!.id);
    return { svc, id: found!.id };
  }

  const reject = async (): Promise<never> => {
    throw new ResponseError(new Packet(Packet.baseSize), 'unsupported');
  };

  it('addresses sender 0 / port / card on every read and decodes the rgb byte', async () => {
    const { session, calls } = fake();
    const { svc, id } = await setup(session);
    const snap = await svc.readSmartSnapshot(id, 2, 5);
    expect(snap).toEqual({
      portIndex: 2, cardIndex: 5, moduleWidth: 40, moduleHeight: 20, scanMode: 8, dataGroups: 4, driverIc: 5,
      decodeType: 1, dataDirection: 1, oePolarity: 1, rgb: { red: 0, green: 1, blue: 2, virtualRed: 3 },
    });
    const reads = calls.filter(([n]) => n.startsWith('Read'));
    expect(reads.map((c) => c[0])).toEqual([
      'ReadModuleWidth', 'ReadModuleHeight', 'ReadScanMode', 'ReadDriverType', 'ReadDecodeType',
      'ReadPhysicalTotalDataGroupNum', 'ReadDataDirection', 'ReadRgbCode', 'ReadOEPority',
    ]);
    for (const call of reads) expect(call.slice(1)).toEqual([0, 2, 5]);
    expect(calls.some(([n]) => n.startsWith('Set'))).toBe(false);
  });

  it('fails the whole snapshot when any register is refused, and maps the error', async () => {
    for (const name of ['ReadDataDirection', 'ReadOEPority', 'ReadRgbCode', 'ReadDecodeType']) {
      const { session } = fake({ [name]: reject });
      const { svc, id } = await setup(session);
      await expectCode(svc.readSmartSnapshot(id, 0, 0), 'PROTOCOL');
    }
    const { session } = fake({
      ReadOEPority: async () => {
        throw new TimeoutError(new Request(1), 'slow');
      },
    });
    const { svc, id } = await setup(session);
    await expectCode(svc.readSmartSnapshot(id, 0, 0), 'TIMEOUT');
  });

  it('sends acknowledged writes for one card and a broadcast write for all, with the exact arguments', async () => {
    const one = fake();
    const a = await setup(one.session);
    await a.svc.login('admin');
    await a.svc.writeSmartSettings(a.id, { scope: 'card', portIndex: 3, cardIndex: 4 }, {
      moduleWidth: 64, moduleHeight: 32, scanMode: 16, driverIc: 33, decodeType: 3, dataGroups: 8,
      dataDirection: 1, rgb: { red: 1, green: 0, blue: 2, virtualRed: 2 }, oePolarity: 1,
    });
    expect(one.calls).toEqual([
      ['SetModuleWidth', 0, 3, 4, false, 64],
      ['SetModuleHeight', 0, 3, 4, false, 32],
      ['SetScanMode', 0, 3, 4, false, 16],
      ['SetDriverType', 0, 3, 4, false, 33],
      ['SetDecodeType', 0, 3, 4, false, 3],
      ['SetPhysicalTotalDataGroupNum', 0, 3, 4, false, 8],
      ['SetDataDirection', 0, 3, 4, false, 1],
      ['SetRgbCode', 0, 3, 4, false, 1, 0, 2, 2],
      ['SetOEPority', 0, 3, 4, false, 1],
    ]);

    const all = fake();
    const b = await setup(all.session);
    await b.svc.login('admin');
    await b.svc.writeSmartSettings(b.id, { scope: 'all' }, { oePolarity: 0 });
    expect(all.calls).toEqual([['SetOEPority', 0, 0xff, 0xffff, true, 0]]);
  });

  it('encodes the rgb code through the native SetRgbCode (bytes on the wire)', async () => {
    // Real native encoder, captured request: no fake for SetRgbCode here.
    const sent: Array<{ address: number; port: number; rcvIndex: number; data: Buffer }> = [];
    const { session } = fake({
      SetRgbCode: async (...args: unknown[]) => {
        const create = createRequire(import.meta.url)('@novastar/native/api/SetRgbCode') as (...a: unknown[]) => { address: number; port: number; rcvIndex: number; data: Buffer };
        sent.push(create(...args));
      },
    });
    const { svc, id } = await setup(session);
    await svc.login('admin');
    await svc.writeSmartSettings(id, CARD, { rgb: { red: 2, green: 0, blue: 1, virtualRed: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.address).toBe(R.rgbCode);
    expect(Buffer.from(sent[0]!.data as unknown as Uint8Array)).toEqual(Buffer.from([0b01_01_00_10]));
  });

  it('returns a partial result naming the written fields when a later write fails', async () => {
    const { session, calls } = fake({
      SetDataDirection: async () => {
        throw new TimeoutError(new Request(1), 'slow');
      },
    });
    const { svc, id } = await setup(session);
    await svc.login('admin');
    const res = await svc.writeSmartSettings(id, CARD, { moduleWidth: 10, moduleHeight: 11, dataDirection: 1, oePolarity: 1 });
    expect(res).toMatchObject({ ok: false, written: ['moduleWidth', 'moduleHeight'], failed: { field: 'dataDirection', code: 'TIMEOUT' } });
    // later fields were not attempted
    expect(calls.map((c) => c[0])).toEqual(['SetModuleWidth', 'SetModuleHeight']);
  });

  it('rejects (not a partial result) when the very first write fails', async () => {
    const { session } = fake({ SetModuleWidth: reject });
    const { svc, id } = await setup(session);
    await svc.login('admin');
    await expectCode(svc.writeSmartSettings(id, CARD, { moduleWidth: 10, oePolarity: 1 }), 'PROTOCOL');
  });
});
