import { DeviceError, type DeviceErrorCode } from '@rockzalct/shared';

export const DEVICE_ERROR_CODES: readonly DeviceErrorCode[] = [
  'NOT_FOUND',
  'NOT_CONNECTED',
  'TIMEOUT',
  'PROTOCOL',
  'PERMISSION',
  'INVALID_ARGUMENT',
];

/** Plain-data error that survives structured clone (IPC) unchanged. */
export interface SerializedDeviceError {
  code: DeviceErrorCode;
  message: string;
}

/** Result envelope returned by every IPC handler. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: SerializedDeviceError };

const MARKER = '__ROCKZALCT_ERROR__';

const isCode = (c: unknown): c is DeviceErrorCode =>
  typeof c === 'string' && (DEVICE_ERROR_CODES as readonly string[]).includes(c);

/** Turn anything thrown in the main process into {code, message}. */
export function serializeError(err: unknown): SerializedDeviceError {
  if (err instanceof DeviceError) return { code: err.code, message: err.message };
  const maybe = err as { code?: unknown; message?: unknown } | null;
  if (maybe && isCode(maybe.code)) {
    return { code: maybe.code, message: typeof maybe.message === 'string' ? maybe.message : '' };
  }
  // Unknown failure: report as a protocol-level problem rather than leaking internals.
  return { code: 'PROTOCOL', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Errors thrown through contextBridge lose custom properties, but keep `message`.
 * The preload therefore encodes the payload into the message; `decodeError` reverses it.
 */
export function encodeErrorMessage(e: SerializedDeviceError): string {
  return MARKER + JSON.stringify(e);
}

/** Best-effort conversion of any rejection value into a DeviceError. */
export function decodeError(err: unknown): DeviceError {
  if (err instanceof DeviceError) return err;
  const maybe = err as { code?: unknown; message?: unknown } | null;
  const message = maybe && typeof maybe.message === 'string' ? maybe.message : String(err);
  const at = message.indexOf(MARKER);
  if (at >= 0) {
    try {
      const parsed = JSON.parse(message.slice(at + MARKER.length)) as SerializedDeviceError;
      if (isCode(parsed.code)) return new DeviceError(parsed.code, String(parsed.message ?? ''));
    } catch {
      /* fall through */
    }
  }
  if (maybe && isCode(maybe.code)) return new DeviceError(maybe.code, message);
  return new DeviceError('PROTOCOL', message);
}
