import { describe, expect, it } from 'vitest';
import { DeviceError, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from './mockDevice';

const make = (): DeviceApi => createMockDevice({ latencyMs: 0 });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceError);
    return (e as DeviceError).code;
  }
  throw new Error('expected rejection');
}

describe('mockDevice', () => {
  it('discovers one serial and one net controller', async () => {
    const found = await make().discover();
    expect(found.map((c) => c.transport).sort()).toEqual(['net', 'serial']);
    expect(found.find((c) => c.transport === 'net')?.id).toBe('net:192.168.0.10:5200');
  });

  it('filters the net controller by requested hosts but always lists serial', async () => {
    const api = make();
    expect((await api.discover({ netHosts: ['10.9.9.9'] })).map((c) => c.transport)).toEqual(['serial']);
    expect(await api.discover({ netHosts: ['192.168.0.10'] })).toHaveLength(2);
  });

  it('connect returns info with receiving cards; unknown id is NOT_FOUND', async () => {
    const api = make();
    const info = await api.connect('serial:COM3');
    expect(info.id).toBe('serial:COM3');
    expect(info.receivingCards.length).toBeGreaterThan(0);
    expect(info.receivingCards.every((c) => c.portIndex < info.outputPorts)).toBe(true);
    expect(await codeOf(api.connect('serial:nope'))).toBe('NOT_FOUND');
  });

  it('requires a connection for device operations', async () => {
    const api = make();
    expect(await codeOf(api.getBrightness('serial:COM3'))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.setTestPattern('serial:COM3', 'red'))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.setDisplayMode('serial:COM3', 'freeze'))).toBe('NOT_CONNECTED');
    await api.connect('serial:COM3');
    await expect(api.getBrightness('serial:COM3')).resolves.toBeDefined();
    await api.disconnect('serial:COM3');
    expect(await codeOf(api.getBrightness('serial:COM3'))).toBe('NOT_CONNECTED');
  });

  it('setBrightness merges partial values and getBrightness reads them back', async () => {
    const api = make();
    await api.connect('net:192.168.0.10:5200');
    const before = await api.getBrightness('net:192.168.0.10:5200');
    const after = await api.setBrightness('net:192.168.0.10:5200', { percent: 33 });
    expect(after).toEqual({ ...before, percent: 33 });
    expect(await api.getBrightness('net:192.168.0.10:5200')).toEqual(after);
  });

  it('rejects out-of-range brightness with INVALID_ARGUMENT and leaves state unchanged', async () => {
    const api = make();
    await api.connect('serial:COM3');
    const before = await api.getBrightness('serial:COM3');
    expect(await codeOf(api.setBrightness('serial:COM3', { percent: 101 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setBrightness('serial:COM3', { red: Number.NaN }))).toBe('INVALID_ARGUMENT');
    expect(await api.getBrightness('serial:COM3')).toEqual(before);
  });

  it('accepts all patterns/modes and rejects unknown ones', async () => {
    const api = make();
    await api.connect('serial:COM3');
    await api.setTestPattern('serial:COM3', 'grayscale');
    await api.setDisplayMode('serial:COM3', 'blackout');
    expect(await codeOf(api.setTestPattern('serial:COM3', 'bogus' as never))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setDisplayMode('serial:COM3', 'bogus' as never))).toBe('INVALID_ARGUMENT');
  });

  it('login resolves true only for the right password', async () => {
    const api = make();
    expect(await api.login('wrong')).toBe(false);
    expect(await api.login(MOCK_ADVANCED_PASSWORD)).toBe(true);
  });

  it('applies the configured latency', async () => {
    const api = createMockDevice({ latencyMs: 40 });
    const t0 = Date.now();
    await api.discover();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
  });
});
