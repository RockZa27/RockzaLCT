import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Packet, ResponseError, TimeoutError, Request } from '@novastar/codec';
import {
  DeviceError,
  RECEIVER_METHODS,
  parseCabinetLibraryJson,
  parseCabinetProfileJson,
  serializeCabinetLibrary,
  serializeCabinetProfile,
  validateCabinetProfile,
  type CabinetProfile,
  type ReceiverTarget,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import {
  createDeviceService,
  createNetSessionFactory,
  type DeviceService,
  type SessionFactory,
  type SessionLike,
} from '../src/index.js';
import { RECEIVER_REGISTERS as R, type ReceiverSession } from '../src/features/receiver.js';

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

const PROFILE: CabinetProfile = {
  name: 'P3 indoor 64x32',
  width: 64,
  height: 32,
  scanMode: 16,
  dataGroups: 8,
  refNumPerVs: 3840,
  gamma: 28,
  grayDepth: 14,
  grayRealize: 1,
  grayMode: 2,
  driverIc: 33,
  icPerGroup: 4,
  note: 'unit test',
};

describe('library model (pure)', () => {
  it('lists every ReceiverApi method', () => {
    expect(Object.keys(RECEIVER_METHODS).sort()).toEqual(
      ['applyCabinetProfile', 'getReceiverParameters', 'setReceiverParameters'].sort(),
    );
  });

  it('round-trips a profile through JSON and normalises input', () => {
    const res = parseCabinetProfileJson(serializeCabinetProfile(PROFILE));
    expect(res).toEqual({ ok: true, profile: PROFILE });

    const messy = validateCabinetProfile({ ...PROFILE, name: '  Spaced  ', note: '   ', extra: 1, driverIc: null });
    expect(messy.ok).toBe(true);
    if (messy.ok) {
      expect(messy.profile.name).toBe('Spaced');
      expect(messy.profile).not.toHaveProperty('note');
      expect(messy.profile).not.toHaveProperty('extra');
      expect(messy.profile).not.toHaveProperty('driverIc');
    }
  });

  it('reports every bad field', () => {
    const res = validateCabinetProfile({ name: '', width: 0, height: 256, scanMode: 129, dataGroups: 1.5, refNumPerVs: 70000, gamma: -1, grayDepth: '8', grayRealize: 6, grayMode: 4, driverIc: 255, icPerGroup: 256 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.map((e) => e.field).sort()).toEqual(
        ['dataGroups', 'driverIc', 'gamma', 'grayDepth', 'grayMode', 'grayRealize', 'height', 'icPerGroup', 'name', 'refNumPerVs', 'scanMode', 'width'].sort(),
      );
    }
    expect(validateCabinetProfile(null).ok).toBe(false);
    expect(validateCabinetProfile([]).ok).toBe(false);
    expect(parseCabinetProfileJson('{nope').ok).toBe(false);
  });

  it('round-trips a library and rejects duplicates, wrong format and bad entries', () => {
    const other = { ...PROFILE, name: 'Other' };
    const text = serializeCabinetLibrary([PROFILE, other]);
    expect(parseCabinetLibraryJson(text)).toEqual({ ok: true, profiles: [PROFILE, other] });

    const dup = serializeCabinetLibrary([PROFILE, { ...PROFILE, name: PROFILE.name.toUpperCase() }]);
    const dupRes = parseCabinetLibraryJson(dup);
    expect(dupRes.ok).toBe(false);
    if (!dupRes.ok) expect(dupRes.errors[0]!.field).toBe('profiles[1].name');

    expect(parseCabinetLibraryJson('{"format":"x","version":1,"profiles":[]}').ok).toBe(false);
    expect(parseCabinetLibraryJson('{"format":"rockzalct.cabinet-library","version":2,"profiles":[]}').ok).toBe(false);
    const bad = parseCabinetLibraryJson('{"format":"rockzalct.cabinet-library","version":1,"profiles":[{"name":"a"}]}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.every((e) => e.field.startsWith('profiles[0].'))).toBe(true);
    expect(parseCabinetLibraryJson('not json').ok).toBe(false);
  });
});

describe('against the simulator', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;

  beforeAll(async () => {
    // 2 ports x 2 cards: sim card index k -> (port k % 2, chain position floor(k / 2)).
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
  const u16 = (port: number, card: number, addr: number): number => mem(port, card).read(addr, 2).readUInt16LE(0);

  const clearAll = (): void => {
    for (const c of sim.state.receivingCards) {
      for (const addr of Object.values(R)) c.memory.write(addr, Buffer.alloc(2));
    }
  };

  const seed = (port: number, card: number, v: Partial<Record<keyof typeof R, number>>, u16Keys: string[] = ['refNumPerVs']): void => {
    for (const [key, value] of Object.entries(v)) {
      const addr = R[key as keyof typeof R];
      if (u16Keys.includes(key)) mem(port, card).writeU16LE(addr, value);
      else mem(port, card).writeU8(addr, value);
    }
  };

  const fresh = async (advanced = false): Promise<void> => {
    clearAll();
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

  it('reads the seeded registers of the addressed card only', async () => {
    await fresh();
    seed(1, 1, {
      moduleWidth: 64,
      moduleHeight: 32,
      scanMode: 16,
      physicalDataGroups: 8,
      logicalDataGroups: 9,
      groupsPerModule: 2,
      moduleRows: 32,
      driverIc: 33,
      decodeType: 3,
      icPerGroup: 4,
      refNumPerVs: 0x0f00,
      grayDepth: 14,
      gamma: 28,
      voltage: 50,
    });
    mem(1, 1).writeU8(R.grayMode, (3 << 4) + 2); // Blance + Highlight
    mem(1, 1).write(R.temperature, Buffer.from([1, 41])); // [valid, value]
    seed(0, 0, { moduleWidth: 128, moduleHeight: 64, scanMode: 4 });

    expect(await service.getReceiverParameters(id, 1, 1)).toEqual({
      portIndex: 1,
      cardIndex: 1,
      moduleWidth: 64,
      moduleHeight: 32,
      scanMode: 16,
      physicalDataGroups: 8,
      logicalDataGroups: 9,
      groupsPerModule: 2,
      moduleRows: 32,
      driverIc: 33,
      decodeType: 3,
      icPerGroup: 4,
      refNumPerVs: 3840,
      grayDepth: 14,
      grayRealize: 3,
      grayMode: 2,
      gamma: 28,
      temperatureRaw: 41,
      voltageRaw: 50,
    });

    const other = await service.getReceiverParameters(id, 0, 0);
    expect(other).toMatchObject({ moduleWidth: 128, moduleHeight: 64, scanMode: 4, gamma: 0 });
    // temperature block flagged invalid (valid byte 0) is omitted
    expect(other).not.toHaveProperty('temperatureRaw');
  });

  it('refuses writes at normal level without touching the device', async () => {
    await fresh();
    const before = sim.state.requestCount;
    const target: ReceiverTarget = { scope: 'card', portIndex: 0, cardIndex: 0 };
    await expectCode(service.setReceiverParameters(id, target, { gamma: 20 }), 'PERMISSION');
    await expectCode(service.setReceiverParameters(id, { scope: 'all' }, { gamma: 20 }), 'PERMISSION');
    await expectCode(service.applyCabinetProfile(id, target, PROFILE), 'PERMISSION');
    // permission is checked before argument validation
    await expectCode(service.setReceiverParameters(id, target, { gamma: 9999 }), 'PERMISSION');
    expect(sim.state.requestCount).toBe(before);
    expect(byte(0, 0, R.gamma)).toBe(0);
    // reads are allowed at normal level
    await expect(service.getReceiverParameters(id, 0, 0)).resolves.toBeDefined();
  });

  it('writes refresh / gamma / grayscale to exactly one card', async () => {
    await fresh(true);
    await service.setReceiverParameters(id, { scope: 'card', portIndex: 1, cardIndex: 0 }, {
      refNumPerVs: 0x1234,
      gamma: 22,
      grayDepth: 13,
      grayRealize: 4,
      grayMode: 1,
    });
    expect(u16(1, 0, R.refNumPerVs)).toBe(0x1234);
    expect(byte(1, 0, R.gamma)).toBe(22);
    expect(byte(1, 0, R.grayDepth)).toBe(13);
    expect(byte(1, 0, R.grayMode)).toBe((4 << 4) + 1);
    for (const [p, c] of [[0, 0], [0, 1], [1, 1]] as const) {
      expect(byte(p, c, R.gamma)).toBe(0);
      expect(u16(p, c, R.refNumPerVs)).toBe(0);
      expect(byte(p, c, R.grayMode)).toBe(0);
    }
    expect(await service.getReceiverParameters(id, 1, 0)).toMatchObject({
      refNumPerVs: 0x1234,
      gamma: 22,
      grayDepth: 13,
      grayRealize: 4,
      grayMode: 1,
    });
  });

  it('read-modify-writes the shared gray-mode register for a partial update', async () => {
    await fresh(true);
    mem(0, 1).writeU8(R.grayMode, (2 << 4) + 1);
    await service.setReceiverParameters(id, { scope: 'card', portIndex: 0, cardIndex: 1 }, { grayMode: 3 });
    expect(byte(0, 1, R.grayMode)).toBe((2 << 4) + 3);
    await service.setReceiverParameters(id, { scope: 'card', portIndex: 0, cardIndex: 1 }, { grayRealize: 5 });
    expect(byte(0, 1, R.grayMode)).toBe((5 << 4) + 3);
  });

  it('broadcasts to every card with scope all', async () => {
    await fresh(true);
    await service.setReceiverParameters(id, { scope: 'all' }, { gamma: 30, refNumPerVs: 960, grayRealize: 2, grayMode: 0 });
    // a broadcast is fire-and-forget: give the simulator a moment to apply it
    for (let i = 0; i < 100 && byte(1, 1, R.grayMode) === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    for (const [p, c] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      expect(byte(p, c, R.gamma)).toBe(30);
      expect(u16(p, c, R.refNumPerVs)).toBe(960);
      expect(byte(p, c, R.grayMode)).toBe(2 << 4);
    }
    // gray halves must be given together for a broadcast
    await expectCode(service.setReceiverParameters(id, { scope: 'all' }, { grayMode: 1 }), 'INVALID_ARGUMENT');
  });

  it('applies a cabinet profile and reads it back', async () => {
    await fresh(true);
    await service.applyCabinetProfile(id, { scope: 'card', portIndex: 0, cardIndex: 1 }, PROFILE);
    expect(await service.getReceiverParameters(id, 0, 1)).toMatchObject({
      moduleWidth: 64,
      moduleHeight: 32,
      scanMode: 16,
      physicalDataGroups: 8,
      driverIc: 33,
      icPerGroup: 4,
      refNumPerVs: 3840,
      gamma: 28,
      grayDepth: 14,
      grayRealize: 1,
      grayMode: 2,
    });
    expect(byte(0, 0, R.moduleWidth)).toBe(0);

    // optional fields (driver IC, ICs per group) are left alone when the profile omits them
    mem(0, 0).writeU8(R.driverIc, 7);
    const { driverIc: _d, icPerGroup: _i, ...bare } = PROFILE;
    await service.applyCabinetProfile(id, { scope: 'card', portIndex: 0, cardIndex: 0 }, bare);
    expect(byte(0, 0, R.driverIc)).toBe(7);
    expect(byte(0, 0, R.icPerGroup)).toBe(0);
    expect(byte(0, 0, R.moduleHeight)).toBe(32);
  });

  it('validates arguments before any I/O and maps id / connection errors', async () => {
    await fresh(true);
    const before = sim.state.requestCount;
    const card: ReceiverTarget = { scope: 'card', portIndex: 0, cardIndex: 0 };
    await expectCode(service.getReceiverParameters(id, -1, 0), 'INVALID_ARGUMENT');
    await expectCode(service.getReceiverParameters(id, 0, 1.5), 'INVALID_ARGUMENT');
    await expectCode(service.getReceiverParameters(id, 255, 0), 'INVALID_ARGUMENT'); // would alias the broadcast port
    await expectCode(service.setReceiverParameters(id, card, {}), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, card, { gamma: 256 }), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, card, { refNumPerVs: 0 }), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, card, { grayMode: 4 }), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, card, { grayRealize: 6 }), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, card, { bogus: 1 } as never), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, { scope: 'card', portIndex: 255, cardIndex: 0 }, { gamma: 1 }), 'INVALID_ARGUMENT');
    await expectCode(service.setReceiverParameters(id, { scope: 'x' } as never, { gamma: 1 }), 'INVALID_ARGUMENT');
    await expectCode(service.applyCabinetProfile(id, card, { ...PROFILE, width: 0 }), 'INVALID_ARGUMENT');
    await expectCode(service.applyCabinetProfile(id, card, null as never), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);

    await expectCode(service.getReceiverParameters('net:9.9.9.9:5200', 0, 0), 'NOT_FOUND');
    await expectCode(service.setReceiverParameters('nope', card, { gamma: 1 }), 'NOT_FOUND');
    await service.disconnect(id);
    await expectCode(service.getReceiverParameters(id, 0, 0), 'NOT_CONNECTED');
    await expectCode(service.setReceiverParameters(id, card, { gamma: 1 }), 'NOT_CONNECTED');
    await expectCode(service.applyCabinetProfile(id, card, PROFILE), 'NOT_CONNECTED');
  });

  it('reports a card that is not on the chain as a protocol error (downstream timeout ack)', async () => {
    await fresh();
    await expectCode(service.getReceiverParameters(id, 1, 7), 'PROTOCOL');
  });
});

