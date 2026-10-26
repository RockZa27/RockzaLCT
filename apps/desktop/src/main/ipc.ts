import { IPC_PREFIX, type DeviceApi } from '@rockzalct/shared';
import { DEVICE_METHODS } from '../common/methods';
import { serializeError, type IpcResult } from '../common/ipcError';

/** Minimal slice of Electron's ipcMain, so this can be tested without Electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
}

/** Registers one handler per DeviceApi method on `${IPC_PREFIX}${method}`. */
export function registerDeviceIpc(ipc: IpcMainLike, api: DeviceApi): void {
  for (const method of DEVICE_METHODS) {
    ipc.handle(IPC_PREFIX + method, async (_event, ...args: unknown[]): Promise<IpcResult<unknown>> => {
      try {
        const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
        return { ok: true, value: await fn.apply(api, args) };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    });
  }
}
