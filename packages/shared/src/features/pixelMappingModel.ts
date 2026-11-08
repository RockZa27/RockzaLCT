// Pixel mapping ("point table" + "scan sequence") for one receiving card: the pure model.
//
// Source of every rule below: our own spec of NovaLCT's Smart Settings behaviour (sections B1, B4, C
// and E of smartsetting-spec.md; summarised in docs/novalct-protocol-notes.md Q8). No NovaLCT code
// is used. This is the 3rd-generation path only (chip not flagged IsCabinetToolChip): the module
// point table goes to the receiving card at 0x03000000 and the scan sequence to 0x1C000100. The
// 4th-generation run-line tables (0x04000000, 4 byte entries) are NOT covered.
//
// How it works: the point table is not computed from the answers, it is recorded from the operator.
// The card is made to light one table position at a time (one pixel of the PC picture that feeds the
// sender), the operator looks at the real module and clicks the cell of the grid where the LED lit.
// This file turns the inputs into that marking plan, validates the clicks and encodes the bytes.
// Chip timing / OE / gamma / driver registers are NOT part of it ("geometry only"): the card keeps
// whatever it holds now.
//
// Keep this file free of runtime deps (it is bundled into the renderer as well).

// ---------------------------------------------------------------------------------------------
// Limits (spec B1 step 4/6, B4, C "Bounds from user answers")

export const PIXEL_MAPPING_LIMITS = {
  /** "Max 8 groups else error" (B1 step 4). */
  dataGroups: { min: 1, max: 8 },
  /** ScanType max 64 (B1 step 6); the scan sequence register holds 128 bytes. */
  scanCount: { min: 1, max: 64 },
  /** 0x03000000 holds 1664 bytes = 832 entries of (X, Y) (B4). */
  maxEntries: 832,
  tableBytes: 1664,
  /** 0x1C000100, up to 128 bytes, one per scan line (B4). */
  scanSequenceBytes: 128,
  /** Cell coordinates fit one byte and 255 is reserved for "invalid" (C). */
  maxCoordinate: 254,
  /** Modules per cabinet in either direction (counts, 1 byte registers downstream). */
  moduleCount: { min: 1, max: 16 },
  /** The module itself: 1 byte per axis, 255 is reserved for "invalid" (C). */
  moduleSize: { min: 1, max: 255 },
  /** LineBias is added to a byte. */
  lineBias: { min: 0, max: 255 },
} as const;

/** Value NovaLCT writes to AddrExtend (0x020000B5) at the end of the smart-type step (B1 step 6, E). */
export const ADDR_EXTEND_VALUE = 5;

// ---------------------------------------------------------------------------------------------
// Types

/** One cell of the marking grid = one table entry (module-local X, Y). */
export interface Cell {
  x: number;
  y: number;
}

/** "No related point" entry: 255, 255 (B4). */
export const INVALID_CELL: Readonly<Cell> = { x: 255, y: 255 };
export const isInvalidCell = (c: Cell): boolean => c.x === 255 && c.y === 255;

export type CascadeDirection = 'horizontal' | 'vertical';

export interface PixelMappingInputs {
  /** Pixels of ONE module. */
  moduleWidth: number;
  moduleHeight: number;
  /** K: scan count (1 = static, 8 = 1/8 scan ...). */
  scanCount: number;
  /** Data groups of one module (1..8). */
  dataGroups: number;
  /** DataDirectionType: 0 = horizontal, 1 = vertical. */
  dataDirection: number;
  /** M: points per driver (PointNumPerDrive). Default: the shift unit (= table entries x modules in the cascade). */
  pointsPerDriver?: number;
  /** Modules of the card across / down (ModuleCols / ModuleRows). Default 1 x 1. */
  modulesAcross?: number;
  modulesDown?: number;
  /** Direction the modules are cascaded in: horizontal = left-right (default). Decides the physical group count and the shift unit. */
  cascade?: CascadeDirection;
  /** RowsCtrlByDataGroup: rows (or columns for vertical) of each data group. Default: even split. */
  rowsPerGroup?: readonly number[];
  /** DataGroupSequence: a permutation of 0..dataGroups-1. Default 0..N-1. */
  groupSequence?: readonly number[];
  /** LineBias added to the scan sequence. Default 0. */
  lineBias?: number;
}