describe('with a fake session', () => {
  type Calls = Array<[string, ...unknown[]]>;

  function fake(overrides: Partial<Record<keyof ReceiverSession, unknown>> = {}): { session: SessionLike; calls: Calls } {
    const calls: Calls = [];
    const rec =
      (name: string, ret: unknown) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return ret;
      };
    const base: Record<string, unknown> = {
      // connect() needs these
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
      ReadLogicalTotalDataGroupNum: 4, ReadGroupNumInModule: 1, ReadModuelRows: 20, ReadDriverType: 5,
      ReadDecodeType: 1, ReadICNumber: 2, ReadRefNumPerVs: 1920, ReadGrayDepth: 12, ReadGrayMode: 0x21,
      ReadGamma: 22, ReadTempInfoOfScanCard: 0x2d01, ReadVoltageOfScanCard: 49,
    };
    for (const [k, v] of Object.entries(reads)) base[k] = rec(k, v);
    for (const k of ['SetModuleWidth', 'SetModuleHeight', 'SetScanMode', 'SetPhysicalTotalDataGroupNum', 'SetDriverType', 'SetICNumber', 'SetRefNumPerVs', 'SetGrayDepth', 'SetGrayMode', 'SetGamma']) {
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

  it('addresses sender 0 / port / card on every read and decodes the packed fields', async () => {
    const { session, calls } = fake();
    const { svc, id } = await setup(session);
    const p = await svc.getReceiverParameters(id, 2, 5);
    expect(p).toMatchObject({ grayRealize: 2, grayMode: 1, temperatureRaw: 0x2d, voltageRaw: 49, refNumPerVs: 1920 });
    const reads = calls.filter(([n]) => n.startsWith('Read'));
    expect(reads.length).toBeGreaterThanOrEqual(16);
    for (const call of reads) expect(call.slice(1)).toEqual([0, 2, 5]);
  });

  it('omits optional registers the card rejects but propagates real failures', async () => {
    const reject = async (): Promise<number> => {
      throw new ResponseError(new Packet(Packet.baseSize), 'unsupported');
    };
    const { session } = fake({ ReadICNumber: reject, ReadModuelRows: reject, ReadTempInfoOfScanCard: reject, ReadVoltageOfScanCard: reject });
    const { svc, id } = await setup(session);
    const p = await svc.getReceiverParameters(id, 0, 0);
    expect(p).not.toHaveProperty('icPerGroup');
    expect(p).not.toHaveProperty('moduleRows');
    expect(p).not.toHaveProperty('temperatureRaw');
    expect(p).not.toHaveProperty('voltageRaw');
    expect(p.moduleWidth).toBe(40);

    // a core register that errors fails the whole read, mapped to a DeviceError
    const failing = fake({ ReadGamma: reject });
    const b = await setup(failing.session);
    await expectCode(b.svc.getReceiverParameters(b.id, 0, 0), 'PROTOCOL');

    const timing = fake({
      ReadScanMode: async () => {
        throw new TimeoutError(new Request(1), 'slow');
      },
    });
    const c = await setup(timing.session);
    await expectCode(c.svc.getReceiverParameters(c.id, 0, 0), 'TIMEOUT');

    // an optional register that times out is NOT swallowed
    const optTimeout = fake({
      ReadICNumber: async () => {
        throw new TimeoutError(new Request(1), 'slow');
      },
    });
    const d = await setup(optTimeout.session);
    await expectCode(d.svc.getReceiverParameters(d.id, 0, 0), 'TIMEOUT');
  });

  it('uses acknowledged writes for one card and broadcast writes for all', async () => {
    const one = fake();
    const a = await setup(one.session);
    await a.svc.login('admin');
    await a.svc.setReceiverParameters(a.id, { scope: 'card', portIndex: 3, cardIndex: 4 }, { gamma: 25, grayMode: 3 });
    expect(one.calls).toContainEqual(['SetGamma', 0, 3, 4, false, 25]);
    // grayMode alone: current register 0x21 -> realize 2 kept, mode replaced
    expect(one.calls).toContainEqual(['ReadGrayMode', 0, 3, 4]);
    expect(one.calls).toContainEqual(['SetGrayMode', 0, 3, 4, false, 2, 3]);

    const all = fake();
    const b = await setup(all.session);
    await b.svc.login('admin');
    await b.svc.setReceiverParameters(b.id, { scope: 'all' }, { refNumPerVs: 600 });
    expect(all.calls).toEqual([['SetRefNumPerVs', 0, 0xff, 0xffff, true, 600]]);
  });

  it('applies a profile in geometry-first order', async () => {
    const { session, calls } = fake();
    const { svc, id } = await setup(session);
    await svc.login('admin');
    await svc.applyCabinetProfile(id, { scope: 'card', portIndex: 0, cardIndex: 0 }, PROFILE);
    expect(calls.map((c) => c[0])).toEqual([
      'SetModuleWidth', 'SetModuleHeight', 'SetScanMode', 'SetDriverType', 'SetICNumber',
      'SetPhysicalTotalDataGroupNum', 'SetRefNumPerVs', 'SetGamma', 'SetGrayDepth', 'SetGrayMode',
    ]);
    expect(calls).toContainEqual(['SetGrayMode', 0, 0, 0, false, 1, 2]);
    expect(calls).toContainEqual(['SetPhysicalTotalDataGroupNum', 0, 0, 0, false, 8]);
  });
});
