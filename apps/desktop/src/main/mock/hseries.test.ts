import { describe, expect, it } from 'vitest';
import { DeviceError, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'hseries:192.168.0.20:6000';
const make = async (advanced = false): Promise<DeviceApi> => {
  const api = createMockDevice({ latencyMs: 0 });
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

describe('mock H5', () => {
  it('is listed when asked for by host, or in an unfiltered scan when the hseries option is on', async () => {
    expect((await createMockDevice({ latencyMs: 0 }).discover()).map((c) => c.transport).sort()).toEqual(['net', 'serial']);
    const withHost = await createMockDevice({ latencyMs: 0 }).discover({ netHosts: ['192.168.0.20'] });
    expect(withHost.map((c) => c.id)).toContain(ID);
    const all = await createMockDevice({ latencyMs: 0, hseries: true }).discover();
    expect(all.map((c) => c.transport).sort()).toEqual(['hseries', 'net', 'serial']);
    expect((await createMockDevice({ latencyMs: 0, hseries: true }).discover({ netHosts: ['10.9.9.9'] })).map((c) => c.transport)).toEqual([
      'serial',
    ]);
  });

  it('connect reports the hseries family; unconnected calls are NOT_CONNECTED', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.listScreens(ID))).toBe('NOT_CONNECTED');
    const info = await api.connect(ID);
    expect(info).toMatchObject({ id: ID, family: 'hseries', receivingCards: [] });
  });

  it('H-only calls reject MCTRL ids', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    await api.connect('serial:COM3');
    expect(await codeOf(api.listScreens('serial:COM3'))).toBe('INVALID_ARGUMENT');
  });

  it('brightness: percent only, no login needed (like MCTRL), applied to every screen', async () => {
    const api = await make();
    expect(await api.getBrightness(ID)).toEqual({ percent: 80, red: 100, green: 100, blue: 100 });
    expect(await codeOf(api.setBrightness(ID, { red: 50 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setBrightness(ID, { percent: 101 }))).toBe('INVALID_ARGUMENT');
    expect(await api.setBrightness(ID, { percent: 20, red: 100 })).toMatchObject({ percent: 20 });
    expect((await api.listScreens(ID)).map((s) => s.brightness)).toEqual([20, 20]);
  });

  it('modes and patterns need the advanced level and update the screens', async () => {
    const api = await make();
    expect(await codeOf(api.setDisplayMode(ID, 'freeze'))).toBe('PERMISSION');
    expect(await codeOf(api.setTestPattern(ID, 'red'))).toBe('PERMISSION');
    await api.login(MOCK_ADVANCED_PASSWORD);
    await api.setDisplayMode(ID, 'freeze');
    expect((await api.listScreens(ID)).map((s) => s.frozen)).toEqual([true, true]);
    await api.setDisplayMode(ID, 'normal');
    expect((await api.listScreens(ID)).map((s) => s.frozen)).toEqual([false, false]);
    await api.setTestPattern(ID, 'red');
  });

  it('presets, layers, inputs and fade to black', async () => {
    const api = await make();
    expect(await codeOf(api.playPreset(ID, 0, 1))).toBe('PERMISSION');
    expect(await codeOf(api.fadeToBlack(ID, 0, true))).toBe('PERMISSION');
    await api.login(MOCK_ADVANCED_PASSWORD);

    expect((await api.listPresets(ID, 0)).map((p) => p.name)).toEqual(['Opening', 'Show', 'Closing']);
    expect(await api.listPresets(ID)).toHaveLength(6);
    await api.playPreset(ID, 1, 2);
    expect(await codeOf(api.playPreset(ID, 1, 99))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.playPreset(ID, 7, 0))).toBe('INVALID_ARGUMENT');

    expect(await api.listLayers(ID)).toHaveLength(4);
    expect((await api.listInputs(ID)).length).toBeGreaterThan(2);
    await api.setLayerInput(ID, 0, 1, 2);
    await api.setLayerInput(ID, 0, 1, 0, 0);
    expect(await codeOf(api.setLayerInput(ID, 0, 1, 42))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setLayerInput(ID, 0, 9, 0))).toBe('INVALID_ARGUMENT');

    await api.fadeToBlack(ID, 1, true);
    expect((await api.listScreens(ID)).map((s) => s.fadeToBlack)).toEqual([false, true]);
    await api.saveScreenBrightness(ID, 0);
  });
});
