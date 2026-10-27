// PLAN.md phase 6: pure screen-config file model. No runtime deps, no I/O (bundled into the renderer too).
//
// A screen-config file is a JSON snapshot of everything the earlier phases can read and write:
// sender video + ports (phase 3), every receiving card's raw parameters (phase 4) and the screen
// layout (phase 5). NovaLCT's own .rcfgx / .scr files are NOT understood (undocumented format).

import { SENDER_INPUT_SOURCES, SENDER_MAX_PORTS } from './sender.js';
import type { SenderInputSource, SenderPortStatus, SenderVideoStatus } from './sender.js';
import {
  MODULE_LIBRARY_FORMAT,
  MODULE_LIBRARY_VERSION,
  validateCardIndex,
  validateModuleLibrary,
  validateModuleProfile,
} from './receiver.js';
import type { ModuleProfile, ReceiverParameters } from './receiver.js';
import { describeLayoutIssue, layoutHasErrors, validateLayout } from './layoutModel.js';
import type { LayoutModel } from './layoutModel.js';
import { parseLayoutModel, planLayoutWrite } from './layoutPlan.js';

export const SCREEN_CONFIG_FORMAT = 'rockzalct.screen-config';
export const SCREEN_CONFIG_VERSION = 1;
/** Files larger than this are refused before JSON.parse. */
export const SCREEN_CONFIG_MAX_BYTES = 8 * 1024 * 1024;

/** Sanity limits that keep a hostile or corrupt file from making validation expensive. */
export const SCREEN_CONFIG_LIMITS = {
  /** Most receiving cards one file may list. */
  receivers: 4096,
  /** Largest grid side accepted in a layout. */
  gridSide: 1024,
  /** Most cabinets (rows x cols) in a layout. */
  cabinets: 65536,
  /** Most module-library entries. */
  moduleLibrary: 1000,
  text: 128,
} as const;

// ---------------------------------------------------------------------------------------------
// Types

export interface ScreenConfigController {
  /** Model string as shown by the connection page (informational, compared before applying). */
  model: string;
  firmwareVersion?: string;
  outputPorts: number;
  /** Receiving cards the controller reported when the file was saved. */
  receivingCards: number;
}

export interface ScreenConfigSender {
  video: SenderVideoStatus;
  ports: SenderPortStatus[];
}

/** One receiving card; live telemetry (temperature, voltage) is deliberately not stored. */
export type ScreenConfigReceiver = Omit<ReceiverParameters, 'temperatureRaw' | 'voltageRaw'>;

export interface ScreenConfig {
  format: typeof SCREEN_CONFIG_FORMAT;
  version: typeof SCREEN_CONFIG_VERSION;
  /** ISO-8601 timestamp. */
  savedAt: string;
  controller: ScreenConfigController;
  /** null = the sender could not be read when the file was made; applying skips it. */
  sender: ScreenConfigSender | null;
  receivers: ScreenConfigReceiver[];
  /** null = no layout was stored in / could be derived from the controller; applying skips it. */
  layout: LayoutModel | null;
  moduleLibrary?: ModuleProfile[];
}

export interface ScreenConfigError {
  field: string;
  message: string;
}

export type ScreenConfigValidation =
  | { ok: true; config: ScreenConfig }
  | { ok: false; errors: ScreenConfigError[] };

// ---------------------------------------------------------------------------------------------
// Validation

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MAX_ERRORS = 50;

class Collector {
  readonly errors: ScreenConfigError[] = [];
  add(field: string, message: string): void {
    if (this.errors.length < MAX_ERRORS) this.errors.push({ field, message });
  }
  int(obj: Record<string, unknown>, key: string, path: string, min: number, max: number): number {
    const v = obj[key];
    if (!isInt(v) || v < min || v > max) {
      this.add(`${path}${key}`, `${key} must be an integer ${min}..${max}`);
      return min;
    }
    return v;
  }
  optInt(obj: Record<string, unknown>, key: string, path: string, min: number, max: number): number | undefined {
    if (obj[key] === undefined || obj[key] === null) return undefined;
    return this.int(obj, key, path, min, max);
  }
  bool(obj: Record<string, unknown>, key: string, path: string): boolean {
    const v = obj[key];
    if (typeof v !== 'boolean') {
      this.add(`${path}${key}`, `${key} must be true or false`);
      return false;
    }
    return v;
  }
}

