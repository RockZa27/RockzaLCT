import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DeviceError,
  autoWire,
  createLayoutScreen,
  inferLayout,
  planLayoutWrite,
  setCabinetSize,
  type LayoutModel,
} from '@rockzalct/shared';
import { cardCountAddress, startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { createDeviceService, createNetSessionFactory, type DeviceService } from '../src/index.js';
import { decodeScannerXY } from '../src/features/layout.js';

// Register addresses, copied from the generated @novastar/native api files (dist/api/<Name>.cjs)
// so that the tests check the bytes on the wire independently of the implementation:
//   sender   SetEthernetPortScannerXY  4096*port + 0x03000000 + 4*card   (u32 LE = (x << 16) + y)
//   sender   SetPortEnable/Width/Height/OffsetX/OffsetY  0x02000050/51/53/55/57 + 9*port (port < 4)
//   sender   SetSender_ComplexCfgScreenFlagSpace  0x0200004A
//   card     SetControlWidth 0x02000017, SetControlHeight 0x02000019, SetvCabinetSerialNum 0x0200008B
//   card     SetSelfTestMode 0x02000101
const XY = (port: number, card: number): number => 0x0300_0000 + 4096 * port + 4 * card;
const PORT = { enable: 0x0200_0050, width: 0x0200_0051, height: 0x0200_0053, offX: 0x0200_0055, offY: 0x0200_0057 };
const portReg = (base: number, port: number): number => base + 9 * port;
const COMPLEX = 0x0200_004a;
const CTRL_W = 0x0200_0017;
const CTRL_H = 0x0200_0019;
const SERIAL = 0x0200_008b;
const SELF_TEST = 0x0200_0101;

let sim: SimulatorHandle;
let service: DeviceService;
let id: string;

const card = (port: number, index: number) => {
  const c = sim.state.receivingCards.find((x) => x.portIndex === port && x.cardIndex === index);
  if (!c) throw new Error(`no simulated card ${port}/${index}`);
  return c.memory;
};
const s16 = (m: { read(a: number, n: number): Buffer }, addr: number): number => m.read(addr, 2).readUInt16LE(0);
const sender = () => sim.state.sendingCard;

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

/** 2 ports x 2 cards: a 2 x 2 wall, one row per port. */
const wall = (): LayoutModel => {
  const screen = createLayoutScreen(2, 2, 128, 64);
  return { screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 2, split: 'rows' }) };
};

beforeAll(async () => {
  sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
});
afterAll(async () => {
  await sim.close();
});

const clearRegisters = (): void => {
  const zero2 = Buffer.alloc(2);
  const zero4 = Buffer.alloc(4);
  for (let p = 0; p < 2; p += 1) {
    for (const base of Object.values(PORT)) sender().write(portReg(base, p), zero2);
    for (let i = 0; i < 2; i += 1) {
      sender().write(XY(p, i), zero4);
      card(p, i).write(CTRL_W, zero2);
      card(p, i).write(CTRL_H, zero2);
      card(p, i).write(SERIAL, zero2);
      card(p, i).write(SELF_TEST, Buffer.from([0]));
    }
  }
  sender().write(COMPLEX, Buffer.from([0]));
};

