import type { API, Session } from '@novastar/codec';
// Side-effect imports: each adds one method to the codec Session prototype. The register address
// of every call is listed in SMART_REGISTERS below (read from dist/api/<Name>.cjs, field
// `req.address`; all use `req.deviceType = 1`, i.e. the receiving card, addressed by port + index).
// The width/height/scan/driver/data-group calls are the ones receiver.ts already imports.
import '@novastar/native/api/ReadModuleWidth';
import '@novastar/native/api/SetModuleWidth';
import '@novastar/native/api/ReadModuleHeight';
import '@novastar/native/api/SetModuleHeight';
import '@novastar/native/api/ReadScanMode';
import '@novastar/native/api/SetScanMode';
import '@novastar/native/api/ReadPhysicalTotalDataGroupNum';
import '@novastar/native/api/SetPhysicalTotalDataGroupNum';
import '@novastar/native/api/ReadDriverType';
import '@novastar/native/api/SetDriverType';
import '@novastar/native/api/ReadDecodeType';
import '@novastar/native/api/SetDecodeType';
import '@novastar/native/api/ReadDataDirection';
import '@novastar/native/api/SetDataDirection';
import '@novastar/native/api/ReadOEPority';
import '@novastar/native/api/SetOEPority';
import '@novastar/native/api/ReadRgbCode';
import '@novastar/native/api/SetRgbCode';
import {
  DeviceError,
  SMART_FIELDS,
  byteToRgbCode,
  validateReceiverTarget,
  validateSmartChanges,
  type ReceiverTarget,
  type SmartChanges,
  type SmartField,
  type SmartSettingsApi,
  type SmartSnapshot,
  type SmartWriteResult,
} from '@rockzalct/shared';
import type { FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';

/**
 * Register address (receiving card, deviceType 1) behind every native call used here. Source:
 * node_modules/@novastar/native/dist/api/<Name>.cjs `req.address`; width in bytes is the
 * `Request(<n>)` / `encodeUIntLE(v, <n>)` argument in the same file. AddressMapping.d.cts names the
 * same addresses (DataDirectionAddr, ModuleWidthAddr, ModuleHeightAddr, DriverTypeAddr,
 * ScanModeAddr, OEPorityAddr, DecodeTypeAddr, RgbCodeAddr, ...). A device test re-derives every
 * address from the .cjs files, so this table cannot drift from the library.
 */
export const SMART_REGISTERS = {
  dataDirection: 0x0200_0009, // ReadDataDirection / SetDataDirection (33554441), 1 byte, DataDirectionTypeEnum 0 Horizontal / 1 Vertical (enum names are the library's; the physical effect is UNVERIFIED on hardware)
  moduleWidth: 0x0200_000a, // ReadModuleWidth / SetModuleWidth, 1 byte
  moduleHeight: 0x0200_000b, // ReadModuleHeight / SetModuleHeight, 1 byte
  driverIc: 0x0200_000c, // ReadDriverType / SetDriverType, 1 byte
  scanMode: 0x0200_000d, // ReadScanMode / SetScanMode, 1 byte
  oePolarity: 0x0200_000e, // ReadOEPority / SetOEPority (33554446), 1 byte, OEPolarityTypeEnum 0 HighEnable / 1 LowEnable (which value gives a normal picture is UNVERIFIED on hardware)
  decodeType: 0x0200_000f, // ReadDecodeType / SetDecodeType (33554447), 1 byte
  dataGroups: 0x0200_001b, // ReadPhysicalTotalDataGroupNum / SetPhysicalTotalDataGroupNum, 1 byte
  rgbCode: 0x0200_005c, // ReadRgbCode / SetRgbCode (33554524), 1 byte = red | green << 2 | blue << 4 | virtualRed << 6 (what the 2-bit fields mean is UNVERIFIED on hardware)
} as const;

/** The native Session methods this feature calls (signatures from dist/*.d.cts). */
export interface SmartSession {
  ReadModuleWidth(addr: number, port: number, card: number): Promise<number>;
  SetModuleWidth(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadModuleHeight(addr: number, port: number, card: number): Promise<number>;
  SetModuleHeight(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadScanMode(addr: number, port: number, card: number): Promise<number>;
  SetScanMode(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadPhysicalTotalDataGroupNum(addr: number, port: number, card: number): Promise<number>;
  SetPhysicalTotalDataGroupNum(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadDriverType(addr: number, port: number, card: number): Promise<number>;
  SetDriverType(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadDecodeType(addr: number, port: number, card: number): Promise<number>;
  SetDecodeType(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadDataDirection(addr: number, port: number, card: number): Promise<number>;
  SetDataDirection(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadOEPority(addr: number, port: number, card: number): Promise<number>;
  SetOEPority(addr: number, port: number, card: number, broadcast: boolean, v: number): Promise<void>;
  ReadRgbCode(addr: number, port: number, card: number): Promise<number>;
  SetRgbCode(
    addr: number,
    port: number,
    card: number,
    broadcast: boolean,
    red: number,
    green: number,
    blue: number,
    virtualRed: number,
  ): Promise<void>;
}

// Compile-time proof that the real codec Session (augmented by the imports above) satisfies the
// narrow interface: if a native signature differs this line stops compiling.
const _nativeSessionMatches: (API & Session) extends SmartSession ? true : never = true;
void _nativeSessionMatches;

const SENDER = 0;
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;

const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);

export function createSmartSettingsFeature(ctx: FeatureContext): SmartSettingsApi {
  const requireAdvanced = (): void => {
    if (ctx.userLevel().level !== 'advanced') {
      throw new DeviceError('PERMISSION', 'advanced user level required to write receiving-card parameters');
    }
  };

  const on = <T>(id: string, fn: (s: SmartSession) => Promise<T>): Promise<T> =>
    ctx.withSession(id, (s: SessionLike) => fn(s as unknown as SmartSession));

  /** One write per field; the order of SMART_FIELDS is the order they are sent. */
  const writers: { [F in SmartField]: (s: SmartSession, p: number, c: number, bc: boolean, ch: SmartChanges) => Promise<void> } = {
    moduleWidth: (s, p, c, bc, ch) => s.SetModuleWidth(SENDER, p, c, bc, ch.moduleWidth!),
    moduleHeight: (s, p, c, bc, ch) => s.SetModuleHeight(SENDER, p, c, bc, ch.moduleHeight!),
    scanMode: (s, p, c, bc, ch) => s.SetScanMode(SENDER, p, c, bc, ch.scanMode!),
    driverIc: (s, p, c, bc, ch) => s.SetDriverType(SENDER, p, c, bc, ch.driverIc!),
    decodeType: (s, p, c, bc, ch) => s.SetDecodeType(SENDER, p, c, bc, ch.decodeType!),
    dataGroups: (s, p, c, bc, ch) => s.SetPhysicalTotalDataGroupNum(SENDER, p, c, bc, ch.dataGroups!),
    dataDirection: (s, p, c, bc, ch) => s.SetDataDirection(SENDER, p, c, bc, ch.dataDirection!),
    rgb: (s, p, c, bc, ch) => s.SetRgbCode(SENDER, p, c, bc, ch.rgb!.red, ch.rgb!.green, ch.rgb!.blue, ch.rgb!.virtualRed),
    oePolarity: (s, p, c, bc, ch) => s.SetOEPority(SENDER, p, c, bc, ch.oePolarity!),
  };

  return {
    async readSmartSnapshot(id, portIndex, cardIndex): Promise<SmartSnapshot> {
      const bad = validateReceiverTarget({ scope: 'card', portIndex, cardIndex });
      if (bad) throw invalid(bad);
      return on(id, async (s) => {
        const a = [SENDER, portIndex, cardIndex] as const;
        // Every register is required: a card that refuses one makes the whole snapshot fail, so the
        // revert point is never partial.
        const moduleWidth = await s.ReadModuleWidth(...a);
        const moduleHeight = await s.ReadModuleHeight(...a);
        const scanMode = await s.ReadScanMode(...a);
        const driverIc = await s.ReadDriverType(...a);
        const decodeType = await s.ReadDecodeType(...a);
        const dataGroups = await s.ReadPhysicalTotalDataGroupNum(...a);
        const dataDirection = await s.ReadDataDirection(...a);
        const rgbByte = await s.ReadRgbCode(...a);
        const oePolarity = await s.ReadOEPority(...a);
        return {
          portIndex,
          cardIndex,
          moduleWidth,
          moduleHeight,
          scanMode,
          dataGroups,
          driverIc,
          decodeType,
          dataDirection,
          oePolarity,
          rgb: byteToRgbCode(rgbByte),
        };
      });
    },

    async writeSmartSettings(id, target: ReceiverTarget, changes, options): Promise<SmartWriteResult> {
      requireAdvanced();
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw invalid(badTarget);
      const bad = validateSmartChanges(changes, options);
      if (bad) throw invalid(bad);
      const port = target.scope === 'all' ? ALL_PORTS : target.portIndex;
      const card = target.scope === 'all' ? ALL_CARDS : target.cardIndex;
      const broadcast = target.scope === 'all';

      const written: SmartField[] = [];
      for (const field of SMART_FIELDS) {
        if (changes[field] === undefined) continue;
        try {
          await on(id, (s) => writers[field](s, port, card, broadcast, changes));
        } catch (err) {
          const e = err instanceof DeviceError ? err : new DeviceError('PROTOCOL', err instanceof Error ? err.message : String(err));
          // Nothing written yet: a plain rejection is accurate. Otherwise report the partial write.
          if (written.length === 0) throw e;
          return { ok: false, written, failed: { field, code: e.code, message: e.message } };
        }
        written.push(field);
      }
      return { ok: true, written };
    },
  };
}
