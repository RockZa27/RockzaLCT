// PLAN.md phase 5: screen connection. Owned by the layout feature; types + methods it adds to DeviceApi.

import type { LayoutHardwareState, LayoutModel } from './layoutModel.js';

export * from './layoutModel.js';
export * from './layoutPlan.js';

export interface WriteLayoutOptions {
  /** Also write the "port enabled" flag of every port that has cabinets. Default true. */
  enablePorts?: boolean;
  /** Pixels per port used when validating; default LAYOUT_DEFAULT_PORT_CAPACITY (650 000). */
  portCapacity?: number;
  /**
   * By default the write is refused when a port's chain length differs from the number of
   * receiving cards the sender reports on that port. Set to write anyway (e.g. a stale count
   * register); a card that does not exist still fails the write with PROTOCOL.
   */
  ignoreCardCount?: boolean;
  /** Also write each card's cabinet serial-number register (1-based, port order then chain order). */
  writeCabinetNumbers?: boolean;
}

export interface WriteLayoutResult {
  portsWritten: number;
  cardsWritten: number;
  complexScreen: boolean;
}

export interface LayoutApi {
  /**
   * Read the screen layout stored in the controller: per output port the load region, per receiving
   * card its position (relative to its port region) and size, and the complex-screen flag.
   */
  readLayout(id: string): Promise<LayoutHardwareState>;
  /**
   * Write `layout` to the controller: sender port regions and flags plus every receiving card's
   * position and size. Requires advanced level (PERMISSION otherwise); INVALID_ARGUMENT when the
   * layout has validation errors or does not match the cards found on each port.
   */
  writeLayout(id: string, layout: LayoutModel, options?: WriteLayoutOptions): Promise<WriteLayoutResult>;
  /**
   * NovaLCT "display cabinet numbers": writes each card's cabinet serial number and switches the
   * receiving cards to / from their hardware-screen test mode. Requires advanced level.
   */
  showCabinetNumbers(id: string, layout: LayoutModel, enabled: boolean): Promise<void>;
}

/** Every LayoutApi method name; typed so a missing/extra name is a compile error. */
export const LAYOUT_METHODS: { [K in keyof LayoutApi]-?: true } = {
  readLayout: true,
  writeLayout: true,
  showCabinetNumbers: true,
};
