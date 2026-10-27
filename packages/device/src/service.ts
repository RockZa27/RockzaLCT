import { ConnectionClosedError, ResponseError, TimeoutError } from '@novastar/codec';
import { findNetDevices } from '@novastar/net';
import { findSendingCards } from '@novastar/serial';
import { TestModeEnum } from '@novastar/native/TestMode';
import {
  DeviceError,
  percentToRaw,
  rawToPercent,
  type BrightnessState,
  type ControllerInfo,
  type DeviceApi,
  type DiscoveredController,
  type DisplayMode,
  type ReceivingCardInfo,
  type TestPattern,
  type UserLevel,
} from '@rockzalct/shared';
import { createDefaultSessionFactory, DEFAULT_NET_PORT } from './factories.js';
import type { SessionFactory, SessionLike } from './session.js';
import type { FeatureContext } from './features/context.js';
import { createLayoutFeature } from './features/layout.js';
import { createMonitorFeature } from './features/monitor.js';
import { createPersistFeature } from './features/persist.js';
import { createReceiverFeature } from './features/receiver.js';
import { createSenderFeature } from './features/sender.js';

/** Sending-card address on the bus; the only (first) sender is addressed as 0. */
const SENDER = 0;
/** "All output ports / all receiving cards" selectors used for writes. */
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;
/** `cardType` argument of ReadNumberOfCardOrScanBoardInPort: 0 = receiving card. */
const CARD_TYPE_RECEIVING = 0;

/**
 * Test pattern -> value written by SetSelfTestMode. Values come from the `TestModeEnum` shipped in
 * @novastar/native (decompiled from the vendor library). 'off' = Reserved1_Mode (0) is assumed to
 * mean "no test pattern"; that assumption is UNVERIFIED on hardware.
 */
const TEST_PATTERN_MODE: Record<TestPattern, number> = {
  off: TestModeEnum.Reserved1_Mode,
  red: TestModeEnum.Red_Mode,
  green: TestModeEnum.Green_Mode,
  blue: TestModeEnum.Blue_Mode,
  white: TestModeEnum.White_Mode,
  'horizontal-lines': TestModeEnum.HorizonLine_Mode,
  'vertical-lines': TestModeEnum.VerticalLine_Mode,
  slash: TestModeEnum.InclineLine_Mode,
  grayscale: TestModeEnum.GrayIncrease_Mode,
};

/**
 * Byte values written by setDisplayMode via SetKillMode (blackout, receiving-card register
 * 0x02000100) and SetLockMode (freeze, register 0x02000102).
 *
 * UNVERIFIED ON HARDWARE. @novastar/native documents no on/off values for these registers. Evidence
 * used: both registers are 1 byte (AddressMapping.d.mts KillModeOccupancy/LockModeOccupancy = 1),
 * the decompiled structs expose `IsKillMode` as a boolean (ScanBoardRegionInfo.d.mts), and
 * ControlModeTypeEnum (ControlModeType.d.mts) is Normal=0, Black=1, Lock=2. So off=0 and on=1 was
 * chosen for both; if hardware wants lock=2 override `displayModeValues.lockOn` in the options.
 */
export const DISPLAY_MODE_VALUES = {
  killOn: 1,
  killOff: 0,
  lockOn: 1,
  lockOff: 0,
} as const;

export type DisplayModeValues = { [K in keyof typeof DISPLAY_MODE_VALUES]: number };

export interface DeviceServiceOptions {
  /** Override DISPLAY_MODE_VALUES (e.g. after a hardware test). */
  displayModeValues?: Partial<DisplayModeValues>;
  /** Creates sessions; default routes serial/net to the real @novastar bindings. */
  sessionFactory?: SessionFactory;
  /** Advanced-user password, default "admin". */
  advancedPassword?: string;
  /** Request / connect timeout, default 2000 ms. */
  timeoutMs?: number;
  /** Hosts probed by discover() when the caller passes no `netHosts`. */
  netHosts?: string[];
  /** TCP port for net hosts without an explicit port, default 5200. */
  netPort?: number;
  /** Also run UDP discovery (@novastar/net findNetDevices) in discover(); default false. */
  udpDiscovery?: boolean;
  /** Enumerate USB/COM sending cards in discover(); default true. */
  serialDiscovery?: boolean;
  /** Injection points for tests. */
  findSerialPaths?: () => Promise<string[]>;
  findUdpHosts?: () => Promise<string[]>;
}

export interface FirmwareDetails {
  mcu: string;
  fpga: string;
}

