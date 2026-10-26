import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DeviceError, percentToRaw, type DeviceApi } from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { createDeviceService, createNetSessionFactory, type DeviceService } from '../src/index.js';

/** Receiving-card register written by SetSelfTestMode (address 0x02000101). */
const SELF_TEST_ADDR = 0x0200_0101;

let sim: SimulatorHandle;
let service: DeviceService;
let id: string;

const selfTest = (card: number): number =>
  sim.state.receivingCards[card]!.memory.read(SELF_TEST_ADDR, 1)[0]!;
const globalRaw = (card: number): number =>
  sim.state.receivingCards[card]!.memory.read(0x0200_0001, 1)[0]!;

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
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

const fresh = async (): Promise<void> => {
  service = createDeviceService({
    sessionFactory: createNetSessionFactory({ port: sim.port }),
    netPort: sim.port,
    serialDiscovery: false,
    timeoutMs: 1500,
  });
  const found = await service.discover({ netHosts: ['127.0.0.1'] });
  id = found[0]!.id;
};

describe('discover', () => {
  it('finds the simulator, tolerates a dead host, and follows the id contract', async () => {
    service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
    });
    const found = await service.discover({
      netHosts: ['127.0.0.1', '127.0.0.1:1', 'not a host:::'],
      timeoutMs: 1500,
    });
    expect(found).toEqual([
      {
        id: `net:127.0.0.1:${sim.port}`,
        transport: 'net',
        address: '127.0.0.1',
        port: sim.port,
        label: `127.0.0.1:${sim.port}`,
      },
    ]);
    const targets = service.lastDiscoveryErrors.map((e) => e.target);
    expect(targets).toContain('net:127.0.0.1:1');
    expect(targets).toContain('not a host:::');
  });

  it('returns an empty list when every host is dead', async () => {
    service = createDeviceService({ sessionFactory: createNetSessionFactory(), serialDiscovery: false });
    expect(await service.discover({ netHosts: ['127.0.0.1:1'], timeoutMs: 500 })).toEqual([]);
  });

  it('uses explicit host:port entries', async () => {
    service = createDeviceService({ sessionFactory: createNetSessionFactory(), serialDiscovery: false });
    const found = await service.discover({ netHosts: [`127.0.0.1:${sim.port}`] });
    expect(found.map((c) => c.id)).toEqual([`net:127.0.0.1:${sim.port}`]);
  });
});

