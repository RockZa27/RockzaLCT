import type { DiscoveredController } from '@rockzalct/shared';

/**
 * The subset of the Session API (methods added by `@novastar/native/api/*` side-effect imports)
 * that the device service uses. Production factories return real `@novastar/codec` sessions
 * cast to this interface; tests supply fakes.
 */
export interface SessionLike {
  ReadControllerModelId(addr: number): Promise<number>;
  ReadSender_McuProgramEdition(addr: number): Promise<number>;
  ReadSender_FPGAProgramEdition(addr: number): Promise<number>;
  ReadScanerCountOfSenderCard(addr: number): Promise<Buffer>;
  ReadNumberOfCardOrScanBoardInPort(addr: number, portIndex: number, cardType: number): Promise<number>;
  ReadScanner_McuProgramEdition(addr: number, portAddr: number, scanBoardAddr: number): Promise<number>;
  ReadAllBrightnessInfo(addr: number, portAddr: number, scanBoardAddr: number): Promise<Buffer>;
  SetGlobalBrightness(
    addr: number,
    portAddr: number,
    scanBoardAddr: number,
    broadcast: boolean,
    value: number,
  ): Promise<void>;
  SetRGBBrightness(
    addr: number,
    portAddr: number,
    scanBoardAddr: number,
    broadcast: boolean,
    red: number,
    green: number,
    blue: number,
    vRed: number,
  ): Promise<void>;
  SetSelfTestMode(
    addr: number,
    portAddr: number,
    scanBoardAddr: number,
    broadcast: boolean,
    mode: number,
  ): Promise<void>;
  /** Close the underlying connection. */
  close(): unknown;
}

export interface OpenOptions {
  /** Per-request / connect timeout in milliseconds. */
  timeoutMs: number;
}

/** Opens (and closes) sessions for a discovered controller. Injected so tests can fake it. */
export interface SessionFactory {
  open(controller: DiscoveredController, options: OpenOptions): Promise<SessionLike>;
  /** Optional: fully release the transport. Falls back to `session.close()`. */
  close?(controller: DiscoveredController, session: SessionLike): Promise<void>;
}
