import {
  DeviceError,
  FIRMWARE_TARGETS,
  FIRMWARE_WRITE_MISSING,
  FUNCTION_CARD_RELAY_COUNT,
  POWER_CTRL_MODE,
  POWER_OPERATE,
  buildDryRunPlan,
  checkFirmwareCompatibility,
  formatProgramEdition,
  relayStateFromRaw,
  validateFirmwareFile,
  type DeviceProgramState,
  type DryRunRequest,
  type DryRunResult,
  type FirmwareWriteRequest,
  type FirmwareWriteStatus,
  type FunctionCardInfo,
  type FunctionCardSchedule,
  type MaintenanceApi,
  type PowerControlMode,
  type ProgramVersions,
  type ReadProgramVersionsOptions,
  type RelayStatus,
  type SetPowerModeResult,
  type SetRelayRequest,
  type SetRelayResult,
} from '@rockzalct/shared';
// Side-effect imports: each adds one method to the codec Session prototype. Registers are from
// @novastar/native@2.5.1 dist/api/<Name>.mjs (`req.address`) and dist/AddressMapping.mjs:
//   FuncCard_ReadFuncCardModle        2 bytes  @ 2          (FuncCard_ReadFuncCardModle.mjs)
//   FuncCard_ReadFuncCardMCUVersion   4 bytes  @ 33554436   (FuncCard_MCUVersionAddr)
//   FuncCard_ReadFuncCardFPGAVersion  4 bytes  @ 16777220   (FuncCard_FPGAVersionAddr)
//   FuncCard_ReadGoldenFPGAVersion    4 bytes  @ 4
//   FuncCard_ReadTimeOnFuncCard       7 bytes  @ 83886080   (FuncCard_TimeOnFuncCardAddr)
//   FuncCard_ReadPowerPortCtrl        1 byte   @ 83886096 + powerIndex   (FuncCard_PowerPortCtrlAddr, Num = 8)
//   FuncCard_SetPowerPortCtrl         1 byte   @ 83886096 + powerIndex, value = PowerOperateType
//   FuncCard_ReadPowerOperTime        48 bytes @ 83886112   (FuncCard_PowerOperTimeAddr)
//   FuncCard_ReadPowerCtrlMode        1 byte   @ 83886176   (FuncCard_PowerCtrlModeAddr)
//   FuncCard_SetPowerCtrlMode         1 byte   @ 83886176, value = PowerCtrlMode (Mannual 0 / Auto 1)
//   FuncCard_ReadPowerPortCtrlTotal   1 byte   @ 83886178   (FuncCard_PowerPortCtrlTotalAddr)
//   FuncCard_SetPowerPortCtrlTotal    1 byte   @ 83886178, value = PowerOperateType (Start 0 / Stop 1)
//   ReadScanner_FPGAProgramEdition    4 bytes  @ 134217732, deviceType 1 (port, card)
//   ReadSender_FPGAProgramEdition     4 bytes  @ 68157444
// ReadSender_McuProgramEdition / ReadScanner_McuProgramEdition are already imported by the service.
import '@novastar/native/api/FuncCard_ReadFuncCardModle';
import '@novastar/native/api/FuncCard_ReadFuncCardMCUVersion';
import '@novastar/native/api/FuncCard_ReadFuncCardFPGAVersion';
import '@novastar/native/api/FuncCard_ReadGoldenFPGAVersion';
import '@novastar/native/api/FuncCard_ReadTimeOnFuncCard';
import '@novastar/native/api/FuncCard_ReadPowerPortCtrl';
import '@novastar/native/api/FuncCard_SetPowerPortCtrl';
import '@novastar/native/api/FuncCard_ReadPowerOperTime';
import '@novastar/native/api/FuncCard_ReadPowerCtrlMode';
import '@novastar/native/api/FuncCard_SetPowerCtrlMode';
import '@novastar/native/api/FuncCard_ReadPowerPortCtrlTotal';
import '@novastar/native/api/FuncCard_SetPowerPortCtrlTotal';
import '@novastar/native/api/ReadScanner_FPGAProgramEdition';
import '@novastar/native/api/ReadSender_FPGAProgramEdition';
import '@novastar/native/api/ReadSender_McuProgramEdition';
import '@novastar/native/api/ReadScanner_McuProgramEdition';
import type { API, Session } from '@novastar/codec';
import type { FeatureContext } from './context.js';
import type { SessionLike } from '../session.js';

