// Pixel mapping step of the Smart Settings wizard: types + methods it adds to DeviceApi.
// Owned by the smartSettings feature (SmartSettingsApi extends PixelMappingApi); the pure model is in
// pixelMappingModel.ts. Keep this file free of runtime deps (it is bundled into the renderer too).
//
// Geometry only: the point table, the scan sequence and the chip-independent geometry registers.
// Chip timing / OE / gamma / driver registers are never written; the card keeps its current values.
// Everything is RAM only; nothing here saves to flash. 4th-generation run-line tables are not covered.

import type { DeviceErrorCode } from '../index.js';
import type { ReceiverTarget } from './receiver.js';
import type { Cell, PixelMappingInputs } from './pixelMappingModel.js';

export * from './pixelMappingModel.js';

/** A PC display the sender could be fed from (the picture that lights the pixels is drawn on it). */
export interface PixelDisplay {
  index: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

/** What is drawn: a black window at the display's top-left corner with one white pixel. */
export interface PixelFrame {
  /** Window size in picture pixels. */
  width: number;
  height: number;
  /** The lit pixel. */
  x: number;
  y: number;
}

/**
 * Draws the marking pictures on a PC display. NovaLCT lights a table position by drawing one pixel on
 * the desktop area that feeds the sender; the desktop app implements this with a borderless window.
 * Injected into the device service (createDeviceService option `pixelPainter`).
 */
export interface PixelPainter {
  listDisplays(): Promise<PixelDisplay[]>;
  /** Show `frame` on the display with this index (replaces the previous picture). */
  show(displayIndex: number, frame: PixelFrame): Promise<void>;
  /** Remove the picture (idempotent). */
  hide(): Promise<void>;
}

/** What the wizard read from the card (and the sender) before it changed anything. Informational: the undo is a reload from flash. */
export interface PixelMappingSnapshot {
  portIndex: number;
  cardIndex: number;
  controlWidth: number;
  controlHeight: number;
  totalPointInTable: number;
  pointNumPerDrive: number;
  groupNumInModule: number;
  smartSetMode: number;
  /** 128 bytes at 0x1C000100. */
  scanSequence: number[];
  rowsCtrlByDataGroup: number[];
  startPositionOfDataGroup: number[];
  dataGroupSequence: number[];
  /** Sender DVI offset of DVI 0 (restored when the wizard ends). */
  dviOffsetX: number;
  dviOffsetY: number;
}

export interface PixelMappingStartRequest {
  /** One card, or `all` = broadcast to every card of the controller (what NovaLCT does). */
  target: ReceiverTarget;
  /** The card that is read for the snapshot (must equal the target for scope `card`). */
  reference: { portIndex: number; cardIndex: number };
  inputs: PixelMappingInputs;
  /** Index into listPixelDisplays. */
  display: number;
  /** Where the card's top-left corner is on the PC picture; default 0, 0 (the wizard moves the sender DVI offset to 0, 0). */
  origin?: { x: number; y: number };
  /** Required to be exactly `true` when the target is `all`. */
  confirmBroadcast?: boolean;
}

export interface PixelMappingFailure {
  /** Name of the write that failed (a register key or step name). */
  step: string;
  code: DeviceErrorCode;
  message: string;
}

export interface PixelMappingStartResult {
  /** True when the card is now in the marking state. */
  ok: boolean;
  snapshot: PixelMappingSnapshot;
  /** Writes that went out, in order. */
  written: string[];
  failed?: PixelMappingFailure;
}

export interface PixelMappingFinishResult {
  ok: boolean;
  written: string[];
  failed?: PixelMappingFailure;
}

export interface PixelMappingUndoStep {
  step: string;
  ok: boolean;
  message?: string;
}

export interface PixelMappingUndoResult {
  /** True when every undo step went through. */
  ok: boolean;
  steps: PixelMappingUndoStep[];
}

export type PixelMappingStage = 'idle' | 'marking' | 'needs-undo';

export interface PixelMappingStatus {
  stage: PixelMappingStage;
  stepCount: number;
}

export interface PixelMappingApi {
  /** The PC displays the marking picture can be shown on. Allowed for every user level. */
  listPixelDisplays(id: string): Promise<PixelDisplay[]>;
  /**
   * Begin the marking: read the snapshot, put the sender (and the card) in smart mode, write the
   * geometry and make the card build its linear run-line table. Advanced level only (PERMISSION,
   * checked first). Locks the controller against every other command until finish or cancel.
   * A failure before anything was written rejects; a failure after that returns `{ ok: false, ... }`
   * and the wizard stays active so that cancelPixelMapping can undo.
   */
  startPixelMapping(id: string, request: PixelMappingStartRequest): Promise<PixelMappingStartResult>;
  /** Light the pixel of marking step `stepIndex` (drawn on the PC display). Writes nothing to the device. */
  lightPixelMappingStep(id: string, stepIndex: number): Promise<{ pixel: Cell }>;
  /**
   * Send the marked table: sender smart mode off, freeze, geometry, point table, scan sequence,
   * generate the run-line table, unfreeze. RAM only. The marks are re-validated against the plan
   * given at start. On success the controller is released. A failure after the first write returns
   * `{ ok: false, ... }` and keeps the wizard active for cancelPixelMapping.
   */
  finishPixelMapping(id: string, marks: readonly Cell[]): Promise<PixelMappingFinishResult>;
  /**
   * Undo: sender smart mode off, card smart mode off, reload the parameters from flash, clear
   * freeze/kill/lock. Every step is tried even if one fails. Releases the controller. Advanced level only.
   */
  cancelPixelMapping(id: string): Promise<PixelMappingUndoResult>;
  getPixelMappingStatus(id: string): Promise<PixelMappingStatus>;
}

/** Every PixelMappingApi method name; typed so a missing/extra name is a compile error. */
export const PIXEL_MAPPING_METHODS: { [K in keyof PixelMappingApi]-?: true } = {
  listPixelDisplays: true,
  startPixelMapping: true,
  lightPixelMappingStep: true,
  finishPixelMapping: true,
  cancelPixelMapping: true,
  getPixelMappingStatus: true,
};
