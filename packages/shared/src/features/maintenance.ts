// PLAN.md phase 9: function card (power relays) & firmware tools. Owned by the maintenance feature.
//
// Every register number below was read from @novastar/native@2.5.1 dist/AddressMapping.mjs and the
// generated dist/api/<Name>.mjs named next to it. Firmware WRITING is deliberately not implemented
// (see FIRMWARE_WRITE_MISSING): the library has no complete, unambiguous program-loading sequence.

// ---------------------------------------------------------------------------------------------
// Function card (multi-function card)
// ---------------------------------------------------------------------------------------------

/** dist/AddressMapping.mjs FuncCard_PowerPortCtrlNum = 8 (also FuncCard_OperPowerNum = 8). */
export const FUNCTION_CARD_RELAY_COUNT = 8;

/**
 * dist/PowerOperateType.mjs (decompiled Nova.LCT.GigabitSystem.ProtocolEnum:2037):
 * Start = 0, Stop = 1. The generated setters FuncCard_SetPowerPortCtrl / FuncCard_SetPowerPortCtrlTotal
 * are typed with this enum (FuncCard_SetPowerPortCtrl-Cit_E8l-.d.mts). Whether Start means "relay
 * closed / output powered" is the natural reading but is NOT stated by the library.
 */
export const POWER_OPERATE = { start: 0, stop: 1 } as const;

/** dist/PowerCtrlMode.mjs (ProtocolEnum:2048): Mannual = 0, Auto = 1. */
export const POWER_CTRL_MODE = { manual: 0, auto: 1 } as const;
export type PowerControlMode = keyof typeof POWER_CTRL_MODE;

/** 'start'/'stop' when the raw byte equals a PowerOperateType value; 'unknown' otherwise. */
export type RelayState = 'start' | 'stop' | 'unknown';

export function relayStateFromRaw(raw: number): RelayState {
  if (raw === POWER_OPERATE.start) return 'start';
  if (raw === POWER_OPERATE.stop) return 'stop';
  return 'unknown';
}

export interface RelayReading {
  /** 0-based relay index (FuncCard_ReadPowerPortCtrl powerIndex). */
  index: number;
  /** Raw byte read at FuncCard_PowerPortCtrlAddr + index. */
  raw: number;
  /**
   * `raw` read through PowerOperateType. UNVERIFIED on hardware: the library types the setter with
   * that enum but documents no enum for the read value.
   */
  state: RelayState;
}

export interface FunctionCardSchedule {
  relay: number;
  /** [hour, minute, second] as stored (FuncCard_OpenTimeHourIndex..SecondIndex = 0..2). */
  open: [number, number, number];
  /** FuncCard_CloseTimeHourIndex..SecondIndex = 3..5. */
  close: [number, number, number];
}

export interface FunctionCardInfo {
  functionCardAddress: number;
  /** FuncCard_ReadFuncCardModle, 2 bytes @ 2. Raw id: the library has no model-name table. */
  modelId: number;
  /** FuncCard_ReadFuncCardMCUVersion, 4 bytes @ 0x02000004 (33554436), formatted like other editions. */
  mcuVersion: string;
  mcuVersionRaw: number;
  /** FuncCard_ReadFuncCardFPGAVersion, 4 bytes @ 0x01000004 (16777220). */
  fpgaVersion: string;
  fpgaVersionRaw: number;
  /** FuncCard_ReadGoldenFPGAVersion, 4 bytes @ 4. */
  goldenFpgaVersion: string;
  goldenFpgaVersionRaw: number;
  /** FuncCard_ReadTimeOnFuncCard, 7 bytes @ 0x05000000 (year, month, day, weekday, hour, minute, second). */
  clock: { year: number; month: number; day: number; weekday: number; hour: number; minute: number; second: number };
}

export interface RelayStatus {
  functionCardAddress: number;
  relays: RelayReading[];
  /** FuncCard_ReadPowerPortCtrlTotal, 1 byte @ 0x05000062 (83886178). */
  total: { raw: number; state: RelayState };
  /** FuncCard_ReadPowerCtrlMode, 1 byte @ 0x05000060 (83886176); null when the value is not 0/1. */
  mode: PowerControlMode | null;
  modeRaw: number;
  /** FuncCard_ReadPowerOperTime, 48 bytes @ 0x05000020 (83886112), 8 x (open hms, close hms). */
  schedule: FunctionCardSchedule[];
}

