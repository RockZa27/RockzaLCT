import { describe, expect, it } from 'vitest';
import {
  LAYOUT_DEFAULT_PORT_CAPACITY,
  WIRING_PATTERNS,
  WIRING_PATTERN_HW_ID,
  appendCabinet,
  autoWire,
  autoWireByCapacity,
  cabinetKey,
  cabinetRect,
  clearLayoutPort,
  computeCardPlacements,
  computeLayoutPortLoads,
  computePortRegions,
  createLayoutScreen,
  generateChain,
  inferLayout,
  isComplexLayoutScreen,
  layoutHasErrors,
  layoutScreenBounds,
  parseLayoutModel,
  planLayoutWrite,
  pruneChains,
  regionOfScreen,
  resizeLayoutScreen,
  rewireChain,
  setCabinetSize,
  toggleCabinet,
  validateLayout,
  type CabinetRef,
  type LayoutIssueCode,
  type LayoutModel,
  type PortChain,
  type WiringPattern,
} from '@rockzalct/shared';

const keys = (cs: CabinetRef[]): string[] => cs.map(cabinetKey);
const codes = (m: LayoutModel, o?: Parameters<typeof validateLayout>[1]): LayoutIssueCode[] =>
  validateLayout(m, o).map((i) => i.code);
const model = (rows: number, cols: number, ports: PortChain[], w = 100, h = 50): LayoutModel => ({
  screen: createLayoutScreen(rows, cols, w, h),
  ports,
});

describe('wiring patterns', () => {
  const region = { row0: 0, col0: 0, row1: 2, col1: 3 }; // 3 rows x 4 cols

  it('has the 8 NovaLCT patterns with ids 0..7 (ScanBoardConnectTypeEnum)', () => {
    expect(WIRING_PATTERNS).toHaveLength(8);
    expect(WIRING_PATTERNS.map((p) => WIRING_PATTERN_HW_ID[p])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // hand-written expectations for a 3 x 4 block ("r,c")
  const expected: Record<WiringPattern, string[]> = {
    'left-top-horizontal': ['0,0', '0,1', '0,2', '0,3', '1,3', '1,2', '1,1', '1,0', '2,0', '2,1', '2,2', '2,3'],
    'right-top-horizontal': ['0,3', '0,2', '0,1', '0,0', '1,0', '1,1', '1,2', '1,3', '2,3', '2,2', '2,1', '2,0'],
    'left-bottom-horizontal': ['2,0', '2,1', '2,2', '2,3', '1,3', '1,2', '1,1', '1,0', '0,0', '0,1', '0,2', '0,3'],
    'right-bottom-horizontal': ['2,3', '2,2', '2,1', '2,0', '1,0', '1,1', '1,2', '1,3', '0,3', '0,2', '0,1', '0,0'],
    'left-top-vertical': ['0,0', '1,0', '2,0', '2,1', '1,1', '0,1', '0,2', '1,2', '2,2', '2,3', '1,3', '0,3'],
    'left-bottom-vertical': ['2,0', '1,0', '0,0', '0,1', '1,1', '2,1', '2,2', '1,2', '0,2', '0,3', '1,3', '2,3'],
    'right-top-vertical': ['0,3', '1,3', '2,3', '2,2', '1,2', '0,2', '0,1', '1,1', '2,1', '2,0', '1,0', '0,0'],
    'right-bottom-vertical': ['2,3', '1,3', '0,3', '0,2', '1,2', '2,2', '2,1', '1,1', '0,1', '0,0', '1,0', '2,0'],
  };

  for (const p of WIRING_PATTERNS) {
    it(`${p}: exact serpentine order`, () => {
      expect(keys(generateChain(p, region))).toEqual(expected[p]);
    });
    it(`${p}: visits every cabinet once, each step moves to a neighbour`, () => {
      const chain = generateChain(p, { row0: 1, col0: 2, row1: 4, col1: 6 });
      expect(new Set(keys(chain)).size).toBe(20);
      for (let i = 1; i < chain.length; i += 1) {
        const d = Math.abs(chain[i]!.row - chain[i - 1]!.row) + Math.abs(chain[i]!.col - chain[i - 1]!.col);
        expect(d).toBe(1);
      }
    });
  }

  it('handles 1xN, Nx1, 1x1 and empty regions', () => {
    expect(keys(generateChain('left-top-horizontal', { row0: 0, col0: 0, row1: 0, col1: 2 }))).toEqual(['0,0', '0,1', '0,2']);
    expect(keys(generateChain('left-top-vertical', { row0: 0, col0: 0, row1: 0, col1: 2 }))).toEqual(['0,0', '0,1', '0,2']);
    expect(keys(generateChain('right-bottom-vertical', { row0: 0, col0: 0, row1: 2, col1: 0 }))).toEqual(['2,0', '1,0', '0,0']);
    expect(generateChain('left-top-horizontal', { row0: 0, col0: 0, row1: 0, col1: 0 })).toHaveLength(1);
    expect(generateChain('left-top-horizontal', { row0: 2, col0: 0, row1: 1, col1: 0 })).toEqual([]);
  });

  it('rewireChain re-routes a full rectangle and refuses a ragged chain', () => {
    const chain = generateChain('left-top-horizontal', region);
    expect(keys(rewireChain('right-bottom-vertical', chain)!)).toEqual(expected['right-bottom-vertical']);
    expect(rewireChain('left-top-horizontal', chain.slice(0, 5))).toBeNull();
    expect(rewireChain('left-top-horizontal', [])).toEqual([]);
  });
});

describe('screen geometry', () => {
  it('standard screen: rect = col*w,row*h', () => {
    const s = createLayoutScreen(3, 4, 128, 64);
    expect(cabinetRect(s, 2, 3)).toEqual({ x: 384, y: 128, width: 128, height: 64 });
    expect(layoutScreenBounds(s)).toEqual({ x: 0, y: 0, width: 512, height: 192 });
  });

  it('complex screen: per-cabinet size shifts neighbours in its row and column', () => {
    const s = setCabinetSize(createLayoutScreen(2, 3, 100, 50), 0, 1, 160, 50);
    expect(s.kind).toBe('complex');
    expect(isComplexLayoutScreen(s)).toBe(true);
    expect(cabinetRect(s, 0, 2)).toMatchObject({ x: 260, y: 0 });
    expect(cabinetRect(s, 1, 2)).toMatchObject({ x: 200, y: 50 }); // other rows unaffected
    // setting a cabinet back to the default size removes the override
    expect(setCabinetSize(s, 0, 1, 100, 50).overrides).toEqual([]);
  });

  it('resizeLayoutScreen drops overrides outside the new grid; pruneChains drops stale cabinets', () => {
    const s = setCabinetSize(createLayoutScreen(3, 3, 10, 10), 2, 2, 20, 20);
    const small = resizeLayoutScreen(s, { rows: 2, cols: 2 });
    expect(small.overrides).toEqual([]);
    const pruned = pruneChains(small, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 2, col: 2 }] }]);
    expect(keys(pruned[0]!.cabinets)).toEqual(['0,0']);
  });
});

