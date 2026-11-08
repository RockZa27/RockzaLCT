import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GEOMETRY_KEYS,
  INVALID_CELL,
  PIXEL_MAPPING_LIMITS,
  PIXEL_MAPPING_METHODS,
  SMART_SETTINGS_METHODS,
  autoCreate,
  buildFinalImage,
  buildGeometryRegisters,
  clearMarks,
  collectMarking,
  defaultScanSequence,
  emptyMarking,
  encodePointTable,
  encodeScanSequence,
  encodeTotalPoints,
  isMarkingComplete,
  logicalGroupCount,
  markCell,
  markInvalid,
  markingProgress,
  nextStep,
  planPixelMapping,
  undoMark,
  type Cell,
  type MarkingState,
  type PixelMappingInputs,
  type PixelMappingPlan,
} from '@rockzalct/shared';
import { parseRcfgx } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const hex = (b: ArrayLike<number>): string => Buffer.from(Array.from(b)).toString('hex');

/** The spec's worked example (section E): 32 x 16 px, 1/8 scan, 2 data groups, horizontal. */
const EXAMPLE: PixelMappingInputs = { moduleWidth: 32, moduleHeight: 16, scanCount: 8, dataGroups: 2, dataDirection: 0 };

const planOf = (inputs: PixelMappingInputs): PixelMappingPlan => {
  const r = planPixelMapping(inputs);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.plan;
};

/** Mark every step with the cells of the worked example: (0..31, 0) then (0, 1..7). */
const exampleMarks = (): Cell[] => [
  ...Array.from({ length: 32 }, (_, x) => ({ x, y: 0 })),
  ...Array.from({ length: 7 }, (_, i) => ({ x: 0, y: i + 1 })),
];

const mark = (plan: PixelMappingPlan, cells: Cell[], from: MarkingState = emptyMarking()): MarkingState => {
  let s = from;
  for (const c of cells) {
    const r = markCell(plan, s, c);
    if (!r.ok) throw new Error(`mark (${c.x},${c.y}): ${r.reason}`);
    s = r.state;
  }
  return s;
};