export interface SetRelayRequest {
  /** 0..7, or 'all' to use the single "total" register. */
  relay: number | 'all';
  /** true = PowerOperateType.Start, false = Stop. */
  on: boolean;
  /** Must be exactly true: the caller has shown the "turning off will black out the screen" warning. */
  confirmed: boolean;
}

export interface SetRelayResult {
  relay: number | 'all';
  written: number;
  /** Raw byte read back from the same register after the write (null when the read failed). */
  readBack: number | null;
  /** readBack === written. false/null means the card did not echo the value; check the hardware. */
  verified: boolean;
}

export interface SetPowerModeResult {
  mode: PowerControlMode;
  readBack: number | null;
  verified: boolean;
}

// ---------------------------------------------------------------------------------------------
// Firmware: versions
// ---------------------------------------------------------------------------------------------

export interface ProgramVersions {
  sender: { mcu: string | null; fpga: string | null };
  /** Same order as the request's `cards`; null fields when that read failed. */
  receivers: { portIndex: number; cardIndex: number; mcu: string | null; fpga: string | null; error?: string }[];
  /** Present only when a function card address was given. */
  functionCard?: { functionCardAddress: number; mcu: string | null; fpga: string | null; golden: string | null };
}

export interface ReadProgramVersionsOptions {
  /** Receiving cards to read (same shape as ControllerInfo.receivingCards). */
  cards?: { portIndex: number; cardIndex: number }[];
  functionCardAddress?: number;
}

// ---------------------------------------------------------------------------------------------
// Firmware: file validation, compatibility and dry run (all pure; nothing here touches a device)
// ---------------------------------------------------------------------------------------------

/**
 * What the file is meant for. Only the function card FPGA has a data-write function in the library
 * (FuncCard_SetFPGAData); the others are listed so a wrong choice is reported, not silently accepted.
 */
export type FirmwareTarget =
  | 'function-card-fpga'
  | 'function-card-mcu'
  | 'sender-mcu'
  | 'sender-fpga'
  | 'receiver-mcu'
  | 'receiver-fpga';

export const FIRMWARE_TARGETS: readonly FirmwareTarget[] = [
  'function-card-fpga',
  'function-card-mcu',
  'sender-mcu',
  'sender-fpga',
  'receiver-mcu',
  'receiver-fpga',
];

/**
 * Register layout for the function card, from dist/AddressMapping.mjs (FuncCard_*), and the
 * generated setters in dist/api/FuncCard_Set*.mjs.
 */
export const FUNCTION_CARD_PROGRAM = {
  fpga: {
    /** FuncCard_FPGALengthAddr = 16777216 (u32 LE). Same base the FuncCard_SetFPGAData request uses: `address = 16777216 + offset`. */
    lengthAddress: 16777216,
    /** FuncCard_FPGAVersionAddr = 16777220 (u32 LE). */
    versionAddress: 16777220,
    /** FuncCard_FPGADescriptionAddr = 16777224, FuncCard_FPGADescriptionnOccupancy = 248. */
    descriptionAddress: 16777224,
    descriptionLength: 248,
    /** FuncCard_FPGADataAddr = 16777472. */
    dataAddress: 16777472,
    /** Next region start (FuncCard_MCUProgramLengthAddr = 33554432) bounds the data area. */
    nextRegionAddress: 33554432,
  },
  mcu: {
    /** FuncCard_MCUProgramLengthAddr = 33554432. */
    lengthAddress: 33554432,
    /** FuncCard_MCUVersionAddr = 33554436. */
    versionAddress: 33554436,
    /** FuncCard_MCUDescriptionAddr = 33554440, FuncCard_MCUDescriptionOccupancy = 248. */
    descriptionAddress: 33554440,
    descriptionLength: 248,
    /** FuncCard_MCUDataAddr = 33554688. */
    dataAddress: 33554688,
    /** FuncCard_RebootBootFpgaProgramAddr = 50331648 follows the MCU data region. */
    nextRegionAddress: 50331648,
  },
} as const;

