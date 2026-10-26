import { describe, expect, it } from 'vitest';
import { DeviceError, IPC_PREFIX } from '@rockzalct/shared';
import { decodeError, encodeErrorMessage, type IpcResult } from '../common/ipcError';
import { DEVICE_METHODS } from '../common/methods';
import { getDeviceApi } from './deviceFactory';
import { registerDeviceIpc } from './ipc';
import { createMockDevice } from './mockDevice';

function setup() {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => Promise<IpcResult<unknown>>>();
  registerDeviceIpc(
    { handle: (c, l) => void handlers.set(c, l as never) },
    createMockDevice({ latencyMs: 0 }),
  );
  const call = (m: string, ...args: unknown[]) => handlers.get(IPC_PREFIX + m)!({}, ...args);
  return { handlers, call };
}

describe('ipc', () => {
  it('registers a handler per DeviceApi method on IPC_PREFIX + name', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(DEVICE_METHODS.map((m) => IPC_PREFIX + m).sort());
  });

  it('wraps results and serialises DeviceError as {code, message}', async () => {
    const { call } = setup();
    const ok = await call('discover');
    expect(ok.ok).toBe(true);
    const bad = await call('getBrightness', 'serial:COM3');
    expect(bad).toEqual({ ok: false, error: { code: 'NOT_CONNECTED', message: expect.any(String) } });
    // The envelope is plain data, so it survives structured clone.
    expect(structuredClone(bad)).toEqual(bad);
  });

  it('maps unexpected errors to PROTOCOL', async () => {
    const handlers = new Map<string, (e: unknown) => Promise<IpcResult<unknown>>>();
    registerDeviceIpc({ handle: (c, l) => void handlers.set(c, l as never) }, {
      ...createMockDevice(),
      login: async () => {
        throw new TypeError('boom');
      },
    });
    expect(await handlers.get(IPC_PREFIX + 'login')!({})).toEqual({
      ok: false,
      error: { code: 'PROTOCOL', message: 'boom' },
    });
  });

  it('error message encoding round-trips through decodeError', () => {
    const err = decodeError(new Error('Error invoking: ' + encodeErrorMessage({ code: 'PERMISSION', message: 'm' })));
    expect(err).toBeInstanceOf(DeviceError);
    expect(err.code).toBe('PERMISSION');
    expect(err.message).toBe('m');
    expect(decodeError(new Error('plain')).code).toBe('PROTOCOL');
  });
});

describe('getDeviceApi', () => {
  it('defaults to the mock and rejects unknown names', () => {
    expect(typeof getDeviceApi(undefined).discover).toBe('function');
    expect(typeof getDeviceApi('mock').connect).toBe('function');
    expect(() => getDeviceApi('nope')).toThrow(/Available: mock/);
  });
});
