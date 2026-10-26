// PLAN.md phase 5: screen connection. Owned by the layout feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LayoutApi {}

/** Every LayoutApi method name; typed so a missing/extra name is a compile error. */
export const LAYOUT_METHODS: { [K in keyof LayoutApi]-?: true } = {};