/** Largest image that fits between the data address and the next register region (address arithmetic only). */
export function firmwareCapacity(target: 'function-card-fpga' | 'function-card-mcu'): number {
  const r = target === 'function-card-fpga' ? FUNCTION_CARD_PROGRAM.fpga : FUNCTION_CARD_PROGRAM.mcu;
  return r.nextRegionAddress - r.dataAddress;
}

/** Why a firmware write is not offered. Shown verbatim in the UI and returned by getFirmwareWriteStatus. */
export const FIRMWARE_WRITE_MISSING: readonly string[] = [
  'No erase command: no function in @novastar/native dist/api erases the function card FPGA/MCU program area (the only *Erase* functions are for module/coefficient flash: SetCoefficientInSpiFlashErase, SetCoefficientInIIcFlashErase, SetBrightDarkLineCoefsErase, SetLowlumCoefficientErase).',
  'No block size: FuncCard_SetFPGAData takes an arbitrary Buffer and offset; AddressMapping defines no block/page size (the codec Request.makeChunks default of 256 is a transport splitter, not a firmware property).',
  'No MCU data write: AddressMapping has FuncCard_MCUDataAddr (33554688) but there is no FuncCard_SetMCUData function (only FuncCard_SetFPGAData exists).',
  'No sender or receiving card program write: Set*_McuProgram*/Set*_FPGAProgram* only write length/edition/info/remarks metadata; ReadScanerBurningProgramPackage is read-only.',
  'No verify-by-readback: there is no FuncCard_ReadFPGAData/ReadMCUData, so a written block cannot be read back and compared.',
  'No file format: the library defines no firmware file header, checksum or CRC, so the target, length and version cannot be derived from a file.',
  'Ambiguous sequence: the meaning of the "funcCardModle" argument of FuncCard_SetStoreFpgaAppProgram / SetStoreFpgaBootProgram / SetRebootAppFpgaProgram / SetRebootBootFpgaProgram, the (portAddr, funcCardAddr) arguments of FuncCard_SetFPGAData, and whether its offset starts at 0 (base 16777216) or at the data address (16777472) are undocumented.',
];

export interface FirmwareFileInput {
  name: string;
  bytes: Uint8Array;
}

export type FirmwareFormat = 'intel-hex' | 'binary' | 'empty';

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface FirmwareFinding {
  severity: FindingSeverity;
  /** Stable machine id (tests, i18n). */
  code: string;
  message: string;
}

export interface FirmwareFileReport {
  name: string;
  size: number;
  target: FirmwareTarget;
  /** Heuristic only: the library defines no firmware file format. */
  format: FirmwareFormat;
  /** Largest image the target region can hold; null when the target has no known region. */
  capacity: number | null;
  /** No error finding. Says nothing about whether writing is possible. */
  valid: boolean;
  findings: FirmwareFinding[];
}

const finding = (severity: FindingSeverity, code: string, message: string): FirmwareFinding => ({ severity, code, message });

/** Verify one Intel HEX record line (standard format: sum of all bytes incl. checksum is 0 mod 256). */
function intelHexLineOk(line: string): boolean {
  if (!/^:[0-9A-Fa-f]+$/.test(line) || line.length < 11 || line.length % 2 === 0) return false;
  const bytes: number[] = [];
  for (let i = 1; i < line.length; i += 2) bytes.push(parseInt(line.slice(i, i + 2), 16));
  if (bytes[0] !== bytes.length - 5) return false;
  return bytes.reduce((a, b) => a + b, 0) % 256 === 0;
}

/** Detect Intel HEX text: every non-empty line must be a valid record. Returns the first bad line number or 0. */
function checkIntelHex(bytes: Uint8Array): { isHex: boolean; badLine: number } {
  if (bytes.length === 0 || bytes[0] !== 0x3a) return { isHex: false, badLine: 0 };
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i]!;
    if (b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09)) return { isHex: false, badLine: 0 };
    text += String.fromCharCode(b);
  }
  const lines = text.split(/\r?\n/);
  let bad = 0;
  let sawEof = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || bad !== 0) return;
    if (!intelHexLineOk(line)) bad = i + 1;
    else if (line.slice(7, 9) === '01') sawEof = true;
  });
  if (bad === 0 && !sawEof) bad = lines.length;
  return { isHex: true, badLine: bad };
}

