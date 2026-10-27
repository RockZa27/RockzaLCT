import {
  CALIBRATION_METHODS,
  HSERIES_METHODS,
  MAINTENANCE_METHODS,
  LAYOUT_METHODS,
  MONITOR_METHODS,
  NOVA_IMPORT_METHODS,
  OVERRIDES_METHODS,
  PERSIST_METHODS,
  RECEIVER_METHODS,
  SENDER_METHODS,
  SMART_SETTINGS_METHODS,
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
  ...SMART_SETTINGS_METHODS,
  ...LAYOUT_METHODS,
  ...PERSIST_METHODS,
  ...MONITOR_METHODS,
  ...CALIBRATION_METHODS,
  ...MAINTENANCE_METHODS,
  ...OVERRIDES_METHODS,
  ...NOVA_IMPORT_METHODS,
  ...HSERIES_METHODS,
  ...TAURUS_METHODS,
};

export const DEVICE_METHODS = Object.keys(table) as (keyof DeviceApi)[];