export interface DeviceService extends DeviceApi {
  getUserLevel(): UserLevel;
  /** MCU / FPGA versions read during connect(). */
  getFirmwareDetails(id: string): FirmwareDetails;
  /** Errors from the most recent discover() (per-host failures never fail the scan). */
  readonly lastDiscoveryErrors: ReadonlyArray<{ target: string; message: string }>;
  /** Disconnect everything. */
  dispose(): Promise<void>;
}

interface Entry {
  controller: DiscoveredController;
  session?: SessionLike;
  info?: ControllerInfo;
  firmware?: FirmwareDetails;
}

/** Version word -> "major.minor.patch" (+ ".build" when non-zero); layout as used by the simulator. */
export function formatEdition(edition: number): string {
  const v = edition >>> 0;
  const base = `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`;
  return (v & 0xff) === 0 ? base : `${base}.${v & 0xff}`;
}

/** No model-id table exists in @novastar/native, so every id is reported as unknown. */
export function modelName(modelId: number): string {
  return `Unknown (0x${(modelId >>> 0).toString(16).toUpperCase().padStart(4, '0')})`;
}

export function parseNetHost(entry: string, defaultPort: number): { host: string; port: number } | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { host: trimmed, port: defaultPort };
  const host = trimmed.slice(0, idx);
  const port = Number(trimmed.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Map codec / transport errors onto DeviceError codes. */
export function mapError(err: unknown): DeviceError {
  if (err instanceof DeviceError) return err;
  if (err instanceof TimeoutError) return new DeviceError('TIMEOUT', err.message);
  if (err instanceof ConnectionClosedError) return new DeviceError('NOT_CONNECTED', err.message);
  if (err instanceof ResponseError) return new DeviceError('PROTOCOL', err.message);
  const message = err instanceof Error ? err.message : String(err);
  return new DeviceError('PROTOCOL', message);
}

export function createDeviceService(options: DeviceServiceOptions = {}): DeviceService {
  const dmv: DisplayModeValues = { ...DISPLAY_MODE_VALUES, ...options.displayModeValues };
  const advancedPassword = options.advancedPassword ?? 'admin';
  const timeoutMs = options.timeoutMs ?? 2000;
  const netPort = options.netPort ?? DEFAULT_NET_PORT;
  const factory = options.sessionFactory ?? createDefaultSessionFactory({ net: { port: netPort } });
  const serialDiscovery = options.serialDiscovery ?? true;
  const findSerialPaths =
    options.findSerialPaths ?? (async () => (await findSendingCards()).map((p) => p.path));
  const findUdpHosts = options.findUdpHosts ?? (() => findNetDevices());

  const registry = new Map<string, Entry>();
  let userLevel: UserLevel = { level: 'normal' };
  let discoveryErrors: Array<{ target: string; message: string }> = [];

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw mapError(err);
    }
  };

  const lookup = (id: unknown): Entry => {
    const entry = typeof id === 'string' ? registry.get(id) : undefined;
    if (!entry) throw new DeviceError('NOT_FOUND', `unknown controller id: ${String(id)}`);
    return entry;
  };

  const connected = (id: string): { entry: Entry; session: SessionLike } => {
    const entry = lookup(id);
    if (!entry.session) throw new DeviceError('NOT_CONNECTED', `not connected: ${id}`);
    return { entry, session: entry.session };
  };

  /** Run `fn` on the session; a closed connection also drops the registry session. */
  const withSession = async <T>(id: string, fn: (s: SessionLike) => Promise<T>): Promise<T> => {
    const { entry, session } = connected(id);
    try {
      return await guard(() => fn(session));
    } catch (err) {
      if (err instanceof DeviceError && err.code === 'NOT_CONNECTED') {
        entry.session = undefined;
        entry.info = undefined;
      }
      throw err;
    }
  };

  const closeSession = async (entry: Entry): Promise<void> => {
    const session = entry.session;
    entry.session = undefined;
    entry.info = undefined;
    entry.firmware = undefined;
    if (!session) return;
    try {
      if (factory.close) await factory.close(entry.controller, session);
      else session.close();
    } catch {
      // Closing is best effort.
    }
  };

  const remember = (c: DiscoveredController): DiscoveredController => {
    const existing = registry.get(c.id);
    if (existing) return existing.controller;
    registry.set(c.id, { controller: c });
    return c;
  };

  const netController = (host: string, port: number): DiscoveredController => ({
    id: `net:${host}:${port}`,
    transport: 'net',
    address: host,
    port,
    label: `${host}:${port}`,
  });

  const record = (target: string, err: unknown): void => {
    discoveryErrors.push({ target, message: err instanceof Error ? err.message : String(err) });
  };

  /** Open a session, ask for the model id, then release it (unless already connected). */
  const probe = async (c: DiscoveredController, probeTimeout: number): Promise<boolean> => {
    const live = registry.get(c.id);
    if (live?.session) return true;
    let session: SessionLike | undefined;
    try {
      session = await factory.open(c, { timeoutMs: probeTimeout });
      await session.ReadControllerModelId(SENDER);
      return true;
    } catch (err) {
      record(c.id, err);
      return false;
    } finally {
      if (session && !registry.get(c.id)?.session) {
        try {
          if (factory.close) await factory.close(c, session);
          else session.close();
        } catch {
          // ignore
        }
      }
    }
  };

  async function discover(opts: { netHosts?: string[]; timeoutMs?: number } = {}): Promise<DiscoveredController[]> {
    discoveryErrors = [];
    const probeTimeout = opts.timeoutMs ?? timeoutMs;
    if (!(probeTimeout > 0)) throw new DeviceError('INVALID_ARGUMENT', 'timeoutMs must be positive');
    const found = new Map<string, DiscoveredController>();

    if (serialDiscovery) {
      try {
        for (const path of await findSerialPaths()) {
          const c: DiscoveredController = { id: `serial:${path}`, transport: 'serial', address: path, label: path };
          found.set(c.id, c);
        }
      } catch (err) {
        record('serial', err);
      }
    }

    const hosts = new Map<string, DiscoveredController>();
    for (const entry of opts.netHosts ?? options.netHosts ?? []) {
      const parsed = typeof entry === 'string' ? parseNetHost(entry, netPort) : null;
      if (!parsed) {
        record(String(entry), new Error('invalid host entry'));
        continue;
      }
      const c = netController(parsed.host, parsed.port);
      hosts.set(c.id, c);
    }
    if (options.udpDiscovery) {
      try {
        const withTimeout = await Promise.race([
          findUdpHosts(),
          new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error('UDP discovery timed out')), probeTimeout)),
        ]);
        for (const host of withTimeout) {
          const c = netController(host, netPort);
          if (!hosts.has(c.id)) hosts.set(c.id, c);
        }
      } catch (err) {
        record('udp', err);
      }
    }

    const results = await Promise.all(
      [...hosts.values()].map(async (c) => ((await probe(c, probeTimeout)) ? c : null)),
    );
    for (const c of results) if (c) found.set(c.id, c);

    return [...found.values()].map(remember);
  }

  async function readInfo(id: string, session: SessionLike): Promise<{ info: ControllerInfo; firmware: FirmwareDetails }> {
    const modelId = await session.ReadControllerModelId(SENDER);
    const mcu = formatEdition(await session.ReadSender_McuProgramEdition(SENDER));
    const fpga = formatEdition(await session.ReadSender_FPGAProgramEdition(SENDER));
    const perPort = await session.ReadScanerCountOfSenderCard(SENDER);
    let outputPorts = 0;
    perPort.forEach((n, port) => {
      if (n > 0) outputPorts = port + 1;
    });
    const receivingCards: ReceivingCardInfo[] = [];
    for (let portIndex = 0; portIndex < outputPorts; portIndex += 1) {
      const count = await session.ReadNumberOfCardOrScanBoardInPort(SENDER, portIndex, CARD_TYPE_RECEIVING);
      for (let cardIndex = 0; cardIndex < count; cardIndex += 1) {
        let firmwareVersion = 'unknown';
        try {
          firmwareVersion = formatEdition(await session.ReadScanner_McuProgramEdition(SENDER, portIndex, cardIndex));
        } catch (err) {
          if (!(err instanceof ResponseError)) throw err; // card did not answer: keep going
        }
        // No receiving-card model register/table exists in @novastar/native.
        receivingCards.push({ portIndex, cardIndex, model: 'Unknown', firmwareVersion });
      }
    }
    return {
      info: { id, model: modelName(modelId), firmwareVersion: mcu, outputPorts, receivingCards },
      firmware: { mcu, fpga },
    };
  }

  async function connect(id: string): Promise<ControllerInfo> {
    const entry = lookup(id);
    if (!entry.session) {
      const session = await guard(() => factory.open(entry.controller, { timeoutMs }));
      entry.session = session;
    }
    const session = entry.session;
    try {
      const { info, firmware } = await guard(() => readInfo(id, session));
      entry.info = info;
      entry.firmware = firmware;
      return info;
    } catch (err) {
      await closeSession(entry);
      throw err;
    }
  }

  async function disconnect(id: string): Promise<void> {
    await closeSession(lookup(id));
  }

  async function readBrightness(s: SessionLike): Promise<{ state: BrightnessState; vRed: number }> {
    const raw = await s.ReadAllBrightnessInfo(SENDER, 0, 0);
    if (raw.length < 4) throw new DeviceError('PROTOCOL', `short brightness block (${raw.length} bytes)`);
    return {
      state: {
        percent: rawToPercent(raw[0]!),
        red: rawToPercent(raw[1]!),
        green: rawToPercent(raw[2]!),
        blue: rawToPercent(raw[3]!),
      },
      vRed: raw[4] ?? raw[1]!,
    };
  }

  async function getBrightness(id: string): Promise<BrightnessState> {
    return withSession(id, async (s) => (await readBrightness(s)).state);
  }

  const FIELDS = ['percent', 'red', 'green', 'blue'] as const;

  async function setBrightness(id: string, value: Partial<BrightnessState>): Promise<BrightnessState> {
    if (typeof value !== 'object' || value === null) {
      throw new DeviceError('INVALID_ARGUMENT', 'brightness value must be an object');
    }
    for (const key of FIELDS) {
      const v = value[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) {
        throw new DeviceError('INVALID_ARGUMENT', `${key} must be a number between 0 and 100, got ${String(v)}`);
      }
    }
    connected(id); // NOT_FOUND / NOT_CONNECTED before any I/O
    return withSession(id, async (s) => {
      if (value.percent !== undefined) {
        await s.SetGlobalBrightness(SENDER, ALL_PORTS, ALL_CARDS, true, percentToRaw(value.percent));
      }
      if (value.red !== undefined || value.green !== undefined || value.blue !== undefined) {
        const cur = await readBrightness(s);
        const raw = (v: number | undefined, fallback: number): number => (v === undefined ? fallback : percentToRaw(v));
        await s.SetRGBBrightness(
          SENDER,
          ALL_PORTS,
          ALL_CARDS,
          true,
          raw(value.red, percentToRaw(cur.state.red)),
          raw(value.green, percentToRaw(cur.state.green)),
          raw(value.blue, percentToRaw(cur.state.blue)),
          cur.vRed,
        );
      }
      return (await readBrightness(s)).state;
    });
  }

  async function setTestPattern(id: string, pattern: TestPattern): Promise<void> {
    const mode = Object.prototype.hasOwnProperty.call(TEST_PATTERN_MODE, pattern)
      ? TEST_PATTERN_MODE[pattern]
      : undefined;
    if (mode === undefined) throw new DeviceError('INVALID_ARGUMENT', `unknown test pattern: ${String(pattern)}`);
    await withSession(id, (s) => s.SetSelfTestMode(SENDER, ALL_PORTS, ALL_CARDS, true, mode));
  }

  async function setDisplayMode(id: string, mode: DisplayMode): Promise<void> {
    if (mode !== 'normal' && mode !== 'blackout' && mode !== 'freeze') {
      throw new DeviceError('INVALID_ARGUMENT', `unknown display mode: ${String(mode)}`);
    }
    connected(id);
    // Blackout = kill register, freeze = lock register; they are independent of the test-pattern
    // register. 'normal' switches both off. Values: see DISPLAY_MODE_VALUES.
    const kill = mode === 'blackout' ? dmv.killOn : dmv.killOff;
    const lock = mode === 'freeze' ? dmv.lockOn : dmv.lockOff;
    await withSession(id, async (s) => {
      await s.SetKillMode(SENDER, ALL_PORTS, ALL_CARDS, true, kill);
      await s.SetLockMode(SENDER, ALL_PORTS, ALL_CARDS, true, lock);
    });
  }

  async function login(password: string): Promise<boolean> {
    if (typeof password !== 'string') throw new DeviceError('INVALID_ARGUMENT', 'password must be a string');
    const ok = password === advancedPassword;
    if (ok) userLevel = { level: 'advanced' };
    return ok;
  }

  const ctx: FeatureContext = { withSession, userLevel: () => ({ ...userLevel }), timeoutMs };

  return {
    ...createSenderFeature(ctx),
    ...createReceiverFeature(ctx),
    ...createLayoutFeature(ctx),
    ...createPersistFeature(ctx),
    ...createMonitorFeature(ctx),
    discover,
    connect,
    disconnect,
    getBrightness,
    setBrightness,
    setTestPattern,
    setDisplayMode,
    login,
    getUserLevel: () => ({ ...userLevel }),
    getFirmwareDetails(id: string): FirmwareDetails {
      const { entry } = connected(id);
      if (!entry.firmware) throw new DeviceError('NOT_CONNECTED', `not connected: ${id}`);
      return { ...entry.firmware };
    },
    get lastDiscoveryErrors() {
      return discoveryErrors;
    },
    async dispose(): Promise<void> {
      await Promise.all([...registry.values()].map(closeSession));
    },
  };
}