describe('connected controller', () => {
  it('connect reads model, firmware, ports and receiving cards', async () => {
    await fresh();
    const info = await service.connect(id);
    expect(info.id).toBe(id);
    expect(info.model).toBe('Unknown (0x0660)');
    expect(info.firmwareVersion).toBe(sim.state.firmwareVersion);
    expect(info.outputPorts).toBe(2);
    expect(info.receivingCards.map((c) => [c.portIndex, c.cardIndex])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(service.getFirmwareDetails(id)).toEqual({ mcu: '1.2.3', fpga: '1.2.3' });
    expect(sim.state.connections).toBeGreaterThanOrEqual(1);
  });

  it('gets and sets brightness, including partial updates', async () => {
    await fresh();
    await service.connect(id);
    expect(await service.getBrightness(id)).toEqual({ percent: 80, red: 100, green: 100, blue: 100 });

    // only `percent` is written; RGB stays
    expect(await service.setBrightness(id, { percent: 50 })).toEqual({
      percent: 50,
      red: 100,
      green: 100,
      blue: 100,
    });
    for (let i = 0; i < 4; i += 1) expect(globalRaw(i)).toBe(percentToRaw(50));

    // only `red` is written; percent and the other channels stay
    expect(await service.setBrightness(id, { red: 40 })).toEqual({
      percent: 50,
      red: 40,
      green: 100,
      blue: 100,
    });
    const cardRgb = [...sim.state.receivingCards[3]!.memory.read(0x0200_0002, 4)];
    expect(cardRgb).toEqual([percentToRaw(40), 255, 255, 255]);

    // empty update is a pure read-back
    expect(await service.setBrightness(id, {})).toEqual({ percent: 50, red: 40, green: 100, blue: 100 });

    // everything at once, and the value really is on the device
    expect(await service.setBrightness(id, { percent: 100, red: 90, green: 80, blue: 70 })).toEqual({
      percent: 100,
      red: 90,
      green: 80,
      blue: 70,
    });
    expect(await service.getBrightness(id)).toEqual({ percent: 100, red: 90, green: 80, blue: 70 });
  });

  it('rejects out-of-range brightness without touching the device', async () => {
    await fresh();
    await service.connect(id);
    const before = sim.state.requestCount;
    await expectCode(service.setBrightness(id, { percent: 101 }), 'INVALID_ARGUMENT');
    await expectCode(service.setBrightness(id, { red: -1 }), 'INVALID_ARGUMENT');
    await expectCode(service.setBrightness(id, { blue: Number.NaN }), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);
  });

  it('sends test patterns and display modes to every receiving card', async () => {
    await fresh();
    await service.connect(id);
    await service.setTestPattern(id, 'red');
    for (let i = 0; i < 4; i += 1) expect(selfTest(i)).toBe(2);
    await service.setTestPattern(id, 'grayscale');
    expect(selfTest(0)).toBe(9);
    await service.setTestPattern(id, 'off');
    expect(selfTest(2)).toBe(0);

    await service.setDisplayMode(id, 'freeze');
    expect(selfTest(1)).toBe(32);
    await service.setDisplayMode(id, 'normal');
    expect(selfTest(1)).toBe(0);

    await expectCode(service.setDisplayMode(id, 'blackout'), 'PROTOCOL');
    await expectCode(service.setTestPattern(id, 'plaid' as never), 'INVALID_ARGUMENT');
    await expectCode(service.setDisplayMode(id, 'sepia' as never), 'INVALID_ARGUMENT');
  });

  it('can reconnect after disconnect, and all calls after disconnect are NOT_CONNECTED', async () => {
    await fresh();
    await service.connect(id);
    await service.disconnect(id);
    await expectCode(service.getBrightness(id), 'NOT_CONNECTED');
    await expectCode(service.setBrightness(id, { percent: 10 }), 'NOT_CONNECTED');
    await expectCode(service.setTestPattern(id, 'red'), 'NOT_CONNECTED');
    await expectCode(service.setDisplayMode(id, 'normal'), 'NOT_CONNECTED');
    await service.disconnect(id); // idempotent
    for (let i = 0; i < 100 && sim.state.connections > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sim.state.connections).toBe(0);

    const info = await service.connect(id);
    expect(info.receivingCards).toHaveLength(4);
    expect((await service.getBrightness(id)).percent).toBeGreaterThanOrEqual(0);
  });

  it('unknown ids are NOT_FOUND', async () => {
    await fresh();
    const api: DeviceApi = service;
    await expectCode(api.connect('net:9.9.9.9:5200'), 'NOT_FOUND');
    await expectCode(api.disconnect('nope'), 'NOT_FOUND');
    await expectCode(api.getBrightness('nope'), 'NOT_FOUND');
    await expectCode(api.setBrightness('nope', { percent: 1 }), 'NOT_FOUND');
    await expectCode(api.setTestPattern('nope', 'red'), 'NOT_FOUND');
    await expectCode(api.setDisplayMode('nope', 'normal'), 'NOT_FOUND');
  });
});

describe('login', () => {
  it('upgrades the user level only with the right password', async () => {
    service = createDeviceService({ serialDiscovery: false, advancedPassword: 's3cret' });
    expect(service.getUserLevel()).toEqual({ level: 'normal' });
    expect(await service.login('admin')).toBe(false);
    expect(service.getUserLevel().level).toBe('normal');
    expect(await service.login('s3cret')).toBe(true);
    expect(service.getUserLevel().level).toBe('advanced');
  });

  it('defaults the advanced password to "admin"', async () => {
    service = createDeviceService({ serialDiscovery: false });
    expect(await service.login('admin')).toBe(true);
    expect(service.getUserLevel()).toEqual({ level: 'advanced' });
  });
});
