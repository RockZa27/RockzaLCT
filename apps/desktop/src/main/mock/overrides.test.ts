import { describe, expect, it } from 'vitest';
import { DEFAULT_HARDWARE_OVERRIDES, DeviceError, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const make = async (advanced: boolean): Promise<DeviceApi> => {
  const api = createMockDevice({ latencyMs: 0 });
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

describe('mock hardware overrides', () => {
  it('starts at the defaults and returns copies', async () => {
    const api = await make(false);
    const v = await api.getHardwareOverrides();
    expect(v).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    v.killOn = 77;
    expect(await api.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });

  it('needs the advanced level to set or reset', async () => {
    const api = await make(false);
    expect(await codeOf(api.setHardwareOverrides({ killOn: 2 }))).toBe('PERMISSION');
    expect(await codeOf(api.resetHardwareOverrides())).toBe('PERMISSION');
    expect(await api.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });

  it('merges, validates the whole and resets', async () => {
    const api = await make(true);
    expect(await api.setHardwareOverrides({ lockOn: 2 })).toEqual({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 });
    expect(await api.setHardwareOverrides({ scannerXyOrder: 'x-low' })).toEqual({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2, scannerXyOrder: 'x-low' });
    expect(await codeOf(api.setHardwareOverrides({ killOn: 256 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setHardwareOverrides({ correctionEnabledBit: 2 }))).toBe('INVALID_ARGUMENT');
    expect((await api.getHardwareOverrides()).lockOn).toBe(2);
    expect(await api.resetHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });
});
