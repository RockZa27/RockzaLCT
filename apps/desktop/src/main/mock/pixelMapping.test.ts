import { describe, expect, it } from 'vitest';
import { DeviceError, type Cell, type DeviceApi, type PixelMappingStartRequest } from '@rockzalct/shared';
import { createMockDevice, MOCK_ADVANCED_PASSWORD } from '../mockDevice';

const ID = 'serial:COM3';
const REQ: PixelMappingStartRequest = {
  target: { scope: 'card', portIndex: 0, cardIndex: 0 },
  reference: { portIndex: 0, cardIndex: 0 },
  inputs: { moduleWidth: 32, moduleHeight: 16, scanCount: 8, dataGroups: 2, dataDirection: 0 },
  display: 0,
};
const marks = (): Cell[] => [
  ...Array.from({ length: 32 }, (_, x) => ({ x, y: 0 })),
  ...Array.from({ length: 7 }, (_, i) => ({ x: 0, y: i + 1 })),
];
const make = async (advanced = true): Promise<DeviceApi> => {
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

describe('mock pixel mapping', () => {
  it('needs a connection; listing displays and the status are open to every level', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.listPixelDisplays(ID))).toBe('NOT_CONNECTED');
    await api.connect(ID);
    expect(await api.listPixelDisplays(ID)).toHaveLength(2);
    expect(await api.getPixelMappingStatus(ID)).toEqual({ stage: 'idle', stepCount: 0 });
  });

  it('locks the wizard to advanced users, before validation', async () => {
    const api = await make(false);
    expect(await codeOf(api.startPixelMapping(ID, REQ))).toBe('PERMISSION');
    expect(await codeOf(api.startPixelMapping(ID, { ...REQ, inputs: { ...REQ.inputs, dataGroups: 99 } }))).toBe('PERMISSION');
    expect(await codeOf(api.lightPixelMappingStep(ID, 0))).toBe('PERMISSION');
    expect(await codeOf(api.finishPixelMapping(ID, marks()))).toBe('PERMISSION');
    expect(await codeOf(api.cancelPixelMapping(ID))).toBe('PERMISSION');
  });

  it('runs start, light, finish end to end and changes the geometry the receiver page shows', async () => {
    const api = await make();
    const res = await api.startPixelMapping(ID, REQ);
    expect(res.ok).toBe(true);
    expect(await api.getPixelMappingStatus(ID)).toEqual({ stage: 'marking', stepCount: 39 });
    expect(await api.lightPixelMappingStep(ID, 32)).toEqual({ pixel: { x: 0, y: 1 } });
    expect(await api.getReceiverParameters(ID, 0, 0)).toMatchObject({ scanMode: 8, physicalDataGroups: 2 });
    expect(await codeOf(api.startPixelMapping(ID, REQ))).toBe('INVALID_ARGUMENT'); // already running
    expect(await codeOf(api.lightPixelMappingStep(ID, 39))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.finishPixelMapping(ID, marks().slice(0, 10)))).toBe('INVALID_ARGUMENT');
    expect((await api.finishPixelMapping(ID, marks())).ok).toBe(true);
    expect(await api.getPixelMappingStatus(ID)).toEqual({ stage: 'idle', stepCount: 0 });
    expect(await api.getReceiverParameters(ID, 0, 0)).toMatchObject({ scanMode: 8, physicalDataGroups: 2 });
    expect(await codeOf(api.finishPixelMapping(ID, marks()))).toBe('INVALID_ARGUMENT'); // not running any more
  });

  it('cancel puts the geometry back and ends the wizard; with nothing running it does nothing', async () => {
    const api = await make();
    const before = await api.getReceiverParameters(ID, 0, 0);
    await api.startPixelMapping(ID, REQ);
    expect(await api.getReceiverParameters(ID, 0, 0)).not.toMatchObject({ scanMode: before.scanMode, physicalDataGroups: before.physicalDataGroups });
    const undo = await api.cancelPixelMapping(ID);
    expect(undo.ok).toBe(true);
    expect(undo.steps.map((s) => s.step)).toContain('parameterReload');
    expect(await api.getReceiverParameters(ID, 0, 0)).toMatchObject({ scanMode: before.scanMode, physicalDataGroups: before.physicalDataGroups });
    expect(await api.getPixelMappingStatus(ID)).toEqual({ stage: 'idle', stepCount: 0 });
    expect(await api.cancelPixelMapping(ID)).toEqual({ ok: true, steps: [] });
  });

  it('broadcast needs the confirmation; the reference must be the target card', async () => {
    const api = await make();
    expect(await codeOf(api.startPixelMapping(ID, { ...REQ, target: { scope: 'all' } }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.startPixelMapping(ID, { ...REQ, reference: { portIndex: 0, cardIndex: 1 } }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.startPixelMapping(ID, { ...REQ, display: 7 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.startPixelMapping(ID, { ...REQ, inputs: { ...REQ.inputs, scanCount: 65 } }))).toBe('INVALID_ARGUMENT');
    expect((await api.startPixelMapping(ID, { ...REQ, target: { scope: 'all' }, confirmBroadcast: true })).ok).toBe(true);
  });
});