describe('autoWire', () => {
  const screen = createLayoutScreen(4, 6, 100, 50);

  it('splits rows into even bands, one chain per port, using the pattern', () => {
    const ports = autoWire(screen, { pattern: 'left-top-horizontal', ports: 2, split: 'rows' });
    expect(ports.map((p) => p.port)).toEqual([0, 1]);
    expect(ports.map((p) => p.cabinets.length)).toEqual([12, 12]);
    expect(keys(ports[1]!.cabinets).slice(0, 3)).toEqual(['2,0', '2,1', '2,2']);
    expect(layoutHasErrors(validateLayout({ screen, ports }))).toBe(false);
  });

  it('uneven split gives the earlier ports the extra line; more ports than lines is capped', () => {
    const three = autoWire(screen, { pattern: 'left-top-vertical', ports: 3, split: 'columns' });
    expect(three.map((p) => p.cabinets.length)).toEqual([8, 8, 8]);
    const five = autoWire(createLayoutScreen(4, 6, 1, 1), { pattern: 'left-top-vertical', ports: 4, split: 'columns', firstPort: 2 });
    expect(five.map((p) => p.port)).toEqual([2, 3, 4, 5]);
    expect(five.map((p) => p.cabinets.length)).toEqual([8, 8, 4, 4]);
    expect(autoWire(createLayoutScreen(2, 2, 1, 1), { pattern: 'left-top-horizontal', ports: 10, split: 'rows' })).toHaveLength(2);
  });

  it('autoWireByCapacity packs whole rows under the limit', () => {
    // 4 rows x 6 cols of 100x50 = 30 000 px per row
    const ports = autoWireByCapacity(screen, { pattern: 'left-top-horizontal', capacity: 65_000, split: 'rows' });
    expect(ports.map((p) => p.cabinets.length)).toEqual([12, 12]);
    const tight = autoWireByCapacity(screen, { pattern: 'left-top-horizontal', capacity: 29_999, split: 'rows' });
    expect(tight).toHaveLength(4); // one row alone already exceeds -> still one port per row
    expect(codes({ screen, ports: tight }, { portCapacity: 29_999 })).toContain('port-over-capacity');
    expect(autoWireByCapacity(screen, { pattern: 'left-top-horizontal', capacity: 1e9, split: 'columns' })).toHaveLength(1);
  });

  it('returns nothing for an empty grid', () => {
    expect(autoWire(createLayoutScreen(0, 3, 1, 1), { pattern: 'left-top-horizontal', ports: 2, split: 'rows' })).toEqual([]);
  });
});

