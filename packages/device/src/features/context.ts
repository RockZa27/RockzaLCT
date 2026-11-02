import { DEFAULT_HARDWARE_OVERRIDES, type HardwareOverrides, type UserLevel } from '@rockzalct/shared';
import type { SessionLike } from '../session.js';

/**
 * A hold on one controller that outlives a single call (the pixel-mapping wizard owns the controller
 * across several UI steps). While it is held every other withSession / withExclusiveSession call for
 * that controller is refused (PROTOCOL, "busy"). Commands run through the lease itself.
 */
export interface SessionLease {
  run<T>(fn: (session: SessionLike) => Promise<T>): Promise<T>;
  /** True until released or until the connection was closed / lost (the service drops the hold then). */
  held(): boolean;
  /** Idempotent. */
  release(): void;
}

/** What a feature module gets from the device service. */
export interface FeatureContext {
  /**
   * Run `fn` on the controller's open session. Throws NOT_FOUND / NOT_CONNECTED, and maps codec
   * errors to DeviceError. Cast the session to add the @novastar/native methods your feature imports.
   */
  withSession<T>(id: string, fn: (session: SessionLike) => Promise<T>): Promise<T>;
  /**
   * Like withSession, but while `fn` runs every other withSession call for the same controller is
   * refused (PROTOCOL, "busy"), and a second exclusive run is refused too. Optional: a context
   * without it just runs `fn` like withSession.
   */
  withExclusiveSession?<T>(id: string, fn: (session: SessionLike) => Promise<T>): Promise<T>;
  /**
   * Take the controller for several calls (see SessionLease). Throws NOT_FOUND / NOT_CONNECTED, and
   * PROTOCOL "busy" when another run or lease holds it. Optional: a context without it (tests) gets
   * a lease that is plain withSession per call and does not lock anything.
   */
  acquireExclusive?(id: string): SessionLease;
  userLevel(): UserLevel;
  timeoutMs: number;
  /**
   * The advanced hardware settings (unverified protocol values) in effect RIGHT NOW. Features must
   * call this inside the command they are executing, never cache the result at construction, so a
   * change made on the settings page applies to the very next command. Optional so that a context
   * built without it (tests, other callers) simply uses DEFAULT_HARDWARE_OVERRIDES.
   */
  hardwareOverrides?(): HardwareOverrides;
}

/** Overrides in effect for this call (see FeatureContext.hardwareOverrides). */
export const currentOverrides = (ctx: FeatureContext): Readonly<HardwareOverrides> =>
  ctx.hardwareOverrides?.() ?? DEFAULT_HARDWARE_OVERRIDES;