function validateController(raw: unknown, c: Collector): ScreenConfigController {
  const out: ScreenConfigController = { model: '', outputPorts: 0, receivingCards: 0 };
  if (!isRecord(raw)) {
    c.add('controller', 'controller must be an object');
    return out;
  }
  if (typeof raw.model !== 'string' || raw.model.trim() === '' || raw.model.length > SCREEN_CONFIG_LIMITS.text) {
    c.add('controller.model', `model must be text of 1..${SCREEN_CONFIG_LIMITS.text} characters`);
  } else {
    out.model = raw.model.trim();
  }
  if (raw.firmwareVersion !== undefined && raw.firmwareVersion !== null) {
    if (typeof raw.firmwareVersion !== 'string' || raw.firmwareVersion.length > SCREEN_CONFIG_LIMITS.text) {
      c.add('controller.firmwareVersion', 'firmwareVersion must be text');
    } else {
      out.firmwareVersion = raw.firmwareVersion;
    }
  }
  out.outputPorts = c.int(raw, 'outputPorts', 'controller.', 0, SENDER_MAX_PORTS);
  out.receivingCards = c.int(raw, 'receivingCards', 'controller.', 0, SCREEN_CONFIG_LIMITS.receivers);
  return out;
}

function validateSender(raw: unknown, c: Collector): ScreenConfigSender | null {
  if (raw === null) return null;
  if (!isRecord(raw)) {
    c.add('sender', 'sender must be an object or null');
    return null;
  }
  const v = raw.video;
  let video: SenderVideoStatus = {
    signalPresent: false,
    resolution: { width: 0, height: 0 },
    fieldRateMode: 0,
    fieldRate: 0,
    measuredFieldRate: 0,
    inputSource: null,
    inputSourceRaw: 0,
  };
  if (!isRecord(v)) {
    c.add('sender.video', 'video must be an object');
  } else {
    const res = isRecord(v.resolution) ? v.resolution : null;
    if (!res) c.add('sender.video.resolution', 'resolution must be an object');
    let inputSource: SenderInputSource | null = null;
    if (v.inputSource !== null) {
      if (typeof v.inputSource === 'string' && (SENDER_INPUT_SOURCES as readonly string[]).includes(v.inputSource)) {
        inputSource = v.inputSource as SenderInputSource;
      } else {
        c.add('sender.video.inputSource', `inputSource must be null or one of ${SENDER_INPUT_SOURCES.join(', ')}`);
      }
    }
    video = {
      signalPresent: c.bool(v, 'signalPresent', 'sender.video.'),
      resolution: {
        width: res ? c.int(res, 'width', 'sender.video.resolution.', 0, 0xffff) : 0,
        height: res ? c.int(res, 'height', 'sender.video.resolution.', 0, 0xffff) : 0,
      },
      fieldRateMode: c.int(v, 'fieldRateMode', 'sender.video.', 0, 0xff),
      fieldRate: c.int(v, 'fieldRate', 'sender.video.', 0, 0xffff),
      measuredFieldRate: c.int(v, 'measuredFieldRate', 'sender.video.', 0, 0xffff),
      inputSource,
      inputSourceRaw: c.int(v, 'inputSourceRaw', 'sender.video.', 0, 0xff),
    };
  }
  const ports: SenderPortStatus[] = [];
  if (!Array.isArray(raw.ports)) {
    c.add('sender.ports', 'ports must be an array');
  } else if (raw.ports.length > SENDER_MAX_PORTS) {
    c.add('sender.ports', `at most ${SENDER_MAX_PORTS} ports`);
  } else {
    const seen = new Set<number>();
    raw.ports.forEach((p: unknown, i: number) => {
      const path = `sender.ports[${i}].`;
      if (!isRecord(p)) {
        c.add(`sender.ports[${i}]`, 'port must be an object');
        return;
      }
      const portIndex = c.int(p, 'portIndex', path, 0, SENDER_MAX_PORTS - 1);
      if (seen.has(portIndex)) c.add(`${path}portIndex`, `duplicate port ${portIndex}`);
      seen.add(portIndex);
      const width = c.int(p, 'width', path, 0, 0xffff);
      const height = c.int(p, 'height', path, 0, 0xffff);
      ports.push({
        portIndex,
        enabled: c.bool(p, 'enabled', path),
        width,
        height,
        pixels: width * height,
        receivingCards: c.int(p, 'receivingCards', path, 0, 0xffff),
      });
    });
  }
  return { video, ports };
}

