import type { DeviceApi } from '@rockzalct/shared';
import { createDeviceService } from '@rockzalct/device';
import { startSimulator } from '@rockzalct/simulator';
import { createMockDevice } from './mockDevice';

/** Defers every call until `ready` resolves; used for back-ends that need async setup. */
function deferred(ready: Promise<DeviceApi>): DeviceApi {
  return new Proxy({} as DeviceApi, {
    get: (_t, method: keyof DeviceApi) =>
      async (...args: unknown[]) => {
        const api = await ready;
        return (api[method] as (...a: unknown[]) => Promise<unknown>).apply(api, args);
      },
  });
}

/**
 * Registry of device back-ends, selected with env ROCKZALCT_DEVICE (default "real").
 * - real: NovaStar controllers over USB/COM and LAN
 * - sim:  starts the protocol simulator in-process and talks to it over TCP
 * - mock: in-memory fake, no protocol involved
 */
const backends: Record<string, () => DeviceApi> = {
  real: () => createDeviceService(),
  sim: () =>
    deferred(
      startSimulator({ port: 0, host: '127.0.0.1' }).then((sim) =>
        createDeviceService({ netHosts: ['127.0.0.1'], netPort: sim.port, serialDiscovery: false }),
      ),
    ),
  mock: () => createMockDevice(),
};

export function getDeviceApi(name: string | undefined = process.env.ROCKZALCT_DEVICE): DeviceApi {
  const key = name && name.length > 0 ? name : 'real';
  const make = backends[key];
  if (!make) {
    throw new Error(
      `Unknown ROCKZALCT_DEVICE "${key}". Available: ${Object.keys(backends).join(', ')}`,
    );
  }
  return make();
}
