// PLAN.md phase 3: sending card (NovaLCT: Screen Configuration -> Sending Card).
// Types + methods this feature adds to DeviceApi. Keep free of runtime deps.

/**
 * Physical input connector selected on the sending card. Names mirror `DviSelectModeEnum` in
 * @novastar/native (dist/DviSelectMode-*.d.cts); the numeric values live in the device package.
 */
export type SenderInputSource = 'DVI' | 'HDMI' | 'HDMI1' | 'HDMI2' | 'SDI' | 'DP' | 'Dual_DVI' | 'HDBaseT' | 'LVDS';

export const SENDER_INPUT_SOURCES: readonly SenderInputSource[] = [
  'DVI',
  'HDMI',
  'HDMI1',
  'HDMI2',
  'SDI',
  'DP',
  'Dual_DVI',
  'HDBaseT',
  'LVDS',
];

/** Input resolution of the sending card in pixels. */
export interface SenderResolution {
  width: number;
  height: number;
}

/** Input side of the sending card. */
export interface SenderVideoStatus {
  /** Whether the card reports an input signal (ReadIsHasDVI). */
  signalPresent: boolean;
  /** Configured input resolution (ReadDviWidth/ReadDviHeight, DVI index 0). */
  resolution: SenderResolution;
  /** Raw field-rate mode byte (ReadFieldRateMode). Meaning of values is not documented by the library. */
  fieldRateMode: number;
  /** Raw configured field-rate register (ReadFieldRate). Unit is not documented by the library. */
  fieldRate: number;
  /** Raw measured DVI0 field-rate register (ReadDVI0FieldRate). Unit is not documented by the library. */
  measuredFieldRate: number;
  /** Selected input connector, or null when the register holds a value not in SENDER_INPUT_SOURCES. */
  inputSource: SenderInputSource | null;
  /** Raw value of the input-select register (ReadDviSelect). */
  inputSourceRaw: number;
}

/** One Ethernet output port of the sending card. */
export interface SenderPortStatus {
  portIndex: number;
  enabled: boolean;
  /** Size of the screen area loaded by this port (ReadPortWidth/ReadPortHeight). */
  width: number;
  height: number;
  /** width * height: pixels loaded on this port. Percent of capacity is not derivable from the library. */
  pixels: number;
  /** Receiving cards counted on the port (ReadNumberOfCardOrScanBoardInPort, cardType 0). */
  receivingCards: number;
}

export type SenderRedundancyState = 'ok' | 'error' | 'unknown';

/** One 8-byte redundant-state block of the sending card, decoded per byte as RedundantStateTypeEnum. */
export interface SenderRedundancySpace {
  /** 'legacy' = ReadSender_RedundantStateSpace, 'new' = ReadSender_RedundantStateNewSpace. */
  space: 'legacy' | 'new';
  /** Raw 8 bytes as read. */
  raw: number[];
  /** Byte i decoded as the state of port i (0 ok, 1 error, anything else unknown). Mapping is unverified on hardware. */
  ports: { portIndex: number; state: SenderRedundancyState }[];
}

/** Backup / redundancy status. */
export interface SenderRedundancyStatus {
  /** Load mode (ReadLoadMode): normal 'high-load' or 'backup' load; 'unknown' for any other byte. */
  loadMode: 'high-load' | 'backup' | 'unknown';
  /**
   * The library has two redundant-state blocks (older and newer firmware layouts) and no way to tell
   * which one a given card uses, so both are returned.
   */
  spaces: SenderRedundancySpace[];
}

export interface SenderApi {
  /** Input resolution, field rate, signal and input source. */
  getSenderVideo(id: string): Promise<SenderVideoStatus>;
  /** ADVANCED. Writes the input resolution (1..65535 each). Returns the re-read status. */
  setSenderResolution(id: string, resolution: SenderResolution): Promise<SenderVideoStatus>;
  /** ADVANCED. Writes the field-rate register (0..65535, raw). Returns the re-read status. */
  setSenderFieldRate(id: string, fieldRate: number): Promise<SenderVideoStatus>;
  /** ADVANCED. Selects the input connector. Returns the re-read status. */
  setSenderInputSource(id: string, source: SenderInputSource): Promise<SenderVideoStatus>;
  /** Per Ethernet output port: enable state, loaded area and receiving-card count. */
  getSenderPorts(id: string): Promise<SenderPortStatus[]>;
  /** ADVANCED. Enables / disables one output port (0..31). Returns the re-read port list. */
  setSenderPortEnabled(id: string, portIndex: number, enabled: boolean): Promise<SenderPortStatus[]>;
  /** Backup / redundancy status. */
  getSenderRedundancy(id: string): Promise<SenderRedundancyStatus>;
}

/** Every SenderApi method name; typed so a missing/extra name is a compile error. */
export const SENDER_METHODS: { [K in keyof SenderApi]-?: true } = {
  getSenderVideo: true,
  setSenderResolution: true,
  setSenderFieldRate: true,
  setSenderInputSource: true,
  getSenderPorts: true,
  setSenderPortEnabled: true,
  getSenderRedundancy: true,
};

/** Output-port indexes accepted by the port methods (0..SENDER_MAX_PORTS-1). */
export const SENDER_MAX_PORTS = 32;
