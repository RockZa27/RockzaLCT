import {
  HSERIES_METHODS,
  LAYOUT_METHODS,
  MONITOR_METHODS,
  PERSIST_METHODS,
  RECEIVER_METHODS,
  SENDER_METHODS,
  TAURUS_METHODS,
  type DeviceApi,
} from '@rockzalct/shared';

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
  ...SENDER_METHODS,
  ...RECEIVER_METHODS,
  ...LAYOUT_METHODS,
  ...PERSIST_METHODS,
  ...MONITOR_METHODS,
  ...HSERIES_METHODS,
  ...TAURUS_METHODS,
};

export const DEVICE_METHODS = Object.keys(table) as (keyof DeviceApi)[];
