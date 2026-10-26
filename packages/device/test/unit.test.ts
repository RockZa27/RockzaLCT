import { describe, expect, it, vi } from 'vitest';
import { ConnectionClosedError, Packet, Request, ResponseError, TimeoutError } from '@novastar/codec';
import { DeviceError } from '@rockzalct/shared';
import {
  createDeviceService,
  formatEdition,
  mapError,
  modelName,
  parseNetHost,
  type DeviceService,
  type SessionFactory,
  type SessionLike,
} from '../src/index.js';

const timeoutError = (): TimeoutError => new TimeoutError(new Request(1), 'test');
const responseError = (): ResponseError => new ResponseError(new Packet(Packet.baseSize), 'test');

function fakeSession(overrides: Partial<SessionLike> = {}): SessionLike {
  return {
    ReadControllerModelId: async () => 0x1234,
    ReadSender_McuProgramEdition: async () => 0x02030400,
    ReadSender_FPGAProgramEdition: async () => 0x01000000,
    ReadScanerCountOfSenderCard: async () => Buffer.from([1, 0, 0]),
    ReadNumberOfCardOrScanBoardInPort: async (_a, port) => (port === 0 ? 1 : 0),
    ReadScanner_McuProgramEdition: async () => 0x01020300,
    ReadAllBrightnessInfo: async () => Buffer.from([255, 255, 128, 0, 255]),
    SetGlobalBrightness: async () => undefined,
    SetRGBBrightness: async () => undefined,
    SetSelfTestMode: async () => undefined,
    SetKillMode: async () => undefined,
    SetLockMode: async () => undefined,
    close: () => true,
    ...overrides,
  };
}

async function setup(
  session: SessionLike,
  extra: Partial<Parameters<typeof createDeviceService>[0]> = {},
): Promise<{ svc: DeviceService; id: string }> {
  const factory: SessionFactory = { open: async () => session };
  const svc = createDeviceService({ sessionFactory: factory, serialDiscovery: false, ...extra });
  const [found] = await svc.discover({ netHosts: ['10.0.0.1'] });
  return { svc, id: found!.id };
}

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof DeviceError ? e.code : `non-DeviceError: ${String(e)}`),
  );

describe('helpers', () => {
  it('formats editions and model ids', () => {
    expect(formatEdition(0x01020300)).toBe('1.2.3');
    expect(formatEdition(0x01020304)).toBe('1.2.3.4');
    expect(formatEdition(0xff000000)).toBe('255.0.0');
    expect(modelName(0x660)).toBe('Unknown (0x0660)');
    expect(modelName(0x12345)).toBe('Unknown (0x12345)');
  });

  it('parses host entries', () => {
    expect(parseNetHost('10.0.0.1', 5200)).toEqual({ host: '10.0.0.1', port: 5200 });
    expect(parseNetHost(' 10.0.0.1:99 ', 5200)).toEqual({ host: '10.0.0.1', port: 99 });
    expect(parseNetHost('10.0.0.1:abc', 5200)).toBeNull();
    expect(parseNetHost('10.0.0.1:70000', 5200)).toBeNull();
    expect(parseNetHost('', 5200)).toBeNull();
  });

  it('maps errors onto DeviceError codes', () => {
    expect(mapError(timeoutError()).code).toBe('TIMEOUT');
    expect(mapError(responseError()).code).toBe('PROTOCOL');
    expect(mapError(new ConnectionClosedError()).code).toBe('NOT_CONNECTED');
    expect(mapError(new Error('boom')).code).toBe('PROTOCOL');
    const original = new DeviceError('PERMISSION', 'x');
    expect(mapError(original)).toBe(original);
  });
});

