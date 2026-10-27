// PLAN.md phase 7: monitoring. Owned by the monitor feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MonitorApi {}

/** Every MonitorApi method name; typed so a missing/extra name is a compile error. */
export const MONITOR_METHODS: { [K in keyof MonitorApi]-?: true } = {};
