import type { DeviceApi } from '@rockzalct/shared';
import { DEVICE_METHODS } from '../common/methods';
import { decodeError } from '../common/ipcError';

declare global {
  interface Window {
    /** Exposed by the preload script. The renderer's only link to the main process. */
    rockzalct?: DeviceApi;
  }
}

/**
 * Wrap a DeviceApi so every rejection becomes a real DeviceError ({code, message}),
 * whatever shape the transport (contextBridge, a test fake) delivered it in.
 */
export function wrapDeviceApi(raw: DeviceApi): DeviceApi {
  const wrapped = {} as Record<string, unknown>;
  for (const m of DEVICE_METHODS) {
    wrapped[m] = async (...args: unknown[]) => {
      try {
        return await (raw[m] as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (e) {
        throw decodeError(e);
      }
    };
  }
  return wrapped as unknown as DeviceApi;
}

/** The production client: window.rockzalct, wrapped. */
export function getWindowDeviceClient(): DeviceApi {
  if (!window.rockzalct) throw new Error('window.rockzalct is missing (preload not loaded)');
  return wrapDeviceApi(window.rockzalct);
}
