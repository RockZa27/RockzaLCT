import { describe, expect, it } from 'vitest';
import { DeviceError, autoWire, createLayoutScreen, inferLayout, type LayoutModel } from '@rockzalct/shared';
import { MOCK_ADVANCED_PASSWORD, createMockDevice } from '../mockDevice';

const COM3 = 'serial:COM3'; // 4 ports x 2 cards
const wall = (cols: number, ports: number): LayoutModel => {
  const screen = createLayoutScreen(2, cols, 100, 100);
  return { screen, ports: autoWire(screen, { pattern: 'left-top-vertical', ports, split: 'columns' }) };
};
const code = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof DeviceError ? e.code : 'other'),
  );

async function connected() {
  const dev = createMockDevice({ latencyMs: 0 });
  await dev.connect(COM3);
  return dev;
}

describe('mock layout', () => {
  it('starts COM3 with a readable 2 x 4 wall and the LAN fake unconfigured', async () => {
    const dev = await connected();
    const hw = await dev.readLayout(COM3);
    expect(inferLayout(hw).model?.screen).toMatchObject({ rows: 2, cols: 4 });
    await dev.connect('net:192.168.0.10:5200');
    const empty = await dev.readLayout('net:192.168.0.10:5200');
    expect(empty.cards).toHaveLength(10);
    expect(inferLayout(empty).model).toBeNull();
  });

  it('write needs advanced; then read returns what was written', async () => {
    const dev = await connected();
    expect(await code(dev.writeLayout(COM3, wall(4, 4)))).toBe('PERMISSION');
    expect(await code(dev.showCabinetNumbers(COM3, wall(4, 4), true))).toBe('PERMISSION');
    await dev.login(MOCK_ADVANCED_PASSWORD);
    // 2 x 4 wall of 100 px cabinets over 4 ports: 2 cabinets per port, matching the 2 cards per port
    const model = wall(4, 4);
    expect(await dev.writeLayout(COM3, model)).toEqual({ portsWritten: 4, cardsWritten: 8, complexScreen: false });
    const hw = await dev.readLayout(COM3);
    expect(inferLayout(hw).model).toEqual(model);
    expect(hw.ports.find((p) => p.port === 1)).toMatchObject({ enabled: true, x: 100, width: 100, height: 200 });
  });

  it('rejects invalid layouts and chains that do not match the cards on a port', async () => {
    const dev = await connected();
    await dev.login(MOCK_ADVANCED_PASSWORD);
    expect(await code(dev.writeLayout(COM3, { ...wall(2, 2), ports: [] }))).toBe('INVALID_ARGUMENT');
    // 2 ports of 4 cabinets, but only 2 receiving cards per port
    expect(await code(dev.writeLayout(COM3, wall(4, 2)))).toBe('INVALID_ARGUMENT');
    expect((await dev.writeLayout(COM3, wall(4, 2), { ignoreCardCount: true })).cardsWritten).toBe(8);
    // 3 ports of 2 cabinets fits the cards
    expect((await dev.writeLayout(COM3, wall(3, 3))).portsWritten).toBe(3);
  });

  it('needs a connected controller', async () => {
    const dev = createMockDevice({ latencyMs: 0 });
    expect(await code(dev.readLayout(COM3))).toBe('NOT_CONNECTED');
    expect(await code(dev.readLayout('nope'))).toBe('NOT_FOUND');
  });
});
