import { describe, expect, it } from 'vitest';
import { DeviceError, cardTemperatureC, diffAlerts, evaluateSnapshot, humidityPct, voltageV, type MonitorSnapshot } from '@rockzalct/shared';
import { createMockDevice } from '../mockDevice';

const COM3 = 'serial:COM3'; // 4 ports x 2 cards
const LAN = 'net:192.168.0.10:5200'; // 10 ports x 1 card

async function connected(id = COM3) {
  const dev = createMockDevice({ latencyMs: 0 });
  await dev.connect(id);
  return dev;
}

async function run(id: string, count: number): Promise<MonitorSnapshot[]> {
  const dev = await connected(id);
  const out: MonitorSnapshot[] = [];
  for (let i = 0; i < count; i += 1) out.push(await dev.readMonitorSnapshot(id));
  return out;
}

describe('mock monitor', () => {
  it('needs a connected controller', async () => {
    const dev = createMockDevice({ latencyMs: 0 });
    await expect(dev.readMonitorSnapshot(COM3)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(dev.readMonitorSnapshot('serial:nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports every card of the fake controller with drifting raw bytes that decode to plausible units', async () => {
    const snaps = await run(COM3, 6);
    expect(snaps[0]!.cards).toHaveLength(8);
    expect(snaps[0]!.sender.portLinks).toHaveLength(4);
    expect(snaps[0]!.cards.every((c) => c.state === 'online' && c.voltageRaw !== undefined)).toBe(true);
    const temps = snaps.map((s) => cardTemperatureC(s.cards[0]!));
    expect(new Set(temps).size).toBeGreaterThan(1); // values drift
    expect(temps.every((t) => t! >= 30 && t! <= 55)).toBe(true); // ...but stay plausible (degrees C)
    for (const c of snaps[0]!.cards) {
      expect(voltageV(c.voltageRaw!)).toBeGreaterThanOrEqual(4.9); // ~5.0 V supply
      expect(voltageV(c.voltageRaw!)).toBeLessThanOrEqual(5.1);
      expect(humidityPct(c.humidityRaw!)).toBeGreaterThan(30);
    }
    expect((await run(LAN, 1))[0]!.cards).toHaveLength(10);
  });

  it('is deterministic and honours an explicit card list', async () => {
    const a = await run(COM3, 3);
    const b = await run(COM3, 3);
    expect(a.map((s) => s.cards)).toEqual(b.map((s) => s.cards));
    const dev = await connected();
    const s = await dev.readMonitorSnapshot(COM3, { cards: [{ portIndex: 1, cardIndex: 1 }] });
    expect(s.cards.map((c) => `${c.portIndex}/${c.cardIndex}`)).toEqual(['1/1']);
    await expect(dev.readMonitorSnapshot(COM3, { cards: [{ portIndex: -1, cardIndex: 0 }] })).rejects.toBeInstanceOf(DeviceError);
  });

  it('has an occasional fault: a temperature spike, then a card dropping offline', async () => {
    const snaps = await run(COM3, 30);
    const alerts = snaps.map((s) => evaluateSnapshot(s));
    const kinds = new Set(alerts.flat().map((a) => `${a.kind}:${a.severity}`));
    expect(kinds).toContain('temperature-high:warning');
    expect(kinds).toContain('temperature-high:critical');
    expect(kinds).toContain('card-offline:critical');
    expect(kinds).toContain('port-partial:warning'); // the sender counts one card less on that port
    // faults are occasional: most snapshots are clean, and they clear again
    expect(alerts.filter((a) => a.length === 0).length).toBeGreaterThan(15);
    const cleared = alerts.slice(1).some((a, i) => diffAlerts(alerts[i]!, a).some((t) => t.type === 'cleared'));
    expect(cleared).toBe(true);
  });
});