/** One register image of the plan; the device layer maps `key` to an address. */
export interface RegisterImage {
  key: GeometryKey;
  data: Uint8Array;
}

/** Chip-independent geometry registers, in the order they are written (B1 steps 4-6, E). */
export const GEOMETRY_KEYS = [
  'dataDirection',
  'groupNumInModule',
  'rowsCtrlByDataGroup',
  'startPositionOfDataGroup',
  'dataGroupSequence',
  'controlWidth',
  'controlHeight',
  'physicalTotalDataGroupNum',
  'realPhysicalGroupNum',
  'totalPointInTable',
  'logicShiftUnitNumPerSubField',
  'shiftUnitNumPerSubField',
  'pointNumPerDrive',
  'logicalTotalDataGroupNum',
  // "SendEndSmartSetType":
  'smartSetMode',
  'addrExtend',
  'scanMode',
] as const;
export type GeometryKey = (typeof GEOMETRY_KEYS)[number];

export interface MarkingStep {
  /** Position in the plan = index of the mark it expects. */
  index: number;
  /** A: the T points of the first scan. B: the first point of each other scan. */
  phase: 'A' | 'B';
  /** For phase B the scan (1..K-1) whose first point is asked; 0 for phase A. */
  scan: number;
  a: number;
  b: number;
  c: number;
  /** n = K*M*c + M*b + a */
  n: number;
  /** The pixel of the picture to light, relative to the card's control window: (n mod W, n div W). */
  pixel: Cell;
}

export interface PixelMappingPlan {
  inputs: Required<Omit<PixelMappingInputs, 'rowsPerGroup' | 'groupSequence'>> & { rowsPerGroup: readonly number[]; groupSequence: readonly number[] };
  /** T: table entries (OneScanDistributeCount). */
  totalPoints: number;
  /** M: points per driver. */
  pointsPerDriver: number;
  /** K. */
  scanCount: number;
  /** N: logical data group count (the register value). */
  logicalGroups: number;
  physicalGroups: number;
  shiftUnit: number;
  /** Index of the group with the most rows (first maximum wins). */
  cmax: number;
  controlWidth: number;
  controlHeight: number;
  /** Marking grid size: horizontal = ModulePixelCols x max(rows); vertical = max(rows) x ModulePixelRows. */
  grid: { cols: number; rows: number };
  /** Size of the picture window to draw: ControlWidth x (pixel row of the last conceivable light + 1). */
  window: { width: number; height: number };
  steps: readonly MarkingStep[];
  /** The 8 byte entries written for RowsCtrlByDataGroup / StartPositionOfDataGroup, and the 4 nibble bytes. */
  rows8: readonly number[];
  start8: readonly number[];
  sequenceBytes: readonly number[];
}

export type PixelMappingPlanResult = { ok: true; plan: PixelMappingPlan } | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------------------------
// Helpers

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const inRange = (v: unknown, r: { readonly min: number; readonly max: number }): v is number => isInt(v) && v >= r.min && v <= r.max;

const u16 = (v: number): Uint8Array => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]);
const u8 = (v: number): Uint8Array => Uint8Array.from([v & 0xff]);

/** Physical -> logical data group count (spec D1, concurrent/parallel drive) and the legacy wizard's clamp to 16 (>= 17). */
export function logicalGroupCount(physical: number): number | null {
  if (!isInt(physical) || physical < 1) return null;
  const logical = physical <= 8 ? 8 : physical <= 16 ? 16 : physical <= 32 ? 32 : physical <= 64 ? 64 : null;
  if (logical === null) return null;
  return logical >= 17 ? 16 : logical;
}

// ---------------------------------------------------------------------------------------------
// Plan

/**
 * Validate the inputs and compute the plan: derived register values, the marking grid and the list of
 * pixels to light. All errors are returned together (never partial).
 */