beforeEach(async () => {
  clearRegisters();
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

const seed = (hw: ReturnType<typeof planLayoutWrite>): void => {
  sender().write(COMPLEX, Buffer.from([hw.complexScreen ? 1 : 0]));
  for (const p of hw.ports) {
    const w = (base: number, v: number): void => {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(v);
      sender().write(portReg(base, p.port), b);
    };
    sender().write(portReg(PORT.enable, p.port), Buffer.from([p.enabled ? 1 : 0]));
    w(PORT.width, p.width);
    w(PORT.height, p.height);
    w(PORT.offX, p.x);
    w(PORT.offY, p.y);
  }
  for (const c of hw.cards) {
    const xy = Buffer.alloc(4);
    xy.writeUInt32LE(((c.x << 16) | c.y) >>> 0);
    sender().write(XY(c.port, c.index), xy);
    const m = card(c.port, c.index);
    const w = Buffer.alloc(2);
    w.writeUInt16LE(c.width);
    m.write(CTRL_W, w);
    const h = Buffer.alloc(2);
    h.writeUInt16LE(c.height);
    m.write(CTRL_H, h);
    const n = Buffer.alloc(2);
    n.writeUInt16LE(c.cabinetNumber);
    m.write(SERIAL, n);
  }
};

describe('decodeScannerXY', () => {
  it('mirrors the (x << 16) + y little-endian word and rejects short data', () => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(((300 << 16) | 70) >>> 0);
    expect(decodeScannerXY(b)).toEqual({ x: 300, y: 70 });
    expect(() => decodeScannerXY(Buffer.alloc(2))).toThrow(DeviceError);
  });
});

describe('readLayout', () => {
  it('reads seeded port regions, card positions/sizes and serial numbers; infers the model', async () => {
    const model = wall();
    seed(planLayoutWrite(model));
    const hw = await service.readLayout(id);
    expect(hw.complexScreen).toBe(false);
    expect(hw.ports).toEqual([
      { port: 0, enabled: true, x: 0, y: 0, width: 256, height: 64 },
      { port: 1, enabled: true, x: 0, y: 64, width: 256, height: 64 },
    ]);
    expect(hw.cards).toEqual([
      { port: 0, index: 0, x: 0, y: 0, width: 128, height: 64, cabinetNumber: 1 },
      { port: 0, index: 1, x: 128, y: 0, width: 128, height: 64, cabinetNumber: 2 },
      { port: 1, index: 0, x: 0, y: 0, width: 128, height: 64, cabinetNumber: 3 },
      { port: 1, index: 1, x: 128, y: 0, width: 128, height: 64, cabinetNumber: 4 },
    ]);
    expect(inferLayout(hw).model).toEqual(model);
  });

  it('reads the complex flag and a wide card (x above 255) from the exact byte positions', async () => {
    const screen = setCabinetSize(createLayoutScreen(1, 2, 300, 100), 0, 1, 500, 100);
    const model: LayoutModel = { screen, ports: [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }] };
    seed(planLayoutWrite(model));
    // x = 300 -> bytes y_lo y_hi x_lo x_hi = 00 00 2C 01
    expect([...sender().read(XY(0, 1), 4)]).toEqual([0, 0, 0x2c, 0x01]);
    const hw = await service.readLayout(id);
    expect(hw.complexScreen).toBe(true);
    expect(hw.cards[1]).toMatchObject({ x: 300, y: 0, width: 500, height: 100 });
  });

  it('an unconfigured controller reads back as all-zero cards, which infer to no model', async () => {
    const hw = await service.readLayout(id);
    expect(hw.cards).toHaveLength(4);
    expect(hw.cards.every((c) => c.width === 0 && c.height === 0)).toBe(true);
    expect(inferLayout(hw)).toMatchObject({ model: null });
  });

  it('needs a known, connected controller', async () => {
    await expectCode(service.readLayout('net:nope:1'), 'NOT_FOUND');
    await service.disconnect(id);
    await expectCode(service.readLayout(id), 'NOT_CONNECTED');
  });
});