const EXTENSION_HINTS: Record<string, 'fpga' | 'mcu'> = {
  rbf: 'fpga',
  bit: 'fpga',
  mcs: 'fpga',
  hex: 'mcu',
};

/**
 * Validate a user-provided firmware file for a target. Checks only what can be derived without
 * inventing a format: emptiness, size against the register region (address arithmetic), 32-bit
 * length field, uniform content, and Intel HEX record checksums (a public standard, used purely to
 * spot corruption; the library does not say the device wants HEX).
 */
export function validateFirmwareFile(file: FirmwareFileInput, target: FirmwareTarget): FirmwareFileReport {
  const findings: FirmwareFinding[] = [];
  const size = file.bytes.length;
  const capacity = target === 'function-card-fpga' || target === 'function-card-mcu' ? firmwareCapacity(target) : null;
  let format: FirmwareFormat = 'binary';

  if (!FIRMWARE_TARGETS.includes(target)) {
    findings.push(finding('error', 'unknown-target', `Unknown target "${String(target)}"`));
  }
  if (size === 0) {
    format = 'empty';
    findings.push(finding('error', 'empty', 'The file is empty'));
  } else {
    const hex = checkIntelHex(file.bytes);
    if (hex.isHex) {
      format = 'intel-hex';
      if (hex.badLine !== 0) {
        findings.push(finding('error', 'hex-corrupt', `Intel HEX record on line ${hex.badLine} is malformed, has a bad checksum, or the end-of-file record is missing`));
      } else {
        findings.push(finding('warning', 'hex-unspecified', 'Intel HEX text detected. The library does not say whether the card expects HEX text or the decoded image; the dry run counts the raw file bytes'));
      }
    }
    let uniform = true;
    for (let i = 1; i < size; i += 1) {
      if (file.bytes[i] !== file.bytes[0]) {
        uniform = false;
        break;
      }
    }
    if (uniform && size > 1) {
      findings.push(finding('error', 'uniform', `Every byte is 0x${file.bytes[0]!.toString(16).padStart(2, '0')}: this is not a program image`));
    }
  }
  if (size > 0xffffffff) {
    findings.push(finding('error', 'length-field', 'Larger than the 32-bit length register (FuncCard_Set*Length is 4 bytes)'));
  }
  if (capacity !== null && size > capacity) {
    findings.push(finding('error', 'too-large', `${size} bytes does not fit the ${capacity}-byte region of ${target}`));
  }
  if (capacity === null && FIRMWARE_TARGETS.includes(target)) {
    findings.push(finding('info', 'no-region', 'The library defines no program data region for this target, so size cannot be checked'));
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase();
  const hint = ext ? EXTENSION_HINTS[ext] : undefined;
  if (hint !== undefined) {
    const wants = target.endsWith('fpga') ? 'fpga' : 'mcu';
    if (hint !== wants) {
      findings.push(finding('warning', 'extension-mismatch', `The .${ext} extension usually means an ${hint.toUpperCase()} image but the target is ${target} (file-name convention, not defined by the library)`));
    }
  }
  return {
    name: file.name,
    size,
    target,
    format,
    capacity,
    valid: !findings.some((f) => f.severity === 'error'),
    findings,
  };
}

export interface DeviceProgramState {
  /** FuncCard_ReadFuncCardModle. */
  modelId: number;
  mcuVersionRaw: number;
  fpgaVersionRaw: number;
}

export interface CompatibilityInput {
  report: FirmwareFileReport;
  device: DeviceProgramState | null;
  /** Version the user says the file contains (u32, as written to FuncCard_Set*Version). The file does not carry it. */
  declaredVersion?: number;
  /** Model id the user says the file is for (u16, the "funcCardModle" argument). The file does not carry it. */
  declaredModelId?: number;
}

export interface CompatibilityResult {
  /** No blocking finding. */
  compatible: boolean;
  findings: FirmwareFinding[];
  versionComparison: 'newer' | 'same' | 'older' | 'unknown';
}

/** Target type vs. selected card, plus version comparison. Pure. */
export function checkFirmwareCompatibility(input: CompatibilityInput): CompatibilityResult {
  const { report, device } = input;
  const findings: FirmwareFinding[] = [];
  if (!report.valid) findings.push(finding('error', 'file-invalid', 'The file failed validation'));
  if (report.target.startsWith('sender') || report.target.startsWith('receiver')) {
    findings.push(finding('error', 'no-program-api', `The library has no program-data function for ${report.target}; only the function card FPGA has a data writer`));
  } else if (report.target === 'function-card-mcu') {
    findings.push(finding('error', 'no-mcu-data-api', 'The library has FuncCard_SetFuncCardMCULength/Version/Description but no function that writes MCU program data'));
  }
  if (device === null) {
    findings.push(finding('error', 'no-device-state', 'Current versions could not be read from the selected card'));
  }
  if (input.declaredModelId !== undefined && device !== null && input.declaredModelId !== device.modelId) {
    findings.push(finding('error', 'model-mismatch', `File is declared for model 0x${input.declaredModelId.toString(16)} but the card reports 0x${device.modelId.toString(16)}`));
  } else if (input.declaredModelId === undefined) {
    findings.push(finding('warning', 'model-unchecked', 'The file carries no library-defined model id; enter the model it was built for to check it against the card'));
  }
  let versionComparison: CompatibilityResult['versionComparison'] = 'unknown';
  if (input.declaredVersion !== undefined && device !== null) {
    const current = (report.target === 'function-card-mcu' ? device.mcuVersionRaw : device.fpgaVersionRaw) >>> 0;
    const next = input.declaredVersion >>> 0;
    versionComparison = next > current ? 'newer' : next === current ? 'same' : 'older';
    if (versionComparison === 'older') findings.push(finding('warning', 'downgrade', 'The declared version is older than the installed one (downgrade)'));
    if (versionComparison === 'same') findings.push(finding('warning', 'same-version', 'The declared version equals the installed one'));
  } else {
    findings.push(finding('warning', 'version-unchecked', 'No version declared, so it cannot be compared with the installed one'));
  }
  return { compatible: !findings.some((f) => f.severity === 'error'), findings, versionComparison };
}

export interface DryRunBlock {
  index: number;
  /** Offset passed to FuncCard_SetFPGAData(..., data, offset). */
  offset: number;
  /** Register address the request would carry: 16777216 + offset (FuncCard_SetFPGAData.mjs). */
  address: number;
  length: number;
}

export interface DryRunStep {
  /** Native function that would be called. */
  call: string;
  address: number;
  length: number;
  note: string;
}

export interface DryRunPlan {
  target: FirmwareTarget;
  fileSize: number;
  blockSize: number;
  /** Where blockSize came from: always the caller (nothing in the library defines it). */
  blockSizeSource: 'user';
  blockCount: number;
  /** Metadata writes, in the order the library's setters suggest. */
  steps: DryRunStep[];
  /** First and last three blocks (the whole list can be tens of thousands). */
  blockSample: DryRunBlock[];
  /** Always false: the library lacks the pieces listed in `blockers`. */
  executable: false;
  blockers: string[];
  /** Always 0: building this plan sends nothing. */
  requestsSent: 0;
}

export const DEFAULT_DRY_RUN_BLOCK_SIZE = 256;

/**
 * Compute the write plan that FuncCard_SetFPGAData would need for this image, without sending
 * anything. Returns null when the target has no data-write function at all. The plan is
 * informational: `executable` is always false.
 */
export function buildDryRunPlan(report: FirmwareFileReport, blockSize: number = DEFAULT_DRY_RUN_BLOCK_SIZE): DryRunPlan | null {
  if (report.target !== 'function-card-fpga' || !report.valid) return null;
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 65535) {
    throw new RangeError('blockSize must be an integer 1..65535');
  }
  const r = FUNCTION_CARD_PROGRAM.fpga;
  const baseOffset = r.dataAddress - r.lengthAddress; // 256 if the offset is relative to 16777216
  const blockCount = Math.ceil(report.size / blockSize);
  const block = (i: number): DryRunBlock => {
    const offset = baseOffset + i * blockSize;
    return { index: i, offset, address: r.lengthAddress + offset, length: Math.min(blockSize, report.size - i * blockSize) };
  };
  const indexes = new Set<number>();
  for (let i = 0; i < Math.min(3, blockCount); i += 1) indexes.add(i);
  for (let i = Math.max(0, blockCount - 3); i < blockCount; i += 1) indexes.add(i);
  return {
    target: report.target,
    fileSize: report.size,
    blockSize,
    blockSizeSource: 'user',
    blockCount,
    steps: [
      { call: 'FuncCard_SetFuncCardFPGALength', address: r.lengthAddress, length: 4, note: `u32 LE = ${report.size}` },
      { call: 'FuncCard_SetFuncCardFPGAVersion', address: r.versionAddress, length: 4, note: 'u32 LE, only if a version is declared' },
      { call: 'FuncCard_SetFPGAData', address: r.lengthAddress + baseOffset, length: report.size, note: `${blockCount} request(s) of up to ${blockSize} bytes; first offset ${baseOffset} assumes the offset is relative to ${r.lengthAddress}, not ${r.dataAddress} (undocumented)` },
    ],
    blockSample: [...indexes].sort((a, b) => a - b).map(block),
    executable: false,
    blockers: [...FIRMWARE_WRITE_MISSING],
    requestsSent: 0,
  };
}

