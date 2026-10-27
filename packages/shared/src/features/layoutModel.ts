// Pure screen-connection model (PLAN.md phase 5). No runtime deps, no I/O.
//
// A screen is a grid of cabinets. Every output port of the sending card feeds an ordered chain of
// cabinets (the first one is the cabinet cabled directly to the sender). Each cabinet holds one
// receiving card, so "cabinet N of port P" and "receiving card N of port P" are the same thing.
//
// Coordinates: x grows to the right, y grows downwards, (0,0) is the top-left pixel of the screen.

/** Largest coordinate / dimension the model accepts (the sender register pair is written as a
 * signed 32-bit `(x << 16) + y`, so x must stay below 0x8000). */
export const LAYOUT_MAX_COORD = 0x7fff;
/** Pixel capacity of one gigabit output port (NovaLCT figure for 8-bit, 60 Hz). */
/** Highest port index a layout may name: 0xFF is the codec's "all ports" broadcast, never a real port. */
export const LAYOUT_MAX_PORT_INDEX = 0xfe;
/** Most receiving cards one chain may hold: card index 0xFFFF is the "all cards" broadcast. */
export const LAYOUT_MAX_CARDS_PER_PORT = 0xffff;
export const LAYOUT_DEFAULT_PORT_CAPACITY = 650_000;

export interface CabinetRef {
  row: number;
  col: number;
}

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Inclusive cabinet region of the grid. */
export interface CabinetRegion {
  row0: number;
  col0: number;
  row1: number;
  col1: number;
}

export interface CabinetSizeOverride extends CabinetRef {
  width: number;
  height: number;
}

export type LayoutScreenKind = 'standard' | 'complex';

export interface LayoutScreen {
  /** `standard`: every cabinet has the same size. `complex`: per-cabinet overrides are allowed. */
  kind: LayoutScreenKind;
  rows: number;
  cols: number;
  cabinetWidth: number;
  cabinetHeight: number;
  overrides: CabinetSizeOverride[];
}

export interface PortChain {
  /** Output port index on the sending card (0-based). */
  port: number;
  /** Cabinets in cable order; index in this array = receiving card index on the port. */
  cabinets: CabinetRef[];
}

export interface LayoutModel {
  screen: LayoutScreen;
  ports: PortChain[];
}

// ---------------------------------------------------------------------------------------------
// Wiring patterns
// ---------------------------------------------------------------------------------------------

/**
 * The eight serpentine wiring patterns NovaLCT offers. The numeric ids are the values of
 * `ScanBoardConnectTypeEnum` in @novastar/native (dist/ScanBoardConnectType.d.cts):
 * LeftTop_Horizontal=0 .. RightBottom_Vertical=7.
 */
export const WIRING_PATTERNS = [
  'left-top-horizontal',
  'left-bottom-horizontal',
  'right-top-horizontal',
  'right-bottom-horizontal',
  'left-top-vertical',
  'left-bottom-vertical',
  'right-top-vertical',
  'right-bottom-vertical',
] as const;

export type WiringPattern = (typeof WIRING_PATTERNS)[number];

/** `ScanBoardConnectTypeEnum` value of each pattern (index in {@link WIRING_PATTERNS}). */
export const WIRING_PATTERN_HW_ID: Record<WiringPattern, number> = {
  'left-top-horizontal': 0,
  'left-bottom-horizontal': 1,
  'right-top-horizontal': 2,
  'right-bottom-horizontal': 3,
  'left-top-vertical': 4,
  'left-bottom-vertical': 5,
  'right-top-vertical': 6,
  'right-bottom-vertical': 7,
};

export interface WiringPatternInfo {
  fromLeft: boolean;
  fromTop: boolean;
  /** `horizontal`: run along a row, then step to the next row (snake). `vertical`: along a column. */
  axis: 'horizontal' | 'vertical';
}