/** Raw register ranges accepted when *reading* a file (wider than what may be written back). */
const RECEIVER_REQUIRED = [
  ['moduleWidth', 0xff],
  ['moduleHeight', 0xff],
  ['scanMode', 0xff],
  ['physicalDataGroups', 0xff],
  ['driverIc', 0xff],
  ['refNumPerVs', 0xffff],
  ['grayDepth', 0xff],
  ['grayRealize', 0x0f],
  ['grayMode', 0x0f],
  ['gamma', 0xff],
] as const;
const RECEIVER_OPTIONAL = ['logicalDataGroups', 'groupsPerModule', 'moduleRows', 'decodeType', 'icPerGroup'] as const;

function validateReceivers(raw: unknown, c: Collector): ScreenConfigReceiver[] {
  const out: ScreenConfigReceiver[] = [];
  if (!Array.isArray(raw)) {
    c.add('receivers', 'receivers must be an array');
    return out;
  }
  if (raw.length > SCREEN_CONFIG_LIMITS.receivers) {
    c.add('receivers', `at most ${SCREEN_CONFIG_LIMITS.receivers} receiving cards`);
    return out;
  }
  const seen = new Set<string>();
  raw.forEach((r: unknown, i: number) => {
    const path = `receivers[${i}].`;
    if (!isRecord(r)) {
      c.add(`receivers[${i}]`, 'receiving card must be an object');
      return;
    }
    const bad = validateCardIndex(r.portIndex, r.cardIndex);
    if (bad) c.add(`receivers[${i}]`, bad);
    const portIndex = isInt(r.portIndex) ? r.portIndex : 0;
    const cardIndex = isInt(r.cardIndex) ? r.cardIndex : 0;
    const key = `${portIndex}:${cardIndex}`;
    if (!bad && seen.has(key)) c.add(`receivers[${i}]`, `duplicate card port ${portIndex} / card ${cardIndex}`);
    seen.add(key);
    const card: Record<string, number> = { portIndex, cardIndex };
    for (const [name, max] of RECEIVER_REQUIRED) card[name] = c.int(r, name, path, 0, max);
    for (const name of RECEIVER_OPTIONAL) {
      const v = c.optInt(r, name, path, 0, 0xff);
      if (v !== undefined) card[name] = v;
    }
    out.push(card as unknown as ScreenConfigReceiver);
  });
  return out;
}

function validateLayoutField(raw: unknown, c: Collector): LayoutModel | null {
  if (raw === null) return null;
  const shape = parseLayoutModel(raw);
  if (!shape) {
    c.add('layout', 'layout has the wrong shape');
    return null;
  }
  const { screen } = shape;
  const L = SCREEN_CONFIG_LIMITS;
  if (screen.rows < 1 || screen.cols < 1 || screen.rows > L.gridSide || screen.cols > L.gridSide || screen.rows * screen.cols > L.cabinets) {
    c.add('layout.screen', `rows and cols must be 1..${L.gridSide} with at most ${L.cabinets} cabinets`);
    return null;
  }
  const chained = shape.ports.reduce((n, p) => n + p.cabinets.length, 0);
  if (shape.ports.length > SENDER_MAX_PORTS || chained > L.cabinets || screen.overrides.length > L.cabinets) {
    c.add('layout', 'layout has too many ports or cabinets');
    return null;
  }
  const model: LayoutModel = {
    screen: {
      kind: screen.kind,
      rows: screen.rows,
      cols: screen.cols,
      cabinetWidth: screen.cabinetWidth,
      cabinetHeight: screen.cabinetHeight,
      overrides: screen.overrides.map((o) => ({ row: o.row, col: o.col, width: o.width, height: o.height })),
    },
    ports: shape.ports.map((p) => ({ port: p.port, cabinets: p.cabinets.map((cab) => ({ row: cab.row, col: cab.col })) })),
  };
  const issues = validateLayout(model, { maxPorts: SENDER_MAX_PORTS });
  if (layoutHasErrors(issues)) {
    const errors = issues.filter((i) => i.severity === 'error');
    for (const e of errors.slice(0, 5)) c.add('layout', `layout is invalid: ${describeLayoutIssue(e)}`);
    return null;
  }
  return model;
}