export interface DryRunRequest {
  functionCardAddress: number;
  target: FirmwareTarget;
  file: FirmwareFileInput;
  declaredVersion?: number;
  declaredModelId?: number;
  blockSize?: number;
}

export interface DryRunResult {
  report: FirmwareFileReport;
  compatibility: CompatibilityResult;
  plan: DryRunPlan | null;
  /** Always 0 writes; reads are the version reads needed for the compatibility check. */
  writesSent: 0;
}

export interface FirmwareWriteStatus {
  /** false: nothing in this build can write a program. */
  implemented: false;
  /** The `enableFirmwareWrite` option as configured (default false). */
  enabled: boolean;
  missing: string[];
}

export interface FirmwareWriteRequest {
  functionCardAddress: number;
  target: FirmwareTarget;
  file: FirmwareFileInput;
  /** Card position the user typed to confirm, e.g. "fc:3". Reserved for when writing exists. */
  typedConfirmation?: string;
}

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export interface MaintenanceApi {
  /** Reads only. Model id, program versions and clock of the function card at bus address `functionCardAddress` (0..255, user supplied). */
  readFunctionCardInfo(id: string, functionCardAddress: number): Promise<FunctionCardInfo>;
  /** Reads only: 8 relay bytes, the total relay byte, control mode and the 48-byte schedule. */
  readRelayStatus(id: string, functionCardAddress: number): Promise<RelayStatus>;
  /** Advanced level + `confirmed: true`. Switches one relay or all (the "total" register), then reads the register back. */
  setRelay(id: string, functionCardAddress: number, request: SetRelayRequest): Promise<SetRelayResult>;
  /** Advanced level + `confirmed: true`. Manual/Auto power control mode. */
  setPowerControlMode(id: string, functionCardAddress: number, mode: PowerControlMode, confirmed: boolean): Promise<SetPowerModeResult>;
  /** Reads only: MCU/FPGA editions of the sender, the listed receiving cards and optionally a function card. */
  readProgramVersions(id: string, options?: ReadProgramVersionsOptions): Promise<ProgramVersions>;
  /** Reads versions, validates the file, checks compatibility and builds the write plan. Sends no write. */
  dryRunFirmware(id: string, request: DryRunRequest): Promise<DryRunResult>;
  /** Always `implemented: false` with the list of what the library lacks. */
  getFirmwareWriteStatus(id: string): Promise<FirmwareWriteStatus>;
  /** Always refuses (zero requests): PERMISSION below advanced level or while `enableFirmwareWrite` is off, PROTOCOL otherwise. */
  writeFirmware(id: string, request: FirmwareWriteRequest): Promise<never>;
}

/** Every MaintenanceApi method name; typed so a missing/extra name is a compile error. */
export const MAINTENANCE_METHODS: { [K in keyof MaintenanceApi]-?: true } = {
  readFunctionCardInfo: true,
  readRelayStatus: true,
  setRelay: true,
  setPowerControlMode: true,
  readProgramVersions: true,
  dryRunFirmware: true,
  getFirmwareWriteStatus: true,
  writeFirmware: true,
};

/** Same text as the other features' edition formatting (a.b.c, plus .d when non-zero). */
export function formatProgramEdition(edition: number): string {
  const v = edition >>> 0;
  const base = `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`;
  return (v & 0xff) === 0 ? base : `${base}.${v & 0xff}`;
}
