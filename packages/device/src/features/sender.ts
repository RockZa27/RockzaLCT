import {
  DeviceError,
  SENDER_INPUT_SOURCES,
  SENDER_MAX_PORTS,
  type SenderApi,
  type SenderInputSource,
  type SenderPortStatus,
  type SenderRedundancySpace,
  type SenderRedundancyState,
  type SenderRedundancyStatus,
  type SenderResolution,
  type SenderVideoStatus,
} from '@rockzalct/shared';
import { DviSelectModeEnum } from '@novastar/native/DviSelectMode';
import { RedundantStateTypeEnum } from '@novastar/native/RedundantStateType';
import { SourceSelectLoadModeEnum } from '@novastar/native/SourceSelectLoadMode';
// Side-effect imports: each adds one method to the codec Session prototype. Every file below is
// node_modules/@novastar/native/dist/api/<Name>.cjs; the register address (`req.address`, decimal
// in the generated file) is cited next to each use. None of them sets `req.deviceType`, so they all
// go to the sending card (Packet deviceType 0).
import '@novastar/native/api/ReadDviWidth';
import '@novastar/native/api/ReadDviHeight';
import '@novastar/native/api/SetDviWidth';
import '@novastar/native/api/SetDviHeight';
import '@novastar/native/api/ReadIsHasDVI';
import '@novastar/native/api/ReadFieldRateMode';
import '@novastar/native/api/ReadFieldRate';
import '@novastar/native/api/SetFieldRate';
import '@novastar/native/api/ReadDVI0FieldRate';
import '@novastar/native/api/ReadDviSelect';
import '@novastar/native/api/SetDviSelect_1';
import '@novastar/native/api/ReadScanerCountOfSenderCard';
import '@novastar/native/api/ReadNumberOfCardOrScanBoardInPort';
import '@novastar/native/api/ReadPortEnable';
import '@novastar/native/api/SetPortEnable';
import '@novastar/native/api/ReadPortWidth';
import '@novastar/native/api/ReadPortHeight';
import '@novastar/native/api/ReadLoadMode';
import '@novastar/native/api/ReadSender_RedundantStateSpace';
import '@novastar/native/api/ReadSender_RedundantStateNewSpace';
import type { SessionLike } from '../session.js';
import type { FeatureContext } from './context.js';

/** Sending-card address on the bus (same as service.ts). */
const SENDER = 0;
/** DVI index used for the single-input resolution registers (ReadDviWidth(addr, index)). */
const DVI_INDEX = 0;
/** `cardType` argument of ReadNumberOfCardOrScanBoardInPort: 0 = receiving card. */
const CARD_TYPE_RECEIVING = 0;

/**
 * The @novastar/native session methods this feature calls. Signatures are copied from the
 * `.d.cts` files in dist/ (declaration-merged onto `API` of @novastar/codec).
 */
