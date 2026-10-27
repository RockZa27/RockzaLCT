/** localStorage key of the function card bus address (the library has no default for it). */
export const FUNCTION_CARD_ADDRESS_KEY = 'rockzalct.functionCardAddress';

/** Parse the address field: an integer 0..255, otherwise null. */
export function parseAddress(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 0 && n <= 255 ? n : null;
}

export function loadAddress(): string {
  try {
    return localStorage.getItem(FUNCTION_CARD_ADDRESS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAddress(text: string): void {
  try {
    localStorage.setItem(FUNCTION_CARD_ADDRESS_KEY, text);
  } catch {
    /* storage unavailable */
  }
}

/** Parse up to 8 hex digits into an unsigned number; empty means "not given" (undefined); bad input is null. */
export function parseHex32(text: string): number | undefined | null {
  const s = text.trim().replace(/^0x/i, '');
  if (s === '') return undefined;
  if (!/^[0-9a-fA-F]{1,8}$/.test(s)) return null;
  return parseInt(s, 16) >>> 0;
}