describe('connect with a fake session', () => {
  it('builds ControllerInfo from the session reads', async () => {
    const { svc, id } = await setup(fakeSession());
    expect(id).toBe('net:10.0.0.1:5200');
    expect(await svc.connect(id)).toEqual({
      id,
      model: 'Unknown (0x1234)',
      firmwareVersion: '2.3.4',
      outputPorts: 1,
      receivingCards: [{ portIndex: 0, cardIndex: 0, model: 'Unknown', firmwareVersion: '1.2.3' }],
    });
    expect(svc.getFirmwareDetails(id)).toEqual({ mcu: '2.3.4', fpga: '1.0.0' });
  });

  it('tolerates a receiving card that does not answer, but not a dead sender', async () => {
    const session = fakeSession({
      ReadScanner_McuProgramEdition: async () => {
        throw responseError();
      },
    });
    const { svc, id } = await setup(session);
    expect((await svc.connect(id)).receivingCards[0]!.firmwareVersion).toBe('unknown');

    const dead = fakeSession({
      ReadSender_McuProgramEdition: async () => {
        throw timeoutError();
      },
    });
    const second = await setup(dead);
    expect(await codeOf(second.svc.connect(second.id))).toBe('TIMEOUT');
    // failed connect leaves the controller disconnected
    expect(await codeOf(second.svc.getBrightness(second.id))).toBe('NOT_CONNECTED');
  });

  it('closes the session when connect fails and when disconnecting', async () => {
    const close = vi.fn(() => true);
    const failing = fakeSession({
      close,
      ReadScanerCountOfSenderCard: async () => {
        throw responseError();
      },
    });
    const { svc, id } = await setup(failing);
    close.mockClear(); // discover's probe also closes
    expect(await codeOf(svc.connect(id))).toBe('PROTOCOL');
    expect(close).toHaveBeenCalledTimes(1);

    const ok = fakeSession({ close });
    const good = await setup(ok);
    await good.svc.connect(good.id);
    close.mockClear();
    await good.svc.disconnect(good.id);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('surfaces a factory failure as a DeviceError', async () => {
    const factory: SessionFactory = {
      open: vi
        .fn()
        .mockResolvedValueOnce(fakeSession())
        .mockRejectedValueOnce(new DeviceError('TIMEOUT', 'connect timed out')),
    };
    const svc = createDeviceService({ sessionFactory: factory, serialDiscovery: false });
    const [c] = await svc.discover({ netHosts: ['10.0.0.1'] });
    expect(await codeOf(svc.connect(c!.id))).toBe('TIMEOUT');
  });
});

describe('error mapping on operations', () => {
  it('maps codec TimeoutError to TIMEOUT and ResponseError to PROTOCOL', async () => {
    let mode: 'timeout' | 'response' | 'closed' = 'timeout';
    const fail = async (): Promise<never> => {
      throw mode === 'timeout' ? timeoutError() : mode === 'response' ? responseError() : new ConnectionClosedError();
    };
    const { svc, id } = await setup(
      fakeSession({ ReadAllBrightnessInfo: fail, SetGlobalBrightness: fail, SetSelfTestMode: fail, SetKillMode: fail }),
    );
    await svc.connect(id);
    expect(await codeOf(svc.getBrightness(id))).toBe('TIMEOUT');
    expect(await codeOf(svc.setBrightness(id, { percent: 5 }))).toBe('TIMEOUT');
    expect(await codeOf(svc.setTestPattern(id, 'blue'))).toBe('TIMEOUT');
    mode = 'response';
    expect(await codeOf(svc.getBrightness(id))).toBe('PROTOCOL');
    expect(await codeOf(svc.setDisplayMode(id, 'blackout'))).toBe('PROTOCOL');
    mode = 'closed';
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
    // a closed connection is dropped from the registry
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
  });
});

describe('validation', () => {
  it('rejects bad arguments before any device I/O', async () => {
    const setGlobal = vi.fn<SessionLike['SetGlobalBrightness']>(async () => undefined);
    const setRgb = vi.fn<SessionLike['SetRGBBrightness']>(async () => undefined);
    const selfTest = vi.fn<SessionLike['SetSelfTestMode']>(async () => undefined);
    const { svc, id } = await setup(
      fakeSession({ SetGlobalBrightness: setGlobal, SetRGBBrightness: setRgb, SetSelfTestMode: selfTest }),
    );
    await svc.connect(id);
    for (const bad of [{ percent: -0.1 }, { percent: 100.5 }, { green: 1000 }, { blue: '5' as unknown as number }]) {
      expect(await codeOf(svc.setBrightness(id, bad))).toBe('INVALID_ARGUMENT');
    }
    expect(await codeOf(svc.setBrightness(id, null as never))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setTestPattern(id, 'toString' as never))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setDisplayMode(id, 'dim' as never))).toBe('INVALID_ARGUMENT');
    expect(setGlobal).not.toHaveBeenCalled();
    expect(setRgb).not.toHaveBeenCalled();
    expect(selfTest).not.toHaveBeenCalled();
  });

  it('accepts the 0 and 100 boundaries and writes the matching raw values', async () => {
    const setGlobal = vi.fn<SessionLike['SetGlobalBrightness']>(async () => undefined);
    const { svc, id } = await setup(fakeSession({ SetGlobalBrightness: setGlobal }));
    await svc.connect(id);
    await svc.setBrightness(id, { percent: 0 });
    await svc.setBrightness(id, { percent: 100 });
    expect(setGlobal.mock.calls.map((c) => c[4])).toEqual([0, 255]);
  });

  it('partial RGB set keeps the other channels and the virtual-red byte', async () => {
    const setRgb = vi.fn<SessionLike['SetRGBBrightness']>(async () => undefined);
    const setGlobal = vi.fn<SessionLike['SetGlobalBrightness']>(async () => undefined);
    const { svc, id } = await setup(
      fakeSession({
        SetRGBBrightness: setRgb,
        SetGlobalBrightness: setGlobal,
        ReadAllBrightnessInfo: async () => Buffer.from([200, 255, 128, 0, 77]),
      }),
    );
    await svc.connect(id);
    await svc.setBrightness(id, { green: 100 });
    expect(setGlobal).not.toHaveBeenCalled();
    expect(setRgb).toHaveBeenCalledTimes(1);
    expect(setRgb.mock.calls[0]!.slice(4)).toEqual([255, 255, 0, 77]);
  });

  it('not-connected and unknown ids', async () => {
    const { svc, id } = await setup(fakeSession());
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
    expect(await codeOf(svc.getBrightness('serial:COM9'))).toBe('NOT_FOUND');
    expect(await codeOf(svc.connect('serial:COM9'))).toBe('NOT_FOUND');
    expect(() => svc.getFirmwareDetails(id)).toThrow(DeviceError);
  });

  it('display modes write kill/lock values, overridable via options', async () => {
    const kill = vi.fn<SessionLike['SetKillMode']>(async () => undefined);
    const lock = vi.fn<SessionLike['SetLockMode']>(async () => undefined);
    const { svc, id } = await setup(fakeSession({ SetKillMode: kill, SetLockMode: lock }), {
      displayModeValues: { lockOn: 2 },
    });
    await svc.connect(id);
    await svc.setDisplayMode(id, 'blackout');
    await svc.setDisplayMode(id, 'freeze');
    await svc.setDisplayMode(id, 'normal');
    expect(kill.mock.calls.map((c) => c[4])).toEqual([1, 0, 0]);
    expect(lock.mock.calls.map((c) => c[4])).toEqual([0, 2, 0]);
  });
});

