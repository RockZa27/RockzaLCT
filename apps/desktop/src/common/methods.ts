import type { DeviceApi } from '@rockzalct/shared';

/** Every DeviceApi method; typed so a missing/extra name is a compile error. */
const table: { [K in keyof DeviceApi]: true } = {
  discover: true,
  connect: true,
  disconnect: true,
  getBrightness: true,
  setBrightness: true,
  setTestPattern: true,
  setDisplayMode: true,
  login: true,
};

export const DEVICE_METHODS = Object.keys(table) as (keyof DeviceApi)[];