export interface SenderSession {
  /** ReadDviWidth.cjs: u16 @ 33554468 (0x2000024) + 8*index. */
  ReadDviWidth(addr: number, index: number): Promise<number>;
  /** ReadDviHeight.cjs: u16 @ 33554470 (0x2000026) + 8*index. */
  ReadDviHeight(addr: number, index: number): Promise<number>;
  /** SetDviWidth.cjs: u16 @ 33554468 + 8*index. */
  SetDviWidth(addr: number, broadcast: boolean, width: number, index: number): Promise<void>;
  /** SetDviHeight.cjs: u16 @ 33554470 + 8*index. */
  SetDviHeight(addr: number, broadcast: boolean, height: number, index: number): Promise<void>;
  /** ReadIsHasDVI.cjs: u8 @ 33554455 (0x2000017, AddressMapping IsHasDVISignalAddr). */
  ReadIsHasDVI(addr: number): Promise<number>;
  /** ReadFieldRateMode.cjs: u8 @ 33554440 (0x2000008). */
  ReadFieldRateMode(addr: number): Promise<number>;
  /** ReadFieldRate.cjs: u16 @ 33554441 (0x2000009). */
  ReadFieldRate(addr: number): Promise<number>;
  /** SetFieldRate.cjs: u16 @ 33554441. */
  SetFieldRate(addr: number, broadcast: boolean, fieldRate: number): Promise<void>;
  /** ReadDVI0FieldRate.cjs: u16 @ 33554460 (0x200001C). */
  ReadDVI0FieldRate(addr: number): Promise<number>;
  /** ReadDviSelect.cjs: u8 @ 33554467 (0x2000023). */
  ReadDviSelect(addr: number): Promise<number>;
  /** SetDviSelect_1.cjs: u8 @ 33554467, argument typed DviSelectModeEnum. */
  SetDviSelect_1(addr: number, broadcast: boolean, mode: DviSelectModeEnum): Promise<void>;
  /** ReadScanerCountOfSenderCard.cjs: 19 bytes @ 41943056 (0x2800010), one count per port. */
  ReadScanerCountOfSenderCard(addr: number): Promise<Buffer>;
  /** ReadNumberOfCardOrScanBoardInPort.cjs (see simulator ADDR.cardCountBase*). */
  ReadNumberOfCardOrScanBoardInPort(addr: number, portIndex: number, cardType: number): Promise<number>;
  /** ReadPortEnable.cjs: u8 @ 33554512 + 9*index (index < 4; other bases for higher ports). */
  ReadPortEnable(addr: number, index: number): Promise<number>;
  /** SetPortEnable.cjs: same address as ReadPortEnable. */
  SetPortEnable(addr: number, broadcast: boolean, enable: number, index: number): Promise<void>;
  /** ReadPortWidth.cjs: u16 @ 33554513 + 9*index (index < 4). */
  ReadPortWidth(addr: number, index: number): Promise<number>;
  /** ReadPortHeight.cjs: u16 @ 33554515 + 9*index (index < 4). */
  ReadPortHeight(addr: number, index: number): Promise<number>;
  /** ReadLoadMode.cjs: u8 @ 35651862 (0x2200116). */
  ReadLoadMode(addr: number): Promise<number>;
  /**
   * ReadSender_RedundantStateSpace.cjs: 8 bytes @ 33554456 (0x2000018). NOTE: this range overlaps
   * ReadDVI0FieldRate (0x200001C) in the vendor's own map.
   */
  ReadSender_RedundantStateSpace(addr: number): Promise<Buffer>;
  /** ReadSender_RedundantStateNewSpace.cjs: 8 bytes @ 33554584 (0x2000098). */
  ReadSender_RedundantStateNewSpace(addr: number): Promise<Buffer>;
}

const asSender = (s: SessionLike): SenderSession => s as unknown as SenderSession;

/** Input-source name -> register value (DviSelectModeEnum in @novastar/native/DviSelectMode). */
const INPUT_SOURCE_VALUE: Record<SenderInputSource, DviSelectModeEnum> = {
  DVI: DviSelectModeEnum.DVI,
  HDMI: DviSelectModeEnum.HDMI,
  HDMI1: DviSelectModeEnum.HDMI1,
  HDMI2: DviSelectModeEnum.HDMI2,
  SDI: DviSelectModeEnum.SDI,
  DP: DviSelectModeEnum.DP,
  Dual_DVI: DviSelectModeEnum.Dual_DVI,
  HDBaseT: DviSelectModeEnum.HDBaseT,
  LVDS: DviSelectModeEnum.LVDS,
};

export function inputSourceFromRaw(raw: number): SenderInputSource | null {
  for (const name of SENDER_INPUT_SOURCES) if (INPUT_SOURCE_VALUE[name] === raw) return name;
  return null;
}

export function redundancyStateFromRaw(raw: number): SenderRedundancyState {
  if (raw === RedundantStateTypeEnum.OK) return 'ok';
  if (raw === RedundantStateTypeEnum.Error) return 'error';
  return 'unknown';
}

const isU16 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;

function requireAdvanced(ctx: FeatureContext, what: string): void {
  if (ctx.userLevel().level !== 'advanced') {
    throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
  }
}

function checkPort(portIndex: unknown): asserts portIndex is number {
  if (typeof portIndex !== 'number' || !Number.isInteger(portIndex) || portIndex < 0 || portIndex >= SENDER_MAX_PORTS) {
    throw new DeviceError('INVALID_ARGUMENT', `portIndex must be an integer 0..${SENDER_MAX_PORTS - 1}`);
  }
}

async function readVideo(s: SenderSession): Promise<SenderVideoStatus> {
  const width = await s.ReadDviWidth(SENDER, DVI_INDEX);
  const height = await s.ReadDviHeight(SENDER, DVI_INDEX);
  const signal = await s.ReadIsHasDVI(SENDER);
  const fieldRateMode = await s.ReadFieldRateMode(SENDER);
  const fieldRate = await s.ReadFieldRate(SENDER);
  const measuredFieldRate = await s.ReadDVI0FieldRate(SENDER);
  const inputSourceRaw = await s.ReadDviSelect(SENDER);
  return {
    signalPresent: signal !== 0,
    resolution: { width, height },
    fieldRateMode,
    fieldRate,
    measuredFieldRate,
    inputSource: inputSourceFromRaw(inputSourceRaw),
    inputSourceRaw,
  };
}