function validateLibrary(raw: unknown, c: Collector): ModuleProfile[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    c.add('moduleLibrary', 'moduleLibrary must be an array');
    return undefined;
  }
  if (raw.length > SCREEN_CONFIG_LIMITS.moduleLibrary) {
    c.add('moduleLibrary', `at most ${SCREEN_CONFIG_LIMITS.moduleLibrary} module profiles`);
    return undefined;
  }
  const res = validateModuleLibrary({ format: MODULE_LIBRARY_FORMAT, version: MODULE_LIBRARY_VERSION, profiles: raw });
  if (!res.ok) {
    for (const e of res.errors) c.add(e.field.replace(/^profiles/, 'moduleLibrary'), e.message);
    return undefined;
  }
  return res.profiles;
}

/**
 * Validate an unknown value as a screen config. On success returns a normalised copy (unknown
 * keys dropped, derived fields recomputed). Every problem is listed (up to 50).
 */
export function validateScreenConfig(input: unknown): ScreenConfigValidation {
  if (!isRecord(input)) return { ok: false, errors: [{ field: '', message: 'config must be an object' }] };
  if (input.format !== SCREEN_CONFIG_FORMAT) {
    return { ok: false, errors: [{ field: 'format', message: `format must be "${SCREEN_CONFIG_FORMAT}"` }] };
  }
  if (input.version !== SCREEN_CONFIG_VERSION) {
    const newer = isInt(input.version) && input.version > SCREEN_CONFIG_VERSION;
    return {
      ok: false,
      errors: [
        {
          field: 'version',
          message: newer
            ? `file version ${String(input.version)} is newer than this program understands (${SCREEN_CONFIG_VERSION})`
            : `unsupported version ${String(input.version)} (expected ${SCREEN_CONFIG_VERSION})`,
        },
      ],
    };
  }
  const c = new Collector();
  let savedAt = '';
  if (typeof input.savedAt !== 'string' || input.savedAt.length > 64 || !Number.isFinite(Date.parse(input.savedAt))) {
    c.add('savedAt', 'savedAt must be an ISO-8601 date-time');
  } else {
    savedAt = input.savedAt;
  }
  const controller = validateController(input.controller, c);
  const sender = input.sender === undefined ? (c.add('sender', 'sender is required (use null when unknown)'), null) : validateSender(input.sender, c);
  const receivers = validateReceivers(input.receivers, c);
  const layout =
    input.layout === undefined ? (c.add('layout', 'layout is required (use null when unknown)'), null) : validateLayoutField(input.layout, c);
  const moduleLibrary = validateLibrary(input.moduleLibrary, c);
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  const config: ScreenConfig = {
    format: SCREEN_CONFIG_FORMAT,
    version: SCREEN_CONFIG_VERSION,
    savedAt,
    controller,
    sender,
    receivers,
    layout,
  };
  if (moduleLibrary !== undefined) config.moduleLibrary = moduleLibrary;
  return { ok: true, config };
}

// ---------------------------------------------------------------------------------------------
// JSON

export function serializeScreenConfig(config: ScreenConfig): string {
  const doc: Record<string, unknown> = {
    format: config.format,
    version: config.version,
    savedAt: config.savedAt,
    controller: config.controller,
    sender: config.sender,
    receivers: config.receivers,
    layout: config.layout,
  };
  if (config.moduleLibrary !== undefined) doc.moduleLibrary = config.moduleLibrary;
  return JSON.stringify(doc, null, 2);
}

