// PLAN.md phase 7: monitoring. Owned by the monitor feature; types + methods it adds to DeviceApi.
//
// Everything here is read-only and allowed at the normal user level.
//
// UNITS: readings are carried as RAW register bytes (valid bit included) and decoded to degrees C /
// % RH / V / rpm with units.ts (docs/novalct-protocol-notes.md Q7). Thresholds are in real units.
// Still unknown (kept raw): sender-card temperature/humidity/fan words and the DVI status.

import type { MonitorSnapshot, MonitorSnapshotOptions } from './monitorModel.js';

export * from './monitorModel.js';
export * from './monitorLogic.js';

export interface MonitorApi {
  /**
   * One monitoring pass over the controller: sender-side per-port link information plus every
   * receiving card (online / offline / error and the raw temperature, humidity and voltage bytes).
   * Per-card failures become `offline` / `error` entries and never abort the pass; only a closed
   * connection (NOT_CONNECTED) or an unknown id (NOT_FOUND) rejects. Requests per card: 1
   * (+1 when the card refuses the 82-byte block, +1 with `includeBitErrorRate`); the device
   * implementation (packages/device/src/features/monitor.ts) documents the full count.
   */
  readMonitorSnapshot(id: string, options?: MonitorSnapshotOptions): Promise<MonitorSnapshot>;
}

/** Every MonitorApi method name; typed so a missing/extra name is a compile error. */
export const MONITOR_METHODS: { [K in keyof MonitorApi]-?: true } = {
  readMonitorSnapshot: true,
};
