// PLAN.md phase 6: save & load. Owned by the persist feature; types + methods it adds to DeviceApi.
// Keep this file free of runtime deps (it is bundled into the renderer as well).

import type { DeviceErrorCode } from '../index.js';
import type { WriteLayoutOptions } from './layout.js';
import type { ReceiverTarget } from './receiver.js';
import type { ScreenConfig } from './persistModel.js';

export * from './persistModel.js';
export * from './persistRunner.js';

// ---------------------------------------------------------------------------------------------
// Save to hardware

export interface SaveToHardwareOptions {
  /** Also persist the sending card's parameters. Default: true for scope 'all', false for one card. */
  includeSender?: boolean;
  /**
   * Byte written to the sender's save register (SetSaveSendCardsParameters). The library does not
   * document its meaning; the default is in the device package (SAVE_COMMAND_VALUES, UNVERIFIED).
   */
  senderValue?: number;
  /** Byte written to each card's store-to-flash register (SetParameterStore2SpiFlash); same caveat. */
  receiverValue?: number;
}

export interface SaveItemResult {
  /** Absent for the sending card. */
  portIndex?: number;
  cardIndex?: number;
  ok: boolean;
  code?: DeviceErrorCode;
  message?: string;
}

export interface SaveToHardwareResult {
  /** null when the sender was not part of the request. */
  sender: SaveItemResult | null;
  /** One entry per receiving card addressed (each is sent and acknowledged separately). */
  cards: SaveItemResult[];
  /** True when every attempted item succeeded. */
  ok: boolean;
}

// ---------------------------------------------------------------------------------------------
// Read back

export interface ConfigReadFailure {
  part: 'controller' | 'sender' | 'receiver' | 'layout';
  portIndex?: number;
  cardIndex?: number;
  code: DeviceErrorCode | 'UNKNOWN';
  message: string;
}

export interface ConfigReadWarning {
  /** layout-*: why the controller's stored layout could not be turned into a layout model. */
  code: 'layout-no-cards' | 'layout-not-a-grid' | 'layout-unsized-cards' | 'layout-invalid';
  params?: Record<string, number>;
}

export interface ReadScreenConfigResult {
  /** Everything that could be read. Parts that failed are null / missing (see `failures`). */
  config: ScreenConfig;
  failures: ConfigReadFailure[];
  warnings: ConfigReadWarning[];
  /** True when there are no failures. */
  complete: boolean;
}

// ---------------------------------------------------------------------------------------------
// Apply

export interface ApplyScreenConfigOptions {
  /** Which parts of the file to write; all true by default. A part that is null in the file is skipped anyway. */
  parts?: { receivers?: boolean; layout?: boolean; sender?: boolean };
  /** After a fully successful apply, also save to hardware (all cards + sender). */
  saveToHardware?: boolean;
  save?: SaveToHardwareOptions;
  /** Apply although the file's controller model differs from the connected one. */
  allowModelMismatch?: boolean;
  /** Skip file cards the controller does not have instead of refusing the whole apply. */
  skipMissingCards?: boolean;
  /** Passed to writeLayout. */
  layout?: WriteLayoutOptions;
}

export type ApplyStepKind =
  | 'receiver'
  | 'layout'
  | 'sender-resolution'
  | 'sender-field-rate'
  | 'sender-input-source'
  | 'sender-port'
  | 'save';

export interface ApplyStepResult {
  kind: ApplyStepKind;
  portIndex?: number;
  cardIndex?: number;
  /** written = sent to the controller; skipped = deliberately not written (see `message`); failed = the step that stopped the run. */
  status: 'written' | 'skipped' | 'failed';
  code?: DeviceErrorCode;
  message?: string;
}

export interface ApplyScreenConfigResult {
  /** True when every step succeeded (skipped steps are fine). */
  ok: boolean;
  /** Steps in the order they ran; the run stops at the first failed step. */
  steps: ApplyStepResult[];
  /** The step that failed, when ok is false. Nothing after it was written. */
  failedStep?: ApplyStepResult;
  /** Present when saveToHardware was requested and all earlier steps succeeded. */
  save?: SaveToHardwareResult;
}

// ---------------------------------------------------------------------------------------------

export interface PersistApi {
  /**
   * ADVANCED. Make the current parameters permanent (survive a power cycle): per receiving card
   * the "store parameters to flash" command, and optionally the sender's save command. Target one
   * card or all. Each card is sent separately so a partial failure is reported per card.
   */
  saveToHardware(id: string, target: ReceiverTarget, options?: SaveToHardwareOptions): Promise<SaveToHardwareResult>;
  /**
   * Read a full snapshot: controller identity, sender video/ports, every receiving card and the
   * layout. A part that fails to read is reported in `failures` and does not abort the others.
   */
  readScreenConfig(id: string): Promise<ReadScreenConfigResult>;
  /**
   * ADVANCED. Write a screen config to the connected controller: validates the file and checks it
   * against the controller first (INVALID_ARGUMENT, nothing written), then writes receivers, then
   * the layout, then the sender, stopping at the first error. Only values that differ are written.
   */
  applyScreenConfig(id: string, config: ScreenConfig, options?: ApplyScreenConfigOptions): Promise<ApplyScreenConfigResult>;
}

/** Every PersistApi method name; typed so a missing/extra name is a compile error. */
export const PERSIST_METHODS: { [K in keyof PersistApi]-?: true } = {
  saveToHardware: true,
  readScreenConfig: true,
  applyScreenConfig: true,
};

/** Byte range of the save command arguments. */
export const SAVE_VALUE_RANGE = { min: 0, max: 255 } as const;
