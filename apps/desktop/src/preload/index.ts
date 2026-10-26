import { contextBridge, ipcRenderer } from 'electron';
import { IPC_PREFIX, type DeviceApi } from '@rockzalct/shared';
import { DEVICE_METHODS } from '../common/methods';
import { encodeErrorMessage, type IpcResult } from '../common/ipcError';

const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
for (const method of DEVICE_METHODS) {
  api[method] = async (...args: unknown[]) => {
    const res = (await ipcRenderer.invoke(IPC_PREFIX + method, ...args)) as IpcResult<unknown>;
    if (res.ok) return res.value;
    // Custom Error fields do not cross the context bridge; the message does.
    throw new Error(encodeErrorMessage(res.error));
  };
}

contextBridge.exposeInMainWorld('rockzalct', api as unknown as DeviceApi);