describe('manual wiring helpers', () => {
  const a = { row: 0, col: 0 };
  const b = { row: 0, col: 1 };
  const c = { row: 1, col: 0 };

  it('appends in click order, creating the port', () => {
    let ports: PortChain[] = [];
    ports = toggleCabinet(ports, 1, a);
    ports = toggleCabinet(ports, 1, b);
    expect(ports).toEqual([{ port: 1, cabinets: [a, b] }]);
  });

  it('clicking the last cabinet undoes it; an earlier one truncates after it', () => {
    let ports: PortChain[] = [{ port: 0, cabinets: [a, b, c] }];
    ports = toggleCabinet(ports, 0, a);
    expect(ports[0]!.cabinets).toEqual([a]);
    ports = toggleCabinet(ports, 0, a);
    expect(ports[0]!.cabinets).toEqual([]);
  });

  it('a cabinet of another port moves to the active port (never on two chains)', () => {
    const start: PortChain[] = [{ port: 0, cabinets: [a, b] }];
    const moved = toggleCabinet(start, 2, b);
    expect(moved).toEqual([
      { port: 0, cabinets: [a] },
      { port: 2, cabinets: [b] },
    ]);
    expect(appendCabinet(moved, 0, b).flatMap((p) => p.cabinets)).toHaveLength(2);
    expect(clearLayoutPort(moved, 0)[0]!.cabinets).toEqual([]);
  });
});

