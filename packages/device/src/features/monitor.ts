import { ConnectionClosedError, ErrorType, ResponseError, TimeoutError, type API, type Session } from '@novastar/codec';
// Side-effect imports: each adds one method to the codec Session prototype. Every file is
// node_modules/@novastar/native/dist/api/<Name>.cjs; the register address (`req.address`, decimal
// in the generated file), the read length (`new Request(<n>, ...)`) and the target
// (`req.deviceType`) are listed in MONITOR_REGISTERS below.
import '@novastar/native/api/ReadAllStatus';
import '@novastar/native/api/ReadScanCardAllStatus';
import '@novastar/native/api/ReadBitErrorRateData';
import '@novastar/native/api/ReadScanerCountOfSenderCard';
import '@novastar/native/api/ReadNumberOfCardOrScanBoardInPort';
import '@novastar/native/api/ReadSenderDVIStatus';
import '@novastar/native/api/ReadTemperature';
import '@novastar/native/api/ReadHumidity';
import '@novastar/native/api/ReadFan';
import '@novastar/native/api/FuncCard_ReadFuncCardAllStatus';
import '@novastar/native/api/FuncCard_ReadMonitorCardAllInfo';
import {
  DeviceError,
  portLinkStatus,
  validateCardIndex,
  type MonitorApi,
  type MonitorAttachedCard,
  type MonitorCardReading,
  type MonitorCardRef,
  type MonitorFunctionCardReading,
  type MonitorPortLink,
  type MonitorSenderReading,
  type MonitorSnapshot,
  type MonitorSnapshotOptions,
} from '@rockzalct/shared';
import type { FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';

/**
 * Registers behind every native call used here. Source: AddressMapping.d.cts (names in
 * parentheses) and node_modules/@novastar/native/dist/api/<Name>.cjs (`req.address`,
 * `Request(<length>)`). "receiving" = `req.deviceType = 1`, addressed by port + card index;
 * "sender" = no deviceType set (sending card, deviceType 0).
 *
 * The library defines BYTE POSITIONS only. No file in dist/ gives a unit, scale or offset for any
 * temperature / humidity / voltage / fan value, so everything is reported raw.
 */
export const MONITOR_REGISTERS = {
  /** ReadAllStatus.cjs, receiving, 82 bytes @ 167772160 (Scanner_AllMonitorDataAddr, Occupancy 82). */
  scannerAllStatus: 0x0a00_0000,
  /** ReadScanCardAllStatus.cjs, receiving, 4 bytes @ 167772160 (Scanner_ScanCardAllStatusAddr/Occupancy). */
  scanCardAllStatus: 0x0a00_0000,
  /** ReadBitErrorRateData.cjs, receiving, 3 bytes @ 33554762 (BitErrorRateAddr/Occupancy). */
  bitErrorRate: 0x0200_014a,
  /** ReadScanerCountOfSenderCard.cjs, sender, 19 bytes @ 41943056: cards the sender counted per port. */
  scannerCountOfSender: 0x0280_0010,
  /** ReadSenderDVIStatus.cjs, sender, 1 byte @ 33554455. */
  senderDviStatus: 0x0200_0017,
  /** ReadTemperature.cjs / ReadHumidity.cjs / ReadFan.cjs, sender, 2 bytes each @ 33554434 / 33554436 / 33554438 (TemperatureAddr, HumidityAddr, FanAddr; Occupancy 2). */
  senderTemperature: 0x0200_0002,
  senderHumidity: 0x0200_0004,
  senderFan: 0x0200_0006,
  /** FuncCard_ReadFuncCardAllStatus.cjs, `destination = addr`, 4 bytes @ 67108864 (FuncCard_FuncCardAllStatusAddr). */
  funcCardAllStatus: 0x0400_0000,
  /** FuncCard_ReadMonitorCardAllInfo.cjs, `destination = addr`, 14 bytes @ 67108879 (FuncCard_MonitorCardAllInfoAddr). */
  funcCardMonitorAllInfo: 0x0400_000f,
} as const;

/**
 * Byte offsets inside the 82-byte ReadAllStatus block (Scanner_AllMonitorDataOccupancy = 82).
 * Each offset is AddressMapping address minus 0x0A000000:
 *   Scanner_TempInfoOfScanCard 0x0A000000 (2 bytes: valid, value), Scanner_HumiOfScanCard +2,
 *   Scanner_VoltageOfScanCard +3, AttachedMonitorCardExist +0x20,
 *   Scanner_TempInfoOfMonitorCard +0x27 (2 bytes), Scanner_HumiOfMonitorCard +0x29,
 *   Scanner_SmokeWarningOfMonitorCard +0x2A, Scanner_FanSpeedOfMonitorCard +0x2B (x4, 1 byte each),
 *   Scanner_VoltageOfMonitorCard +0x2F (x9), Scanner_GeneralStatusOfMonitorCard +0x41,
 *   Scanner_ModuleStatusOfMonitorCard +0x42 (x16 bytes, Scanner_ModuleStatusOfMonitorCardBytesCnt).
 * The pieces tile the block exactly: 0x42 + 16 = 0x52 = 82.
 */
export const ALL_STATUS_LENGTH = 82;
export const ALL_STATUS_OFFSETS = {
  tempValid: 0x00,
  tempValue: 0x01,
  humidity: 0x02,
  voltage: 0x03,
  monitorCardExists: 0x20,
  monitorTempValid: 0x27,
  monitorTempValue: 0x28,
  monitorHumidity: 0x29,
  monitorSmoke: 0x2a,
  monitorFan: 0x2b,
  monitorFanCount: 4,
  monitorVoltage: 0x2f,
  monitorVoltageCount: 9,
  monitorGeneralStatus: 0x41,
  monitorModuleStatus: 0x42,
  monitorModuleStatusCount: 16,
} as const;

/**
 * Layout of FuncCard_ReadMonitorCardAllInfo (14 bytes @ 0x0400000F): link state (+0,
 * FuncCard_LinkStateOfMonitorCardAddr 67108879), then FuncCard_MonitorCardAllStatus (13 bytes
 * @ 67108880): temperature valid/value, humidity, smoke, fan x4 (FuncCard_FanNumOfMonitorCard),
 * voltage x5 (FuncCard_VoltageNumOfMonitorCard).
 */
export const FUNC_MONITOR_INFO_LENGTH = 14;

/** The native Session methods this feature calls (signatures from dist/*.d.cts). */
export interface MonitorSession {
  ReadAllStatus(addr: number, port: number, card: number): Promise<Buffer>;
  ReadScanCardAllStatus(addr: number, port: number, card: number): Promise<number>;
  ReadBitErrorRateData(addr: number, port: number, card: number): Promise<Buffer>;
  ReadScanerCountOfSenderCard(addr: number): Promise<Buffer>;
  ReadNumberOfCardOrScanBoardInPort(addr: number, portIndex: number, cardType: number): Promise<number>;
  ReadSenderDVIStatus(addr: number): Promise<number>;
  ReadTemperature(addr: number): Promise<number>;
  ReadHumidity(addr: number): Promise<number>;
  ReadFan(addr: number): Promise<number>;
  FuncCard_ReadFuncCardAllStatus(addr: number): Promise<number>;
  FuncCard_ReadMonitorCardAllInfo(addr: number): Promise<Buffer>;
}

// Compile-time proof that the real codec Session (augmented by the imports above) satisfies the
// narrow interface: if a native signature differs this line stops compiling.
const _nativeSessionMatches: (API & Session) extends MonitorSession ? true : never = true;
void _nativeSessionMatches;

const SENDER = 0;
/** `cardType` argument of ReadNumberOfCardOrScanBoardInPort: 0 = receiving card. */
const CARD_TYPE_RECEIVING = 0;

type Bytes = ArrayLike<number>;

const slice = (data: Bytes, from: number, count: number): number[] => Array.from({ length: count }, (_, i) => data[from + i] ?? 0);

/** Decode the 4-byte word of ReadScanCardAllStatus (decodeUIntLE: byte 0 is the least significant). */
export function decodeScanCardWord(word: number): Pick<MonitorCardReading, 'temperatureRaw' | 'humidityRaw' | 'voltageRaw'> {
  const w = word >>> 0;
  const out: Pick<MonitorCardReading, 'temperatureRaw' | 'humidityRaw' | 'voltageRaw'> = {
    humidityRaw: (w >>> 16) & 0xff,
    voltageRaw: (w >>> 24) & 0xff,
  };
  // [valid, value]; a zero valid byte means the card has no usable temperature (same rule as
  // receiver.ts getReceiverParameters). Byte order inside the block is UNVERIFIED on hardware.
  if ((w & 0xff) !== 0) out.temperatureRaw = (w >>> 8) & 0xff;
  return out;
}

/** Decode the 82-byte ReadAllStatus block; throws when it is shorter than the 4 scan-card bytes. */
export function decodeAllStatus(
  data: Bytes,
): Pick<MonitorCardReading, 'temperatureRaw' | 'humidityRaw' | 'voltageRaw' | 'monitorCard'> {
  const o = ALL_STATUS_OFFSETS;
  if (data.length < 4) throw new DeviceError('PROTOCOL', `short monitor block (${data.length} bytes)`);
  const out: Pick<MonitorCardReading, 'temperatureRaw' | 'humidityRaw' | 'voltageRaw' | 'monitorCard'> = {
    humidityRaw: data[o.humidity]!,
    voltageRaw: data[o.voltage]!,
  };
  if (data[o.tempValid] !== 0) out.temperatureRaw = data[o.tempValue]!;
  if (data.length >= ALL_STATUS_LENGTH && data[o.monitorCardExists] !== 0) {
    const mc: MonitorAttachedCard = {
      humidityRaw: data[o.monitorHumidity]!,
      smokeRaw: data[o.monitorSmoke]!,
      fanRaw: slice(data, o.monitorFan, o.monitorFanCount),
      voltageRaw: slice(data, o.monitorVoltage, o.monitorVoltageCount),
      generalStatusRaw: data[o.monitorGeneralStatus]!,
      moduleStatusRaw: slice(data, o.monitorModuleStatus, o.monitorModuleStatusCount),
    };
    if (data[o.monitorTempValid] !== 0) mc.temperatureRaw = data[o.monitorTempValue]!;
    out.monitorCard = mc;
  }
  return out;
}

/** Decode FuncCard_ReadMonitorCardAllInfo (14 bytes, see FUNC_MONITOR_INFO_LENGTH). */
export function decodeFuncMonitorInfo(
  data: Bytes,
): Pick<MonitorFunctionCardReading, 'linkStateRaw' | 'monitorTemperatureRaw' | 'monitorHumidityRaw' | 'smokeRaw' | 'fanRaw' | 'voltageRawList'> {
  if (data.length < FUNC_MONITOR_INFO_LENGTH) {
    throw new DeviceError('PROTOCOL', `short function-card monitor block (${data.length} bytes)`);
  }
  const out: ReturnType<typeof decodeFuncMonitorInfo> = {
    linkStateRaw: data[0]!,
    monitorHumidityRaw: data[3]!,
    smokeRaw: data[4]!,
    fanRaw: slice(data, 5, 4),
    voltageRawList: slice(data, 9, 5),
  };
  if (data[1] !== 0) out.monitorTemperatureRaw = data[2]!;
  return out;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The card did not answer. Two shapes: the request itself times out (TimeoutError), or the sending
 * card answers on behalf of an absent receiving card with ack `ErrorType.Timeout` (a "downstream
 * timeout", @novastar/codec Connection.sendImpl turns any non-zero ack into a ResponseError).
 */
const isSilent = (err: unknown): boolean =>
  err instanceof TimeoutError || (err instanceof ResponseError && err.res.ack === ErrorType.Timeout);

/** A codec failure that means "this one request got no usable answer" (the pass carries on). */
const isSoftFailure = (err: unknown): boolean => err instanceof TimeoutError || err instanceof ResponseError;

const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);

function validateOptions(options: MonitorSnapshotOptions | undefined): MonitorSnapshotOptions {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw invalid('options must be an object');
  if (options.includeBitErrorRate !== undefined && typeof options.includeBitErrorRate !== 'boolean') {
    throw invalid('includeBitErrorRate must be a boolean');
  }
  const fa = options.functionCardAddress;
  if (fa !== undefined && (typeof fa !== 'number' || !Number.isInteger(fa) || fa < 0 || fa > 255)) {
    throw invalid('functionCardAddress must be an integer 0..255');
  }
  if (options.cards !== undefined) {
    if (!Array.isArray(options.cards)) throw invalid('cards must be an array');
    for (const c of options.cards) {
      if (typeof c !== 'object' || c === null) throw invalid('every card must be {portIndex, cardIndex}');
      const bad = validateCardIndex(c.portIndex, c.cardIndex);
      if (bad) throw invalid(bad);
    }
  }
  return options;
}

export function createMonitorFeature(ctx: FeatureContext): MonitorApi {
  const on = <T>(id: string, fn: (s: MonitorSession) => Promise<T>): Promise<T> =>
    ctx.withSession(id, (s: SessionLike) => fn(s as unknown as MonitorSession));

  return {
    /**
     * Requests issued (all reads, nothing is written):
     *   sender   : 1 ReadScanerCountOfSenderCard + 1 ReadSenderDVIStatus + ReadTemperature +
     *              ReadHumidity + ReadFan = 5; plus 1 ReadNumberOfCardOrScanBoardInPort per port
     *              that reports cards, only when `options.cards` is omitted.
     *   per card : 1 ReadAllStatus (82 bytes: online test + temperature + humidity + voltage +
     *              attached monitor card). +1 ReadScanCardAllStatus (4 bytes) only when the card
     *              answers the 82-byte read with an error. +1 ReadBitErrorRateData with
     *              `includeBitErrorRate`. An offline card costs exactly one request (one timeout).
     *   function : 2 (FuncCard_ReadFuncCardAllStatus, FuncCard_ReadMonitorCardAllInfo) only with
     *              `options.functionCardAddress`.
     * The pass is sequential (one connection); worst case duration is requests x timeoutMs.
     */
    async readMonitorSnapshot(id, rawOptions): Promise<MonitorSnapshot> {
      const options = validateOptions(rawOptions);
      return on(id, async (s) => {
        let requestCount = 0;
        const send = <T>(read: () => Promise<T>): Promise<T> => {
          requestCount += 1;
          return read();
        };

        // ---- sender ------------------------------------------------------------------------
        const sender: MonitorSenderReading = { portLinks: [] };
        const expectedByPort = new Map<number, number>();
        let cards: MonitorCardRef[];
        let counts: Buffer | undefined;
        try {
          counts = await send(() => s.ReadScanerCountOfSenderCard(SENDER));
        } catch (err) {
          if (!isSoftFailure(err)) throw err;
          sender.error = messageOf(err);
        }

        if (options.cards) {
          const seen = new Set<string>();
          cards = [];
          for (const c of options.cards) {
            const k = `${c.portIndex}:${c.cardIndex}`;
            if (seen.has(k)) continue;
            seen.add(k);
            cards.push({ portIndex: c.portIndex, cardIndex: c.cardIndex });
            expectedByPort.set(c.portIndex, (expectedByPort.get(c.portIndex) ?? 0) + 1);
          }
        } else {
          cards = [];
          if (counts) {
            for (let port = 0; port < counts.length; port += 1) {
              if (counts[port]! === 0) continue;
              let n = 0;
              try {
                n = await send(() => s.ReadNumberOfCardOrScanBoardInPort(SENDER, port, CARD_TYPE_RECEIVING));
              } catch (err) {
                if (!isSoftFailure(err)) throw err;
                sender.error ??= messageOf(err);
                continue;
              }
              expectedByPort.set(port, n);
              for (let cardIndex = 0; cardIndex < n; cardIndex += 1) cards.push({ portIndex: port, cardIndex });
            }
          }
        }

        if (counts) {
          const ports = new Set<number>(expectedByPort.keys());
          for (let port = 0; port < counts.length; port += 1) if (counts[port]! > 0) ports.add(port);
          const links: MonitorPortLink[] = [];
          for (const portIndex of [...ports].sort((a, b) => a - b)) {
            if (portIndex >= counts.length) continue; // the sender block has no counter for this port
            const detected = counts[portIndex]!;
            const expected = expectedByPort.has(portIndex) ? expectedByPort.get(portIndex)! : null;
            links.push({ portIndex, detected, expected, status: portLinkStatus(detected, expected) });
          }
          sender.portLinks = links;
        }

        // Optional sender sensors: a refusal/timeout just leaves the field out.
        const soft = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
          try {
            return await send(read);
          } catch (err) {
            if (isSoftFailure(err)) return undefined;
            throw err;
          }
        };
        if (counts) {
          const dvi = await soft(() => s.ReadSenderDVIStatus(SENDER));
          if (dvi !== undefined) sender.dviStatusRaw = dvi;
          const temp = await soft(() => s.ReadTemperature(SENDER));
          if (temp !== undefined) sender.temperatureRaw = temp;
          const humi = await soft(() => s.ReadHumidity(SENDER));
          if (humi !== undefined) sender.humidityRaw = humi;
          const fan = await soft(() => s.ReadFan(SENDER));
          if (fan !== undefined) sender.fanRaw = fan;
        }

        // ---- receiving cards ---------------------------------------------------------------
        const readings: MonitorCardReading[] = [];
        for (const ref of cards) {
          const reading: MonitorCardReading = { portIndex: ref.portIndex, cardIndex: ref.cardIndex, state: 'online' };
          try {
            let decoded: ReturnType<typeof decodeAllStatus>;
            try {
              decoded = decodeAllStatus(await send(() => s.ReadAllStatus(SENDER, ref.portIndex, ref.cardIndex)));
            } catch (err) {
              // The card answered but refused the long read: fall back to the 4-byte block.
              if (!(err instanceof ResponseError) || isSilent(err)) throw err;
              decoded = decodeScanCardWord(await send(() => s.ReadScanCardAllStatus(SENDER, ref.portIndex, ref.cardIndex)));
            }
            Object.assign(reading, decoded);
            if (options.includeBitErrorRate) {
              const ber = await soft(() => s.ReadBitErrorRateData(SENDER, ref.portIndex, ref.cardIndex));
              if (ber !== undefined) reading.bitErrorRaw = Array.from(ber);
            }
          } catch (err) {
            if (err instanceof ConnectionClosedError) throw err; // whole connection gone: abort the pass
            reading.state = isSilent(err) ? 'offline' : 'error';
            reading.error = messageOf(err);
          }
          readings.push(reading);
        }

        // ---- multi-function card (opt-in) ----------------------------------------------------
        let functionCard: MonitorFunctionCardReading | undefined;
        if (options.functionCardAddress !== undefined) {
          const addr = options.functionCardAddress;
          functionCard = { state: 'online' };
          try {
            const word = decodeScanCardWord(await send(() => s.FuncCard_ReadFuncCardAllStatus(addr)));
            Object.assign(functionCard, word);
            const info = await soft(() => s.FuncCard_ReadMonitorCardAllInfo(addr));
            if (info !== undefined) Object.assign(functionCard, decodeFuncMonitorInfo(info));
          } catch (err) {
            if (err instanceof ConnectionClosedError) throw err;
            functionCard = { state: isSilent(err) ? 'offline' : 'error', error: messageOf(err) };
          }
        }

        const snapshot: MonitorSnapshot = {
          controllerId: id,
          takenAt: Date.now(),
          sender,
          cards: readings,
          requestCount,
        };
        if (functionCard) snapshot.functionCard = functionCard;
        return snapshot;
      });
    },
  };
}
