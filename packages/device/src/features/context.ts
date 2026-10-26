import type { UserLevel } from '@rockzalct/shared';
import type { SessionLike } from '../session.js';

/** What a feature module gets from the device service. */
export interface FeatureContext {
  /**
   * Run `fn` on the controller's open session. Throws NOT_FOUND / NOT_CONNECTED, and maps codec
   * errors to DeviceError. Cast the session to add the @novastar/native methods your feature imports.
   */
  withSession<T>(id: string, fn: (session: SessionLike) => Promise<T>): Promise<T>;
  userLevel(): UserLevel;
  timeoutMs: number;
}
