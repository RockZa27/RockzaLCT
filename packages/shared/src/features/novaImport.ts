// NovaLCT file import: .rcfgx (receiving-card config) and .scr (screen config).
// Owned by the novaImport feature; types + methods it adds to DeviceApi.
// Keep this file free of runtime deps (it is bundled into the renderer as well).

import type {
  NovaFileInput,
  RcfgxParseResult,
  RcfgxProgress,
  RcfgxTarget,
  ScrParseResult,
  SendRcfgxOptions,
  SendRcfgxResult,
} from './novaImportModel.js';

export * from './novaImportModel.js';

export interface NovaImportApi {
  /**
   * Parse a .rcfgx picked by the user (the renderer hands over the bytes, the main process parses
   * them; no controller needed). Bad files come back as `{ ok: false, reason, message }`. The
   * register writes stay in the main process; the result carries a `fileId` for sendRcfgx.
   */
  parseRcfgxFile(file: NovaFileInput): Promise<RcfgxParseResult>;
  /** Parse a .scr (screen layout; CRC checked) and convert it to a layout model where it maps cleanly. */
  parseScreenFile(file: NovaFileInput): Promise<ScrParseResult>;
  /**
   * ADVANCED (PERMISSION otherwise). Replay the file's register writes on one receiving card or
   * broadcast them, in file order, honouring each record's delay. Every record is validated first;
   * nothing is sent if any is refused (INVALID_ARGUMENT). Stops at the first failed write and
   * reports how many were written. Never saves to flash by itself. While it runs, every other
   * command to this controller is refused.
   */
  sendRcfgx(id: string, fileId: string, target: RcfgxTarget, options: SendRcfgxOptions): Promise<SendRcfgxResult>;
  /** Progress of the running (or last finished) sendRcfgx on this controller; null if none. */
  getRcfgxProgress(id: string): Promise<RcfgxProgress | null>;
}

/** Every NovaImportApi method name; typed so a missing/extra name is a compile error. */
export const NOVA_IMPORT_METHODS: { [K in keyof NovaImportApi]-?: true } = {
  parseRcfgxFile: true,
  parseScreenFile: true,
  sendRcfgx: true,
  getRcfgxProgress: true,
};
