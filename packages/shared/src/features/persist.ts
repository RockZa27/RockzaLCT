// PLAN.md phase 6: save & load. Owned by the persist feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PersistApi {}

/** Every PersistApi method name; typed so a missing/extra name is a compile error. */
export const PERSIST_METHODS: { [K in keyof PersistApi]-?: true } = {};
