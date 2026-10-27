import type { MessageKey } from '../../i18n/dictionary';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Human text for a failed block: the localised error code when there is one, else the raw message. */
export function failureReason(t: Translate, failed: { code: string; message: string }): string {
  const key = `error.${failed.code}` as MessageKey;
  const text = t(key);
  return text === key ? failed.message : text;
}

export const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(6, '0')}`;
