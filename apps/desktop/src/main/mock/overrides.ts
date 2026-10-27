import {
  DEFAULT_HARDWARE_OVERRIDES,
  DeviceError,
  resolveHardwareOverrides,
  type HardwareOverrides,
  type OverridesApi,
} from '@rockzalct/shared';
import type { MockContext } from './context';

/** In-memory advanced hardware settings: same permission and validation rules as the real service, nothing persisted. */
export function createMockOverrides(ctx: MockContext, initial?: Partial<HardwareOverrides>): OverridesApi {
  const start = resolveHardwareOverrides(DEFAULT_HARDWARE_OVERRIDES, initial);
  let current: HardwareOverrides = start.ok ? start.values : { ...DEFAULT_HARDWARE_OVERRIDES };
  const requireAdvanced = (): void => {
    if (!ctx.isAdvanced()) {
      throw new DeviceError('PERMISSION', 'changing the advanced hardware settings requires an advanced user login');
    }
  };
  return {
    async getHardwareOverrides() {
      await ctx.delay();
      return { ...current };
    },
    async setHardwareOverrides(partial) {
      await ctx.delay();
      requireAdvanced();
      const res = resolveHardwareOverrides(current, partial);
      if (!res.ok) throw new DeviceError('INVALID_ARGUMENT', `invalid hardware settings: ${res.errors.join('; ')}`);
      current = res.values;
      return { ...current };
    },
    async resetHardwareOverrides() {
      await ctx.delay();
      requireAdvanced();
      current = { ...DEFAULT_HARDWARE_OVERRIDES };
      return { ...current };
    },
  };
}
