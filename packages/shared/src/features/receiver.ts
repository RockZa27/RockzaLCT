// PLAN.md phase 4: receiving card. Owned by the receiver feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ReceiverApi {}

/** Every ReceiverApi method name; typed so a missing/extra name is a compile error. */
export const RECEIVER_METHODS: { [K in keyof ReceiverApi]-?: true } = {};