export function planPixelMapping(inputs: PixelMappingInputs): PixelMappingPlanResult {
  const errors: string[] = [];
  const L = PIXEL_MAPPING_LIMITS;
  if (typeof inputs !== 'object' || inputs === null) return { ok: false, errors: ['inputs must be an object'] };

  if (!inRange(inputs.moduleWidth, L.moduleSize)) errors.push(`moduleWidth must be an integer ${L.moduleSize.min}..${L.moduleSize.max}`);
  if (!inRange(inputs.moduleHeight, L.moduleSize)) errors.push(`moduleHeight must be an integer ${L.moduleSize.min}..${L.moduleSize.max}`);
  if (!inRange(inputs.scanCount, L.scanCount)) errors.push(`scanCount must be an integer ${L.scanCount.min}..${L.scanCount.max}`);
  if (!inRange(inputs.dataGroups, L.dataGroups)) errors.push(`dataGroups must be an integer ${L.dataGroups.min}..${L.dataGroups.max}`);
  if (inputs.dataDirection !== 0 && inputs.dataDirection !== 1) errors.push('dataDirection must be 0 (horizontal) or 1 (vertical)');
  const across = inputs.modulesAcross ?? 1;
  const down = inputs.modulesDown ?? 1;
  if (!inRange(across, L.moduleCount)) errors.push(`modulesAcross must be an integer ${L.moduleCount.min}..${L.moduleCount.max}`);
  if (!inRange(down, L.moduleCount)) errors.push(`modulesDown must be an integer ${L.moduleCount.min}..${L.moduleCount.max}`);
  const cascade = inputs.cascade ?? 'horizontal';
  if (cascade !== 'horizontal' && cascade !== 'vertical') errors.push("cascade must be 'horizontal' or 'vertical'");
  const lineBias = inputs.lineBias ?? 0;
  if (!inRange(lineBias, L.lineBias)) errors.push(`lineBias must be an integer ${L.lineBias.min}..${L.lineBias.max}`);
  if (errors.length > 0) return { ok: false, errors };

  const W = inputs.moduleWidth;
  const H = inputs.moduleHeight;
  const K = inputs.scanCount;
  const DG = inputs.dataGroups;
  const vertical = inputs.dataDirection === 1;

  // T = Cols*Rows / (DataGroup*Scan) for a normal module
  const area = W * H;
  if (area % (DG * K) !== 0) errors.push(`module ${W} x ${H} does not divide into ${DG} data group(s) x ${K} scan lines`);
  const T = Math.floor(area / (DG * K));
  if (T < 1) errors.push('the module has no points per scan line');
  if (T > L.maxEntries) errors.push(`${T} table entries exceed the limit of ${L.maxEntries}`);

  // rows (or columns when vertical) per data group
  const axis = vertical ? W : H;
  let rows: number[];
  if (inputs.rowsPerGroup !== undefined) {
    rows = [...inputs.rowsPerGroup];
    if (rows.length !== DG || !rows.every((r) => inRange(r, { min: 1, max: 255 }))) errors.push(`rowsPerGroup must list ${DG} integers 1..255`);
  } else {
    if (axis % DG !== 0) errors.push(`${axis} ${vertical ? 'columns' : 'rows'} do not divide evenly into ${DG} data groups; give rowsPerGroup`);
    rows = new Array<number>(DG).fill(Math.floor(axis / DG));
  }

  // DataGroupSequence
  let seq: number[];
  if (inputs.groupSequence !== undefined) {
    seq = [...inputs.groupSequence];
    const perm = seq.length === DG && new Set(seq).size === DG && seq.every((s) => inRange(s, { min: 0, max: DG - 1 }));
    if (!perm) errors.push(`groupSequence must be a permutation of 0..${DG - 1}`);
  } else {
    seq = Array.from({ length: DG }, (_, i) => i);
  }
  if (errors.length > 0) return { ok: false, errors };

  // 8 entry images. Unused entries (>= DG) follow the NovaLCT default: the same rows as the first
  // group and the running start position (E: 08 x8 and 00 08 10 .. 38). Their values are not used
  // by the card (GroupNumInModule says how many groups exist).
  const rows8 = Array.from({ length: 8 }, (_, i) => (i < DG ? rows[i]! : rows[0]!));
  const seq8 = Array.from({ length: 8 }, (_, i) => (i < DG ? seq[i]! : i));
  const start8 = rows8.map((_, i) => rows8.reduce((sum, r, j) => (seq8[j]! < seq8[i]! ? sum + r : sum), 0));
  // Used entries must fit a byte. Unused ones wrap like a byte cast would (not used by the card).
  for (let i = 0; i < DG; i += 1) {
    if (start8[i]! > 255) errors.push(`start position of group ${i} (${start8[i]}) does not fit one byte`);
  }
  const startBytes = start8.map((s) => s & 0xff);

  const shiftCount = cascade === 'horizontal' ? across : down;
  const shiftUnit = T * shiftCount;
  const M = inputs.pointsPerDriver ?? shiftUnit;
  if (!inRange(M, { min: 1, max: 0xffff })) errors.push('pointsPerDriver must be an integer 1..65535');
  if (shiftUnit > 0xffff) errors.push(`shift unit ${shiftUnit} does not fit 2 bytes`);
  const physical = cascade === 'horizontal' ? DG * down : DG * across;
  const logical = logicalGroupCount(physical);
  if (logical === null) errors.push(`${physical} physical data groups are not supported (max 64)`);
  if (physical > 255) errors.push('physical data groups do not fit one byte');

  const controlWidth = W * across;
  const controlHeight = H * down;
  if (controlWidth > 0xffff || controlHeight > 0xffff) errors.push('control size does not fit 2 bytes');

  const cols = vertical ? Math.max(...rows) : W;
  const gridRows = vertical ? H : Math.max(...rows);
  if (cols > 255 || gridRows > 255) errors.push('the marking grid is larger than 255 cells');
  if (T > cols * gridRows) errors.push(`${T} points do not fit the ${cols} x ${gridRows} grid`);
  if (errors.length > 0 || logical === null) return { ok: false, errors };

  // c with the largest number of rows; the first maximum wins
  const cmax = rows.indexOf(Math.max(...rows));

  const steps: MarkingStep[] = [];
  const pushStep = (phase: 'A' | 'B', scan: number, a: number, b: number): void => {
    const n = K * M * cmax + M * b + a;
    steps.push({ index: steps.length, phase, scan, a, b, c: cmax, n, pixel: { x: n % controlWidth, y: Math.floor(n / controlWidth) } });
  };
  for (let k = 0; k < T; k += 1) pushStep('A', 0, k, 0);
  for (let s = 1; s < K; s += 1) pushStep('B', s, 0, s);

  const blackMax = K * M * (logical - 1) + M * (K - 1) + (M - 1);
  const window = { width: controlWidth, height: Math.floor(blackMax / controlWidth) + 1 };
  const maxStepY = Math.max(...steps.map((s) => s.pixel.y));
  if (maxStepY >= controlHeight) errors.push(`a marking light would fall outside the ${controlWidth} x ${controlHeight} control window (row ${maxStepY}); check points per driver and rows per group`);
  if (window.height > 0xffff) errors.push('the picture window is too tall');
  if (errors.length > 0) return { ok: false, errors };

  const sequenceBytes = [0, 1, 2, 3].map((i) => (seq8[2 * i]! | (seq8[2 * i + 1]! << 4)) & 0xff);

  return {
    ok: true,
    plan: {
      inputs: {
        moduleWidth: W,
        moduleHeight: H,
        scanCount: K,
        dataGroups: DG,
        dataDirection: inputs.dataDirection,
        pointsPerDriver: M,
        modulesAcross: across,
        modulesDown: down,
        cascade,
        rowsPerGroup: rows,
        groupSequence: seq,
        lineBias,
      },
      totalPoints: T,
      pointsPerDriver: M,
      scanCount: K,
      logicalGroups: logical,
      physicalGroups: physical,
      shiftUnit,
      cmax,
      controlWidth,
      controlHeight,
      grid: { cols, rows: gridRows },
      window,
      steps,
      rows8,
      start8: startBytes,
      sequenceBytes,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Encoders

/** TotalPointInTable (0x0200001D): 2 bytes little endian. */
export function encodeTotalPoints(total: number): Uint8Array {
  if (!inRange(total, { min: 0, max: 0xffff })) throw new RangeError(`total points must be an integer 0..65535, got ${String(total)}`);
  return u16(total);
}

/**
 * The module point table (0x03000000): X byte, Y byte per entry; (255, 255) = unused entry.
 * Rejects more than 832 entries, a half-invalid entry and coordinates above 254.
 */
export function encodePointTable(points: readonly Cell[]): Uint8Array {
  if (points.length > PIXEL_MAPPING_LIMITS.maxEntries) throw new RangeError(`${points.length} entries exceed the limit of ${PIXEL_MAPPING_LIMITS.maxEntries}`);
  const out = new Uint8Array(points.length * 2);
  points.forEach((p, i) => {
    const invalid = isInvalidCell(p);
    if (!invalid && (!inRange(p.x, { min: 0, max: PIXEL_MAPPING_LIMITS.maxCoordinate }) || !inRange(p.y, { min: 0, max: PIXEL_MAPPING_LIMITS.maxCoordinate }))) {
      throw new RangeError(`entry ${i} (${String(p.x)}, ${String(p.y)}) is neither a cell 0..${PIXEL_MAPPING_LIMITS.maxCoordinate} nor the invalid entry (255, 255)`);
    }
    out[2 * i] = p.x;
    out[2 * i + 1] = p.y;
  });
  return out;
}

/** Default scan sequence when no usable first points exist: 0, 1 .. N-1. */
export function defaultScanSequence(scanCount: number): Uint8Array {
  if (!inRange(scanCount, { min: 1, max: PIXEL_MAPPING_LIMITS.scanSequenceBytes })) throw new RangeError('scanCount must be an integer 1..128');
  return Uint8Array.from({ length: scanCount }, (_, i) => i);
}

/**
 * The scan sequence (0x1C000100), one byte per scan line: v[s] = Y of the first point of scan s
 * (horizontal) or X (vertical); then v[s] = v[s] - v[0] + lineBias. With no first points the default
 * 0..N-1 is returned (spec B4). A result outside 0..255 is an error, not a wrap.
 */
export function encodeScanSequence(firstPoints: readonly Cell[] | null, dataDirection: number, lineBias = 0, scanCount?: number): Uint8Array {
  if (firstPoints === null || firstPoints.length === 0) return defaultScanSequence(scanCount ?? 1);
  if (firstPoints.length > PIXEL_MAPPING_LIMITS.scanSequenceBytes) throw new RangeError('more than 128 scan lines');
  if (!inRange(lineBias, PIXEL_MAPPING_LIMITS.lineBias)) throw new RangeError('lineBias must be an integer 0..255');
  const axisOf = (c: Cell): number => (dataDirection === 1 ? c.x : c.y);
  firstPoints.forEach((c, i) => {
    if (isInvalidCell(c) || !inRange(c.x, { min: 0, max: PIXEL_MAPPING_LIMITS.maxCoordinate }) || !inRange(c.y, { min: 0, max: PIXEL_MAPPING_LIMITS.maxCoordinate })) {
      throw new RangeError(`first point of scan ${i} is not a valid cell`);
    }
  });
  const base = axisOf(firstPoints[0]!);
  const out = new Uint8Array(firstPoints.length);
  firstPoints.forEach((c, s) => {
    const v = axisOf(c) - base + lineBias;
    if (v < 0 || v > 255) throw new RangeError(`scan sequence value ${v} for scan ${s} is outside 0..255; adjust the line bias`);
    out[s] = v;
  });
  return out;
}

/** The chip-independent geometry registers for a plan, in write order (see GEOMETRY_KEYS). */
export function buildGeometryRegisters(plan: PixelMappingPlan): RegisterImage[] {
  const i = plan.inputs;
  const values: Record<GeometryKey, Uint8Array> = {
    dataDirection: u8(i.dataDirection),
    groupNumInModule: u8(i.dataGroups),
    rowsCtrlByDataGroup: Uint8Array.from(plan.rows8),
    startPositionOfDataGroup: Uint8Array.from(plan.start8),
    dataGroupSequence: Uint8Array.from(plan.sequenceBytes),
    controlWidth: u16(plan.controlWidth),
    controlHeight: u16(plan.controlHeight),
    physicalTotalDataGroupNum: u8(plan.physicalGroups),
    realPhysicalGroupNum: u8(plan.physicalGroups),
    totalPointInTable: encodeTotalPoints(plan.totalPoints),
    logicShiftUnitNumPerSubField: u16(plan.totalPoints),
    shiftUnitNumPerSubField: u16(plan.shiftUnit),
    pointNumPerDrive: u16(plan.pointsPerDriver),
    logicalTotalDataGroupNum: u8(plan.logicalGroups),
    smartSetMode: u8(0),
    addrExtend: u8(ADDR_EXTEND_VALUE),
    scanMode: u8(plan.scanCount),
  };
  return GEOMETRY_KEYS.map((key) => ({ key, data: values[key] }));
}

// ---------------------------------------------------------------------------------------------
// Marking

/** The marks made so far; marks[i] answers plan.steps[i]. */
export interface MarkingState {
  readonly marks: readonly Cell[];
}

export const emptyMarking = (): MarkingState => ({ marks: [] });

export type MarkRejection = 'complete' | 'outside-grid' | 'cell-used' | 'need-two-marks' | 'not-first-scan' | 'last-two-invalid' | 'nothing-to-add' | 'nothing-to-undo';

export type MarkingChange = { ok: true; state: MarkingState; added?: number } | { ok: false; reason: MarkRejection };

export const isMarkingComplete = (plan: PixelMappingPlan, s: MarkingState): boolean => s.marks.length >= plan.steps.length;

/** The step to light next, or null when everything is marked. */
export const nextStep = (plan: PixelMappingPlan, s: MarkingState): MarkingStep | null => plan.steps[s.marks.length] ?? null;

const same = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;
const insideGrid = (plan: PixelMappingPlan, c: Cell): boolean => isInt(c.x) && isInt(c.y) && c.x >= 0 && c.y >= 0 && c.x < plan.grid.cols && c.y < plan.grid.rows;
const used = (s: MarkingState, c: Cell): boolean => s.marks.some((m) => !isInvalidCell(m) && same(m, c));

/**
 * Mark the cell for the current step. A cell can be used only once (first scan cells and earlier
 * first points included).
 */
export function markCell(plan: PixelMappingPlan, s: MarkingState, cell: Cell): MarkingChange {
  if (isMarkingComplete(plan, s)) return { ok: false, reason: 'complete' };
  if (!insideGrid(plan, cell)) return { ok: false, reason: 'outside-grid' };
  if (used(s, cell)) return { ok: false, reason: 'cell-used' };
  return { ok: true, state: { marks: [...s.marks, { x: cell.x, y: cell.y }] } };
}

/** "No related point" / "no related scan": an invalid (255, 255) entry at the current position. */
export function markInvalid(plan: PixelMappingPlan, s: MarkingState): MarkingChange {
  if (isMarkingComplete(plan, s)) return { ok: false, reason: 'complete' };
  return { ok: true, state: { marks: [...s.marks, { ...INVALID_CELL }] } };
}

export function undoMark(s: MarkingState): MarkingChange {
  if (s.marks.length === 0) return { ok: false, reason: 'nothing-to-undo' };
  return { ok: true, state: { marks: s.marks.slice(0, -1) } };
}

export const clearMarks = (): MarkingState => emptyMarking();

/**
 * "Auto create": needs two marks (both real cells) in the first scan; repeats the step between the
 * last two marks until the first scan has T entries. Stops at the grid edge or at a cell already used.
 */
export function autoCreate(plan: PixelMappingPlan, s: MarkingState): MarkingChange {
  if (s.marks.length >= plan.totalPoints) return { ok: false, reason: 'not-first-scan' };
  if (s.marks.length < 2) return { ok: false, reason: 'need-two-marks' };
  const last = s.marks[s.marks.length - 1]!;
  const prev = s.marks[s.marks.length - 2]!;
  if (isInvalidCell(last) || isInvalidCell(prev)) return { ok: false, reason: 'last-two-invalid' };
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const marks = [...s.marks];
  let cur = last;
  let added = 0;
  while (marks.length < plan.totalPoints) {
    const next = { x: cur.x + dx, y: cur.y + dy };
    if (!insideGrid(plan, next) || marks.some((m) => !isInvalidCell(m) && same(m, next))) break;
    marks.push(next);
    cur = next;
    added += 1;
  }
  if (added === 0) return { ok: false, reason: 'nothing-to-add' };
  return { ok: true, state: { marks }, added };
}

export interface MarkingProgress {
  /** Marks made (valid and invalid). */
  done: number;
  total: number;
  invalid: number;
  /** 1-based number of the step being asked, capped at total. */
  current: number;
  phase: 'A' | 'B' | 'done';
}

export function markingProgress(plan: PixelMappingPlan, s: MarkingState): MarkingProgress {
  const next = nextStep(plan, s);
  return {
    done: s.marks.length,
    total: plan.steps.length,
    invalid: s.marks.filter(isInvalidCell).length,
    current: Math.min(s.marks.length + 1, plan.steps.length),
    phase: next ? next.phase : 'done',
  };
}

export interface CollectedMarking {
  /** The T table entries (invalid ones as 255, 255). */
  pointTable: Cell[];
  /** First point of every scan: [first valid table entry, marks of scans 1..K-1]. */
  firstPoints: Cell[];
  /** True when the first points rise along the scan axis, false when they fall. */
  ascending: boolean;
}

export type CollectResult = { ok: true; marking: CollectedMarking } | { ok: false; errors: string[] };

/**
 * Turn finished marks into the table and the first points, with the spec's checks: everything is
 * marked, a first-scan point exists, every scan has a real first point and the first points are
 * strictly monotonic along the scan axis (Y for horizontal data, X for vertical).
 */
export function collectMarking(plan: PixelMappingPlan, s: MarkingState | readonly Cell[]): CollectResult {
  const marks = Array.isArray(s) ? (s as readonly Cell[]) : (s as MarkingState).marks;
  const errors: string[] = [];
  if (marks.length !== plan.steps.length) return { ok: false, errors: [`${marks.length} of ${plan.steps.length} points are marked`] };
  const T = plan.totalPoints;
  for (const [i, m] of marks.entries()) {
    const bad = typeof m !== 'object' || m === null || !isInt(m.x) || !isInt(m.y);
    if (bad || (!isInvalidCell(m) && !insideGrid(plan, m))) errors.push(`mark ${i + 1} is outside the grid`);
  }
  if (errors.length > 0) return { ok: false, errors };
  // each real cell once
  const seen = new Set<string>();
  for (const m of marks) {
    if (isInvalidCell(m)) continue;
    const k = `${m.x},${m.y}`;
    if (seen.has(k)) errors.push(`cell (${m.x}, ${m.y}) is marked twice`);
    seen.add(k);
  }
  const pointTable = marks.slice(0, T).map((m) => ({ x: m.x, y: m.y }));
  const firstValid = pointTable.find((p) => !isInvalidCell(p));
  if (!firstValid) errors.push('the first scan has no real point');
  const others = marks.slice(T).map((m) => ({ x: m.x, y: m.y }));
  others.forEach((c, i) => {
    if (isInvalidCell(c)) errors.push(`scan ${i + 2} has no first point; scans without a related point are not supported here, use a NovaLCT configuration file`);
  });
  if (errors.length > 0 || !firstValid) return { ok: false, errors };
  const firstPoints = [firstValid, ...others];
  const axis = (c: Cell): number => (plan.inputs.dataDirection === 1 ? c.x : c.y);
  let ascending = true;
  if (firstPoints.length > 1) {
    const diffs = firstPoints.slice(1).map((c, i) => axis(c) - axis(firstPoints[i]!));
    const up = diffs.every((d) => d > 0);
    const down = diffs.every((d) => d < 0);
    if (!up && !down) errors.push('run line drawing error: the first points of the scan lines must rise or fall steadily');
    ascending = up || !down;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, marking: { pointTable, firstPoints, ascending } };
}

/** Everything the final write sends besides the registers of `buildGeometryRegisters`. */
export interface FinalImage {
  geometry: RegisterImage[];
  pointTable: Uint8Array;
  scanSequence: Uint8Array;
}

/** Encode the final image from a plan and finished marks. Throws RangeError on values that do not fit. */
export function buildFinalImage(plan: PixelMappingPlan, marking: CollectedMarking): FinalImage {
  return {
    geometry: buildGeometryRegisters(plan),
    pointTable: encodePointTable(marking.pointTable),
    scanSequence: encodeScanSequence(marking.firstPoints, plan.inputs.dataDirection, plan.inputs.lineBias, plan.scanCount),
  };
}