describe('validateLayout', () => {
  const ok = (): LayoutModel => model(2, 2, autoWire(createLayoutScreen(2, 2, 100, 50), { pattern: 'left-top-horizontal', ports: 2, split: 'rows' }));

  it('accepts a complete wiring', () => {
    expect(validateLayout(ok())).toEqual([]);
  });

  it('flags a cabinet that is on no port (gap) and names it', () => {
    const m = model(2, 2, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }] }]);
    const issues = validateLayout(m);
    expect(issues).toEqual([{ code: 'cabinet-unassigned', severity: 'error', cabinet: { row: 1, col: 0 } }]);
  });

  it('flags a cabinet on two ports and twice on one port', () => {
    const m = ok();
    m.ports[1]!.cabinets.push({ row: 0, col: 0 }, { row: 0, col: 0 });
    const dups = validateLayout(m).filter((i) => i.code === 'cabinet-duplicate');
    expect(dups).toHaveLength(2);
    expect(dups[0]).toMatchObject({ port: 1, params: { firstPort: 0 } });
  });

  it('flags out-of-range cabinets', () => {
    const m = ok();
    m.ports[0]!.cabinets.push({ row: 5, col: 0 }, { row: -1, col: 0 });
    expect(codes(m).filter((c) => c === 'cabinet-out-of-range')).toHaveLength(2);
  });

  it('enforces the port pixel capacity parameter (default 650 000)', () => {
    const big = model(1, 4, [{ port: 0, cabinets: generateChain('left-top-horizontal', { row0: 0, col0: 0, row1: 0, col1: 3 }) }], 410, 410);
    expect(LAYOUT_DEFAULT_PORT_CAPACITY).toBe(650_000);
    const issue = validateLayout(big).find((i) => i.code === 'port-over-capacity');
    expect(issue).toMatchObject({ severity: 'error', port: 0, params: { pixels: 672_400, capacity: 650_000 } });
  });

  it('capacity is a parameter: exactly at the limit passes, one pixel over fails', () => {
    const m = model(1, 2, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }], 10, 10);
    expect(codes(m, { portCapacity: 200 })).toEqual([]);
    expect(codes(m, { portCapacity: 199 })).toEqual(['port-over-capacity']);
  });

  it('flags bad port indices, too-high ports and too-long chains', () => {
    const m = ok();
    m.ports[1]!.port = 0;
    expect(codes(m)).toContain('port-invalid');
    const high = ok();
    high.ports[1]!.port = 9;
    expect(codes(high, { maxPorts: 4 })).toContain('port-invalid');
    expect(codes(ok(), { maxCardsPerPort: 1 })).toEqual(['port-too-many-cards', 'port-too-many-cards']);
    const neg = ok();
    neg.ports[0]!.port = -1;
    expect(codes(neg)).toContain('port-invalid');
  });

  it('warns (not errors) when consecutive cabinets of a chain do not touch', () => {
    const m = model(2, 3, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 2 }, { row: 0, col: 1 }] }, { port: 1, cabinets: generateChain('left-top-horizontal', { row0: 1, col0: 0, row1: 1, col1: 2 }) }]);
    const issues = validateLayout(m);
    expect(issues).toEqual([{ code: 'chain-not-adjacent', severity: 'warning', port: 0, cabinet: { row: 0, col: 2 } }]);
    expect(layoutHasErrors(issues)).toBe(false);
    // diagonal neighbours do not count as touching
    const diag = model(2, 2, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 1, col: 1 }, { row: 0, col: 1 }, { row: 1, col: 0 }] }]);
    expect(codes(diag).filter((c) => c === 'chain-not-adjacent')).toHaveLength(2);
  });

  it('rejects bad screen sizes and empty wiring', () => {
    for (const bad of [{ rows: 0 }, { cols: -1 }, { cabinetWidth: 1.5 }, { cabinetHeight: Number.NaN }]) {
      const m = ok();
      Object.assign(m.screen, bad);
      expect(codes(m)).toEqual(['screen-size']);
    }
    expect(codes(model(2, 2, []))).toEqual(['no-ports']);
    expect(codes(model(2, 2, [{ port: 0, cabinets: [] }]))).toEqual(['no-ports']);
  });

  it('rejects screens beyond the 32767 px register limit', () => {
    const wide = model(1, 2, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }], 16_384, 1);
    expect(codes(wide)).toEqual(['screen-too-large']);
    const edge = model(1, 2, [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }], 16_383, 1);
    expect(codes(edge)).toEqual([]);
  });

  describe('complex screens', () => {
    const wired = (screen: LayoutModel['screen']): LayoutModel => ({
      screen,
      ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 1, split: 'rows' }),
    });

    it('detects overlapping rectangles created by inconsistent sizes', () => {
      // (1,0) becomes 50 wide, so (1,1) starts at x=50; (0,1) is only 40 tall, so (1,1) starts at y=40
      // and its rectangle [50,150)x[40,90) cuts into (0,0) = [0,100)x[0,50).
      let v = createLayoutScreen(2, 2, 100, 50);
      v = setCabinetSize(v, 1, 0, 50, 50);
      v = setCabinetSize(v, 0, 1, 100, 40);
      const found = validateLayout(wired(v)).filter((i) => i.code === 'overlap');
      expect(found).toEqual([{ code: 'overlap', severity: 'error', cabinet: { row: 0, col: 0 }, other: { row: 1, col: 1 } }]);
    });

    it('a consistent complex screen (taller cabinet in a row) has no overlap', () => {
      const t = setCabinetSize(createLayoutScreen(2, 2, 100, 50), 0, 0, 100, 80);
      expect(layoutHasErrors(validateLayout(wired(t)))).toBe(false);
    });

    it('warns about uncovered area (gaps)', () => {
      let s = createLayoutScreen(2, 2, 100, 50);
      s = setCabinetSize(s, 0, 0, 100, 30); // (1,0).y = 30 but (1,1).y = 50 -> hole under (0,0)? (0,0)=[0,30); (1,0)=[30,80); (1,1)=[50,100)
      const issues = validateLayout({ screen: s, ports: autoWire(s, { pattern: 'left-top-horizontal', ports: 1, split: 'rows' }) });
      expect(issues.some((i) => i.code === 'overlap')).toBe(false);
      expect(issues.find((i) => i.code === 'coverage-gap')).toMatchObject({ severity: 'warning' });
    });

    it('rejects overrides outside the grid, duplicated or on a standard screen', () => {
      const base = createLayoutScreen(2, 2, 10, 10);
      const outside = { ...base, kind: 'complex' as const, overrides: [{ row: 3, col: 0, width: 5, height: 5 }] };
      expect(codes(wired(outside))).toEqual(['override-invalid']);
      const dup = { ...base, kind: 'complex' as const, overrides: [{ row: 0, col: 0, width: 5, height: 5 }, { row: 0, col: 0, width: 6, height: 5 }] };
      expect(codes(wired(dup))).toEqual(['override-invalid']);
      const std = { ...base, overrides: [{ row: 0, col: 0, width: 5, height: 5 }] };
      expect(codes(wired(std))).toEqual(['override-invalid']);
      const zero = { ...base, kind: 'complex' as const, overrides: [{ row: 0, col: 0, width: 0, height: 5 }] };
      expect(codes(wired(zero))).toEqual(['override-invalid']);
    });
  });
});

