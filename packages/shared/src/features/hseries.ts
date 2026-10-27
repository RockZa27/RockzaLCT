// H series (NovaStar H2/H5/H9/H15/H20 video-wall splicers) feature: types + methods added to
// DeviceApi. Keep free of runtime deps.
//
// Protocol source: kman1898/companion-module-novastar-splicer v3.0.7 (MIT), see
// packages/device/src/hseries/protocol.ts for the per-command citations. The controller speaks
// UDP/JSON (default port 6000), not the MCTRL binary protocol. Ids look like
// `hseries:<host>:<port>`.
//
// Every method here is H-series only: calling one with a non-H id rejects with
// INVALID_ARGUMENT. Writes (playPreset, setLayerInput, fadeToBlack, saveScreenBrightness) need the
// advanced user level (PERMISSION otherwise); reads do not.

/** One screen (a "screen" on an H series is a canvas the layers/presets belong to). */
export interface HSeriesScreen {
  /** Wire `screenId` (0-based). */
  screenId: number;
  name: string;
  /** Screen brightness 0..100 (W0410/R0401 `brightness` is already a percentage). */
  brightness: number;
  /** R0401 `Freeze.enable === 1`. */
  frozen: boolean;
  /** R0401 `Ftb.enable === 0` (the protocol's FTB flag is inverted: 0 = fade-to-black ON). */
  fadeToBlack: boolean;
}

/** A preset (saved scene) of one screen. */
export interface HSeriesPreset {
  screenId: number;
  presetId: number;
  name: string;
}

/** A layer on a screen. */
export interface HSeriesLayer {
  screenId: number;
  layerId: number;
  name: string;
}

/** An input source. `cropId` 255 = the whole source, otherwise a crop region of it. */
export interface HSeriesInput {
  inputId: number;
  cropId: number;
  name: string;
  /** Input card slot / connector, when the device reports them. */
  slotId?: number;
  interfaceId?: number;
  interfaceType?: number;
  /** R0226 `online` (anything but 0 counts as online). */
  online: boolean;
}

/** `cropId` value meaning "no crop: the whole source". */
export const HSERIES_WHOLE_SOURCE = 255;

export interface HSeriesApi {
  /** R0400 + R0401 per screen. */
  listScreens(id: string): Promise<HSeriesScreen[]>;
  /** R0600 for one screen, or for every screen when `screenId` is omitted. */
  listPresets(id: string, screenId?: number): Promise<HSeriesPreset[]>;
  /** W0605. Advanced level required. */
  playPreset(id: string, screenId: number, presetId: number): Promise<void>;
  /** R0500 for one screen, or for every screen when `screenId` is omitted. */
  listLayers(id: string, screenId?: number): Promise<HSeriesLayer[]>;
  /** R0226. */
  listInputs(id: string): Promise<HSeriesInput[]>;
  /**
   * W0506: show `inputId` (optionally a crop of it) on a layer. INVALID_ARGUMENT when the input is
   * not in the device's input list. Advanced level required.
   */
  setLayerInput(id: string, screenId: number, layerId: number, inputId: number, cropId?: number): Promise<void>;
  /** W0409 on one screen (`enabled` true = fade to black). Advanced level required. */
  fadeToBlack(id: string, screenId: number, enabled: boolean): Promise<void>;
  /** W0417: persist a screen's current brightness to the LED receiving cards. Advanced level required. */
  saveScreenBrightness(id: string, screenId: number): Promise<void>;
}

/** Every HSeriesApi method name; typed so a missing/extra name is a compile error. */
export const HSERIES_METHODS: { [K in keyof HSeriesApi]-?: true } = {
  listScreens: true,
  listPresets: true,
  playPreset: true,
  listLayers: true,
  listInputs: true,
  setLayerInput: true,
  fadeToBlack: true,
  saveScreenBrightness: true,
};

/** Ids of H series controllers: `hseries:<host>:<port>`. */
export const HSERIES_ID_PREFIX = 'hseries:';
export const isHSeriesId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(HSERIES_ID_PREFIX);