describe('discover', () => {
  it('lists serial ports, survives serial and per-host failures, and dedupes', async () => {
    const factory: SessionFactory = {
      open: async (c) => {
        if (c.address === 'bad') throw timeoutError();
        return fakeSession();
      },
    };
    const svc = createDeviceService({
      sessionFactory: factory,
      findSerialPaths: async () => ['COM3', '/dev/ttyUSB0'],
    });
    const found = await svc.discover({ netHosts: ['good', 'bad', 'good', 'good:5200'] });
    expect(found.map((c) => c.id).sort()).toEqual(['net:good:5200', 'serial:/dev/ttyUSB0', 'serial:COM3']);
    expect(found.find((c) => c.id === 'serial:COM3')).toMatchObject({ transport: 'serial', address: 'COM3', label: 'COM3' });

    const broken = createDeviceService({
      sessionFactory: factory,
      findSerialPaths: async () => {
        throw new Error('no serial subsystem');
      },
    });
    expect((await broken.discover({ netHosts: ['good'] })).map((c) => c.id)).toEqual(['net:good:5200']);
    expect(broken.lastDiscoveryErrors[0]).toMatchObject({ target: 'serial' });
  });

  it('merges UDP discovery when enabled and tolerates UDP failure', async () => {
    const factory: SessionFactory = { open: async () => fakeSession() };
    const svc = createDeviceService({
      sessionFactory: factory,
      serialDiscovery: false,
      udpDiscovery: true,
      findUdpHosts: async () => ['192.168.0.9'],
    });
    expect((await svc.discover()).map((c) => c.id)).toEqual(['net:192.168.0.9:5200']);
    const failing = createDeviceService({
      sessionFactory: factory,
      serialDiscovery: false,
      udpDiscovery: true,
      findUdpHosts: async () => {
        throw new Error('no multicast');
      },
    });
    expect(await failing.discover()).toEqual([]);
  });

  it('uses options.netHosts when discover gets none, and rejects a non-positive timeout', async () => {
    const svc = createDeviceService({
      sessionFactory: { open: async () => fakeSession() },
      serialDiscovery: false,
      netHosts: ['h1'],
    });
    expect((await svc.discover()).map((c) => c.id)).toEqual(['net:h1:5200']);
    expect(await codeOf(svc.discover({ timeoutMs: 0 }))).toBe('INVALID_ARGUMENT');
  });
});
