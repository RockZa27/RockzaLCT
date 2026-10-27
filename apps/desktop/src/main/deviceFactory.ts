import type { DeviceApi } from '@rockzalct/shared';
import { createDeviceService } from '@rockzalct/device';
import { startHSeriesSimulator, startSimulator } from '@rockzalct/simulator';
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
 * - sim:  starts the MCTRL simulator (TCP) and the H series simulator (UDP) in-process, so both
 *         controller families show up
 * - mock: in-memory fake, no protocol involved
 */
const backends: Record<string, () => DeviceApi> = {
  real: () => createDeviceService(),
  sim: () =>
    deferred(
      Promise.all([
        startSimulator({ port: 0, host: '127.0.0.1' }),
        startHSeriesSimulator({ port: 0, host: '127.0.0.1' }),
      ]).then(([sim, hsim]) =>
        createDeviceService({
          netHosts: ['127.0.0.1'],
          netPort: sim.port,
          // discover() probes the same host for an H series on this UDP port
          hseriesPort: hsim.port,
          serialDiscovery: false,
        }),
      ),
    ),
  mock: () => createMockDevice({ hseries: true }),
};

/**
 * Picks the back-end name. Command-line flags win over the environment, so a
 * packaged Windows build can be started in simulator mode without env vars:
 *   RockzaLCT.exe --sim        (also --mock, or --device=<name>)
 * Default (no flag, no env) is "real".
 */
export function resolveDeviceName(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): string {
  for (const arg of argv) {
    if (arg === '--sim') return 'sim';
    if (arg === '--mock') return 'mock';
    if (arg.startsWith('--device=') && arg.length > '--device='.length) {
      return arg.slice('--device='.length);
    }
  }
  const fromEnv = env['ROCKZALCT_DEVICE'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'real';
}

export function getDeviceApi(name: string | undefined = resolveDeviceName()): DeviceApi {
  const key = name && name.length > 0 ? name : 'real';
  const make = backends[key];
  if (!make) {
    throw new Error(
      `Unknown ROCKZALCT_DEVICE "${key}". Available: ${Object.keys(backends).join(', ')}`,
    );
  }
  return make();
}
