import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeviceError, type UserLevel } from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { createDeviceService, createNetSessionFactory, type DeviceService } from '../src/index.js';
import {
  createSenderFeature,
  inputSourceFromRaw,
  redundancyStateFromRaw,
  type SenderSession,
} from '../src/features/sender.js';
import type { FeatureContext } from '../src/features/context.js';
import type { SessionLike } from '../src/session.js';

// Register addresses, all taken from node_modules/@novastar/native/dist/api/<Name>.cjs (`req.address`).
const A = {
  dviWidth: 33554468, // ReadDviWidth / SetDviWidth (0x2000024) + 8*index
  dviHeight: 33554470, // ReadDviHeight / SetDviHeight (0x2000026) + 8*index
  hasSignal: 33554455, // ReadIsHasDVI (0x2000017)
  fieldRateMode: 33554440, // ReadFieldRateMode (0x2000008)
  fieldRate: 33554441, // ReadFieldRate / SetFieldRate (0x2000009)
  measuredRate: 33554460, // ReadDVI0FieldRate (0x200001C)
  dviSelect: 33554467, // ReadDviSelect / SetDviSelect_1 (0x2000023)
  portBase: 33554512, // ReadPortEnable / SetPortEnable (0x2000050) + 9*index, index < 4
  loadMode: 35651862, // ReadLoadMode (0x2200116)
  redundant: 33554456, // ReadSender_RedundantStateSpace (0x2000018), 8 bytes; overlaps ReadDVI0FieldRate (0x200001C)
  redundantNew: 33554584, // ReadSender_RedundantStateNewSpace (0x2000098), 8 bytes
} as const;
const portEnableAddr = (i: number): number => A.portBase + 9 * i;
const portWidthAddr = (i: number): number => A.portBase + 1 + 9 * i; // ReadPortWidth: 33554513 + 9*i
const portHeightAddr = (i: number): number => A.portBase + 3 + 9 * i; // ReadPortHeight: 33554515 + 9*i

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof DeviceError ? e.code : `non-DeviceError: ${String(e)}`),
  );