/** The native Session methods this feature calls (signatures from dist/api/*.d.cts). */
export interface MaintenanceSession {
  FuncCard_ReadFuncCardModle(addr: number): Promise<number>;
  FuncCard_ReadFuncCardMCUVersion(addr: number): Promise<number>;
  FuncCard_ReadFuncCardFPGAVersion(addr: number): Promise<number>;
  FuncCard_ReadGoldenFPGAVersion(addr: number): Promise<number>;
  FuncCard_ReadTimeOnFuncCard(addr: number): Promise<Buffer>;
  FuncCard_ReadPowerPortCtrl(addr: number, powerIndex: number): Promise<number>;
  FuncCard_SetPowerPortCtrl(addr: number, bBroadcast: boolean, op: number, powerIndex: number): Promise<void>;
  FuncCard_ReadPowerOperTime(addr: number): Promise<Buffer>;
  FuncCard_ReadPowerCtrlMode(addr: number): Promise<number>;
  FuncCard_SetPowerCtrlMode(addr: number, bBroadcast: boolean, mode: number): Promise<void>;
  FuncCard_ReadPowerPortCtrlTotal(addr: number): Promise<number>;
  FuncCard_SetPowerPortCtrlTotal(addr: number, bBroadcast: boolean, op: number): Promise<void>;
  ReadSender_McuProgramEdition(addr: number): Promise<number>;
  ReadSender_FPGAProgramEdition(addr: number): Promise<number>;
  ReadScanner_McuProgramEdition(addr: number, portAddr: number, scanBoardAddr: number): Promise<number>;
  ReadScanner_FPGAProgramEdition(addr: number, portAddr: number, scanBoardAddr: number): Promise<number>;
}

// Compile-time proof that the real codec Session (augmented by the imports above) satisfies the
// narrow interface: if a native signature differs this line stops compiling.
const _nativeSessionMatches: (API & Session) extends MaintenanceSession ? true : never = true;
void _nativeSessionMatches;

const SENDER = 0;

export interface MaintenanceOptions {
  /**
   * Opt-in switch for firmware writing. Default false. Even when true nothing is written: no
   * writer exists (see FIRMWARE_WRITE_MISSING). The switch only changes the refusal reason.
   */
  enableFirmwareWrite?: boolean;
}

const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);

function checkAddress(a: unknown): number {
  if (typeof a !== 'number' || !Number.isInteger(a) || a < 0 || a > 255) {
    throw invalid('functionCardAddress must be an integer 0..255');
  }
  return a;
}

function checkRelay(r: unknown): number | 'all' {
  if (r === 'all') return 'all';
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r >= FUNCTION_CARD_RELAY_COUNT) {
    throw invalid(`relay must be 0..${FUNCTION_CARD_RELAY_COUNT - 1} or "all"`);
  }
  return r;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Decode FuncCard_ReadPowerOperTime: 8 x 6 bytes (FuncCard_OpenTime/CloseTime Hour/Minute/Second index 0..5). */
export function decodeSchedule(data: ArrayLike<number>): FunctionCardSchedule[] {
  const out: FunctionCardSchedule[] = [];
  for (let relay = 0; relay < FUNCTION_CARD_RELAY_COUNT; relay += 1) {
    const b = (i: number): number => data[relay * 6 + i] ?? 0;
    out.push({ relay, open: [b(0), b(1), b(2)], close: [b(3), b(4), b(5)] });
  }
  return out;
}

