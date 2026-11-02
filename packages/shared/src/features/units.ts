// Real-unit decoders for receiving-card / monitor-card status bytes. No runtime deps, no I/O.
// Formulas are facts recorded in docs/novalct-protocol-notes.md section "Q7. Units / scales".
// Every decoder returns null when the byte says "not valid" (so callers show a dash, never 0).

const VALID = 0x80;

/**
 * Temperature in degrees C from the [flags, magnitude] byte pair: flags bit7 = valid, bit0 =
 * negative; magnitude x 0.5 C (0x80/0x32 -> 25.0, 0x81/0x32 -> -25.0). Null when bit7 is clear.
 */
export function temperatureC(flags: number, magnitude: number): number | null {
  if ((flags & VALID) === 0) return null;
  const c = (magnitude & 0xff) * 0.5;
  return (flags & 0x01) !== 0 && c !== 0 ? -c : c;
}

/** Relative humidity in % from one byte: (b & 0x7F), bit7 = valid. */
export function humidityPct(b: number): number | null {
  return (b & VALID) === 0 ? null : b & 0x7f;
}

/** Volts from one byte: (b & 0x7F) x 0.1, bit7 = valid (0xB2 -> 5.0 V). Rounded to 0.1 V. */
export function voltageV(b: number): number | null {
  return (b & VALID) === 0 ? null : (b & 0x7f) / 10;
}

/** Fan speed in rpm from one byte: (b & 0x7F) x 50, bit7 = valid. */
export function fanRpm(b: number): number | null {
  return (b & VALID) === 0 ? null : (b & 0x7f) * 50;
}

/** Monitor-card smoke byte: bit7 = valid, bit0 = alarm. Null when not valid. */
export function smokeAlarm(b: number): boolean | null {
  return (b & VALID) === 0 ? null : (b & 0x01) !== 0;
}

/** Gamma register byte meaning: a number, or the custom gamma table marker. */
export type GammaValue = { kind: 'value'; value: number } | { kind: 'custom' };

/** Highest gamma the card treats as real; anything above is coerced to the default. */
export const GAMMA_MAX = 4.0;
export const GAMMA_DEFAULT = 2.8;

/**
 * Decode the gamma register byte 0x02000000: (b & 0x3F)/10, plus 0.05 when bit6 is set;
 * 0xFE = custom gamma table, 0xFF = default 2.8, values above 4.0 are coerced to 2.8.
 */
export function decodeGamma(b: number): GammaValue {
  const byte = b & 0xff;
  if (byte === 0xfe) return { kind: 'custom' };
  if (byte === 0xff) return { kind: 'value', value: GAMMA_DEFAULT };
  const g = (byte & 0x3f) / 10 + ((byte & 0x40) !== 0 ? 0.05 : 0);
  return { kind: 'value', value: g > GAMMA_MAX ? GAMMA_DEFAULT : Math.round(g * 100) / 100 };
}

/**
 * Inverse of `decodeGamma` for a plain value: floor(g x 10) in bits 0-5, bit6 when the hundredths digit
 * is 5. Returns null for anything the register cannot hold (outside 0..4.0, or not a multiple of
 * 0.05).
 */
export function encodeGamma(g: number): number | null {
  if (!Number.isFinite(g) || g < 0 || g > GAMMA_MAX) return null;
  const hundredths = Math.round(g * 100);
  if (Math.abs(g * 100 - hundredths) > 1e-6 || hundredths % 5 !== 0) return null;
  const tenths = Math.floor(hundredths / 10);
  return tenths | (hundredths % 10 === 5 ? 0x40 : 0);
}
