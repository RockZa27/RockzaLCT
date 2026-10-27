// PLAN.md phase 8: calibration. Owned by the calibration feature; types + methods it adds to DeviceApi.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CalibrationApi {}

/** Every CalibrationApi method name; typed so a missing/extra name is a compile error. */
export const CALIBRATION_METHODS: { [K in keyof CalibrationApi]-?: true } = {};