describe('sender feature against the simulator', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;

  beforeAll(async () => {
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });

  beforeEach(async () => {
    // Seed values the simulator does not provide itself (unwritten memory reads as zero).
    const m = sim.state.sendingCard;
    m.writeU16LE(A.dviWidth, 1920);
    m.writeU16LE(A.dviHeight, 1080);
    m.writeU8(A.hasSignal, 1);
    m.writeU8(A.fieldRateMode, 2);
    m.writeU16LE(A.fieldRate, 60);
    m.writeU8(A.dviSelect, 95); // DviSelectModeEnum.DP
    m.writeU8(portEnableAddr(0), 1);
    m.writeU16LE(portWidthAddr(0), 1024);
    m.writeU16LE(portHeightAddr(0), 512);
    m.writeU8(portEnableAddr(1), 0);
    m.writeU16LE(portWidthAddr(1), 640);
    m.writeU16LE(portHeightAddr(1), 480);
    m.writeU8(A.loadMode, 88); // SourceSelectLoadModeEnum.BackUpLoad
    m.write(A.redundant, Buffer.from([0, 1, 255, 7, 0, 0, 0, 0]));
    m.write(A.redundantNew, Buffer.from([1, 0, 0, 0, 0, 0, 0, 2]));
    // Written after the redundant block on purpose: bytes 4..5 of that block ARE this register.
    m.writeU16LE(A.measuredRate, 5994);

    service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 1500,
    });
    id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await service.connect(id);
  });
  afterEach(async () => {
    await service.dispose();
  });

  it('reads input resolution, rates, signal and source from the device', async () => {
    expect(await service.getSenderVideo(id)).toEqual({
      signalPresent: true,
      resolution: { width: 1920, height: 1080 },
      fieldRateMode: 2,
      fieldRate: 60,
      measuredFieldRate: 5994,
      inputSource: 'DP',
      inputSourceRaw: 95,
    });
  });

  it('reports an unmapped input-select value as null with the raw value kept', async () => {
    sim.state.sendingCard.writeU8(A.dviSelect, 200);
    const v = await service.getSenderVideo(id);
    expect(v.inputSource).toBeNull();
    expect(v.inputSourceRaw).toBe(200);
  });

  it('reads per-port enable, loaded area, pixels and receiving-card count', async () => {
    expect(await service.getSenderPorts(id)).toEqual([
      { portIndex: 0, enabled: true, width: 1024, height: 512, pixels: 524288, receivingCards: 2 },
      { portIndex: 1, enabled: false, width: 640, height: 480, pixels: 307200, receivingCards: 2 },
    ]);
  });

  it('reads load mode and both redundant-state blocks', async () => {
    const r = await service.getSenderRedundancy(id);
    expect(r.loadMode).toBe('backup');
    const [legacy, fresh] = r.spaces;
    expect(legacy!.space).toBe('legacy');
    // bytes 4..5 hold the DVI0 field rate (5994 = 0x176A) because the vendor ranges overlap
    expect(legacy!.raw).toEqual([0, 1, 255, 7, 0x6a, 0x17, 0, 0]);
    expect(legacy!.ports.slice(0, 4).map((p) => p.state)).toEqual(['ok', 'error', 'unknown', 'unknown']);
    expect(fresh!.space).toBe('new');
    expect(fresh!.raw).toEqual([1, 0, 0, 0, 0, 0, 0, 2]);
    expect(fresh!.ports.map((p) => p.state)).toEqual(['error', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'unknown']);
    sim.state.sendingCard.writeU8(A.loadMode, 0);
    expect((await service.getSenderRedundancy(id)).loadMode).toBe('high-load');
    sim.state.sendingCard.writeU8(A.loadMode, 9);
    expect((await service.getSenderRedundancy(id)).loadMode).toBe('unknown');
  });

  it('refuses every hardware write at the normal level and leaves the device untouched', async () => {
    const before = sim.state.requestCount;
    expect(await codeOf(service.setSenderResolution(id, { width: 1280, height: 720 }))).toBe('PERMISSION');
    expect(await codeOf(service.setSenderFieldRate(id, 50))).toBe('PERMISSION');
    expect(await codeOf(service.setSenderInputSource(id, 'HDMI'))).toBe('PERMISSION');
    expect(await codeOf(service.setSenderPortEnabled(id, 1, true))).toBe('PERMISSION');
    expect(sim.state.requestCount).toBe(before); // not a single request reached the simulator
    expect(sim.state.sendingCard.read(A.dviWidth, 2).readUInt16LE(0)).toBe(1920);
    expect(sim.state.sendingCard.readU8(portEnableAddr(1))).toBe(0);
  });

  describe('as an advanced user', () => {
    beforeEach(async () => {
      expect(await service.login('admin')).toBe(true);
    });

    it('writes the resolution to the width/height registers and returns the read-back', async () => {
      const v = await service.setSenderResolution(id, { width: 1280, height: 720 });
      expect(v.resolution).toEqual({ width: 1280, height: 720 });
      expect(sim.state.sendingCard.read(A.dviWidth, 2).readUInt16LE(0)).toBe(1280);
      expect(sim.state.sendingCard.read(A.dviHeight, 2).readUInt16LE(0)).toBe(720);
    });

    it('writes the field rate register', async () => {
      const v = await service.setSenderFieldRate(id, 50);
      expect(v.fieldRate).toBe(50);
      expect(sim.state.sendingCard.read(A.fieldRate, 2).readUInt16LE(0)).toBe(50);
    });

    it('writes the DviSelectMode value for the chosen input source', async () => {
      const v = await service.setSenderInputSource(id, 'HDMI1');
      expect(v.inputSource).toBe('HDMI1');
      expect(sim.state.sendingCard.readU8(A.dviSelect)).toBe(90);
      expect((await service.setSenderInputSource(id, 'LVDS')).inputSourceRaw).toBe(107);
    });

    it('enables and disables a single port without touching the others', async () => {
      const on = await service.setSenderPortEnabled(id, 1, true);
      expect(on.map((p) => p.enabled)).toEqual([true, true]);
      expect(sim.state.sendingCard.readU8(portEnableAddr(1))).toBe(1);
      const off = await service.setSenderPortEnabled(id, 0, false);
      expect(off.map((p) => p.enabled)).toEqual([false, true]);
      expect(sim.state.sendingCard.readU8(portEnableAddr(0))).toBe(0);
    });

    it('rejects bad arguments without writing', async () => {
      const before = sim.state.requestCount;
      for (const bad of [
        { width: 0, height: 10 },
        { width: 10, height: 70000 },
        { width: 1.5, height: 10 },
        { width: NaN, height: 10 },
        {} as { width: number; height: number },
      ]) {
        expect(await codeOf(service.setSenderResolution(id, bad))).toBe('INVALID_ARGUMENT');
      }
      expect(await codeOf(service.setSenderFieldRate(id, -1))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(service.setSenderFieldRate(id, 65536))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(service.setSenderInputSource(id, 'VGA' as never))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(service.setSenderInputSource(id, 'toString' as never))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(service.setSenderPortEnabled(id, -1, true))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(service.setSenderPortEnabled(id, 32, true))).toBe('INVALID_ARGUMENT');
      expect(await codeOf(service.setSenderPortEnabled(id, 0, 'yes' as never))).toBe('INVALID_ARGUMENT');
      expect(sim.state.requestCount).toBe(before);
    });
  });

  it('reports NOT_FOUND / NOT_CONNECTED like the rest of the service', async () => {
    expect(await codeOf(service.getSenderVideo('net:nope:1'))).toBe('NOT_FOUND');
    await service.disconnect(id);
    expect(await codeOf(service.getSenderPorts(id))).toBe('NOT_CONNECTED');
    expect(await codeOf(service.getSenderRedundancy(id))).toBe('NOT_CONNECTED');
  });
});