describe('placements', () => {
  const screen = createLayoutScreen(2, 3, 100, 50);
  const m: LayoutModel = {
    screen,
    ports: [
      { port: 2, cabinets: generateChain('left-top-horizontal', { row0: 1, col0: 0, row1: 1, col1: 2 }) },
      { port: 0, cabinets: generateChain('right-top-horizontal', { row0: 0, col0: 0, row1: 0, col1: 2 }) },
    ],
  };

  it('port regions are the bounding boxes of the chains', () => {
    expect(computePortRegions(m)).toEqual([
      { port: 0, x: 0, y: 0, width: 300, height: 50 },
      { port: 2, x: 0, y: 50, width: 300, height: 50 },
    ]);
  });

  it('cards: chain order per port, port order overall, size and offsets', () => {
    const cards = computeCardPlacements(m);
    expect(cards.map((c) => [c.port, c.index, c.row, c.col, c.cabinetNumber])).toEqual([
      [0, 0, 0, 2, 1],
      [0, 1, 0, 1, 2],
      [0, 2, 0, 0, 3],
      [2, 0, 1, 0, 4],
      [2, 1, 1, 1, 5],
      [2, 2, 1, 2, 6],
    ]);
    expect(cards[0]).toMatchObject({ x: 200, y: 0, width: 100, height: 50, portX: 200, portY: 0 });
    // port 2 sits at y=50, so its cards are relative to that origin
    expect(cards[3]).toMatchObject({ x: 0, y: 50, portX: 0, portY: 0 });
    expect(cards[5]).toMatchObject({ x: 200, y: 50, portX: 200, portY: 0 });
  });

  it('a port covering a sub-block gives offsets relative to its own corner', () => {
    const quad: LayoutModel = {
      screen: createLayoutScreen(2, 2, 64, 32),
      ports: [{ port: 0, cabinets: [{ row: 1, col: 1 }] }, { port: 1, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 0 }] }],
    };
    const plan = planLayoutWrite(quad);
    expect(plan.ports).toEqual([
      { port: 0, enabled: true, x: 64, y: 32, width: 64, height: 32 },
      { port: 1, enabled: true, x: 0, y: 0, width: 128, height: 64 },
    ]);
    expect(plan.cards.find((c) => c.port === 0)).toMatchObject({ x: 0, y: 0 });
    expect(plan.cards.find((c) => c.port === 1 && c.index === 2)).toMatchObject({ x: 0, y: 32 });
    expect(plan.complexScreen).toBe(false);
  });

  it('port loads are pixel sums with a ratio to the capacity', () => {
    const loads = computeLayoutPortLoads(m, 30_000);
    expect(loads).toEqual([
      { port: 0, cabinets: 3, pixels: 15_000, ratio: 0.5 },
      { port: 2, cabinets: 3, pixels: 15_000, ratio: 0.5 },
    ]);
    const s2 = setCabinetSize(createLayoutScreen(1, 2, 10, 10), 0, 1, 20, 10);
    expect(computeLayoutPortLoads({ screen: s2, ports: [{ port: 0, cabinets: [{ row: 0, col: 0 }, { row: 0, col: 1 }] }] })[0]!.pixels).toBe(300);
  });
});

