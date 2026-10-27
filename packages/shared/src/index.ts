// Contract between the device layer (packages/device, runs in Electron main)
// and the UI (apps/desktop renderer). Keep this file free of runtime deps.

export type TransportKind = 'serial' | 'net' | 'hseries';

/** A controller found during discovery but not yet connected. */
export interface DiscoveredController {
  /** Stable id: `serial:<path>`, `net:<host>:<port>` or `hseries:<host>:<port>` (UDP). */
  id: string;
  transport: TransportKind;
  /** COM path (serial) or host (net). */
  address: string;
  port?: number;
  /** Human label, e.g. "COM3" or "192.168.0.10:5200". */
  label: string;
}

export interface ReceivingCardInfo {
  /** Sending-card output port (0-based). */
  portIndex: number;
  /** Position of the card on that port's chain (0-based). */
  cardIndex: number;
  model: string;
  firmwareVersion: string;
}

/** Controller family: NovaStar MCTRL/VX sending cards (binary protocol) or H series splicers (UDP/JSON). */
export type ControllerFamily = 'novastar' | 'hseries';

export interface ControllerInfo {
  id: string;
  /** Missing means 'novastar'. */
  family?: ControllerFamily;
  model: string;
  firmwareVersion: string;
  /** Number of Ethernet output ports on the sending card. */
  outputPorts: number;
  receivingCards: ReceivingCardInfo[];
}

/** Brightness as a percentage 0..100 (device stores 0..255). */
export interface BrightnessState {
  percent: number;
  /** Per-channel gain 0..100, used for colour temperature. */
  red: number;
  green: number;
  blue: number;
}

export type TestPattern =
  | 'off'
  | 'red'
  | 'green'
  | 'blue'
  | 'white'
  | 'horizontal-lines'
  | 'vertical-lines'
  | 'slash'
  | 'grayscale';

export type DisplayMode = 'normal' | 'blackout' | 'freeze';

export interface UserLevel {
  level: 'normal' | 'advanced';
}

import type { SenderApi } from './features/sender.js';
import type { ReceiverApi } from './features/receiver.js';
import type { LayoutApi } from './features/layout.js';
import type { PersistApi } from './features/persist.js';
import type { MonitorApi } from './features/monitor.js';
import type { HSeriesApi } from './features/hseries.js';

export * from './features/sender.js';
export * from './features/receiver.js';
export * from './features/layout.js';
export * from './features/persist.js';
export * from './features/monitor.js';
export * from './features/hseries.js';

/** Operations exposed to the renderer over IPC. All methods may reject with DeviceError. */
export interface DeviceApi extends SenderApi, ReceiverApi, LayoutApi, PersistApi, MonitorApi, HSeriesApi {
  discover(options?: { netHosts?: string[]; timeoutMs?: number }): Promise<DiscoveredController[]>;
  connect(id: string): Promise<ControllerInfo>;
  disconnect(id: string): Promise<void>;
  getBrightness(id: string): Promise<BrightnessState>;
  setBrightness(id: string, value: Partial<BrightnessState>): Promise<BrightnessState>;
  setTestPattern(id: string, pattern: TestPattern): Promise<void>;
  setDisplayMode(id: string, mode: DisplayMode): Promise<void>;
  /** Advanced-user login; resolves false on wrong password. */
  login(password: string): Promise<boolean>;
}

export type DeviceErrorCode =
  | 'NOT_FOUND'
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'PERMISSION'
  | 'INVALID_ARGUMENT';

export class DeviceError extends Error {
  constructor(
    public readonly code: DeviceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

export const percentToRaw = (percent: number): number =>
  Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);

export const rawToPercent = (raw: number): number =>
  Math.round((Math.min(255, Math.max(0, raw)) / 255) * 100);

/** IPC channel names; renderer calls `window.rockzalct.<method>`. */
export const IPC_PREFIX = 'rockzalct:';
