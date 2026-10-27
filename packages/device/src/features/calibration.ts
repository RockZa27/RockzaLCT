import { ResponseError, type API, type Session } from '@novastar/codec';
// Side-effect imports: each adds one method to the codec Session prototype. Every call below is a
// receiving-card access (`req.deviceType = 1`, addressed by port + card index) whose register comes
// from node_modules/@novastar/native/dist/api/<Name>.cjs `req.address`; see CALIBRATION_REGISTERS.
import '@novastar/native/api/ReadCorrectionState';
import '@novastar/native/api/SetCorrectionOn';
import '@novastar/native/api/SetCorrectionOn_2';
import '@novastar/native/api/ReadCoefficientSource';
import '@novastar/native/api/ReadCorrectionDataToScan';
import '@novastar/native/api/WriteCorrectionDataToScan';
import '@novastar/native/api/MoveCorrectionFromSdramToMasterFlash';
import '@novastar/native/api/MoveCorrectionFromMasterFlashToSdram';
import '@novastar/native/api/SetCoefficientInSpiFlashErase';
import {
  COEFFICIENT_REGION,
  DeviceError,
  base64ToBytes,
  bytesToBase64,
  classifyCoefficientBlock,
  composeCorrectionState,
  decodeCorrectionState,
  describeCoefficientSource,
  validateCalibrationCard,
  validateCalibrationTarget,
  validateCoefficientBlockRange,
  type CalibrationApi,
  type CalibrationCardState,
  type CalibrationType,
  type CoefficientBlock,
  type CoefficientSet,
  type CorrectionStateBits,
  type ReceiverTarget,
} from '@rockzalct/shared';
import { currentOverrides, type FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';

/**
 * Register address behind every native call used here. Source: the `req.address` line of
 * node_modules/@novastar/native/dist/api/<Name>.cjs; AddressMapping.d.cts names the same numbers
 * (cited per entry). Every request is deviceType 1 (receiving card).
 */
export const CALIBRATION_REGISTERS = {
  /**
   * 0x0200_0051 = 33554513. ReadCorrectionState / ReadCorrectionOn / SetCorrectionOn /
   * SetCorrectionOn_2 (api/*.cjs) and ReadBrightDarkLineFixState / SetBrightDarkLineFixState: the
   * same register. AddressMapping: CorrectionOnAddr, BrightDarkLineFixStateAddr, both Occupancy 1.
   */
  correctionState: 0x0200_0051,
  /** 0x0200_0052 = 33554514. ReadCoefficientSource / SetCoefficientSource. AddressMapping: CoefficientSourceAddr, Occupancy 1. */
  coefficientSource: 0x0200_0052,
  /**
   * 0x0700_0000 = 117440512. Base of the coefficient memory: AddressMapping CoefficientAddr (Occupancy
   * 2097152) = Scanner_CorrectionDataBase. ReadCorrectionDataToScan.cjs / WriteCorrectionDataToScan.cjs take
   * the register as an argument (`req.address = registerAddr`), so the base is passed by this feature.
   * That these two functions are meant for this region is an inference (UNVERIFIED on hardware).
   */
  coefficientRegion: COEFFICIENT_REGION.baseAddress,
  /** 0x0100_0004 = 16777220. MoveCorrectionFromSdramToMasterFlash.cjs (coef !== 4); AddressMapping Correction_RestitutionAddr / CoefficientStore2SpiFlashAddr. Writes one 0x00 byte (`Buffer.alloc(1)` in the .cjs). */
  saveToFlash: 0x0100_0004,
  /** 0x0100_00B0 = 16777392. MoveCorrectionFromSdramToMasterFlash.cjs (coef === 4); AddressMapping Correction_Restitution_MultiLayer. */
  saveToFlashMultiLayer: 0x0100_00b0,
  /** 0x0100_0006 = 16777222. MoveCorrectionFromMasterFlashToSdram.cjs (coef !== 4); AddressMapping Correction_ApplicationAddr / CoefficientReloadFromSpiFlashAddr. Writes one 0x00 byte. */
  reloadFromFlash: 0x0100_0006,
  /** 0x0100_00B1 = 16777393. MoveCorrectionFromMasterFlashToSdram.cjs (coef === 4); AddressMapping Correction_Application_MultiLayer. */
  reloadFromFlashMultiLayer: 0x0100_00b1,
  /** 0x0100_0008 = 16777224. SetCoefficientInSpiFlashErase.cjs; AddressMapping CoefficientInSpiFlashEraseAddr, Occupancy 1. */
  eraseSpiFlash: 0x0100_0008,
} as const;

/** CoefType.d.cts: common = 1, MultiLayer = 4. MoveCorrection*.cjs only tests `coef === 4`; every other value uses the standard address. */
export const COEF_TYPE = { standard: 1, multiLayer: 4 } as const;

/**
 * Argument bytes of the commands whose value the native package does not document.
 *
 * UNVERIFIED ON HARDWARE.
 *  - eraseSpiFlash: SetCoefficientInSpiFlashErase.cjs just encodes a caller supplied number into 1 byte
 *    (`encodeUIntLE(v, AddressMapping.CoefficientInSpiFlashEraseOccupancy)`) and no enum names a value
 *    (searched dist/*.d.cts for Erase / Flash types: none). 0 is used because the neighbouring commands of
 *    the same 0x0100_000x family that DO have a fixed value in the library are triggers written with a
 *    zero byte: MoveCorrectionFromSdramToMasterFlash.cjs (0x01000004) and
 *    MoveCorrectionFromMasterFlashToSdram.cjs (0x01000006) both send `Buffer.alloc(1)`. Override per
 *    service with createCalibrationFeature(ctx, { eraseSpiFlash }) if a card ignores 0.
 *  - correctionBits: see CORRECTION_STATE_BITS in @rockzalct/shared.
 * Both are also adjustable at run time (HardwareOverrides.eraseSpiFlash / correctionEnabledBit /
 * correctionBrightnessTypeBit, advanced hardware settings page); see createCalibrationFeature.
 */
export const CALIBRATION_COMMAND_VALUES = {
  eraseSpiFlash: 0,
} as const;

export interface CalibrationCommandOptions {
  eraseSpiFlash?: number;
  correctionBits?: CorrectionStateBits;
}

/** The native Session methods this feature calls (signatures from dist/*.d.cts). */
export interface CalibrationSession {
  ReadCorrectionState(addr: number, port: number, card: number): Promise<number>;
  SetCorrectionOn(addr: number, port: number, card: number, broadcast: boolean, on: boolean): Promise<void>;
  SetCorrectionOn_2(addr: number, port: number, card: number, broadcast: boolean, data: number): Promise<void>;
  ReadCoefficientSource(addr: number, port: number, card: number): Promise<number>;
  ReadCorrectionDataToScan(addr: number, port: number, card: number, readLength: number, registerAddr: number): Promise<Buffer>;
  WriteCorrectionDataToScan(
    addr: number,
    port: number,
    card: number,
    broadcast: boolean,
    data: number[] | Buffer,
    length: number,
    registerAddr: number,
  ): Promise<void>;
  MoveCorrectionFromSdramToMasterFlash(addr: number, port: number, card: number, broadcast: boolean, coef: number): Promise<void>;
  MoveCorrectionFromMasterFlashToSdram(addr: number, port: number, card: number, broadcast: boolean, coef: number): Promise<void>;
  SetCoefficientInSpiFlashErase(addr: number, port: number, card: number, broadcast: boolean, value: number): Promise<void>;
}

// Compile-time proof that the real codec Session (augmented by the imports above) satisfies the
// narrow interface: if a native signature differs this line stops compiling.
const _nativeSessionMatches: (API & Session) extends CalibrationSession ? true : never = true;
void _nativeSessionMatches;

const SENDER = 0;
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;

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

export function createCalibrationFeature(ctx: FeatureContext, options: CalibrationCommandOptions = {}): CalibrationApi {
  // Precedence per call: `options` given to this factory > the advanced hardware settings in effect
  // now (ctx) > the built-in constants. Read inside each command, never cached here, so a settings
  // change applies to the very next command.
  const eraseValue = (): number => options.eraseSpiFlash ?? currentOverrides(ctx).eraseSpiFlash;
  const bits = (): CorrectionStateBits => {
    const o = currentOverrides(ctx);
    return options.correctionBits ?? { enabled: o.correctionEnabledBit, brightnessType: o.correctionBrightnessTypeBit };
  };

  // Checked before any request is built, so a refused call sends nothing.
  const requireAdvanced = (what: string): void => {
    if (ctx.userLevel().level !== 'advanced') {
      throw new DeviceError('PERMISSION', `advanced user level required to ${what}`);
    }
  };
  // validateCardIndex caps port at 0xFE and card at 0xFFFE, so the broadcast addresses (port 0xFF /
  // card 0xFFFF, i.e. target 'all') are refused here: flash store and erase work on one card at a time.
  const checkCard = (portIndex: number, cardIndex: number): void => {
    const bad = validateCalibrationCard(portIndex, cardIndex);
    if (bad) throw invalid(bad);
  };
  const on = <T>(id: string, fn: (s: CalibrationSession) => Promise<T>): Promise<T> =>
    ctx.withSession(id, (s: SessionLike) => fn(s as unknown as CalibrationSession));
  const coefOf = (set: CoefficientSet | undefined): number => (set === 'multi-layer' ? COEF_TYPE.multiLayer : COEF_TYPE.standard);
  const checkSet = (set: unknown): void => {
    if (set !== undefined && set !== 'standard' && set !== 'multi-layer') throw invalid("set must be 'standard' or 'multi-layer'");
  };

  return {
    async getCalibrationState(id, portIndex, cardIndex): Promise<CalibrationCardState> {
      checkCard(portIndex, cardIndex);
      return on(id, async (s) => {
        const stateRaw = await s.ReadCorrectionState(SENDER, portIndex, cardIndex);
        const state: CalibrationCardState = { portIndex, cardIndex, stateRaw, ...decodeCorrectionState(stateRaw, bits()) };
        const source = await optional(() => s.ReadCoefficientSource(SENDER, portIndex, cardIndex));
        if (source !== undefined) {
          state.coefficientSourceRaw = source;
          state.coefficientSource = describeCoefficientSource(source);
        }
        const first = await optional(() =>
          s.ReadCorrectionDataToScan(SENDER, portIndex, cardIndex, COEFFICIENT_REGION.blockBytes, CALIBRATION_REGISTERS.coefficientRegion),
        );
        if (first !== undefined) state.coefficientData = classifyCoefficientBlock(first);
        return state;
      });
    },

    async setCalibrationEnabled(id, target: ReceiverTarget, enabled: boolean, type?: CalibrationType): Promise<void> {
      const badTarget = validateCalibrationTarget(target);
      if (badTarget) throw invalid(badTarget);
      if (typeof enabled !== 'boolean') throw invalid('enabled must be a boolean');
      if (type !== undefined && type !== 'chroma' && type !== 'brightness') throw invalid("type must be 'chroma' or 'brightness'");
      const [port, card, broadcast] =
        target.scope === 'all' ? [ALL_PORTS, ALL_CARDS, true] : [target.portIndex, target.cardIndex, false];
      await on(id, async (s) => {
        if (enabled && type !== undefined) {
          // Type-aware enable: one state byte (bit layout UNVERIFIED, see CORRECTION_STATE_BITS).
          await s.SetCorrectionOn_2(SENDER, port, card, broadcast, composeCorrectionState(type, bits()));
        } else {
          await s.SetCorrectionOn(SENDER, port, card, broadcast, enabled);
        }
      });
    },

    async readCoefficientBlock(id, portIndex, cardIndex, offset, length): Promise<CoefficientBlock> {
      checkCard(portIndex, cardIndex);
      const bad = validateCoefficientBlockRange(offset, length);
      if (bad) throw invalid(bad);
      return on(id, async (s) => {
        const data = await s.ReadCorrectionDataToScan(
          SENDER,
          portIndex,
          cardIndex,
          length,
          CALIBRATION_REGISTERS.coefficientRegion + offset,
        );
        if (data.length !== length) throw new DeviceError('PROTOCOL', `expected ${length} bytes, the card returned ${data.length}`);
        return { offset, length, dataBase64: bytesToBase64(data) };
      });
    },

    async writeCoefficientBlock(id, portIndex, cardIndex, offset, dataBase64): Promise<void> {
      requireAdvanced('write calibration coefficients');
      checkCard(portIndex, cardIndex);
      const bytes = typeof dataBase64 === 'string' ? base64ToBytes(dataBase64) : null;
      if (!bytes) throw invalid('dataBase64 is not valid base64');
      const bad = validateCoefficientBlockRange(offset, bytes.length);
      if (bad) throw invalid(bad);
      const data = Buffer.from(bytes);
      await on(id, (s) =>
        s.WriteCorrectionDataToScan(SENDER, portIndex, cardIndex, false, data, data.length, CALIBRATION_REGISTERS.coefficientRegion + offset),
      );
    },

    async saveCoefficientsToFlash(id, portIndex, cardIndex, set): Promise<void> {
      requireAdvanced('save calibration coefficients to flash');
      checkCard(portIndex, cardIndex);
      checkSet(set);
      await on(id, (s) => s.MoveCorrectionFromSdramToMasterFlash(SENDER, portIndex, cardIndex, false, coefOf(set)));
    },

    async reloadCoefficientsFromFlash(id, portIndex, cardIndex, set): Promise<void> {
      requireAdvanced('reload calibration coefficients from flash');
      checkCard(portIndex, cardIndex);
      checkSet(set);
      await on(id, (s) => s.MoveCorrectionFromMasterFlashToSdram(SENDER, portIndex, cardIndex, false, coefOf(set)));
    },

    async eraseCoefficientsInFlash(id, portIndex, cardIndex): Promise<void> {
      requireAdvanced('erase calibration coefficients in flash');
      checkCard(portIndex, cardIndex);
      await on(id, (s) => s.SetCoefficientInSpiFlashErase(SENDER, portIndex, cardIndex, false, eraseValue()));
    },
  };
}
