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
  type FunctionCardSchedule,
  type MaintenanceApi,
  type PowerControlMode,
} from '@rockzalct/shared';
import type { MockContext } from './context';

const MOCK_MODEL_ID = 0x0a01;
const MOCK_MCU = 0x01020300;
const MOCK_FPGA = 0x01010000;

const checkAddr = (a: number): number => {
  if (!Number.isInteger(a) || a < 0 || a > 255) {
    throw new DeviceError('INVALID_ARGUMENT', 'functionCardAddress must be an integer 0..255');
  }
  return a;
};

/** In-memory function card. State is per bus address, shared by every call (like a real card). */
export function createMockMaintenance(ctx: MockContext): MaintenanceApi {
  const relays = new Map<number, number[]>();
  const modes = new Map<number, number>();
  const totals = new Map<number, number>();
  const relaysOf = (fc: number): number[] => {
    let r = relays.get(fc);
    if (!r) {
      r = new Array<number>(FUNCTION_CARD_RELAY_COUNT).fill(POWER_OPERATE.start);
      relays.set(fc, r);
    }
    return r;
  };
  const schedule = (): FunctionCardSchedule[] =>
    Array.from({ length: FUNCTION_CARD_RELAY_COUNT }, (_, relay) => ({ relay, open: [8, 0, 0], close: [22, 0, 0] }));
  const requireWrite = (confirmed: unknown, what: string): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
    if (confirmed !== true) throw new DeviceError('INVALID_ARGUMENT', `${what} needs an explicit confirmation`);
  };

  return {
    async readFunctionCardInfo(id, functionCardAddress) {
      ctx.requireConnected(id);
      const fc = checkAddr(functionCardAddress);
      await ctx.delay();
      const now = new Date();
      return {
        functionCardAddress: fc,
        modelId: MOCK_MODEL_ID,
        mcuVersion: formatProgramEdition(MOCK_MCU),
        mcuVersionRaw: MOCK_MCU,
        fpgaVersion: formatProgramEdition(MOCK_FPGA),
        fpgaVersionRaw: MOCK_FPGA,
        goldenFpgaVersion: formatProgramEdition(MOCK_FPGA),
        goldenFpgaVersionRaw: MOCK_FPGA,
        clock: {
          year: now.getFullYear() % 100,
          month: now.getMonth() + 1,
          day: now.getDate(),
          weekday: now.getDay(),
          hour: now.getHours(),
          minute: now.getMinutes(),
          second: now.getSeconds(),
        },
      };
    },
    async readRelayStatus(id, functionCardAddress) {
      ctx.requireConnected(id);
      const fc = checkAddr(functionCardAddress);
      await ctx.delay();
      const modeRaw = modes.get(fc) ?? POWER_CTRL_MODE.manual;
      const totalRaw = totals.get(fc) ?? POWER_OPERATE.start;
      return {
        functionCardAddress: fc,
        relays: relaysOf(fc).map((raw, index) => ({ index, raw, state: relayStateFromRaw(raw) })),
        total: { raw: totalRaw, state: relayStateFromRaw(totalRaw) },
        mode: modeRaw === POWER_CTRL_MODE.auto ? 'auto' : 'manual',
        modeRaw,
        schedule: schedule(),
      };
    },
    async setRelay(id, functionCardAddress, request) {
      ctx.requireConnected(id);
      const fc = checkAddr(functionCardAddress);
      requireWrite(request.confirmed, 'Switching a power relay');
      if (request.relay !== 'all' && (!Number.isInteger(request.relay) || request.relay < 0 || request.relay >= FUNCTION_CARD_RELAY_COUNT)) {
        throw new DeviceError('INVALID_ARGUMENT', `relay must be 0..${FUNCTION_CARD_RELAY_COUNT - 1} or "all"`);
      }
      await ctx.delay();
      const written = request.on ? POWER_OPERATE.start : POWER_OPERATE.stop;
      if (request.relay === 'all') totals.set(fc, written);
      else relaysOf(fc)[request.relay] = written;
      return { relay: request.relay, written, readBack: written, verified: true };
    },
    async setPowerControlMode(id, functionCardAddress, mode: PowerControlMode, confirmed) {
      ctx.requireConnected(id);
      const fc = checkAddr(functionCardAddress);
      requireWrite(confirmed, 'Changing the power control mode');
      await ctx.delay();
      modes.set(fc, POWER_CTRL_MODE[mode]);
      return { mode, readBack: POWER_CTRL_MODE[mode], verified: true };
    },
    async readProgramVersions(id, options) {
      ctx.requireConnected(id);
      await ctx.delay();
      const out = {
        sender: { mcu: formatProgramEdition(0x02030400), fpga: formatProgramEdition(0x01000000) },
        receivers: (options?.cards ?? []).map((c) => ({
          portIndex: c.portIndex,
          cardIndex: c.cardIndex,
          mcu: formatProgramEdition(0x01020300),
          fpga: formatProgramEdition(0x01010000),
        })),
      } as Awaited<ReturnType<MaintenanceApi['readProgramVersions']>>;
      if (options?.functionCardAddress !== undefined) {
        out.functionCard = {
          functionCardAddress: checkAddr(options.functionCardAddress),
          mcu: formatProgramEdition(MOCK_MCU),
          fpga: formatProgramEdition(MOCK_FPGA),
          golden: formatProgramEdition(MOCK_FPGA),
        };
      }
      return out;
    },
    async dryRunFirmware(id, request) {
      ctx.requireConnected(id);
      checkAddr(request.functionCardAddress);
      if (!FIRMWARE_TARGETS.includes(request.target)) throw new DeviceError('INVALID_ARGUMENT', 'unknown firmware target');
      await ctx.delay();
      const report = validateFirmwareFile(request.file, request.target);
      const compat: Parameters<typeof checkFirmwareCompatibility>[0] = {
        report,
        device: { modelId: MOCK_MODEL_ID, mcuVersionRaw: MOCK_MCU, fpgaVersionRaw: MOCK_FPGA },
      };
      if (request.declaredVersion !== undefined) compat.declaredVersion = request.declaredVersion;
      if (request.declaredModelId !== undefined) compat.declaredModelId = request.declaredModelId;
      return {
        report,
        compatibility: checkFirmwareCompatibility(compat),
        plan: report.valid ? buildDryRunPlan(report, request.blockSize) : null,
        writesSent: 0,
      };
    },
    async getFirmwareWriteStatus(id) {
      ctx.requireConnected(id);
      return { implemented: false, enabled: false, missing: [...FIRMWARE_WRITE_MISSING] };
    },
    async writeFirmware(id) {
      ctx.requireConnected(id);
      if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'Firmware writing requires the advanced user level');
      throw new DeviceError('PERMISSION', 'Firmware writing is disabled (enableFirmwareWrite is off)');
    },
  };
}
