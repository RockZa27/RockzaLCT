import { describe, expect, it } from 'vitest';
import { DeviceError, type CabinetProfile, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'serial:COM3';
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

const PROFILE: CabinetProfile = {
  name: 'P2.5',
  width: 96,
  height: 48,
  scanMode: 24,
  dataGroups: 12,
  refNumPerVs: 2400,
  gamma: 26,
  grayDepth: 13,
  grayRealize: 2,
  grayMode: 0,
  driverIc: 40,
};

describe('mock receiver', () => {
  it('reads defaults, requires a connection and valid indexes', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.getReceiverParameters(ID, 0, 0))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.getReceiverParameters('nope', 0, 0))).toBe('NOT_FOUND');
    await api.connect(ID);
    const p = await api.getReceiverParameters(ID, 1, 0);
    expect(p).toMatchObject({ portIndex: 1, cardIndex: 0, moduleWidth: 64, moduleHeight: 32 });
    expect(await codeOf(api.getReceiverParameters(ID, -1, 0))).toBe('INVALID_ARGUMENT');
  });

  it('locks writes to advanced users', async () => {
    const api = await make();
    const card = { scope: 'card', portIndex: 0, cardIndex: 0 } as const;
    expect(await codeOf(api.setReceiverParameters(ID, card, { gamma: 20 }))).toBe('PERMISSION');
    expect(await codeOf(api.applyCabinetProfile(ID, card, PROFILE))).toBe('PERMISSION');
    expect((await api.getReceiverParameters(ID, 0, 0)).gamma).toBe(28);
  });

  it('writes one card, broadcasts to touched cards, applies profiles', async () => {
    const api = await make(true);
    await api.getReceiverParameters(ID, 0, 0);
    await api.getReceiverParameters(ID, 0, 1);
    await api.setReceiverParameters(ID, { scope: 'card', portIndex: 0, cardIndex: 0 }, { gamma: 20, grayMode: 3 });
    expect(await api.getReceiverParameters(ID, 0, 0)).toMatchObject({ gamma: 20, grayMode: 3 });
    expect((await api.getReceiverParameters(ID, 0, 1)).gamma).toBe(28);

    await api.applyCabinetProfile(ID, { scope: 'all' }, PROFILE);
    for (const c of [0, 1]) {
      expect(await api.getReceiverParameters(ID, 0, c)).toMatchObject({
        moduleWidth: 96,
        scanMode: 24,
        physicalDataGroups: 12,
        driverIc: 40,
        refNumPerVs: 2400,
        grayRealize: 2,
        grayMode: 0,
      });
    }
  });

  it('rejects bad arguments', async () => {
    const api = await make(true);
    const card = { scope: 'card', portIndex: 0, cardIndex: 0 } as const;
    expect(await codeOf(api.setReceiverParameters(ID, card, { gamma: 999 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setReceiverParameters(ID, { scope: 'all' }, { grayMode: 1 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.applyCabinetProfile(ID, card, { ...PROFILE, width: 0 }))).toBe('INVALID_ARGUMENT');
  });
});