export function wiringPatternInfo(pattern: WiringPattern): WiringPatternInfo {
  const [side, edge, axis] = pattern.split('-') as ['left' | 'right', 'top' | 'bottom', 'horizontal' | 'vertical'];
  return { fromLeft: side === 'left', fromTop: edge === 'top', axis };
}

export const isWiringPattern = (v: unknown): v is WiringPattern =>
  typeof v === 'string' && (WIRING_PATTERNS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------------------------
// Screen geometry
// ---------------------------------------------------------------------------------------------

export function createLayoutScreen(rows: number, cols: number, cabinetWidth: number, cabinetHeight: number): LayoutScreen {
  return { kind: 'standard', rows, cols, cabinetWidth, cabinetHeight, overrides: [] };
}

export const cabinetKey = (c: CabinetRef): string => `${c.row},${c.col}`;
export const sameCabinet = (a: CabinetRef, b: CabinetRef): boolean => a.row === b.row && a.col === b.col;

export function cabinetSize(screen: LayoutScreen, row: number, col: number): { width: number; height: number } {
  for (const o of screen.overrides) {
    if (o.row === row && o.col === col) return { width: o.width, height: o.height };
  }
  return { width: screen.cabinetWidth, height: screen.cabinetHeight };
}

/**
 * Top-left of a cabinet: x is the sum of the widths of the cabinets to its left in the same row,
 * y the sum of the heights of the cabinets above it in the same column. For a standard screen this
 * is simply col*width, row*height. Overlaps / gaps in a complex screen are reported by validation.
 */
export function cabinetRect(screen: LayoutScreen, row: number, col: number): LayoutRect {
  const { width, height } = cabinetSize(screen, row, col);
  if (screen.overrides.length === 0) {
    return { x: col * screen.cabinetWidth, y: row * screen.cabinetHeight, width, height };
  }
  let x = 0;
  for (let c = 0; c < col; c += 1) x += cabinetSize(screen, row, c).width;
  let y = 0;
  for (let r = 0; r < row; r += 1) y += cabinetSize(screen, r, col).height;
  return { x, y, width, height };
}

export function allCabinets(screen: LayoutScreen): CabinetRef[] {
  const out: CabinetRef[] = [];
  for (let row = 0; row < screen.rows; row += 1) for (let col = 0; col < screen.cols; col += 1) out.push({ row, col });
  return out;
}

export function layoutBoundsOf(rects: readonly LayoutRect[]): LayoutRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Bounding box of the whole screen in pixels. */
export function layoutScreenBounds(screen: LayoutScreen): LayoutRect {
  return layoutBoundsOf(allCabinets(screen).map((c) => cabinetRect(screen, c.row, c.col)));
}

/** Set (or, if it equals the default size, clear) a per-cabinet size; the screen becomes complex. */
export function setCabinetSize(screen: LayoutScreen, row: number, col: number, width: number, height: number): LayoutScreen {
  const rest = screen.overrides.filter((o) => !(o.row === row && o.col === col));
  const isDefault = width === screen.cabinetWidth && height === screen.cabinetHeight;
  return {
    ...screen,
    kind: 'complex',
    overrides: isDefault ? rest : [...rest, { row, col, width, height }],
  };
}

/**
 * Change the grid dimensions / default cabinet size, dropping overrides that fall outside the new
 * grid. Chains are not touched; use {@link pruneChains}.
 */
export function resizeLayoutScreen(
  screen: LayoutScreen,
  next: Partial<Pick<LayoutScreen, 'rows' | 'cols' | 'cabinetWidth' | 'cabinetHeight'>>,
): LayoutScreen {
  const merged = { ...screen, ...next };
  return {
    ...merged,
    overrides: merged.overrides.filter((o) => o.row < merged.rows && o.col < merged.cols),
  };
}

/** Remove chain entries that no longer exist in the screen. */
export function pruneChains(screen: LayoutScreen, ports: readonly PortChain[]): PortChain[] {
  return ports.map((p) => ({
    ...p,
    cabinets: p.cabinets.filter((c) => c.row >= 0 && c.col >= 0 && c.row < screen.rows && c.col < screen.cols),
  }));
}

export const isComplexLayoutScreen = (screen: LayoutScreen): boolean => screen.kind === 'complex' || screen.overrides.length > 0;

// ---------------------------------------------------------------------------------------------
// Chain generators
// ---------------------------------------------------------------------------------------------

export function regionOfScreen(screen: LayoutScreen): CabinetRegion {
  return { row0: 0, col0: 0, row1: screen.rows - 1, col1: screen.cols - 1 };
}

export function regionCount(r: CabinetRegion): number {
  return Math.max(0, r.row1 - r.row0 + 1) * Math.max(0, r.col1 - r.col0 + 1);
}

/**
 * Cabinets of `region` in cable order for a serpentine pattern. `*-horizontal` runs along rows
 * (starting in the row at the chosen edge, reversing direction on every row); `*-vertical` runs down
 * / up columns the same way.
 */
export function generateChain(pattern: WiringPattern, region: CabinetRegion): CabinetRef[] {
  const { fromLeft, fromTop, axis } = wiringPatternInfo(pattern);
  const rowCount = region.row1 - region.row0 + 1;
  const colCount = region.col1 - region.col0 + 1;
  if (rowCount <= 0 || colCount <= 0) return [];
  const rowAt = (i: number): number => (fromTop ? region.row0 + i : region.row1 - i);
  const colAt = (i: number): number => (fromLeft ? region.col0 + i : region.col1 - i);
  const out: CabinetRef[] = [];
  if (axis === 'horizontal') {
    for (let i = 0; i < rowCount; i += 1) {
      for (let j = 0; j < colCount; j += 1) {
        out.push({ row: rowAt(i), col: colAt(i % 2 === 0 ? j : colCount - 1 - j) });
      }
    }
  } else {
    for (let i = 0; i < colCount; i += 1) {
      for (let j = 0; j < rowCount; j += 1) {
        out.push({ row: rowAt(i % 2 === 0 ? j : rowCount - 1 - j), col: colAt(i) });
      }
    }
  }
  return out;
}

/** Smallest region containing every cabinet, or null for an empty list. */
export function regionOfCabinets(cabinets: readonly CabinetRef[]): CabinetRegion | null {
  if (cabinets.length === 0) return null;
  let row0 = Infinity;
  let col0 = Infinity;
  let row1 = -Infinity;
  let col1 = -Infinity;
  for (const c of cabinets) {
    row0 = Math.min(row0, c.row);
    col0 = Math.min(col0, c.col);
    row1 = Math.max(row1, c.row);
    col1 = Math.max(col1, c.col);
  }
  return { row0, col0, row1, col1 };
}

/**
 * Re-wire a chain with another pattern over the same cabinets. Only possible when the chain fills
 * a complete rectangle; otherwise returns null.
 */
export function rewireChain(pattern: WiringPattern, cabinets: readonly CabinetRef[]): CabinetRef[] | null {
  const region = regionOfCabinets(cabinets);
  if (!region) return [];
  if (regionCount(region) !== cabinets.length) return null;
  const keys = new Set(cabinets.map(cabinetKey));
  if (keys.size !== cabinets.length) return null;
  return generateChain(pattern, region);
}

export type LayoutSplitAxis = 'rows' | 'columns';

export interface AutoWireOptions {
  pattern: WiringPattern;
  /** Number of output ports to spread the screen over. */
  ports: number;
  /** `rows`: every port takes a horizontal band of rows; `columns`: a vertical band of columns. */
  split: LayoutSplitAxis;
  /** Index of the first port, default 0. */
  firstPort?: number;
}

function bandsEvenly(total: number, bands: number): Array<[number, number]> {
  const n = Math.max(1, Math.min(bands, total));
  const base = Math.floor(total / n);
  const extra = total % n;
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    out.push([start, start + size - 1]);
    start += size;
  }
  return out;
}

