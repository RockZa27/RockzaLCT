// PLAN.md phase 9: function card & firmware. Owned by the maintenance feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MaintenanceApi {}

/** Every MaintenanceApi method name; typed so a missing/extra name is a compile error. */
export const MAINTENANCE_METHODS: { [K in keyof MaintenanceApi]-?: true } = {};
