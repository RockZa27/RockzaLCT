// Taurus (NovaStar TU15 Pro / TU20 Pro / TB40 / TB50 / TB60 multimedia players) feature: types +
// methods added to DeviceApi. Keep free of runtime deps.
//
// Protocol source: @novastar/taurus 0.4.1 (MIT, reverse-engineered management protocol, TCP 16606,
// TLS when the player is in "privacy mode", UDP 16601 discovery). Ids look like `taurus:<host>`.
// See packages/device/src/taurus/ for the per-method mapping onto the library.
//
// Every method here is Taurus only: calling one with a non-Taurus id rejects with
// INVALID_ARGUMENT. Writes (setTaurusSyncMode, saveTaurusBrightness, and the core setBrightness)
// need the advanced user level (PERMISSION otherwise); reads do not.
//
// Credentials: connect() needs the player's password, which only the user knows. The UI calls
// setTaurusCredentials(id, ...) immediately before connect(id). The backend keeps the credentials
// in memory for that one connect attempt and forgets them afterwards (success or failure); they
// are never written to disk or logged, and there is no default password.

import type { BrightnessState } from '../index.js';

export interface TaurusCredentials {
  /** Optional; the library logs in as "admin" when omitted. */
  username?: string;
  password: string;
}

/** What UDP discovery (port 16601) reports about a player; available without logging in. */
export interface TaurusInfo {
  sn: string;
  /** e.g. "TB60"; empty when the player does not report it. */
  productName: string;
  modelId: number;
  aliasName: string;
  platform: string;
  address: string;
  /** Management port (TCP, usually 16606). */
  tcpPort: number;
  ftpPort?: number;
  /** Privacy mode: the management port speaks TLS. */
  privacy: boolean;
  /** `width` / `height` / `rotation` exactly as discovery reports them (meaning UNVERIFIED). */
  width: number;
  height: number;
  rotation: number;
}

/** ViPlex-style playback source policy (library `TaurusVideoMode`). */
export type TaurusVideoModeName = 'hdmi-preferred' | 'manual' | 'scheduled';
export type TaurusVideoSourceName = 'internal' | 'hdmi';

/**
 * 'synchronous' = HDMI input is the selected source (library `setSynchronousMode`);
 * 'asynchronous' = the internal player is selected in manual mode (library `setAsynchronousMode`);
 * 'other' = any other combination stored on the player (e.g. scheduled, or internal + hdmi-preferred).
 */
export type TaurusSyncMode = 'synchronous' | 'asynchronous' | 'other';

export interface TaurusSyncState {
  mode: TaurusSyncMode;
  videoMode: TaurusVideoModeName;
  videoSource: TaurusVideoSourceName;
  /** `videoMode === 'hdmi-preferred'`: fall back to the internal player when HDMI disappears. */
  fallbackToInternal: boolean;
  scaling: boolean;
  offset: { x: number; y: number };
}

export interface TaurusSourceInfo {
  source: number;
  name: string;
  internal: boolean;
  /** Signal present (library `connected`). */
  connected: boolean;
  width: number;
  height: number;
  frameRate: number;
  supportedResolutions: { width: number; height: number; frameRates: number[] }[];
}

export interface TaurusVideoSources {
  /** `currentSource` of the source list. */
  current: TaurusVideoSourceName;
  /** `getCurrentVideoSource`, when the player answered it. */
  active?: TaurusVideoSourceName;
  sources: TaurusSourceInfo[];
  /** Resolution the HDMI input advertises to its source (EDID), when readable. */
  hdmiInput?: { width: number; height: number; frameRate: number };
}

export interface TaurusLightSensor {
  /** false when the player has no usable ambient light sensor. */
  available: boolean;
  /** Raw sensor value; the unit is UNVERIFIED (the library does not say). */
  value?: number;
}

export interface TaurusScreenSummary {
  id: number;
  columns: number;
  rows: number;
  offset: { x: number; y: number };
  /** Pixel size of the area covered by the receiving cards of this screen. */
  width: number;
  height: number;
  portNumber: number;
  receivingCards: number;
}

/** Read-only summary of the LED screen configuration stored on the player. */
export interface TaurusScreenConfig {
  screens: TaurusScreenSummary[];
}

export interface TaurusApi {
  /** Remember the password for the next connect(id). Not persisted; consumed by that connect. */
  setTaurusCredentials(id: string, credentials: TaurusCredentials): Promise<void>;
  /** Discovery data for a known player (no connection needed). */
  getTaurusInfo(id: string): Promise<TaurusInfo>;
  /** Video configuration: HDMI (synchronous) or internal player (asynchronous). */
  getTaurusSyncMode(id: string): Promise<TaurusSyncState>;
  /** Advanced level required. `fallbackToInternal` only applies to 'synchronous'. */
  setTaurusSyncMode(
    id: string,
    mode: 'synchronous' | 'asynchronous',
    options?: { fallbackToInternal?: boolean },
  ): Promise<void>;
  getTaurusVideoSources(id: string): Promise<TaurusVideoSources>;
  getTaurusLightSensor(id: string): Promise<TaurusLightSensor>;
  readTaurusScreenConfig(id: string): Promise<TaurusScreenConfig>;
  /** Write the current brightness to the player's flash (library `persist`). Advanced level required. */
  saveTaurusBrightness(id: string): Promise<BrightnessState>;
}

/** Every TaurusApi method name; typed so a missing/extra name is a compile error. */
export const TAURUS_METHODS: { [K in keyof TaurusApi]-?: true } = {
  setTaurusCredentials: true,
  getTaurusInfo: true,
  getTaurusSyncMode: true,
  setTaurusSyncMode: true,
  getTaurusVideoSources: true,
  getTaurusLightSensor: true,
  readTaurusScreenConfig: true,
  saveTaurusBrightness: true,
};

/** Ids of Taurus players: `taurus:<host>`. */
export const TAURUS_ID_PREFIX = 'taurus:';
export const isTaurusId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(TAURUS_ID_PREFIX);