export function parseScreenConfigJson(json: string): ScreenConfigValidation {
  if (typeof json !== 'string') return { ok: false, errors: [{ field: '', message: 'config text must be a string' }] };
  if (json.length > SCREEN_CONFIG_MAX_BYTES) {
    return { ok: false, errors: [{ field: '', message: `file is larger than ${SCREEN_CONFIG_MAX_BYTES} bytes` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json); // tolerate a UTF-8 BOM
  } catch (err) {
    return { ok: false, errors: [{ field: '', message: `invalid JSON: ${(err as Error).message}` }] };
  }
  return validateScreenConfig(value);
}

// ---------------------------------------------------------------------------------------------
// Turning a stored receiving card back into writes

/**
 * Receiver fields a config application writes (via applyModuleProfile). Compared by the diff.
 * `driverIc` is only written when it is a real chip code (<= 254; 255 = Unknown) and `icPerGroup`
 * only when present.
 */
export const RECEIVER_WRITTEN_FIELDS = [
  'moduleWidth',
  'moduleHeight',
  'scanMode',
  'physicalDataGroups',
  'driverIc',
  'icPerGroup',
  'refNumPerVs',
  'gamma',
  'grayDepth',
  'grayRealize',
  'grayMode',
] as const;
export type ReceiverWrittenField = (typeof RECEIVER_WRITTEN_FIELDS)[number];

export type ReceiverWritePlan =
  | { kind: 'profile'; profile: ModuleProfile }
  | { kind: 'skip'; reason: 'unconfigured' | 'invalid'; errors: string[] };

/**
 * What applying `card` writes. A card whose module size is 0 was never configured: nothing is
 * written to it. A card with other register values outside the writable range is skipped with the
 * reasons (never clamped).
 */
export function receiverWritePlan(card: ScreenConfigReceiver): ReceiverWritePlan {
  if (card.moduleWidth === 0 || card.moduleHeight === 0) return { kind: 'skip', reason: 'unconfigured', errors: [] };
  const candidate: Record<string, unknown> = {
    name: `P${card.portIndex}C${card.cardIndex}`,
    width: card.moduleWidth,
    height: card.moduleHeight,
    scanMode: card.scanMode,
    dataGroups: card.physicalDataGroups,
    refNumPerVs: card.refNumPerVs,
    gamma: card.gamma,
    grayDepth: card.grayDepth,
    grayRealize: card.grayRealize,
    grayMode: card.grayMode,
  };
  if (card.driverIc <= 254) candidate.driverIc = card.driverIc;
  if (card.icPerGroup !== undefined) candidate.icPerGroup = card.icPerGroup;
  const res = validateModuleProfile(candidate);
  return res.ok
    ? { kind: 'profile', profile: res.profile }
    : { kind: 'skip', reason: 'invalid', errors: res.errors.map((e) => e.message) };
}

/** Strip telemetry from a freshly read card so it can go into a config. */
export function toConfigReceiver(p: ReceiverParameters): ScreenConfigReceiver {
  const { temperatureRaw: _t, voltageRaw: _v, ...rest } = p;
  void _t;
  void _v;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// Diff: file vs. current device

export type ConfigDiffSection = 'sender' | 'receiver' | 'layout';

/** One value that applying the file would change. `from` = device now, `to` = file; null = absent. */
export interface ConfigDiffItem {
  section: ConfigDiffSection;
  /** Stable key: sender: resolution | fieldRate | inputSource | portEnabled; receiver: a ReceiverWrittenField; layout: layout | complexScreen | portRegion | cardRect. */
  field: string;
  portIndex?: number;
  cardIndex?: number;
  from: string | null;
  to: string | null;
}

export interface ConfigDiff {
  items: ConfigDiffItem[];
  /** Cards in the file that the controller does not have (when the controller's cards are known). */
  missingCards: { portIndex: number; cardIndex: number }[];
  /** Cards in the file that applying leaves alone, with the reason. */
  skippedCards: { portIndex: number; cardIndex: number; reason: 'unconfigured' | 'invalid' }[];
  /** True when the model strings differ. */
  modelMismatch: boolean;
}

const cardKey = (p: number, c: number): string => `${p}:${c}`;

function receiverValue(card: ScreenConfigReceiver, field: ReceiverWrittenField): string | null {
  if (field === 'driverIc') return card.driverIc <= 254 ? String(card.driverIc) : null;
  const v = card[field];
  return v === undefined ? null : String(v);
}

/**
 * List what applying `file` to a device currently reading `device` would change. Nothing is
 * listed for values that already match, nor for sections that are null in the file. A section the
 * device side could not be read for (null / missing card) lists every file value with `from: null`.
 */
export function diffScreenConfig(file: ScreenConfig, device: ScreenConfig): ConfigDiff {
  const items: ConfigDiffItem[] = [];
  const diff: ConfigDiff = {
    items,
    missingCards: [],
    skippedCards: [],
    modelMismatch: file.controller.model !== device.controller.model,
  };

  // --- receivers ---------------------------------------------------------------------------
  const known = device.sender ? new Set(device.sender.ports.flatMap((p) => Array.from({ length: p.receivingCards }, (_, i) => cardKey(p.portIndex, i)))) : null;
  const deviceCards = new Map(device.receivers.map((r) => [cardKey(r.portIndex, r.cardIndex), r]));
  for (const card of [...file.receivers].sort((a, b) => a.portIndex - b.portIndex || a.cardIndex - b.cardIndex)) {
    const key = cardKey(card.portIndex, card.cardIndex);
    if (known && !known.has(key)) {
      diff.missingCards.push({ portIndex: card.portIndex, cardIndex: card.cardIndex });
      continue;
    }
    const plan = receiverWritePlan(card);
    if (plan.kind === 'skip') {
      diff.skippedCards.push({ portIndex: card.portIndex, cardIndex: card.cardIndex, reason: plan.reason });
      continue;
    }
    const current = deviceCards.get(key);
    for (const field of RECEIVER_WRITTEN_FIELDS) {
      const to = receiverValue(card, field);
      if (to === null) continue; // not written
      const from = current ? receiverValue(current, field) : null;
      if (from !== to) items.push({ section: 'receiver', field, portIndex: card.portIndex, cardIndex: card.cardIndex, from, to });
    }
  }

  // --- layout ------------------------------------------------------------------------------
  if (file.layout) {
    const want = planLayoutWrite(file.layout);
    const have = device.layout ? planLayoutWrite(device.layout) : null;
    if (!have) {
      items.push({ section: 'layout', field: 'layout', from: null, to: `${file.layout.screen.rows} x ${file.layout.screen.cols}` });
    } else {
      if (want.complexScreen !== have.complexScreen) {
        items.push({ section: 'layout', field: 'complexScreen', from: String(have.complexScreen), to: String(want.complexScreen) });
      }
      const rect = (r: { x: number; y: number; width: number; height: number } | undefined): string | null =>
        r ? `${r.width}x${r.height} @ ${r.x},${r.y}` : null;
      const haveP = new Map(have.ports.map((p) => [p.port, p]));
      for (const p of want.ports) {
        const h = haveP.get(p.port);
        if (rect(p) !== rect(h)) {
          items.push({ section: 'layout', field: 'portRegion', portIndex: p.port, from: rect(h), to: rect(p) });
        }
      }
      const haveC = new Map(have.cards.map((c) => [cardKey(c.port, c.index), c]));
      for (const c of want.cards) {
        const h = haveC.get(cardKey(c.port, c.index));
        if (rect(c) !== rect(h)) {
          items.push({ section: 'layout', field: 'cardRect', portIndex: c.port, cardIndex: c.index, from: rect(h), to: rect(c) });
        }
      }
    }
  }

  // --- sender ------------------------------------------------------------------------------
  if (file.sender) {
    const want = file.sender;
    const have = device.sender;
    const res = (v: { width: number; height: number }): string => `${v.width}x${v.height}`;
    if (!have || res(have.video.resolution) !== res(want.video.resolution)) {
      items.push({ section: 'sender', field: 'resolution', from: have ? res(have.video.resolution) : null, to: res(want.video.resolution) });
    }
    if (!have || have.video.fieldRate !== want.video.fieldRate) {
      items.push({ section: 'sender', field: 'fieldRate', from: have ? String(have.video.fieldRate) : null, to: String(want.video.fieldRate) });
    }
    if (want.video.inputSource !== null && (!have || have.video.inputSource !== want.video.inputSource)) {
      items.push({ section: 'sender', field: 'inputSource', from: have ? have.video.inputSource : null, to: want.video.inputSource });
    }
    const haveP = new Map((have?.ports ?? []).map((p) => [p.portIndex, p]));
    for (const p of want.ports) {
      const h = haveP.get(p.portIndex);
      if (have && !h) continue; // port does not exist on this controller
      if (!h || h.enabled !== p.enabled) {
        items.push({ section: 'sender', field: 'portEnabled', portIndex: p.portIndex, from: h ? String(h.enabled) : null, to: String(p.enabled) });
      }
    }
  }
  return diff;
}