describe('writeLayout', () => {
  it('requires the advanced level and touches nothing without it', async () => {
    await expectCode(service.writeLayout(id, wall()), 'PERMISSION');
    expect([...sender().read(PORT.width, 2)]).toEqual([0, 0]);
    expect([...card(0, 0).read(CTRL_W, 2)]).toEqual([0, 0]);
  });

  describe('as advanced user', () => {
    beforeEach(async () => {
      expect(await service.login('admin')).toBe(true);
    });

    it('writes exactly the planned bytes to the documented registers', async () => {
      const result = await service.writeLayout(id, wall());
      expect(result).toEqual({ portsWritten: 2, cardsWritten: 4, complexScreen: false });

      // sender: port regions
      expect(sender().read(portReg(PORT.enable, 1), 1)[0]).toBe(1);
      expect(s16(sender(), portReg(PORT.width, 0))).toBe(256);
      expect(s16(sender(), portReg(PORT.height, 0))).toBe(64);
      expect(s16(sender(), portReg(PORT.offX, 1))).toBe(0);
      expect(s16(sender(), portReg(PORT.offY, 1))).toBe(64);
      // sender: per-card position table, (x << 16) + y little endian
      expect([...sender().read(XY(0, 1), 4)]).toEqual([0, 0, 128, 0]);
      expect([...sender().read(XY(1, 0), 4)]).toEqual([0, 0, 0, 0]); // relative to the port region
      // cards: size
      expect(s16(card(1, 1), CTRL_W)).toBe(128);
      expect(s16(card(1, 1), CTRL_H)).toBe(64);
      // serial numbers are only written on request
      expect(s16(card(0, 0), SERIAL)).toBe(0);
      expect(sender().read(COMPLEX, 1)[0]).toBe(0);
    });

    it('writes the complex flag, cabinet numbers on request, and reads everything back', async () => {
      const screen = setCabinetSize(setCabinetSize(createLayoutScreen(2, 2, 128, 64), 0, 1, 200, 64), 1, 1, 200, 64);
      const model: LayoutModel = { screen, ports: autoWire(screen, { pattern: 'right-top-horizontal', ports: 2, split: 'rows' }) };
      const result = await service.writeLayout(id, model, { writeCabinetNumbers: true });
      expect(result.complexScreen).toBe(true);
      expect(sender().read(COMPLEX, 1)[0]).toBe(1);
      const hw = await service.readLayout(id);
      expect(hw).toEqual(planLayoutWrite(model));
      expect(inferLayout(hw).model).toEqual(model);
      // first card of port 0 is the right-hand cabinet (col 1)
      expect(hw.cards[0]).toMatchObject({ port: 0, index: 0, x: 128, width: 200, cabinetNumber: 1 });
    });

    it('can skip enabling ports', async () => {
      await service.writeLayout(id, wall(), { enablePorts: false });
      expect(sender().read(portReg(PORT.enable, 0), 1)[0]).toBe(0);
      expect(s16(sender(), portReg(PORT.width, 0))).toBe(256);
    });

    it('rejects an invalid layout before writing anything', async () => {
      const bad = wall();
      bad.ports[1]!.cabinets.pop(); // one cabinet is on no port
      await expectCode(service.writeLayout(id, bad), 'INVALID_ARGUMENT');
      const over = await service.writeLayout(id, wall(), { portCapacity: 16_383 }).then(
        () => undefined,
        (e: unknown) => e as DeviceError,
      );
      expect(over?.code).toBe('INVALID_ARGUMENT');
      expect(over?.message).toContain('port-over-capacity');
      expect([...sender().read(portReg(PORT.width, 0), 2)]).toEqual([0, 0]);
      expect(s16(card(0, 0), CTRL_W)).toBe(0);
    });

    it('rejects malformed input from the renderer', async () => {
      await expectCode(service.writeLayout(id, null as unknown as LayoutModel), 'INVALID_ARGUMENT');
      await expectCode(service.writeLayout(id, { screen: 1, ports: [] } as unknown as LayoutModel), 'INVALID_ARGUMENT');
    });

    it('refuses a layout whose chains do not match the cards on the port, unless told otherwise', async () => {
      const screen = createLayoutScreen(1, 3, 128, 64);
      const three: LayoutModel = { screen, ports: [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] }] };
      const err = await service.writeLayout(id, three).then(
        () => undefined,
        (e: unknown) => e as DeviceError,
      );
      expect(err?.code).toBe('INVALID_ARGUMENT');
      expect(err?.message).toContain('port 0 has 2 receiving card(s)');
      expect([...sender().read(portReg(PORT.width, 0), 2)]).toEqual([0, 0]);
      // the option does not make a non-existent card answer: the write of its size times out
      await expectCode(service.writeLayout(id, three, { ignoreCardCount: true }), 'PROTOCOL');
    });

    it('ignoreCardCount covers a stale sender card-count register while the cards do answer', async () => {
      const addr = cardCountAddress(0, 0);
      const before = sender().read(addr, 2);
      sender().write(addr, Buffer.alloc(2));
      try {
        await expectCode(service.writeLayout(id, wall()), 'INVALID_ARGUMENT');
        await expect(service.writeLayout(id, wall(), { ignoreCardCount: true })).resolves.toMatchObject({ cardsWritten: 4 });
      } finally {
        sender().write(addr, before);
      }
    });

    it('needs a connected controller', async () => {
      await expectCode(service.writeLayout('net:nope:1', wall()), 'NOT_FOUND');
      await service.disconnect(id);
      await expectCode(service.writeLayout(id, wall()), 'NOT_CONNECTED');
    });
  });
});

describe('showCabinetNumbers', () => {
  it('requires the advanced level', async () => {
    await expectCode(service.showCabinetNumbers(id, wall(), true), 'PERMISSION');
    expect(card(0, 0).read(SELF_TEST, 1)[0]).toBe(0);
  });

  it('writes serial numbers then switches every card to hardware-screen mode (11) and back to 0', async () => {
    await service.login('admin');
    await service.showCabinetNumbers(id, wall(), true);
    for (const [p, i, n] of [[0, 0, 1], [0, 1, 2], [1, 0, 3], [1, 1, 4]] as const) {
      expect(s16(card(p, i), SERIAL)).toBe(n);
      expect(card(p, i).read(SELF_TEST, 1)[0]).toBe(11);
    }
    await service.showCabinetNumbers(id, wall(), false);
    for (const [p, i] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) expect(card(p, i).read(SELF_TEST, 1)[0]).toBe(0);
  });

  it('validates its arguments', async () => {
    await service.login('admin');
    const bad = wall();
    bad.ports = [];
    await expectCode(service.showCabinetNumbers(id, bad, true), 'INVALID_ARGUMENT');
    await expectCode(service.showCabinetNumbers(id, wall(), 'yes' as unknown as boolean), 'INVALID_ARGUMENT');
  });
});
