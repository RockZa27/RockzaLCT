import { describe, expect, it } from 'vitest';
import { DeviceError, rgbCodeToByte, type DeviceApi } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'serial:COM3';
const CARD = { scope: 'card', portIndex: 0, cardIndex: 0 } as const;
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

describe('mock smart settings', () => {
  it('reads a default snapshot, requires a connection and valid indexes', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.readSmartSnapshot(ID, 0, 0))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.readSmartSnapshot('nope', 0, 0))).toBe('NOT_FOUND');
    await api.connect(ID);
    expect(await api.readSmartSnapshot(ID, 1, 0)).toEqual({
      portIndex: 1,
      cardIndex: 0,
      moduleWidth: 64,
      moduleHeight: 32,
      scanMode: 16,
      dataGroups: 8,
      driverIc: 33,
      decodeType: 3,
      dataDirection: 0,
      oePolarity: 0,
      rgb: { red: 0, green: 1, blue: 2, virtualRed: 0 },
    });
    expect(await codeOf(api.readSmartSnapshot(ID, -1, 0))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.readSmartSnapshot(ID, 255, 0))).toBe('INVALID_ARGUMENT');
  });

  it('locks writes to advanced users, before validation', async () => {
    const api = await make();
    expect(await codeOf(api.writeSmartSettings(ID, CARD, { oePolarity: 1 }))).toBe('PERMISSION');
    expect(await codeOf(api.writeSmartSettings(ID, { scope: 'all' }, { oePolarity: 99 }))).toBe('PERMISSION');
    expect((await api.readSmartSnapshot(ID, 0, 0)).oePolarity).toBe(0);
  });

  it('writes the given fields to the addressed card only and reads them back', async () => {
    const api = await make(true);
    const rgb = { red: 2, green: 0, blue: 1, virtualRed: 1 };
    const res = await api.writeSmartSettings(ID, CARD, { moduleWidth: 96, decodeType: 7, dataDirection: 1, oePolarity: 1, rgb });
    expect(res).toEqual({ ok: true, written: ['moduleWidth', 'decodeType', 'dataDirection', 'rgb', 'oePolarity'] });
    expect(await api.readSmartSnapshot(ID, 0, 0)).toMatchObject({ moduleWidth: 96, decodeType: 7, dataDirection: 1, oePolarity: 1, rgb, moduleHeight: 32 });
    expect(await api.readSmartSnapshot(ID, 0, 1)).toMatchObject({ moduleWidth: 64, decodeType: 3, dataDirection: 0, oePolarity: 0 });
    expect(rgbCodeToByte(rgb)).toBe(0b01_01_00_10);
  });

  it('shares the geometry with the receiving card feature', async () => {
    const api = await make(true);
    await api.writeSmartSettings(ID, CARD, { moduleWidth: 80, driverIc: 40, dataGroups: 12 });
    expect(await api.getReceiverParameters(ID, 0, 0)).toMatchObject({ moduleWidth: 80, driverIc: 40, physicalDataGroups: 12 });
    await api.setReceiverParameters(ID, CARD, { gamma: 20 });
    expect(await api.readSmartSnapshot(ID, 0, 0)).toMatchObject({ moduleWidth: 80 });
  });

  it('broadcast reaches the cards touched before', async () => {
    const api = await make(true);
    await api.readSmartSnapshot(ID, 0, 0);
    await api.readSmartSnapshot(ID, 1, 0);
    await api.writeSmartSettings(ID, { scope: 'all' }, { oePolarity: 1 });
    expect((await api.readSmartSnapshot(ID, 0, 0)).oePolarity).toBe(1);
    expect((await api.readSmartSnapshot(ID, 1, 0)).oePolarity).toBe(1);
  });

  it('validates like the device layer, restore mode included', async () => {
    const api = await make(true);
    expect(await codeOf(api.writeSmartSettings(ID, CARD, {}))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.writeSmartSettings(ID, CARD, { oePolarity: 2 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.writeSmartSettings(ID, CARD, { decodeType: 56 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.writeSmartSettings(ID, CARD, { rgb: { red: 1, green: 1, blue: 1, virtualRed: 0 } }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.writeSmartSettings(ID, { scope: 'card', portIndex: 255, cardIndex: 0 }, { oePolarity: 1 }))).toBe('INVALID_ARGUMENT');
    expect((await api.readSmartSnapshot(ID, 0, 0)).oePolarity).toBe(0);
    const raw = { driverIc: 255, decodeType: 255, oePolarity: 255 };
    expect(await codeOf(api.writeSmartSettings(ID, CARD, raw))).toBe('INVALID_ARGUMENT');
    expect((await api.writeSmartSettings(ID, CARD, raw, { restore: true })).ok).toBe(true);
    expect(await api.readSmartSnapshot(ID, 0, 0)).toMatchObject(raw);
  });
});
