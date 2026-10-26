import { ResponseError, type API, type Session } from '@novastar/codec';
// Side-effect imports: each adds one method to the codec Session prototype. The register address
// of every call is listed in RECEIVER_REGISTERS below (read from dist/api/<Name>.cjs, field
// `req.address`; all use `req.deviceType = 1`, i.e. the receiving card, addressed by port + index).
import '@novastar/native/api/ReadModuleWidth';
import '@novastar/native/api/SetModuleWidth';
import '@novastar/native/api/ReadModuleHeight';
import '@novastar/native/api/SetModuleHeight';
import '@novastar/native/api/ReadScanMode';
import '@novastar/native/api/SetScanMode';
import '@novastar/native/api/ReadPhysicalTotalDataGroupNum';
import '@novastar/native/api/SetPhysicalTotalDataGroupNum';
import '@novastar/native/api/ReadLogicalTotalDataGroupNum';
import '@novastar/native/api/ReadGroupNumInModule';
import '@novastar/native/api/ReadModuelRows';
import '@novastar/native/api/ReadDriverType';
import '@novastar/native/api/SetDriverType';
import '@novastar/native/api/ReadDecodeType';
import '@novastar/native/api/ReadICNumber';
import '@novastar/native/api/SetICNumber';
import '@novastar/native/api/ReadRefNumPerVs';
import '@novastar/native/api/SetRefNumPerVs';
import '@novastar/native/api/ReadGrayDepth';
import '@novastar/native/api/SetGrayDepth';
import '@novastar/native/api/ReadGrayMode';
import '@novastar/native/api/SetGrayMode';
import '@novastar/native/api/ReadGamma';
import '@novastar/native/api/SetGamma';
import '@novastar/native/api/ReadTempInfoOfScanCard';
import '@novastar/native/api/ReadVoltageOfScanCard';
import {
  DeviceError,
  validateCabinetProfile,
  validateCardIndex,
  validateReceiverTarget,
  validateReceiverWritable,
  type CabinetProfile,
  type ReceiverApi,
  type ReceiverParameters,
  type ReceiverTarget,
  type ReceiverWritable,
} from '@rockzalct/shared';
import type { FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';

/**
 * Register address (receiving card, deviceType 1) behind every native call used here. Source:
 * node_modules/@novastar/native/dist/api/<Name>.cjs `req.address`; width in bytes is the
 * `Request(<n>)` / `encodeUIntLE(v, <n>)` argument in the same file. AddressMapping.d.cts names the
 * same addresses (ModuleWidthAddr, ModuleHeightAddr, DriverTypeAddr, ScanModeAddr, ...).
 */
export const RECEIVER_REGISTERS = {
  gamma: 0x0200_0000, // ReadGamma / SetGamma, 1 byte
  moduleWidth: 0x0200_000a, // ReadModuleWidth / SetModuleWidth, 1 byte
  moduleHeight: 0x0200_000b, // ReadModuleHeight / SetModuleHeight, 1 byte
  driverIc: 0x0200_000c, // ReadDriverType / SetDriverType, 1 byte
  scanMode: 0x0200_000d, // ReadScanMode / SetScanMode, 1 byte
  decodeType: 0x0200_000f, // ReadDecodeType, 1 byte
  groupsPerModule: 0x0200_0010, // ReadGroupNumInModule, 1 byte
  moduleRows: 0x0200_0016, // ReadModuelRows, 1 byte
  physicalDataGroups: 0x0200_001b, // ReadPhysicalTotalDataGroupNum / SetPhysicalTotalDataGroupNum, 1 byte
  logicalDataGroups: 0x0200_0022, // ReadLogicalTotalDataGroupNum, 1 byte
  grayDepth: 0x0200_0025, // ReadGrayDepth / SetGrayDepth (same register as ReadGrayBit/SetGrayBit), 1 byte
  grayMode: 0x0200_0026, // ReadGrayMode / SetGrayMode, 1 byte = (grayRealize << 4) + grayMode
  refNumPerVs: 0x0200_0027, // ReadRefNumPerVs / SetRefNumPerVs, 2 bytes LE
  icPerGroup: 0x0200_0105, // ReadICNumber / SetICNumber, 1 byte
  temperature: 0x0a00_0000, // ReadTempInfoOfScanCard, 2 bytes: [valid, value]
  voltage: 0x0a00_0003, // ReadVoltageOfScanCard, 1 byte
} as const;

/** The native Session methods this feature calls (signatures from dist/*.d.cts). */
export interface ReceiverSession {
  ReadModuleWidth(addr: number, port: number, card: number): Promise<number>;
  SetModuleWidth(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadModuleHeight(addr: number, port: number, card: number): Promise<number>;
  SetModuleHeight(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadScanMode(addr: number, port: number, card: number): Promise<number>;
  SetScanMode(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadPhysicalTotalDataGroupNum(addr: number, port: number, card: number): Promise<number>;
  SetPhysicalTotalDataGroupNum(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadLogicalTotalDataGroupNum(addr: number, port: number, card: number): Promise<number>;
  ReadGroupNumInModule(addr: number, port: number, card: number): Promise<number>;
  ReadModuelRows(addr: number, port: number, card: number): Promise<number>;
  ReadDriverType(addr: number, port: number, card: number): Promise<number>;
  SetDriverType(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadDecodeType(addr: number, port: number, card: number): Promise<number>;
  ReadICNumber(addr: number, port: number, card: number): Promise<number>;
  SetICNumber(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadRefNumPerVs(addr: number, port: number, card: number): Promise<number>;
  SetRefNumPerVs(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadGrayDepth(addr: number, port: number, card: number): Promise<number>;
  SetGrayDepth(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadGrayMode(addr: number, port: number, card: number): Promise<number>;
  SetGrayMode(addr: number, port: number, card: number, broadcast: boolean, realize: number, mode: number): Promise<void>;
  ReadGamma(addr: number, port: number, card: number): Promise<number>;
  SetGamma(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadTempInfoOfScanCard(addr: number, port: number, card: number): Promise<number>;
  ReadVoltageOfScanCard(addr: number, port: number, card: number): Promise<number>;
}

// Compile-time proof that the real codec Session (augmented by the imports above) satisfies the
// narrow interface: if a native signature differs this line stops compiling.
const _nativeSessionMatches: (API & Session) extends ReceiverSession ? true : never = true;
void _nativeSessionMatches;

const SENDER = 0;
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;

interface Route {
  port: number;
  card: number;
  /** Native "bBroadcast": true = fire and forget (no acknowledgement awaited). */
  broadcast: boolean;
}

function routeOf(target: ReceiverTarget): Route {
  return target.scope === 'all'
    ? { port: ALL_PORTS, card: ALL_CARDS, broadcast: true }
    : { port: target.portIndex, card: target.cardIndex, broadcast: false };
}

const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);

/** Reads that a card may legitimately refuse (register not implemented): a ResponseError becomes undefined. */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof ResponseError) return undefined;
    throw err;
  }
}

export function createReceiverFeature(ctx: FeatureContext): ReceiverApi {
  const requireAdvanced = (): void => {
    if (ctx.userLevel().level !== 'advanced') {
      throw new DeviceError('PERMISSION', 'advanced user level required to write receiving-card parameters');
    }
  };

  const on = <T>(id: string, fn: (s: ReceiverSession) => Promise<T>): Promise<T> =>
    ctx.withSession(id, (s: SessionLike) => fn(s as unknown as ReceiverSession));

  async function writeSafe(s: ReceiverSession, r: Route, p: ReceiverWritable): Promise<void> {
    if (p.refNumPerVs !== undefined) await s.SetRefNumPerVs(SENDER, r.port, r.card, r.broadcast, p.refNumPerVs);
    if (p.gamma !== undefined) await s.SetGamma(SENDER, r.port, r.card, r.broadcast, p.gamma);
    if (p.grayDepth !== undefined) await s.SetGrayDepth(SENDER, r.port, r.card, r.broadcast, p.grayDepth);
    if (p.grayRealize !== undefined || p.grayMode !== undefined) {
      let realize = p.grayRealize;
      let mode = p.grayMode;
      if (realize === undefined || mode === undefined) {
        // One register holds both halves: read-modify-write (card targets only; validated earlier).
        const cur = await s.ReadGrayMode(SENDER, r.port, r.card);
        realize ??= (cur >> 4) & 0x0f;
        mode ??= cur & 0x0f;
      }
      await s.SetGrayMode(SENDER, r.port, r.card, r.broadcast, realize, mode);
    }
  }

  return {
    async getReceiverParameters(id, portIndex, cardIndex): Promise<ReceiverParameters> {
      const bad = validateCardIndex(portIndex, cardIndex);
      if (bad) throw invalid(bad);
      return on(id, async (s) => {
        const a = [SENDER, portIndex, cardIndex] as const;
        const moduleWidth = await s.ReadModuleWidth(...a);
        const moduleHeight = await s.ReadModuleHeight(...a);
        const scanMode = await s.ReadScanMode(...a);
        const physicalDataGroups = await s.ReadPhysicalTotalDataGroupNum(...a);
        const driverIc = await s.ReadDriverType(...a);
        const refNumPerVs = await s.ReadRefNumPerVs(...a);
        const grayDepth = await s.ReadGrayDepth(...a);
        const grayRaw = await s.ReadGrayMode(...a);
        const gamma = await s.ReadGamma(...a);
        const logicalDataGroups = await optional(() => s.ReadLogicalTotalDataGroupNum(...a));
        const groupsPerModule = await optional(() => s.ReadGroupNumInModule(...a));
        const moduleRows = await optional(() => s.ReadModuelRows(...a));
        const decodeType = await optional(() => s.ReadDecodeType(...a));
        const icPerGroup = await optional(() => s.ReadICNumber(...a));
        const temp = await optional(() => s.ReadTempInfoOfScanCard(...a));
        const voltageRaw = await optional(() => s.ReadVoltageOfScanCard(...a));

        const params: ReceiverParameters = {
          portIndex,
          cardIndex,
          moduleWidth,
          moduleHeight,
          scanMode,
          physicalDataGroups,
          driverIc,
          refNumPerVs,
          grayDepth,
          // SetGrayMode writes (grayRealize << 4) + grayMode into the one register.
          grayRealize: (grayRaw >> 4) & 0x0f,
          grayMode: grayRaw & 0x0f,
          gamma,
        };
        if (logicalDataGroups !== undefined) params.logicalDataGroups = logicalDataGroups;
        if (groupsPerModule !== undefined) params.groupsPerModule = groupsPerModule;
        if (moduleRows !== undefined) params.moduleRows = moduleRows;
        if (decodeType !== undefined) params.decodeType = decodeType;
        if (icPerGroup !== undefined) params.icPerGroup = icPerGroup;
        // Temperature block is [valid, value] (AddressMapping Scanner_TempValid/TempValue, 1 byte each).
        // The byte order inside the block is UNVERIFIED on hardware.
        if (temp !== undefined && (temp & 0xff) !== 0) params.temperatureRaw = (temp >> 8) & 0xff;
        if (voltageRaw !== undefined) params.voltageRaw = voltageRaw;
        return params;
      });
    },

    async setReceiverParameters(id, target, params): Promise<void> {
      requireAdvanced();
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw invalid(badTarget);
      const bad = validateReceiverWritable(params, target);
      if (bad) throw invalid(bad);
      const route = routeOf(target);
      await on(id, (s) => writeSafe(s, route, params));
    },

    async applyCabinetProfile(id, target, profile): Promise<void> {
      requireAdvanced();
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw invalid(badTarget);
      const checked = validateCabinetProfile(profile);
      if (!checked.ok) throw invalid(checked.errors.map((e) => e.message).join('; '));
      const p: CabinetProfile = checked.profile;
      const r = routeOf(target);
      await on(id, async (s) => {
        // Geometry and driver first, then timing / grayscale (which depend on them).
        await s.SetModuleWidth(SENDER, r.port, r.card, r.broadcast, p.width);
        await s.SetModuleHeight(SENDER, r.port, r.card, r.broadcast, p.height);
        await s.SetScanMode(SENDER, r.port, r.card, r.broadcast, p.scanMode);
        if (p.driverIc !== undefined) await s.SetDriverType(SENDER, r.port, r.card, r.broadcast, p.driverIc);
        if (p.icPerGroup !== undefined) await s.SetICNumber(SENDER, r.port, r.card, r.broadcast, p.icPerGroup);
        await s.SetPhysicalTotalDataGroupNum(SENDER, r.port, r.card, r.broadcast, p.dataGroups);
        await writeSafe(s, r, {
          refNumPerVs: p.refNumPerVs,
          gamma: p.gamma,
          grayDepth: p.grayDepth,
          grayRealize: p.grayRealize,
          grayMode: p.grayMode,
        });
      });
    },
  };
}
