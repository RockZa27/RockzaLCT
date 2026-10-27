// Data model of the monitoring feature (PLAN.md phase 7). No runtime deps, no I/O.
// All readings are RAW register bytes: the library defines no unit/scale (see monitor.ts).

export interface MonitorCardRef {
  /** Sending-card output port (0-based). */
  portIndex: number;
  /** Position on the port's chain (0-based). */
  cardIndex: number;
}

export interface MonitorSnapshotOptions {
  /**
   * The cards to poll (normally ControllerInfo.receivingCards). When omitted the device discovers
   * them from the sender (ports that report cards); a port whose cable is down is then invisible,
   * so pass the list to get `port-down` / `offline` reporting.
   */
  cards?: MonitorCardRef[];
  /** +1 request per online card: read the 3-byte bit-error-rate block (raw). Default false. */
  includeBitErrorRate?: boolean;
  /**
   * Bus address (the `addr` argument of the FuncCard_* natives) of a multi-function card. The
   * library does not say which address a function card has, so it is opt-in: when omitted the
   * function card is not read. 2 requests when given.
   */
  functionCardAddress?: number;
}

/** online: answered; offline: no answer (timeout); error: answered with an error / short data. */
export type MonitorCardState = 'online' | 'offline' | 'error';

/** Extra values from a monitor card attached to a receiving card (82-byte block, bytes 0x20..0x51). */
export interface MonitorAttachedCard {
  temperatureRaw?: number;
  humidityRaw?: number;
  /** Raw smoke-warning byte; the library does not define its encoding. */
  smokeRaw?: number;
  /** 4 raw fan-speed bytes (Scanner_FanSpeedOfMonitorCardNum). */
  fanRaw: number[];
  /** 9 raw voltage bytes (Scanner_VoltageOfMonitorCardNum). */
  voltageRaw: number[];
  generalStatusRaw?: number;
  /** 16 raw module-status bytes (Scanner_ModuleStatusOfMonitorCardBytesCnt). */
  moduleStatusRaw: number[];
}

export interface MonitorCardReading extends MonitorCardRef {
  state: MonitorCardState;
  /** Why the card is offline / in error (device error message). */
  error?: string;
  /** Raw temperature byte; absent when the card flags the block invalid. */
  temperatureRaw?: number;
  humidityRaw?: number;
  voltageRaw?: number;
  /** Present only when the card reports an attached monitor card. */
  monitorCard?: MonitorAttachedCard;
  /** Raw 3-byte bit-error-rate block, only with `includeBitErrorRate`. */
  bitErrorRaw?: number[];
}

/** up: all expected cards seen; partial: fewer than expected; down: none; idle: nothing expected. */
export type MonitorPortLinkStatus = 'up' | 'partial' | 'down' | 'idle';

export interface MonitorPortLink {
  portIndex: number;
  /** Receiving cards the sender counted on this port (ReadScanerCountOfSenderCard). */
  detected: number;
  /** Cards expected on the port (from `cards`, or the sender's configured count); null if unknown. */
  expected: number | null;
  status: MonitorPortLinkStatus;
}

export interface MonitorSenderReading {
  portLinks: MonitorPortLink[];
  /** Raw ReadSenderDVIStatus byte (encoding not defined by the library). */
  dviStatusRaw?: number;
  /** Raw 16-bit ReadTemperature / ReadHumidity / ReadFan values of the sending card. */
  temperatureRaw?: number;
  humidityRaw?: number;
  fanRaw?: number;
  /** Set when the sender-level reads failed (the pass continues with the cards). */
  error?: string;
}

export interface MonitorFunctionCardReading {
  state: MonitorCardState;
  error?: string;
  /** Function card's own sensors (FuncCard_ReadFuncCardAllStatus). */
  temperatureRaw?: number;
  humidityRaw?: number;
  voltageRaw?: number;
  /** Monitor card on the function card (FuncCard_ReadMonitorCardAllInfo). */
  linkStateRaw?: number;
  monitorTemperatureRaw?: number;
  monitorHumidityRaw?: number;
  smokeRaw?: number;
  /** 4 raw fan-speed bytes. */
  fanRaw?: number[];
  /** 5 raw voltage bytes. */
  voltageRawList?: number[];
}

export interface MonitorSnapshot {
  controllerId: string;
  /** Epoch ms when the pass finished. */
  takenAt: number;
  sender: MonitorSenderReading;
  cards: MonitorCardReading[];
  functionCard?: MonitorFunctionCardReading;
  /** Number of protocol requests this pass issued. */
  requestCount: number;
}