describe('worked example (spec section E): 32x16, 1/8 scan, 2 data groups', () => {
  const plan = planOf(EXAMPLE);

  it('derives the spec values', () => {
    expect(plan.totalPoints).toBe(32); // 32*16/(2*8)
    expect(plan.pointsPerDriver).toBe(32);
    expect(plan.scanCount).toBe(8);
    expect(plan.logicalGroups).toBe(8);
    expect(plan.physicalGroups).toBe(2);
    expect(plan.shiftUnit).toBe(32);
    expect(plan.cmax).toBe(0);
    expect(plan.controlWidth).toBe(32);
    expect(plan.controlHeight).toBe(16);
    expect(plan.grid).toEqual({ cols: 32, rows: 8 });
    expect(plan.steps).toHaveLength(32 + 7);
  });

  it('plans the lights: phase A n = 0..31 -> (0..31, 0), phase B n = 32, 64 .. 224 -> (0, 1..7)', () => {
    const a = plan.steps.slice(0, 32);
    expect(a.every((s) => s.phase === 'A' && s.scan === 0 && s.b === 0 && s.c === 0)).toBe(true);
    expect(a.map((s) => s.n)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(a.map((s) => s.pixel)).toEqual(Array.from({ length: 32 }, (_, x) => ({ x, y: 0 })));
    const b = plan.steps.slice(32);
    expect(b.map((s) => s.n)).toEqual([32, 64, 96, 128, 160, 192, 224]);
    expect(b.map((s) => s.pixel)).toEqual(Array.from({ length: 7 }, (_, i) => ({ x: 0, y: i + 1 })));
    expect(b.map((s) => [s.phase, s.scan, s.a, s.b])).toEqual(Array.from({ length: 7 }, (_, i) => ['B', i + 1, 0, i + 1]));
    // black extent (M-1, K-1, N-1) with N = 8 logical groups: n = 2047 -> row 63 -> 64 rows
    expect(plan.window).toEqual({ width: 32, height: 64 });
  });

  it('writes the registers of section E byte for byte, in order', () => {
    const regs = buildGeometryRegisters(plan);
    expect(regs.map((r) => r.key)).toEqual([...GEOMETRY_KEYS]);
    expect(regs.map((r) => [r.key, hex(r.data)])).toEqual([
      ['dataDirection', '00'], // 0x02000009
      ['groupNumInModule', '02'], // 0x02000010
      ['rowsCtrlByDataGroup', '0808080808080808'], // 0x02000047
      ['startPositionOfDataGroup', '0008101820283038'], // 0x02000083
      ['dataGroupSequence', '10325476'], // 0x02000011
      ['controlWidth', '2000'], // 0x02000017
      ['controlHeight', '1000'], // 0x02000019
      ['physicalTotalDataGroupNum', '02'], // 0x0200001B
      ['realPhysicalGroupNum', '02'], // 0x020001D6
      ['totalPointInTable', '2000'], // 0x0200001D
      ['logicShiftUnitNumPerSubField', '2000'], // 0x020000E8
      ['shiftUnitNumPerSubField', '2000'], // 0x02000032
      ['pointNumPerDrive', '2000'], // 0x0200001F
      ['logicalTotalDataGroupNum', '08'], // 0x02000022
      ['smartSetMode', '00'], // 0x02000104
      ['addrExtend', '05'], // 0x020000B5
      ['scanMode', '08'], // 0x0200000D
    ]);
  });

  it('encodes the point table 00 00 01 00 .. 1F 00 and the scan sequence 00..07 from the marks', () => {
    const state = mark(plan, exampleMarks());
    expect(isMarkingComplete(plan, state)).toBe(true);
    const collected = collectMarking(plan, state);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    const image = buildFinalImage(plan, collected.marking);
    expect(image.pointTable).toHaveLength(64);
    expect(hex(image.pointTable)).toBe(Array.from({ length: 32 }, (_, i) => `${i.toString(16).padStart(2, '0')}00`).join(''));
    expect(image.pointTable.subarray(0, 6)).toEqual(Uint8Array.from([0, 0, 1, 0, 2, 0]));
    expect(image.pointTable.subarray(62)).toEqual(Uint8Array.from([0x1f, 0]));
    expect(hex(image.scanSequence)).toBe('0001020304050607');
    expect(collected.marking.ascending).toBe(true);
    expect(image.geometry).toEqual(buildGeometryRegisters(plan));
  });
});

describe('plan: derived values, limits and validation', () => {
  const bad = (over: Partial<PixelMappingInputs>): string => {
    const r = planPixelMapping({ ...EXAMPLE, ...over });
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.errors.join('; ');
  };

  it('accepts the limits: 8 groups, scan 64, 832 entries', () => {
    expect(planPixelMapping({ moduleWidth: 64, moduleHeight: 64, scanCount: 64, dataGroups: 8, dataDirection: 0 }).ok).toBe(true);
    // 832 = 26*32: 52 x 16 px, 1/1 scan, 1 group -> 832 entries
    const edge = planPixelMapping({ moduleWidth: 52, moduleHeight: 16, scanCount: 1, dataGroups: 1, dataDirection: 0 });
    expect(edge.ok && edge.plan.totalPoints).toBe(832);
  });

  it('rejects more than 8 groups, scan above 64, more than 832 entries, bad module sizes and directions', () => {
    expect(bad({ dataGroups: 9 })).toMatch(/dataGroups/);
    expect(bad({ dataGroups: 0 })).toMatch(/dataGroups/);
    expect(bad({ scanCount: 65 })).toMatch(/scanCount/);
    expect(bad({ scanCount: 0 })).toMatch(/scanCount/);
    expect(bad({ moduleWidth: 53, moduleHeight: 16, scanCount: 1, dataGroups: 1 })).toMatch(/832/); // 848 entries
    expect(bad({ moduleWidth: 256 })).toMatch(/moduleWidth/);
    expect(bad({ moduleHeight: 0 })).toMatch(/moduleHeight/);
    expect(bad({ dataDirection: 2 })).toMatch(/dataDirection/);
    expect(bad({ scanCount: 3 })).toMatch(/does not divide/);
    expect(bad({ dataGroups: 3 })).toMatch(/do not divide|does not divide/);
    expect(bad({ lineBias: 256 })).toMatch(/lineBias/);
    expect(bad({ rowsPerGroup: [8] })).toMatch(/rowsPerGroup/);
    expect(bad({ groupSequence: [0, 0] })).toMatch(/groupSequence/);
    expect(bad({ modulesAcross: 0 })).toMatch(/modulesAcross/);
  });

  it('reports every problem at once', () => {
    const r = planPixelMapping({ ...EXAMPLE, dataGroups: 9, scanCount: 65, moduleWidth: 0 });
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('maps physical to logical groups: 1..8 -> 8, 9..16 -> 16, larger clamp to 16, over 64 refused', () => {
    expect([1, 2, 8, 9, 16].map(logicalGroupCount)).toEqual([8, 8, 8, 16, 16]);
    expect([17, 32, 33, 64].map(logicalGroupCount)).toEqual([16, 16, 16, 16]);
    expect(logicalGroupCount(65)).toBeNull();
    expect(logicalGroupCount(0)).toBeNull();
  });

  it('uses the group axis for vertical data: cols = max rows, rows = module height', () => {
    const p = planOf({ moduleWidth: 64, moduleHeight: 128, scanCount: 32, dataGroups: 2, dataDirection: 1 });
    expect(p.totalPoints).toBe(128);
    expect(p.grid).toEqual({ cols: 32, rows: 128 });
    expect(p.rows8).toEqual(Array(8).fill(32));
  });

  it('scales with modules across/down and the cascade direction (spec B1 step 6)', () => {
    const p = planOf({ ...EXAMPLE, modulesAcross: 3, modulesDown: 2 });
    expect([p.controlWidth, p.controlHeight]).toEqual([96, 32]);
    expect(p.physicalGroups).toBe(4); // DG * ModuleRows (horizontal cascade)
    expect(p.shiftUnit).toBe(32 * 3);
    expect(p.pointsPerDriver).toBe(96);
    const v = planOf({ ...EXAMPLE, modulesAcross: 3, modulesDown: 2, cascade: 'vertical' });
    expect(v.physicalGroups).toBe(6);
    expect(v.shiftUnit).toBe(32 * 2);
    const override = planOf({ ...EXAMPLE, pointsPerDriver: 40 });
    expect(override.pointsPerDriver).toBe(40);
    expect(override.shiftUnit).toBe(32);
  });

  it('refuses a plan whose lights would fall outside the control window', () => {
    expect(bad({ pointsPerDriver: 4000 })).toMatch(/outside/);
  });

  it('data group sequence and start positions follow the sequence values', () => {
    const p = planOf({ ...EXAMPLE, groupSequence: [1, 0], rowsPerGroup: [6, 10] });
    // bytes: seq8 = 1,0,2,3,4,5,6,7 -> 01, 32, 54, 76 with nibbles low/high
    expect(hex(p.sequenceBytes)).toBe('013254' + '76');
    expect(p.rows8.slice(0, 2)).toEqual([6, 10]);
    expect(p.start8.slice(0, 2)).toEqual([10, 0]); // group 0 comes after group 1 (10 rows)
    expect(p.cmax).toBe(1);
  });

  it('refuses start positions that do not fit a byte', () => {
    expect(bad({ moduleWidth: 8, moduleHeight: 255, scanCount: 8, dataGroups: 3, rowsPerGroup: [130, 130, 130] })).toMatch(/start position/);
  });

  it('marks the group with the most rows first-max-wins (cmax) and lights inside it', () => {
    const p = planOf({ ...EXAMPLE, rowsPerGroup: [6, 10] });
    expect(p.cmax).toBe(1);
    expect(p.steps[0]).toMatchObject({ a: 0, b: 0, c: 1, n: 256, pixel: { x: 0, y: 8 } });
    expect(p.steps[32]).toMatchObject({ phase: 'B', b: 1, n: 256 + 32, pixel: { x: 0, y: 9 } });
    expect(planOf({ ...EXAMPLE, rowsPerGroup: [8, 8] }).cmax).toBe(0);
  });

  it('exports the method names through the smart settings seam', () => {
    for (const name of Object.keys(PIXEL_MAPPING_METHODS)) expect(SMART_SETTINGS_METHODS).toHaveProperty(name);
  });
});

describe('encoders', () => {
  it('total points: 2 bytes little endian', () => {
    expect(hex(encodeTotalPoints(0x0123))).toBe('2301');
    expect(hex(encodeTotalPoints(0))).toBe('0000');
    expect(hex(encodeTotalPoints(832))).toBe('4003');
    expect(() => encodeTotalPoints(65536)).toThrow(RangeError);
    expect(() => encodeTotalPoints(-1)).toThrow(RangeError);
    expect(() => encodeTotalPoints(1.5)).toThrow(RangeError);
  });

  it('point table: X, Y per entry, invalid = 255,255, max 832 entries', () => {
    expect(hex(encodePointTable([{ x: 1, y: 2 }, INVALID_CELL, { x: 254, y: 254 }]))).toBe('0102ffff' + 'fefe');
    expect(encodePointTable([])).toHaveLength(0);
    expect(encodePointTable(Array.from({ length: 832 }, () => ({ x: 1, y: 1 })))).toHaveLength(PIXEL_MAPPING_LIMITS.tableBytes);
    expect(() => encodePointTable(Array.from({ length: 833 }, () => ({ x: 1, y: 1 })))).toThrow(/832/);
    expect(() => encodePointTable([{ x: 255, y: 3 }])).toThrow(RangeError); // half invalid
    expect(() => encodePointTable([{ x: 3, y: 255 }])).toThrow(RangeError);
    expect(() => encodePointTable([{ x: -1, y: 0 }])).toThrow(RangeError);
    expect(() => encodePointTable([{ x: 0.5, y: 0 }])).toThrow(RangeError);
  });

  it('scan sequence: v[s] = Y (horizontal) or X (vertical) of the first point minus the first, plus the line bias', () => {
    const pts: Cell[] = [{ x: 3, y: 5 }, { x: 9, y: 6 }, { x: 4, y: 9 }];
    expect(hex(encodeScanSequence(pts, 0))).toBe('000104');
    expect(hex(encodeScanSequence(pts, 1))).toBe('00 06 01'.replace(/ /g, ''));
    expect(hex(encodeScanSequence(pts, 0, 10))).toBe('0a0b0e');
    // descending first points: the bias lifts them into range
    const down: Cell[] = [{ x: 0, y: 7 }, { x: 0, y: 6 }, { x: 0, y: 5 }];
    expect(hex(encodeScanSequence(down, 0, 2))).toBe('020100');
    expect(() => encodeScanSequence(down, 0, 0)).toThrow(/outside 0..255/);
    expect(() => encodeScanSequence([{ x: 0, y: 0 }, { x: 0, y: 254 }], 0, 255)).toThrow(/outside 0..255/);
    expect(() => encodeScanSequence([{ x: 0, y: 0 }, INVALID_CELL], 0)).toThrow(/valid cell/);
    expect(() => encodeScanSequence(pts, 0, 256)).toThrow(RangeError);
    expect(encodeScanSequence([{ x: 0, y: 40 }], 0)).toEqual(Uint8Array.from([0]));
  });

  it('scan sequence: the default is 0..N-1 when there are no first points', () => {
    expect(hex(encodeScanSequence(null, 0, 0, 8))).toBe('0001020304050607');
    expect(hex(encodeScanSequence([], 1, 7, 3))).toBe('000102');
    expect(defaultScanSequence(64)).toHaveLength(64);
    expect(() => defaultScanSequence(0)).toThrow(RangeError);
    expect(() => defaultScanSequence(129)).toThrow(RangeError);
  });
});

describe('marking', () => {
  const plan = planOf(EXAMPLE);

  it('asks for one pixel at a time and reports progress', () => {
    let s = emptyMarking();
    expect(nextStep(plan, s)?.index).toBe(0);
    expect(markingProgress(plan, s)).toEqual({ done: 0, total: 39, invalid: 0, current: 1, phase: 'A' });
    s = mark(plan, [{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(nextStep(plan, s)?.index).toBe(2);
    expect(markingProgress(plan, s)).toMatchObject({ done: 2, current: 3, phase: 'A' });
    s = mark(plan, exampleMarks().slice(2, 32), s);
    expect(markingProgress(plan, s)).toMatchObject({ done: 32, phase: 'B' });
    expect(nextStep(plan, s)).toMatchObject({ phase: 'B', scan: 1 });
    s = mark(plan, exampleMarks().slice(32), s);
    expect(nextStep(plan, s)).toBeNull();
    expect(markingProgress(plan, s)).toEqual({ done: 39, total: 39, invalid: 0, current: 39, phase: 'done' });
    expect(markCell(plan, s, { x: 5, y: 5 })).toEqual({ ok: false, reason: 'complete' });
    expect(markInvalid(plan, s)).toEqual({ ok: false, reason: 'complete' });
  });

  it('refuses cells outside the grid and cells already used (first-scan cells included)', () => {
    const s = mark(plan, [{ x: 0, y: 0 }]);
    expect(markCell(plan, s, { x: 0, y: 0 })).toEqual({ ok: false, reason: 'cell-used' });
    expect(markCell(plan, s, { x: 32, y: 0 })).toEqual({ ok: false, reason: 'outside-grid' });
    expect(markCell(plan, s, { x: 0, y: 8 })).toEqual({ ok: false, reason: 'outside-grid' });
    expect(markCell(plan, s, { x: -1, y: 0 })).toEqual({ ok: false, reason: 'outside-grid' });
    expect(markCell(plan, s, { x: 1.5, y: 0 })).toEqual({ ok: false, reason: 'outside-grid' });
    // phase B: a first-scan cell cannot be a scan's first point
    const b = mark(plan, exampleMarks().slice(0, 32));
    expect(markCell(plan, b, { x: 5, y: 0 })).toEqual({ ok: false, reason: 'cell-used' });
    expect(markCell(plan, b, { x: 0, y: 1 }).ok).toBe(true);
  });

  it('undo removes the last mark (and is a no-op rejection when empty); clear starts over', () => {
    const s = mark(plan, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
    const u = undoMark(s);
    expect(u.ok && u.state.marks).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    // the undone cell can be marked again
    expect(u.ok && markCell(plan, u.state, { x: 2, y: 0 }).ok).toBe(true);
    expect(undoMark(emptyMarking())).toEqual({ ok: false, reason: 'nothing-to-undo' });
    expect(clearMarks().marks).toEqual([]);
  });

  it('"no related point" inserts (255, 255) at the current position and counts toward T', () => {
    let s = mark(plan, [{ x: 0, y: 0 }]);
    const r = markInvalid(plan, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    s = r.state;
    expect(s.marks[1]).toEqual(INVALID_CELL);
    expect(markingProgress(plan, s)).toMatchObject({ done: 2, invalid: 1 });
    s = mark(plan, [{ x: 2, y: 0 }], s);
    expect(s.marks).toHaveLength(3);
    // invalid entries do not block cells
    expect(markCell(plan, s, { x: 255, y: 255 })).toEqual({ ok: false, reason: 'outside-grid' });
  });

  describe('auto create', () => {
    it('needs two marks', () => {
      expect(autoCreate(plan, emptyMarking())).toEqual({ ok: false, reason: 'need-two-marks' });
      expect(autoCreate(plan, mark(plan, [{ x: 0, y: 0 }]))).toEqual({ ok: false, reason: 'need-two-marks' });
    });

    it('extends the step of the last two marks until T entries exist', () => {
      const r = autoCreate(plan, mark(plan, [{ x: 0, y: 0 }, { x: 1, y: 0 }]));
      expect(r.ok && r.added).toBe(30);
      expect(r.ok && r.state.marks).toEqual(Array.from({ length: 32 }, (_, x) => ({ x, y: 0 })));
    });

    it('uses a stride and stops at the grid edge', () => {
      const r = autoCreate(plan, mark(plan, [{ x: 0, y: 0 }, { x: 5, y: 0 }]));
      expect(r.ok && r.state.marks.map((m) => m.x)).toEqual([0, 5, 10, 15, 20, 25, 30]);
      expect(r.ok && r.added).toBe(5);
    });

    it('stops at a cell that is already used and adds nothing if the very next cell is used', () => {
      const s = mark(plan, [{ x: 3, y: 0 }, { x: 5, y: 0 }, { x: 4, y: 0 }]);
      expect(autoCreate(plan, s)).toEqual({ ok: false, reason: 'nothing-to-add' }); // next is (3,0)
      const t = mark(plan, [{ x: 4, y: 0 }, { x: 3, y: 1 }, { x: 4, y: 1 }]);
      // delta (+1,0) from (4,1): (5,1) ... runs to the edge, no clash
      const u = autoCreate(plan, t);
      expect(u.ok && u.state.marks.at(-1)).toEqual({ x: 31, y: 1 });
      // the first scan stops growing at T
      const small = planOf({ moduleWidth: 8, moduleHeight: 8, scanCount: 4, dataGroups: 1, dataDirection: 0 }); // T = 16
      const v = autoCreate(small, mark(small, [{ x: 0, y: 0 }, { x: 0, y: 1 }]));
      expect(v.ok && v.state.marks).toHaveLength(8); // grid has 8 rows only
    });

    it('does not run on invalid entries or after the first scan', () => {
      const withInvalid = markInvalid(plan, mark(plan, [{ x: 0, y: 0 }]));
      expect(withInvalid.ok && autoCreate(plan, mark(plan, [{ x: 4, y: 0 }], withInvalid.state))).toEqual({ ok: false, reason: 'last-two-invalid' });
      const a = mark(plan, exampleMarks().slice(0, 32));
      expect(autoCreate(plan, a)).toEqual({ ok: false, reason: 'not-first-scan' });
    });
  });

  describe('collect (spec CheckPointDistribute)', () => {
    it('refuses incomplete marking', () => {
      const r = collectMarking(plan, mark(plan, [{ x: 0, y: 0 }]));
      expect(r).toEqual({ ok: false, errors: ['1 of 39 points are marked'] });
    });

    it('first points must rise or fall steadily along the scan axis', () => {
      const marks = exampleMarks();
      marks[34] = { x: 0, y: 7 }; // scan 3 jumps ahead
      marks[38] = { x: 0, y: 3 };
      const r = collectMarking(plan, marks);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.errors.join()).toMatch(/run line drawing error/);
    });

    it('accepts descending first points and reports the direction', () => {
      const marks = exampleMarks().slice(0, 32);
      // first point (0,0) then 7 scans going up in the grid: y must fall -> start at a lower row
      const p = planOf({ ...EXAMPLE });
      const desc = [...marks.map((m) => ({ x: m.x, y: m.y + 7 })), ...Array.from({ length: 7 }, (_, i) => ({ x: 0, y: 6 - i }))];
      const r = collectMarking(p, desc);
      expect(r.ok && r.marking.ascending).toBe(false);
      expect(r.ok && hex(encodeScanSequence(r.marking.firstPoints, 0, 7))).toBe('07060504030201' + '00');
    });

    it('uses X for vertical data', () => {
      const vp = planOf({ moduleWidth: 8, moduleHeight: 8, scanCount: 2, dataGroups: 1, dataDirection: 1 }); // T = 32, grid 8 x 8
      expect(vp.totalPoints).toBe(32);
      const marks = [...Array.from({ length: 32 }, (_, i) => ({ x: Math.floor(i / 8), y: i % 8 })), { x: 4, y: 0 }];
      // first point of scan 0 is (0,0); scan 1 starts at (4,0) - but (4,0) is a first-scan cell, so use a free one
      marks[32] = { x: 7, y: 0 };
      const r = collectMarking(vp, marks);
      expect(r.ok).toBe(true);
    });

    it('needs a real first point and refuses scans without one', () => {
      const none = Array.from({ length: 32 }, () => INVALID_CELL);
      const r1 = collectMarking(plan, [...none, ...exampleMarks().slice(32)]);
      expect(r1.ok ? '' : r1.errors.join()).toMatch(/no real point/);
      const marks = exampleMarks();
      marks[35] = INVALID_CELL;
      const r2 = collectMarking(plan, marks);
      expect(r2.ok ? '' : r2.errors.join()).toMatch(/scan 5 has no first point/);
    });

    it('refuses a cell marked twice and marks outside the grid when called with raw cells', () => {
      const marks = exampleMarks();
      marks[1] = { x: 0, y: 0 };
      expect((collectMarking(plan, marks) as { errors: string[] }).errors.join()).toMatch(/marked twice/);
      marks[1] = { x: 40, y: 0 };
      expect((collectMarking(plan, marks) as { errors: string[] }).errors.join()).toMatch(/outside the grid/);
      expect(collectMarking(plan, [{ x: 'a', y: 0 } as unknown as Cell]).ok).toBe(false);
    });

    it('invalid entries inside the first scan stay in the table as 255,255 and count toward T', () => {
      const marks = exampleMarks();
      marks[5] = INVALID_CELL;
      const r = collectMarking(plan, marks);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.marking.pointTable).toHaveLength(32);
      expect(hex(encodePointTable(r.marking.pointTable).subarray(8, 14))).toBe('0400' + 'ffff' + '0600');
    });
  });
});

describe('the user\'s own .rcfgx (NV7516 64x128, 2x5 modules)', () => {
  const parsed = parseRcfgx({ name: 'u.rcfgx', bytes: new Uint8Array(readFileSync(join(here, 'fixtures', 'novalct', 'user_NV7516_64x128_2x5.rcfgx'))) });
  const record = (address: number, len: number): Buffer => {
    if (!parsed.ok) throw new Error('fixture does not parse');
    const rec = parsed.parsed.records.find((r) => r.address === address);
    if (!rec) throw new Error(`no record at ${address.toString(16)}`);
    return Buffer.from(rec.data.slice(0, len));
  };

  it('agrees with the model where the spec says the values are chip-independent', () => {
    const p = planOf({ moduleWidth: 64, moduleHeight: 128, scanCount: 32, dataGroups: 2, dataDirection: 1 });
    const block = record(0x02000000, 0x83);
    const regs = Object.fromEntries(buildGeometryRegisters(p).map((r) => [r.key, r.data]));
    expect(hex(regs.dataDirection!)).toBe(hex(block.subarray(0x09, 0x0a)));
    expect(hex(regs.groupNumInModule!)).toBe(hex(block.subarray(0x10, 0x11)));
    expect(hex(regs.dataGroupSequence!)).toBe(hex(block.subarray(0x11, 0x15)));
    expect(hex(regs.rowsCtrlByDataGroup!)).toBe(hex(block.subarray(0x47, 0x4f)));
    expect(hex(regs.scanMode!)).toBe(hex(block.subarray(0x0d, 0x0e)));
    expect(hex(regs.totalPointInTable!)).toBe(hex(block.subarray(0x1d, 0x1f)));
  });

  it('encodes the file\'s point table (x = 0, y = 127 .. 0) from the same marks', () => {
    const file = record(0x03000000, 256);
    const cells = Array.from({ length: 128 }, (_, i) => ({ x: 0, y: 127 - i }));
    expect(hex(encodePointTable(cells))).toBe(hex(file));
    const p = planOf({ moduleWidth: 64, moduleHeight: 128, scanCount: 32, dataGroups: 2, dataDirection: 1 });
    // auto create after two clicks gives the same table
    const auto = autoCreate(p, mark(p, cells.slice(0, 2)));
    expect(auto.ok && hex(encodePointTable(auto.state.marks))).toBe(hex(file));
  });
});