describe('inferLayout (hardware -> model)', () => {
  it('round-trips standard and complex layouts through planLayoutWrite', () => {
    const std: LayoutModel = {
      screen: createLayoutScreen(3, 4, 96, 48),
      ports: autoWire(createLayoutScreen(3, 4, 96, 48), { pattern: 'right-bottom-vertical', ports: 2, split: 'columns' }),
    };
    const r = inferLayout(planLayoutWrite(std));
    expect(r.issues).toEqual([]);
    expect(r.model).toEqual(std);

    // a wider middle column (both rows) keeps the cabinets on a grid
    const screen = setCabinetSize(setCabinetSize(createLayoutScreen(2, 3, 100, 50), 0, 1, 160, 50), 1, 1, 160, 50);
    const complex: LayoutModel = { screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 1, split: 'rows' }) };
    const back = inferLayout(planLayoutWrite(complex));
    expect(back.model).toEqual(complex);
    expect(isComplexLayoutScreen(back.model!.screen)).toBe(true);
  });

  it('reports unconfigured (0x0) cards and an empty controller', () => {
    expect(inferLayout({ complexScreen: false, ports: [], cards: [] })).toEqual({ model: null, issues: [{ code: 'no-cards' }] });
    const r = inferLayout({
      complexScreen: false,
      ports: [{ port: 0, enabled: true, x: 0, y: 0, width: 200, height: 50 }],
      cards: [
        { port: 0, index: 0, x: 0, y: 0, width: 100, height: 50, cabinetNumber: 0 },
        { port: 0, index: 1, x: 100, y: 0, width: 100, height: 50, cabinetNumber: 0 },
        { port: 0, index: 2, x: 0, y: 0, width: 0, height: 0, cabinetNumber: 0 },
      ],
    });
    expect(r.issues).toEqual([{ code: 'unsized-cards', params: { count: 1 } }]);
    expect(r.model!.ports[0]!.cabinets).toHaveLength(2);
  });

  it('refuses cards that do not form a grid', () => {
    const r = inferLayout({
      complexScreen: true,
      ports: [{ port: 0, enabled: true, x: 0, y: 0, width: 300, height: 100 }],
      cards: [
        { port: 0, index: 0, x: 0, y: 0, width: 100, height: 50, cabinetNumber: 0 },
        { port: 0, index: 1, x: 100, y: 25, width: 100, height: 50, cabinetNumber: 0 },
      ],
    });
    expect(r.model).toBeNull();
    expect(r.issues).toEqual([{ code: 'not-a-grid' }]);
  });

  it('adds the port offset to the card offset', () => {
    const r = inferLayout({
      complexScreen: false,
      ports: [
        { port: 0, enabled: true, x: 0, y: 0, width: 100, height: 50 },
        { port: 1, enabled: true, x: 0, y: 50, width: 100, height: 50 },
      ],
      cards: [
        { port: 0, index: 0, x: 0, y: 0, width: 100, height: 50, cabinetNumber: 1 },
        { port: 1, index: 0, x: 0, y: 0, width: 100, height: 50, cabinetNumber: 2 },
      ],
    });
    expect(r.model!.screen).toMatchObject({ rows: 2, cols: 1 });
    expect(r.model!.ports).toEqual([
      { port: 0, cabinets: [{ row: 0, col: 0 }] },
      { port: 1, cabinets: [{ row: 1, col: 0 }] },
    ]);
  });
});

describe('parseLayoutModel', () => {
  const good = (): LayoutModel => model(1, 1, [{ port: 0, cabinets: [{ row: 0, col: 0 }] }]);
  it('accepts a well-formed model and rejects wrong shapes', () => {
    expect(parseLayoutModel(good())).toEqual(good());
    for (const bad of [null, 5, {}, { screen: {}, ports: [] }, { ...good(), ports: 'x' }, { ...good(), ports: [{ port: 'a', cabinets: [] }] }, { ...good(), ports: [{ port: 0, cabinets: [{ row: 1 }] }] }]) {
      expect(parseLayoutModel(bad)).toBeNull();
    }
    const badScreen = good();
    (badScreen.screen as unknown as { rows: string }).rows = '1';
    expect(parseLayoutModel(badScreen)).toBeNull();
    const badKind = good();
    (badKind.screen as unknown as { kind: string }).kind = 'weird';
    expect(parseLayoutModel(badKind)).toBeNull();
  });
});

describe('regionOfScreen', () => {
  it('covers the whole grid', () => {
    expect(regionOfScreen(createLayoutScreen(3, 5, 1, 1))).toEqual({ row0: 0, col0: 0, row1: 2, col1: 4 });
  });
});