function chainsFromBands(
  screen: LayoutScreen,
  pattern: WiringPattern,
  split: LayoutSplitAxis,
  bands: Array<[number, number]>,
  firstPort: number,
): PortChain[] {
  return bands.map(([a, b], i) => {
    const region: CabinetRegion =
      split === 'rows'
        ? { row0: a, row1: b, col0: 0, col1: screen.cols - 1 }
        : { col0: a, col1: b, row0: 0, row1: screen.rows - 1 };
    return { port: firstPort + i, cabinets: generateChain(pattern, region) };
  });
}

/** Spread the whole screen over `ports` ports as evenly sized bands, each wired with `pattern`. */
export function autoWire(screen: LayoutScreen, opts: AutoWireOptions): PortChain[] {
  if (screen.rows <= 0 || screen.cols <= 0) return [];
  const total = opts.split === 'rows' ? screen.rows : screen.cols;
  return chainsFromBands(screen, opts.pattern, opts.split, bandsEvenly(total, opts.ports), opts.firstPort ?? 0);
}

/**
 * Greedy variant: add whole rows (or columns) to a port until the next one would exceed `capacity`
 * pixels. A single row / column that alone exceeds the capacity still gets its own port (validation
 * then flags it).
 */
export function autoWireByCapacity(
  screen: LayoutScreen,
  opts: { pattern: WiringPattern; capacity: number; split: LayoutSplitAxis; firstPort?: number },
): PortChain[] {
  if (screen.rows <= 0 || screen.cols <= 0) return [];
  const lines = opts.split === 'rows' ? screen.rows : screen.cols;
  const linePixels = (i: number): number => {
    let px = 0;
    if (opts.split === 'rows') {
      for (let c = 0; c < screen.cols; c += 1) {
        const s = cabinetSize(screen, i, c);
        px += s.width * s.height;
      }
    } else {
      for (let r = 0; r < screen.rows; r += 1) {
        const s = cabinetSize(screen, r, i);
        px += s.width * s.height;
      }
    }
    return px;
  };
  const bands: Array<[number, number]> = [];
  let start = 0;
  let load = 0;
  for (let i = 0; i < lines; i += 1) {
    const px = linePixels(i);
    if (i > start && load + px > opts.capacity) {
      bands.push([start, i - 1]);
      start = i;
      load = 0;
    }
    load += px;
  }
  bands.push([start, lines - 1]);
  return chainsFromBands(screen, opts.pattern, opts.split, bands, opts.firstPort ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Manual wiring helpers (pure; used by the click-to-wire UI)
// ---------------------------------------------------------------------------------------------

export function findCabinetPort(ports: readonly PortChain[], ref: CabinetRef): { port: number; index: number } | null {
  for (const p of ports) {
    const index = p.cabinets.findIndex((c) => sameCabinet(c, ref));
    if (index >= 0) return { port: p.port, index };
  }
  return null;
}

/** Remove a cabinet from whichever chain holds it. */
export function removeCabinet(ports: readonly PortChain[], ref: CabinetRef): PortChain[] {
  return ports.map((p) => ({ ...p, cabinets: p.cabinets.filter((c) => !sameCabinet(c, ref)) }));
}

/** Append `ref` to the end of `port`'s chain, moving it out of any other chain; creates the port. */
export function appendCabinet(ports: readonly PortChain[], port: number, ref: CabinetRef): PortChain[] {
  const stripped = removeCabinet(ports, ref);
  const has = stripped.some((p) => p.port === port);
  const next = has ? stripped : [...stripped, { port, cabinets: [] }];
  return next
    .map((p) => (p.port === port ? { ...p, cabinets: [...p.cabinets, { row: ref.row, col: ref.col }] } : p))
    .sort((a, b) => a.port - b.port);
}

/**
 * Click behaviour of the manual wiring tool for `activePort`:
 * - unassigned cabinet, or one on another port: append to the active port;
 * - the last cabinet of the active port: remove it (undo);
 * - an earlier cabinet of the active port: truncate the chain after it.
 */
export function toggleCabinet(ports: readonly PortChain[], activePort: number, ref: CabinetRef): PortChain[] {
  const at = findCabinetPort(ports, ref);
  if (at && at.port === activePort) {
    return ports.map((p) => {
      if (p.port !== activePort) return p;
      const last = at.index === p.cabinets.length - 1;
      return { ...p, cabinets: p.cabinets.slice(0, last ? at.index : at.index + 1) };
    });
  }
  return appendCabinet(ports, activePort, ref);
}

export function clearLayoutPort(ports: readonly PortChain[], port: number): PortChain[] {
  return ports.map((p) => (p.port === port ? { ...p, cabinets: [] } : p));
}

// ---------------------------------------------------------------------------------------------
// Placements (what is sent to the receiving cards)
// ---------------------------------------------------------------------------------------------

export interface LayoutPortRegion extends LayoutRect {
  port: number;
}

export interface LayoutCardPlacement {
  port: number;
  /** Receiving card index on the port (= position in the chain). */
  index: number;
  row: number;
  col: number;
  /** 1-based number over all ports in port order, chain order. */
  cabinetNumber: number;
  /** Cabinet size = receiving card load size. */
  width: number;
  height: number;
  /** Position in the whole screen. */
  x: number;
  y: number;
  /** Position relative to the top-left of the port's region (what the sender's per-card X/Y table holds). */
  portX: number;
  portY: number;
}

function sortedPorts(model: LayoutModel): PortChain[] {
  return [...model.ports].sort((a, b) => a.port - b.port);
}

/** Bounding rectangle of each port's cabinets (ports without cabinets are omitted). */
export function computePortRegions(model: LayoutModel): LayoutPortRegion[] {
  const out: LayoutPortRegion[] = [];
  for (const p of sortedPorts(model)) {
    if (p.cabinets.length === 0) continue;
    const b = layoutBoundsOf(p.cabinets.map((c) => cabinetRect(model.screen, c.row, c.col)));
    out.push({ port: p.port, ...b });
  }
  return out;
}

/** Every receiving card's position and size, in port order then chain order. */
export function computeCardPlacements(model: LayoutModel): LayoutCardPlacement[] {
  const regions = new Map(computePortRegions(model).map((r) => [r.port, r]));
  const out: LayoutCardPlacement[] = [];
  let n = 1;
  for (const p of sortedPorts(model)) {
    const region = regions.get(p.port);
    p.cabinets.forEach((c, index) => {
      const r = cabinetRect(model.screen, c.row, c.col);
      out.push({
        port: p.port,
        index,
        row: c.row,
        col: c.col,
        cabinetNumber: n,
        width: r.width,
        height: r.height,
        x: r.x,
        y: r.y,
        portX: r.x - (region?.x ?? 0),
        portY: r.y - (region?.y ?? 0),
      });
      n += 1;
    });
  }
  return out;
}

export interface LayoutPortLoad {
  port: number;
  cabinets: number;
  pixels: number;
  /** pixels / capacity; > 1 means overloaded. */
  ratio: number;
}

export function computeLayoutPortLoads(model: LayoutModel, capacity: number = LAYOUT_DEFAULT_PORT_CAPACITY): LayoutPortLoad[] {
  return sortedPorts(model).map((p) => {
    let pixels = 0;
    for (const c of p.cabinets) {
      const s = cabinetSize(model.screen, c.row, c.col);
      pixels += s.width * s.height;
    }
    return { port: p.port, cabinets: p.cabinets.length, pixels, ratio: capacity > 0 ? pixels / capacity : 0 };
  });
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

export type LayoutIssueCode =
  | 'screen-size' //          rows/cols/cabinet size not a positive integer
  | 'screen-too-large' //     a coordinate or dimension exceeds LAYOUT_MAX_COORD
  | 'override-invalid' //     override outside the grid, duplicated or with a bad size
  | 'port-invalid' //         port index not a non-negative integer, duplicated or >= maxPorts
  | 'cabinet-out-of-range' // chain refers to a cabinet outside the grid
  | 'cabinet-duplicate' //    cabinet appears more than once (same or different port)
  | 'cabinet-unassigned' //   cabinet not wired to any port
  | 'port-over-capacity' //   pixels on a port exceed the limit
  | 'port-too-many-cards' //  chain longer than maxCardsPerPort
  | 'chain-not-adjacent' //   (warning) consecutive cabinets do not touch
  | 'overlap' //              two cabinet rectangles overlap
  | 'coverage-gap' //         (warning) complex screen leaves uncovered area
  | 'no-ports'; //            (error) nothing is wired

export interface LayoutIssue {
  code: LayoutIssueCode;
  severity: 'error' | 'warning';
  port?: number;
  cabinet?: CabinetRef;
  /** Second cabinet for `overlap`. */
  other?: CabinetRef;
  /** Numbers for message templates (`pixels`, `capacity`, `count`, `max`, ...). */
  params?: Record<string, number>;
}

export interface LayoutValidateOptions {
  /** Pixels per port, default {@link LAYOUT_DEFAULT_PORT_CAPACITY}. */
  portCapacity?: number;
  /** Number of output ports the controller has; chains on higher ports are errors. */
  maxPorts?: number;
  maxCardsPerPort?: number;
}

const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** True when the rectangles share part of an edge (corner contact does not count). */
const touches = (a: LayoutRect, b: LayoutRect): boolean => {
  const xOverlap = a.x < b.x + b.width && b.x < a.x + a.width;
  const yOverlap = a.y < b.y + b.height && b.y < a.y + a.height;
  return (xOverlap && (a.y === b.y + b.height || b.y === a.y + a.height)) ||
    (yOverlap && (a.x === b.x + b.width || b.x === a.x + a.width));
};

const overlaps = (a: LayoutRect, b: LayoutRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function validateLayout(model: LayoutModel, opts: LayoutValidateOptions = {}): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const { screen } = model;
  const capacity = opts.portCapacity ?? LAYOUT_DEFAULT_PORT_CAPACITY;
  const err = (i: Omit<LayoutIssue, 'severity'>): void => void issues.push({ ...i, severity: 'error' });
  const warn = (i: Omit<LayoutIssue, 'severity'>): void => void issues.push({ ...i, severity: 'warning' });

  // --- screen -----------------------------------------------------------------------------
  const sizeOk =
    isPosInt(screen.rows) && isPosInt(screen.cols) && isPosInt(screen.cabinetWidth) && isPosInt(screen.cabinetHeight);
  if (!sizeOk) {
    err({ code: 'screen-size' });
    return issues; // nothing else is meaningful
  }
  const seenOverride = new Set<string>();
  for (const o of screen.overrides) {
    const key = cabinetKey(o);
    const bad =
      !Number.isInteger(o.row) ||
      !Number.isInteger(o.col) ||
      o.row < 0 ||
      o.col < 0 ||
      o.row >= screen.rows ||
      o.col >= screen.cols ||
      !isPosInt(o.width) ||
      !isPosInt(o.height) ||
      seenOverride.has(key);
    if (bad) err({ code: 'override-invalid', cabinet: { row: o.row, col: o.col } });
    seenOverride.add(key);
  }
  if (issues.some((i) => i.code === 'override-invalid')) return issues;
  if (screen.overrides.length > 0 && screen.kind !== 'complex') {
    err({ code: 'override-invalid', cabinet: { row: screen.overrides[0]!.row, col: screen.overrides[0]!.col } });
    return issues;
  }

  const rects = new Map<string, LayoutRect>();
  for (const c of allCabinets(screen)) rects.set(cabinetKey(c), cabinetRect(screen, c.row, c.col));
  const bounds = layoutBoundsOf([...rects.values()]);
  if (bounds.x + bounds.width > LAYOUT_MAX_COORD || bounds.y + bounds.height > LAYOUT_MAX_COORD) {
    err({ code: 'screen-too-large', params: { max: LAYOUT_MAX_COORD } });
  }

  // --- overlaps / gaps (only possible with per-cabinet sizes) -------------------------------
  if (screen.overrides.length > 0) {
    const list = allCabinets(screen);
    let found = 0;
    outer: for (let i = 0; i < list.length; i += 1) {
      const ri = rects.get(cabinetKey(list[i]!))!;
      for (let j = i + 1; j < list.length; j += 1) {
        if (overlaps(ri, rects.get(cabinetKey(list[j]!))!)) {
          err({ code: 'overlap', cabinet: list[i]!, other: list[j]! });
          found += 1;
          if (found >= 20) break outer; // enough to tell the user
        }
      }
    }
    if (found === 0) {
      let area = 0;
      for (const r of rects.values()) area += r.width * r.height;
      if (area < bounds.width * bounds.height) {
        warn({ code: 'coverage-gap', params: { missing: bounds.width * bounds.height - area } });
      }
    }
  }

  // --- ports --------------------------------------------------------------------------------
  const seenPort = new Set<number>();
  const owner = new Map<string, number>();
  let anyCabinet = false;
  for (const p of model.ports) {
    if (!Number.isInteger(p.port) || p.port < 0 || p.port > LAYOUT_MAX_PORT_INDEX || seenPort.has(p.port) || (opts.maxPorts !== undefined && p.port >= opts.maxPorts)) {
      err({ code: 'port-invalid', port: p.port, params: opts.maxPorts !== undefined ? { max: opts.maxPorts } : undefined });
    }
    seenPort.add(p.port);
    const cardCap = Math.min(opts.maxCardsPerPort ?? LAYOUT_MAX_CARDS_PER_PORT, LAYOUT_MAX_CARDS_PER_PORT);
    if (p.cabinets.length > cardCap) {
      err({ code: 'port-too-many-cards', port: p.port, params: { count: p.cabinets.length, max: cardCap } });
    }
    let pixels = 0;
    let prev: LayoutRect | null = null;
    for (const c of p.cabinets) {
      anyCabinet = true;
      const key = cabinetKey(c);
      const r = rects.get(key);
      if (!r) {
        err({ code: 'cabinet-out-of-range', port: p.port, cabinet: c });
        prev = null;
        continue;
      }
      if (owner.has(key)) err({ code: 'cabinet-duplicate', port: p.port, cabinet: c, params: { firstPort: owner.get(key)! } });
      else owner.set(key, p.port);
      pixels += r.width * r.height;
      if (prev && !touches(prev, r)) warn({ code: 'chain-not-adjacent', port: p.port, cabinet: c });
      prev = r;
    }
    if (pixels > capacity) err({ code: 'port-over-capacity', port: p.port, params: { pixels, capacity } });
  }

  if (!anyCabinet) err({ code: 'no-ports' });
  else {
    for (const c of allCabinets(screen)) {
      if (!owner.has(cabinetKey(c))) err({ code: 'cabinet-unassigned', cabinet: c });
    }
  }
  return issues;
}

export const layoutHasErrors = (issues: readonly LayoutIssue[]): boolean => issues.some((i) => i.severity === 'error');

/** Short human-readable English summary (used for DeviceError messages, logs). */
export function describeLayoutIssue(i: LayoutIssue): string {
  const where = [
    i.port !== undefined ? `port ${i.port}` : '',
    i.cabinet ? `cabinet (${i.cabinet.row},${i.cabinet.col})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const extra = i.params ? ' ' + JSON.stringify(i.params) : '';
  return `${i.code}${where ? ' @ ' + where : ''}${extra}`;
}

// ---------------------------------------------------------------------------------------------
// Hardware snapshot -> model
// ---------------------------------------------------------------------------------------------

/** Output port region as stored in the sender (NovaLCT "port load area"). */
export interface LayoutHardwarePort {
  port: number;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One receiving card as stored on the controller. x/y are relative to the port's region. */
export interface LayoutHardwareCard {
  port: number;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Cabinet serial number register of the card. */
  cabinetNumber: number;
}

export interface LayoutHardwareState {
  complexScreen: boolean;
  ports: LayoutHardwarePort[];
  cards: LayoutHardwareCard[];
}

export type InferIssueCode =
  | 'no-cards' //      nothing with a non-zero size was read
  | 'not-a-grid' //    the cards do not line up in a rows x cols grid
  | 'unsized-cards'; // some cards report 0x0 (never configured); they were skipped

export interface LayoutInferResult {
  model: LayoutModel | null;
  issues: Array<{ code: InferIssueCode; params?: Record<string, number> }>;
}

/**
 * Rebuild a model from what was read from the controller. Cards of size 0x0 are treated as
 * unconfigured. The cards must form a grid (columns = distinct x, rows = distinct y); otherwise
 * `model` is null with `not-a-grid`.
 */
export function inferLayout(hw: LayoutHardwareState): LayoutInferResult {
  const issues: LayoutInferResult['issues'] = [];
  const regionOfPort = new Map(hw.ports.map((p) => [p.port, p]));
  const sized = hw.cards.filter((c) => c.width > 0 && c.height > 0);
  if (sized.length !== hw.cards.length) issues.push({ code: 'unsized-cards', params: { count: hw.cards.length - sized.length } });
  if (sized.length === 0) {
    issues.push({ code: 'no-cards' });
    return { model: null, issues };
  }
  const abs = sized.map((c) => {
    const pr = regionOfPort.get(c.port);
    return { card: c, x: c.x + (pr?.x ?? 0), y: c.y + (pr?.y ?? 0) };
  });
  const xs = [...new Set(abs.map((a) => a.x))].sort((a, b) => a - b);
  const ys = [...new Set(abs.map((a) => a.y))].sort((a, b) => a - b);

  // most common size = default cabinet size
  const counts = new Map<string, number>();
  for (const a of abs) {
    const k = `${a.card.width}x${a.card.height}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const [bestKey] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
  const [dw, dh] = bestKey.split('x').map(Number) as [number, number];

  let screen: LayoutScreen = createLayoutScreen(ys.length, xs.length, dw, dh);
  const chains = new Map<number, Array<{ index: number; ref: CabinetRef }>>();
  for (const a of abs) {
    const ref = { row: ys.indexOf(a.y), col: xs.indexOf(a.x) };
    if (a.card.width !== dw || a.card.height !== dh) screen = setCabinetSize(screen, ref.row, ref.col, a.card.width, a.card.height);
    const list = chains.get(a.card.port) ?? [];
    list.push({ index: a.card.index, ref });
    chains.set(a.card.port, list);
  }
  if (hw.complexScreen && screen.kind !== 'complex') screen = { ...screen, kind: 'complex' };
  const ports: PortChain[] = [...chains.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([port, list]) => ({ port, cabinets: list.sort((a, b) => a.index - b.index).map((l) => l.ref) }));
  const model: LayoutModel = { screen, ports };

  // The reconstruction must reproduce every card's rectangle exactly, else it is not a grid.
  for (const a of abs) {
    const r = cabinetRect(screen, ys.indexOf(a.y), xs.indexOf(a.x));
    if (r.x !== a.x || r.y !== a.y || r.width !== a.card.width || r.height !== a.card.height) {
      issues.push({ code: 'not-a-grid' });
      return { model: null, issues };
    }
  }
  return { model, issues };
}
