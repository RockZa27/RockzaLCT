import { describe, expect, it } from 'vitest';
import {
  DeviceError,
  bytesToBase64,
  coefficientIoFromApi,
  downloadCoefficients,
  uploadCoefficients,
  type DeviceApi,
} from '@rockzalct/shared';
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

describe('mock calibration', () => {
  it('requires a connection and valid arguments', async () => {
    const api = createMockDevice({ latencyMs: 0 });
    expect(await codeOf(api.getCalibrationState(ID, 0, 0))).toBe('NOT_CONNECTED');
    expect(await codeOf(api.getCalibrationState('nope', 0, 0))).toBe('NOT_FOUND');
    await api.connect(ID);
    expect(await codeOf(api.getCalibrationState(ID, -1, 0))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.readCoefficientBlock(ID, 0, 0, 0, 257))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.setCalibrationEnabled(ID, { scope: 'all' }, true, 'red' as never))).toBe('INVALID_ARGUMENT');
  });

  it('switches calibration on and off at the normal level', async () => {
    const api = await make();
    expect(await api.getCalibrationState(ID, 0, 0)).toMatchObject({ enabled: false, type: 'chroma', coefficientData: 'data' });
    await api.setCalibrationEnabled(ID, { scope: 'card', portIndex: 0, cardIndex: 0 }, true, 'brightness');
    expect(await api.getCalibrationState(ID, 0, 0)).toMatchObject({ enabled: true, type: 'brightness', stateRaw: 3 });
    await api.getCalibrationState(ID, 1, 0); // touch a second card so a broadcast reaches it
    await api.setCalibrationEnabled(ID, { scope: 'all' }, false);
    expect(await api.getCalibrationState(ID, 0, 0)).toMatchObject({ enabled: false });
    expect(await api.getCalibrationState(ID, 1, 0)).toMatchObject({ enabled: false });
  });

  it('refuses writes, flash commands and erase at the normal level', async () => {
    const api = await make();
    const block = bytesToBase64(new Uint8Array(16));
    expect(await codeOf(api.writeCoefficientBlock(ID, 0, 0, 0, block))).toBe('PERMISSION');
    expect(await codeOf(api.saveCoefficientsToFlash(ID, 0, 0))).toBe('PERMISSION');
    expect(await codeOf(api.reloadCoefficientsFromFlash(ID, 0, 0))).toBe('PERMISSION');
    expect(await codeOf(api.eraseCoefficientsInFlash(ID, 0, 0))).toBe('PERMISSION');
    // nothing changed
    const down = await downloadCoefficients(coefficientIoFromApi(api, ID, 0, 0), 0, 16);
    expect(down.ok).toBe(true);
    expect(down.data).not.toEqual(new Uint8Array(16));
  });

  it('round-trips coefficients, keeps cards separate, and models flash store / reload / erase', async () => {
    const api = await make(true);
    const io = coefficientIoFromApi(api, ID, 0, 0);
    const original = (await downloadCoefficients(io, 0, 600)).data;

    const patch = new Uint8Array(600).fill(0x5a);
    expect(await uploadCoefficients(io, 0, patch)).toMatchObject({ ok: true, doneBytes: 600 });
    expect((await downloadCoefficients(io, 0, 600)).data).toEqual(patch);
    // the second card still has its own seeded data
    expect((await downloadCoefficients(coefficientIoFromApi(api, ID, 1, 0), 0, 600)).data).toEqual(original);

    // not stored yet: reloading from flash brings the original back
    await api.reloadCoefficientsFromFlash(ID, 0, 0);
    expect((await downloadCoefficients(io, 0, 600)).data).toEqual(original);

    await uploadCoefficients(io, 0, patch);
    await api.saveCoefficientsToFlash(ID, 0, 0);
    await uploadCoefficients(io, 0, new Uint8Array(600).fill(1));
    await api.reloadCoefficientsFromFlash(ID, 0, 0);
    expect((await downloadCoefficients(io, 0, 600)).data).toEqual(patch);

    await api.eraseCoefficientsInFlash(ID, 0, 0);
    await api.reloadCoefficientsFromFlash(ID, 0, 0);
    expect(await api.getCalibrationState(ID, 0, 0)).toMatchObject({ coefficientData: 'erased' });
  });

  it('rejects malformed block arguments like the device does', async () => {
    const api = await make(true);
    expect(await codeOf(api.writeCoefficientBlock(ID, 0, 0, 0, '***'))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.writeCoefficientBlock(ID, 0, 0, 0, bytesToBase64(new Uint8Array(257))))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(api.saveCoefficientsToFlash(ID, 0, 0, 'weird' as never))).toBe('INVALID_ARGUMENT');
  });
});