export function createMaintenanceFeature(ctx: FeatureContext, options: MaintenanceOptions = {}): MaintenanceApi {
  const enableFirmwareWrite = options.enableFirmwareWrite === true;
  const on = <T>(id: string, fn: (s: MaintenanceSession) => Promise<T>): Promise<T> =>
    ctx.withSession(id, (s: SessionLike) => fn(s as unknown as MaintenanceSession));

  /** Refuses before any request is built or sent. */
  const requireWrite = (confirmed: unknown, what: string): void => {
    if (ctx.userLevel().level !== 'advanced') {
      throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
    }
    if (confirmed !== true) {
      throw invalid(`${what} needs an explicit confirmation (confirmed: true)`);
    }
  };

  const readDeviceState = (s: MaintenanceSession, fc: number): Promise<DeviceProgramState> =>
    (async () => ({
      modelId: await s.FuncCard_ReadFuncCardModle(fc),
      mcuVersionRaw: await s.FuncCard_ReadFuncCardMCUVersion(fc),
      fpgaVersionRaw: await s.FuncCard_ReadFuncCardFPGAVersion(fc),
    }))();

  return {
    /** Requests: 6 reads (model, MCU, FPGA, golden FPGA, clock). Writes: none. */
    async readFunctionCardInfo(id, functionCardAddress): Promise<FunctionCardInfo> {
      const fc = checkAddress(functionCardAddress);
      return on(id, async (s) => {
        const modelId = await s.FuncCard_ReadFuncCardModle(fc);
        const mcu = await s.FuncCard_ReadFuncCardMCUVersion(fc);
        const fpga = await s.FuncCard_ReadFuncCardFPGAVersion(fc);
        const golden = await s.FuncCard_ReadGoldenFPGAVersion(fc);
        const t = await s.FuncCard_ReadTimeOnFuncCard(fc);
        return {
          functionCardAddress: fc,
          modelId,
          mcuVersion: formatProgramEdition(mcu),
          mcuVersionRaw: mcu >>> 0,
          fpgaVersion: formatProgramEdition(fpga),
          fpgaVersionRaw: fpga >>> 0,
          goldenFpgaVersion: formatProgramEdition(golden),
          goldenFpgaVersionRaw: golden >>> 0,
          // AddressMapping FuncCard_Time{Year,Month,Day,WeekDay,Hour,Minute,Second}StartIndex = 0..6
          clock: {
            year: t[0] ?? 0,
            month: t[1] ?? 0,
            day: t[2] ?? 0,
            weekday: t[3] ?? 0,
            hour: t[4] ?? 0,
            minute: t[5] ?? 0,
            second: t[6] ?? 0,
          },
        };
      });
    },

    /** Requests: 8 relay reads + total + mode + schedule = 11 reads. Writes: none. */
    async readRelayStatus(id, functionCardAddress): Promise<RelayStatus> {
      const fc = checkAddress(functionCardAddress);
      return on(id, async (s) => {
        const relays = [];
        for (let index = 0; index < FUNCTION_CARD_RELAY_COUNT; index += 1) {
          const raw = await s.FuncCard_ReadPowerPortCtrl(fc, index);
          relays.push({ index, raw, state: relayStateFromRaw(raw) });
        }
        const totalRaw = await s.FuncCard_ReadPowerPortCtrlTotal(fc);
        const modeRaw = await s.FuncCard_ReadPowerCtrlMode(fc);
        const schedule = decodeSchedule(await s.FuncCard_ReadPowerOperTime(fc));
        const mode: PowerControlMode | null =
          modeRaw === POWER_CTRL_MODE.manual ? 'manual' : modeRaw === POWER_CTRL_MODE.auto ? 'auto' : null;
        return {
          functionCardAddress: fc,
          relays,
          total: { raw: totalRaw, state: relayStateFromRaw(totalRaw) },
          mode,
          modeRaw,
          schedule,
        };
      });
    },

    /** Requests: 1 write (never broadcast) + 1 read-back. Refused at normal level / unconfirmed with 0 requests. */
    async setRelay(id, functionCardAddress, request: SetRelayRequest): Promise<SetRelayResult> {
      const fc = checkAddress(functionCardAddress);
      if (typeof request !== 'object' || request === null || typeof request.on !== 'boolean') {
        throw invalid('request must be {relay, on, confirmed}');
      }
      const relay = checkRelay(request.relay);
      requireWrite(request.confirmed, 'Switching a power relay');
      const written = request.on ? POWER_OPERATE.start : POWER_OPERATE.stop;
      return on(id, async (s) => {
        let readBack: number | null = null;
        if (relay === 'all') {
          await s.FuncCard_SetPowerPortCtrlTotal(fc, false, written);
          readBack = await s.FuncCard_ReadPowerPortCtrlTotal(fc).catch(() => null);
        } else {
          await s.FuncCard_SetPowerPortCtrl(fc, false, written, relay);
          readBack = await s.FuncCard_ReadPowerPortCtrl(fc, relay).catch(() => null);
        }
        return { relay, written, readBack, verified: readBack === written };
      });
    },

    /** Requests: 1 write (never broadcast) + 1 read-back. */
    async setPowerControlMode(id, functionCardAddress, mode, confirmed): Promise<SetPowerModeResult> {
      const fc = checkAddress(functionCardAddress);
      if (mode !== 'manual' && mode !== 'auto') throw invalid('mode must be "manual" or "auto"');
      requireWrite(confirmed, 'Changing the power control mode');
      const value = POWER_CTRL_MODE[mode];
      return on(id, async (s) => {
        await s.FuncCard_SetPowerCtrlMode(fc, false, value);
        const readBack = await s.FuncCard_ReadPowerCtrlMode(fc).catch(() => null);
        return { mode, readBack, verified: readBack === value };
      });
    },

    /**
     * Requests (reads only): sender MCU + FPGA edition (2); per listed card MCU + FPGA edition (2 each);
     * with `functionCardAddress` MCU + FPGA + golden FPGA (3). A failing read is reported on that row.
     */
    async readProgramVersions(id, opts?: ReadProgramVersionsOptions): Promise<ProgramVersions> {
      const cards = opts?.cards ?? [];
      if (!Array.isArray(cards)) throw invalid('cards must be an array');
      for (const c of cards) {
        if (
          typeof c !== 'object' || c === null ||
          !Number.isInteger(c.portIndex) || c.portIndex < 0 || c.portIndex > 255 ||
          !Number.isInteger(c.cardIndex) || c.cardIndex < 0 || c.cardIndex > 65534
        ) {
          throw invalid('every card must be {portIndex 0..255, cardIndex 0..65534}');
        }
      }
      const fc = opts?.functionCardAddress === undefined ? undefined : checkAddress(opts.functionCardAddress);
      return on(id, async (s) => {
        const soft = async (fn: () => Promise<number>): Promise<{ v: string | null; err?: string }> => {
          try {
            return { v: formatProgramEdition(await fn()) };
          } catch (e) {
            return { v: null, err: messageOf(e) };
          }
        };
        const mcu = await soft(() => s.ReadSender_McuProgramEdition(SENDER));
        const fpga = await soft(() => s.ReadSender_FPGAProgramEdition(SENDER));
        const receivers: ProgramVersions['receivers'] = [];
        for (const c of cards) {
          const m = await soft(() => s.ReadScanner_McuProgramEdition(SENDER, c.portIndex, c.cardIndex));
          const f = await soft(() => s.ReadScanner_FPGAProgramEdition(SENDER, c.portIndex, c.cardIndex));
          const row: ProgramVersions['receivers'][number] = { portIndex: c.portIndex, cardIndex: c.cardIndex, mcu: m.v, fpga: f.v };
          const err = m.err ?? f.err;
          if (err !== undefined) row.error = err;
          receivers.push(row);
        }
        const out: ProgramVersions = { sender: { mcu: mcu.v, fpga: fpga.v }, receivers };
        if (fc !== undefined) {
          const fm = await soft(() => s.FuncCard_ReadFuncCardMCUVersion(fc));
          const ff = await soft(() => s.FuncCard_ReadFuncCardFPGAVersion(fc));
          const fg = await soft(() => s.FuncCard_ReadGoldenFPGAVersion(fc));
          out.functionCard = { functionCardAddress: fc, mcu: fm.v, fpga: ff.v, golden: fg.v };
        }
        return out;
      });
    },

    /** Requests: 3 reads (model, MCU, FPGA version). Writes: none, ever. */
    async dryRunFirmware(id, request: DryRunRequest): Promise<DryRunResult> {
      if (typeof request !== 'object' || request === null) throw invalid('request must be an object');
      const fc = checkAddress(request.functionCardAddress);
      if (!FIRMWARE_TARGETS.includes(request.target)) throw invalid('unknown firmware target');
      const f = request.file;
      if (typeof f !== 'object' || f === null || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) {
        throw invalid('file must be {name, bytes: Uint8Array}');
      }
      for (const [k, v] of [['declaredVersion', request.declaredVersion], ['declaredModelId', request.declaredModelId]] as const) {
        if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 0xffffffff)) throw invalid(`${k} must be a 32-bit unsigned integer`);
      }
      const report = validateFirmwareFile({ name: f.name, bytes: f.bytes }, request.target);
      let device: DeviceProgramState | null = null;
      try {
        device = await on(id, (s) => readDeviceState(s, fc));
      } catch (e) {
        if (e instanceof DeviceError && (e.code === 'NOT_FOUND' || e.code === 'NOT_CONNECTED')) throw e;
        device = null;
      }
      const compat: Parameters<typeof checkFirmwareCompatibility>[0] = { report, device };
      if (request.declaredVersion !== undefined) compat.declaredVersion = request.declaredVersion;
      if (request.declaredModelId !== undefined) compat.declaredModelId = request.declaredModelId;
      const compatibility = checkFirmwareCompatibility(compat);
      const plan = report.valid ? buildDryRunPlan(report, request.blockSize) : null;
      return { report, compatibility, plan, writesSent: 0 };
    },

    async getFirmwareWriteStatus(id): Promise<FirmwareWriteStatus> {
      // No device traffic; the id is only checked so a stale selection still reports NOT_FOUND.
      await on(id, async () => undefined);
      return { implemented: false, enabled: enableFirmwareWrite, missing: [...FIRMWARE_WRITE_MISSING] };
    },

    /** Never sends anything. */
    async writeFirmware(_id, _request: FirmwareWriteRequest): Promise<never> {
      if (ctx.userLevel().level !== 'advanced') {
        throw new DeviceError('PERMISSION', 'Firmware writing requires the advanced user level');
      }
      if (!enableFirmwareWrite) {
        throw new DeviceError('PERMISSION', 'Firmware writing is disabled (enableFirmwareWrite is off)');
      }
      throw new DeviceError(
        'PROTOCOL',
        `Firmware writing is not implemented: ${FIRMWARE_WRITE_MISSING.length} required pieces are missing from @novastar/native (erase, block size, MCU data write, readback verify, file format, sequence semantics)`,
      );
    },
  };
}
