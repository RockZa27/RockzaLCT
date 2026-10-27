// Maps errors thrown by @novastar/taurus (and Node sockets) onto DeviceError codes.
//
// The library throws plain `Error`s with fixed messages (connection.ts / client.ts in the package):
// "Taurus request N timed out", "Taurus connection closed", "Taurus connection is closed",
// `TaurusResponseError` (non-zero response status) and `RangeError` (argument validation).

import { TaurusResponseError } from '@novastar/taurus';
import { DeviceError } from '@rockzalct/shared';

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

export function mapTaurusError(err: unknown): DeviceError {
  if (err instanceof DeviceError) return err;
  if (err instanceof TaurusResponseError) {
    return new DeviceError('PROTOCOL', `Taurus refused the request (status 0x${err.status.toString(16)})`);
  }
  if (err instanceof RangeError) return new DeviceError('INVALID_ARGUMENT', err.message);
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TIMEOUT_CODES.has(code)) return new DeviceError('TIMEOUT', message);
  if (/timed out/i.test(message)) return new DeviceError('TIMEOUT', message);
  if (/connection (is )?closed/i.test(message)) return new DeviceError('NOT_CONNECTED', message);
  return new DeviceError('PROTOCOL', message);
}
