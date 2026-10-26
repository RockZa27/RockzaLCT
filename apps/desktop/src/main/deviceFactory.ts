import type { DeviceApi } from '@rockzalct/shared';
import { createMockDevice } from './mockDevice';

/**
 * Registry of device back-ends, selected with env ROCKZALCT_DEVICE (default "mock").
 * To use the real service, add one entry, e.g.:
 *   real: () => createDeviceService(),   // from '@rockzalct/device'
 */
const backends: Record<string, () => DeviceApi> = {
  mock: () => createMockDevice(),
};

export function getDeviceApi(name: string | undefined = process.env.ROCKZALCT_DEVICE): DeviceApi {
  const key = name && name.length > 0 ? name : 'mock';
  const make = backends[key];
  if (!make) {
    throw new Error(
      `Unknown ROCKZALCT_DEVICE "${key}". Available: ${Object.keys(backends).join(', ')}`,
    );
  }
  return make();
}