describe('sender feature with a fake session', () => {
  const calls: string[] = [];
  let level: UserLevel['level'];

  const fake = (over: Partial<SenderSession> = {}): SenderSession => {
    const rec =
      <T>(name: string, value: T) =>
      async (...args: unknown[]): Promise<T> => {
        calls.push(`${name}(${args.join(',')})`);
        return value;
      };
    return {
      ReadDviWidth: rec('ReadDviWidth', 800),
      ReadDviHeight: rec('ReadDviHeight', 600),
      SetDviWidth: rec('SetDviWidth', undefined),
      SetDviHeight: rec('SetDviHeight', undefined),
      ReadIsHasDVI: rec('ReadIsHasDVI', 0),
      ReadFieldRateMode: rec('ReadFieldRateMode', 0),
      ReadFieldRate: rec('ReadFieldRate', 0),
      SetFieldRate: rec('SetFieldRate', undefined),
      ReadDVI0FieldRate: rec('ReadDVI0FieldRate', 0),
      ReadDviSelect: rec('ReadDviSelect', 88),
      SetDviSelect_1: rec('SetDviSelect_1', undefined),
      ReadScanerCountOfSenderCard: rec('ReadScanerCountOfSenderCard', Buffer.from([0, 3, 0, 1, 0])),
      ReadNumberOfCardOrScanBoardInPort: async (_a, port) => (port === 1 ? 3 : 1),
      ReadPortEnable: rec('ReadPortEnable', 1),
      SetPortEnable: rec('SetPortEnable', undefined),
      ReadPortWidth: rec('ReadPortWidth', 100),
      ReadPortHeight: rec('ReadPortHeight', 50),
      ReadLoadMode: rec('ReadLoadMode', 0),
      ReadSender_RedundantStateSpace: rec('ReadSender_RedundantStateSpace', Buffer.alloc(8)),
      ReadSender_RedundantStateNewSpace: rec('ReadSender_RedundantStateNewSpace', Buffer.alloc(8)),
      ...over,
    };
  };

  const feature = (session: SenderSession) => {
    const ctx: FeatureContext = {
      withSession: (_id, fn) => fn(session as unknown as SessionLike),
      userLevel: () => ({ level }),
      timeoutMs: 100,
    };
    return createSenderFeature(ctx);
  };

  beforeEach(() => {
    calls.length = 0;
    level = 'advanced';
  });

  it('addresses the sending card (0) with ack-waiting writes, in width-then-height order', async () => {
    await feature(fake()).setSenderResolution('x', { width: 1920, height: 1080 });
    expect(calls.slice(0, 2)).toEqual(['SetDviWidth(0,false,1920,0)', 'SetDviHeight(0,false,1080,0)']);
    await feature(fake()).setSenderPortEnabled('x', 3, false);
    expect(calls).toContain('SetPortEnable(0,false,0,3)');
  });

  it('derives the port list from the highest port with receiving cards', async () => {
    const ports = await feature(fake()).getSenderPorts('x');
    expect(ports.map((p) => p.portIndex)).toEqual([0, 1, 2, 3]);
    expect(ports.map((p) => p.receivingCards)).toEqual([1, 3, 1, 1]);
    expect(ports[0]).toMatchObject({ enabled: true, width: 100, height: 50, pixels: 5000 });
  });

  it('returns an empty port list when no port has cards', async () => {
    const s = fake({ ReadScanerCountOfSenderCard: async () => Buffer.alloc(19) });
    expect(await feature(s).getSenderPorts('x')).toEqual([]);
  });

  it('does not touch the session at all when the level is normal', async () => {
    level = 'normal';
    const f = feature(fake());
    for (const p of [
      f.setSenderResolution('x', { width: 1, height: 1 }),
      f.setSenderFieldRate('x', 60),
      f.setSenderInputSource('x', 'DVI'),
      f.setSenderPortEnabled('x', 0, true),
    ]) {
      expect(await codeOf(p)).toBe('PERMISSION');
    }
    expect(calls).toEqual([]);
  });

  it('allows reads at the normal level', async () => {
    level = 'normal';
    const f = feature(fake());
    expect((await f.getSenderVideo('x')).resolution).toEqual({ width: 800, height: 600 });
    expect(await f.getSenderRedundancy('x')).toMatchObject({ loadMode: 'high-load' });
  });

  it('propagates a device failure from a write and does not read back', async () => {
    const boom = new DeviceError('TIMEOUT', 'no answer');
    const f = feature(
      fake({
        SetDviHeight: async () => {
          throw boom;
        },
      }),
    );
    await expect(f.setSenderResolution('x', { width: 10, height: 10 })).rejects.toBe(boom);
    expect(calls.some((c) => c.startsWith('ReadDvi'))).toBe(false);
  });

  it('decodes enum helpers', () => {
    expect(inputSourceFromRaw(88)).toBe('DVI');
    expect(inputSourceFromRaw(5)).toBe('HDMI');
    expect(inputSourceFromRaw(1)).toBe('SDI');
    expect(inputSourceFromRaw(0)).toBeNull();
    expect(redundancyStateFromRaw(0)).toBe('ok');
    expect(redundancyStateFromRaw(1)).toBe('error');
    expect(redundancyStateFromRaw(255)).toBe('unknown');
  });
});
