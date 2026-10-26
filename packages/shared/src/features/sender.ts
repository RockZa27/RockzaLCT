// PLAN.md phase 3: sending card. Owned by the sender feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SenderApi {}

/** Every SenderApi method name; typed so a missing/extra name is a compile error. */
export const SENDER_METHODS: { [K in keyof SenderApi]-?: true } = {};