async function readPorts(s: SenderSession): Promise<SenderPortStatus[]> {
  const perPort = await s.ReadScanerCountOfSenderCard(SENDER);
  let count = 0;
  for (let i = 0; i < perPort.length; i += 1) if (perPort[i]! > 0) count = i + 1;
  const ports: SenderPortStatus[] = [];
  for (let portIndex = 0; portIndex < count; portIndex += 1) {
    const enabled = (await s.ReadPortEnable(SENDER, portIndex)) !== 0;
    const width = await s.ReadPortWidth(SENDER, portIndex);
    const height = await s.ReadPortHeight(SENDER, portIndex);
    const receivingCards = await s.ReadNumberOfCardOrScanBoardInPort(SENDER, portIndex, CARD_TYPE_RECEIVING);
    ports.push({ portIndex, enabled, width, height, pixels: width * height, receivingCards });
  }
  return ports;
}

export function createSenderFeature(ctx: FeatureContext): SenderApi {
  return {
    getSenderVideo: (id) => ctx.withSession(id, (s) => readVideo(asSender(s))),

    async setSenderResolution(id: string, resolution: SenderResolution): Promise<SenderVideoStatus> {
      requireAdvanced(ctx, 'changing the input resolution');
      const { width, height } = (resolution ?? {}) as Partial<SenderResolution>;
      if (!isU16(width) || !isU16(height) || width < 1 || height < 1) {
        throw new DeviceError('INVALID_ARGUMENT', 'width and height must be integers 1..65535');
      }
      return ctx.withSession(id, async (raw) => {
        const s = asSender(raw);
        await s.SetDviWidth(SENDER, false, width, DVI_INDEX);
        await s.SetDviHeight(SENDER, false, height, DVI_INDEX);
        return readVideo(s);
      });
    },

    async setSenderFieldRate(id: string, fieldRate: number): Promise<SenderVideoStatus> {
      requireAdvanced(ctx, 'changing the refresh rate');
      if (!isU16(fieldRate)) throw new DeviceError('INVALID_ARGUMENT', 'fieldRate must be an integer 0..65535');
      return ctx.withSession(id, async (raw) => {
        const s = asSender(raw);
        await s.SetFieldRate(SENDER, false, fieldRate);
        return readVideo(s);
      });
    },

    async setSenderInputSource(id: string, source: SenderInputSource): Promise<SenderVideoStatus> {
      requireAdvanced(ctx, 'changing the input source');
      const value = Object.prototype.hasOwnProperty.call(INPUT_SOURCE_VALUE, source)
        ? INPUT_SOURCE_VALUE[source]
        : undefined;
      if (value === undefined) throw new DeviceError('INVALID_ARGUMENT', `unknown input source: ${String(source)}`);
      return ctx.withSession(id, async (raw) => {
        const s = asSender(raw);
        await s.SetDviSelect_1(SENDER, false, value);
        return readVideo(s);
      });
    },

    getSenderPorts: (id) => ctx.withSession(id, (s) => readPorts(asSender(s))),

    async setSenderPortEnabled(id: string, portIndex: number, enabled: boolean): Promise<SenderPortStatus[]> {
      requireAdvanced(ctx, 'enabling or disabling an output port');
      checkPort(portIndex);
      if (typeof enabled !== 'boolean') throw new DeviceError('INVALID_ARGUMENT', 'enabled must be a boolean');
      return ctx.withSession(id, async (raw) => {
        const s = asSender(raw);
        await s.SetPortEnable(SENDER, false, enabled ? 1 : 0, portIndex);
        return readPorts(s);
      });
    },

    getSenderRedundancy: (id) =>
      ctx.withSession(id, async (raw): Promise<SenderRedundancyStatus> => {
        const s = asSender(raw);
        const mode = await s.ReadLoadMode(SENDER);
        const legacy = await s.ReadSender_RedundantStateSpace(SENDER);
        const fresh = await s.ReadSender_RedundantStateNewSpace(SENDER);
        const space = (name: 'legacy' | 'new', block: Buffer): SenderRedundancySpace => {
          const bytes = [...block];
          return {
            space: name,
            raw: bytes,
            ports: bytes.map((b, portIndex) => ({ portIndex, state: redundancyStateFromRaw(b) })),
          };
        };
        return {
          loadMode:
            mode === SourceSelectLoadModeEnum.HighLoad
              ? 'high-load'
              : mode === SourceSelectLoadModeEnum.BackUpLoad
                ? 'backup'
                : 'unknown',
          spaces: [space('legacy', legacy), space('new', fresh)],
        };
      }),
  };
}
