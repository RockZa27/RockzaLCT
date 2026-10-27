import { describe, expect, it } from 'vitest';
import { DeviceError, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';
import { MOCK_TAURUS_PASSWORD } from './taurus';

const ID = 'taurus:192.168.0.30';
const make = async (advanced = false): Promise<DeviceApi> => {
  const api = createMockDevice({ latencyMs: 0 });
  await api.setTaurusCredentials(ID, { password: MOCK_TAURUS_PASSWORD });
  await api.connect(ID);
  if (advanced) await api.login(MOCK_ADVANCED_PASSWORD);
  return api;
};
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceError);
    return (e as DeviceError).code;
  }
  throw new Error('expected rejection');
};

describe('mock Taurus', () => {
  it('is listed when asked for by host, or in an unfiltered scan when the taurus option is on; the default list is unchanged', async () => {
    expect((await createMockDevice({ latencyMs: 0 }).discover()).map((c) => c.transport).sort()).toEqual(['net', 'serial']);
    expect((await createMockDevice({ latencyMs: 0 }).discover({ netHosts: ['192.168.0.30'] })).map((c) => c.id)).toContain(ID);
    const all = await createMockDevice({ latencyMs: 0, hseries: true, taurus: true }).discover();
    expect(all.map((c) => c.transport).sort()).toEqual(['hseries', 'net', 'serial', 'taurus']);
    expect((await createMockDevice({ latencyMs: 0, taurus: true }).discover({ netHosts: ['10.9.9.9'] })).map((c) => c.transport)).toEqual([
      'serial',
    ]);
  });

  it('needs the password, once per connect', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.connect(ID))).toBe('PERMISSION');
    await api.setTaurusCredentials(ID, { password: 'wrong' });
    expect(await codeOf(api.connect(ID))).toBe('PERMISSION');
    expect(await codeOf(api.connect(ID))).toBe('PERMISSION'); // single use
    await api.setTaurusCredentials(ID, { password: MOCK_TAURUS_PASSWORD });
    expect(await api.connect(ID)).toMatchObject({ id: ID, family: 'taurus' });
    expect(await codeOf(api.setTaurusCredentials('serial:COM3', { password: 'x' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setTaurusCredentials(ID, { password: '' }))).toBe('INVALID_ARGUMENT');
  });

  it('Taurus-only calls need a connection and reject other families', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.getTaurusSyncMode(ID))).toBe('NOT_CONNECTED');
    await api.connect('serial:COM3');
    expect(await codeOf(api.getTaurusSyncMode('serial:COM3'))).toBe('INVALID_ARGUMENT');
  });

  it('brightness: percent only, advanced only; save needs advanced too', async () => {
    const api = await make();
    expect(await api.getBrightness(ID)).toEqual({ percent: 70, red: 100, green: 100, blue: 100 });
    expect(await codeOf(api.setBrightness(ID, { percent: 20 }))).toBe('PERMISSION');
    expect(await codeOf(api.saveTaurusBrightness(ID))).toBe('PERMISSION');
    await api.login(MOCK_ADVANCED_PASSWORD);
    expect(await codeOf(api.setBrightness(ID, { red: 50 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setBrightness(ID, { percent: 101 }))).toBe('INVALID_ARGUMENT');
    expect(await api.setBrightness(ID, { percent: 20, red: 100 })).toMatchObject({ percent: 20 });
    expect(await api.saveTaurusBrightness(ID)).toMatchObject({ percent: 20 });
  });

  it('test patterns and display modes are not supported', async () => {
    const api = await make(true);
    expect(await codeOf(api.setTestPattern(ID, 'red'))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setDisplayMode(ID, 'blackout'))).toBe('INVALID_ARGUMENT');
  });

  it('sync mode round trip, video sources, light sensor and screen summary', async () => {
    const api = await make();
    expect((await api.getTaurusSyncMode(ID)).mode).toBe('asynchronous');
    expect(await codeOf(api.setTaurusSyncMode(ID, 'synchronous'))).toBe('PERMISSION');
    await api.login(MOCK_ADVANCED_PASSWORD);
    await api.setTaurusSyncMode(ID, 'synchronous', { fallbackToInternal: true });
    expect(await api.getTaurusSyncMode(ID)).toMatchObject({ mode: 'synchronous', fallbackToInternal: true, videoMode: 'hdmi-preferred' });
    await api.setTaurusSyncMode(ID, 'asynchronous');
    expect((await api.getTaurusVideoSources(ID)).current).toBe('internal');
    expect(await api.getTaurusLightSensor(ID)).toEqual({ available: true, value: 320 });
    expect((await api.readTaurusScreenConfig(ID)).screens[0]).toMatchObject({ width: 256, height: 128 });
    expect((await api.getTaurusInfo(ID)).productName).toBe('TB60');
  });
});
