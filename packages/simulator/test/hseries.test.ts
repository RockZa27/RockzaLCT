import { createSocket } from 'node:dgram';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHSeriesSimulator, type HSeriesSimulatorHandle } from '../src/index.js';

/** Send one datagram from a fresh socket and resolve with the parsed reply (or null after `waitMs`). */
function ask(port: number, payload: string, waitMs = 300): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    const done = (v: unknown[] | null): void => {
      clearTimeout(timer);
      s.close();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), waitMs);
    s.on('message', (m) => done(JSON.parse(m.toString()) as unknown[]));
    s.send(payload, port, '127.0.0.1');
  });
}
const cmd = (c: string, body: object = {}) => JSON.stringify([{ cmd: c, deviceId: 0, ...body }]);

describe('H series simulator', () => {
  let sim: HSeriesSimulatorHandle;
  beforeAll(async () => {
    sim = await startHSeriesSimulator();
  });
  afterAll(async () => {
    await sim.close();
  });

  it('answers the handshake with ack Ok and rate 100', async () => {
    expect(await ask(sim.port, JSON.stringify([{ cmd: 'R0118', param0: 0 }]))).toEqual([
      { cmd: 'R0118', ack: 'Ok', deviceId: 0, rate: 100 },
    ]);
  });

  it('keeps written state across separate clients', async () => {
    expect(await ask(sim.port, cmd('W0410', { screenId: 1, brightness: 12 }))).toEqual([
      { cmd: 'W0410', ack: 'Ok', deviceId: 0 },
    ]);
    const reply = (await ask(sim.port, cmd('R0401', { param0: 0, param1: 1 })))![0] as { brightness: number };
    expect(reply.brightness).toBe(12);
  });

  it('refuses bad writes and unknown commands with ack Fail', async () => {
    const bad = (await ask(sim.port, cmd('W0410', { screenId: 0, brightness: 101 })))![0] as { ack: string };
    expect(bad.ack).toBe('Fail');
    const unknown = (await ask(sim.port, cmd('X9999')))![0] as { ack: string; msg: string };
    expect(unknown).toMatchObject({ ack: 'Fail' });
    expect(unknown.msg).toMatch(/unknown command/);
  });

  it('does not answer junk and counts it', async () => {
    const before = sim.state.malformedRequests;
    expect(await ask(sim.port, 'not json', 100)).toBeNull();
    expect(await ask(sim.port, '{"cmd":"R0118"}', 100)).toBeNull();
    expect(sim.state.malformedRequests).toBe(before + 2);
  });

  it('can be silenced to exercise client timeouts', async () => {
    sim.state.mute = true;
    expect(await ask(sim.port, cmd('R0400'), 100)).toBeNull();
    sim.state.mute = false;
    expect(await ask(sim.port, cmd('R0400'))).not.toBeNull();
  });
});
