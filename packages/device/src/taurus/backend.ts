// Taurus back end: implements the core DeviceApi methods for `taurus:<host>` ids plus the TaurusApi,
// on top of @novastar/taurus 0.4.1. The device service (../service.ts) routes to it.
//
// What maps to what (every call below exists in the library's typings, `dist/index.d.mts`):
//
//   discover (hosts)        probeTaurusHost: library encodeTaurusDiscoveryRequest + parseTaurusDiscoveryResponse
//   discover (broadcast)    library discoverTaurusPlayers
//   connect                 TaurusClient.connect({host, port: tcpPort, privacy}) + client.login({sn, username?, password})
//                           + getLedScreenConfiguration + getReceivingCardVersions (card list, best effort)
//   getBrightness           client.getBrightness()   -> `ratio` (percent; the library sends `ratio: percent` on write)
//   setBrightness           client.setBrightness(percent, false)  volatile: the library says it "does not write flash"
//   saveTaurusBrightness    client.setBrightness(current, true)   persist flag = `solidity`
//   getTaurusSyncMode       client.getVideoConfiguration()
//   setTaurusSyncMode       client.setSynchronousMode({fallbackToInternal}) / client.setAsynchronousMode()
//   getTaurusVideoSources   client.getVideoSources() + getCurrentVideoSource() + getHdmiInputResolution()
//   getTaurusLightSensor    client.getEnvironmentBrightness()
//   readTaurusScreenConfig  client.getLedScreenConfiguration()
//   getTaurusInfo           the discovery record (TaurusPlayerInfo)
//
// NOT SUPPORTED (the library has no such call; searched its typings and source, see the report):
// test patterns, blackout / freeze, RGB gains. setTestPattern / setDisplayMode reject with
// INVALID_ARGUMENT; getBrightness reports red = green = blue = 100 and setBrightness rejects
// channel values other than 100.
//
// Passwords: see setTaurusCredentials below. There is no default password and nothing is stored
// beyond the single connect attempt that consumes it.

import {
  TaurusClient,
  TaurusResponseError,
  TaurusVideoMode,
  TaurusVideoSource,
  type TaurusPlayerInfo,
} from '@novastar/taurus';
import {
  DeviceError,
  TAURUS_ID_PREFIX,
  type BrightnessState,
  type ControllerInfo,
  type DiscoveredController,
  type DisplayMode,
  type ReceivingCardInfo,
  type TaurusApi,
  type TaurusCredentials,
  type TaurusInfo,
  type TaurusLightSensor,
  type TaurusScreenConfig,
  type TaurusSyncState,
  type TaurusVideoModeName,
  type TaurusVideoSourceName,
  type TaurusVideoSources,
  type TestPattern,
} from '@rockzalct/shared';
import { TAURUS_DISCOVERY_PORT, broadcastTaurusDiscovery, probeTaurusHost } from './discovery.js';
import { mapTaurusError } from './errors.js';

/** Receiving-card versions are read one request per card; stop at this many to keep connect() quick. */
export const MAX_CARDS_READ_ON_CONNECT = 64;

export interface TaurusBackendOptions {
  /** Connect / request timeout, default 2000 ms. */
  timeoutMs?: number;
  /** UDP port probed on explicit hosts, default 16601 (the library's TAURUS_DISCOVERY_PORT). */
  discoveryPort?: number;
  /** UDP broadcast discovery; default is the library's discoverTaurusPlayers. Injection point for tests. */
  findPlayers?: (timeoutMs: number) => Promise<TaurusPlayerInfo[]>;
  /** Whether the advanced user level is active; writes throw PERMISSION otherwise. */
  isAdvanced(): boolean;
}

export interface TaurusBackend extends TaurusApi {
  owns(id: unknown): boolean;
  /**
   * Ask `host` (UDP) whether it is a Taurus; rejects when nothing answers within `timeoutMs`. A
   * player that answers becomes known, so connect() can find it.
   */
  probe(host: string, timeoutMs: number): Promise<DiscoveredController>;
  /** Library UDP broadcast discovery; the players found become known. */
  broadcast(timeoutMs: number): Promise<DiscoveredController[]>;
  connect(id: string): Promise<ControllerInfo>;
  disconnect(id: string): Promise<void>;
  getBrightness(id: string): Promise<BrightnessState>;
  setBrightness(id: string, value: Partial<BrightnessState>): Promise<BrightnessState>;
  setTestPattern(id: string, pattern: TestPattern): Promise<void>;
  setDisplayMode(id: string, mode: DisplayMode): Promise<void>;
  dispose(): Promise<void>;
}

interface Entry {
  controller: DiscoveredController;
  player: TaurusPlayerInfo;
  client?: TaurusClient;
  /** Held only between setTaurusCredentials() and the connect() that consumes it. */
  credentials?: TaurusCredentials;
}

const FIELDS = ['percent', 'red', 'green', 'blue'] as const;

export function taurusController(player: TaurusPlayerInfo): DiscoveredController {
  const name = player.productName || 'Taurus';
  return {
    id: `${TAURUS_ID_PREFIX}${player.address}`,
    transport: 'taurus',
    address: player.address,
    port: player.tcpPort,
    label: `${name} ${player.address} (SN ${player.sn})`,
  };
}

const videoModeName = (mode: TaurusVideoMode): TaurusVideoModeName =>
  mode === TaurusVideoMode.HdmiPreferred ? 'hdmi-preferred' : mode === TaurusVideoMode.Manual ? 'manual' : 'scheduled';
const videoSourceName = (source: TaurusVideoSource): TaurusVideoSourceName =>
  source === TaurusVideoSource.Hdmi ? 'hdmi' : 'internal';

const hex = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase().padStart(4, '0')}`;

export function createTaurusBackend(options: TaurusBackendOptions): TaurusBackend {
  const timeoutMs = options.timeoutMs ?? 2000;
  const discoveryPort = options.discoveryPort ?? TAURUS_DISCOVERY_PORT;
  const registry = new Map<string, Entry>();

  const lookup = (id: unknown): Entry => {
    const entry = typeof id === 'string' ? registry.get(id) : undefined;
    if (!entry) throw new DeviceError('NOT_FOUND', `unknown controller id: ${String(id)}`);
    return entry;
  };
  const dropClient = (entry: Entry): void => {
    entry.client?.close();
    entry.client = undefined;
  };
  const clientOf = (id: string): { entry: Entry; client: TaurusClient } => {
    const entry = lookup(id);
    if (!entry.client || entry.client.connection.closed) {
      entry.client = undefined;
      throw new DeviceError('NOT_CONNECTED', `not connected: ${id}`);
    }
    return { entry, client: entry.client };
  };
  const requireAdvanced = (what: string): void => {
    if (!options.isAdvanced()) throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
  };

  /** Run `fn` on the connected client; library errors become DeviceErrors, a dead link drops the client. */
  async function use<T>(id: string, fn: (client: TaurusClient) => Promise<T>): Promise<T> {
    const { entry, client } = clientOf(id);
    try {
      return await fn(client);
    } catch (err) {
      const mapped = mapTaurusError(err);
      if (mapped.code === 'NOT_CONNECTED' || client.connection.closed) dropClient(entry);
      throw mapped;
    }
  }

  async function openClient(player: TaurusPlayerInfo): Promise<TaurusClient> {
    const pending = TaurusClient.connect({
      host: player.address,
      port: player.tcpPort,
      privacy: player.privacy,
      timeout: timeoutMs,
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      // TaurusClient.connect has no connect timeout of its own (its `timeout` is per request).
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new DeviceError('TIMEOUT', `timed out connecting to ${player.address}:${player.tcpPort}`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      // A connect that finishes after the timeout must not leak its socket.
      void pending.then(
        (late) => late.close(),
        () => undefined,
      );
      throw mapTaurusError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readCards(client: TaurusClient): Promise<{ outputPorts: number; cards: ReceivingCardInfo[] }> {
    try {
      const config = await client.getLedScreenConfiguration();
      const regions = config.screens.flatMap((s) => s.receivingCards);
      const seen = new Map<string, { port: number; receivingCard: number }>();
      for (const r of regions) seen.set(`${r.port}:${r.connection}`, { port: r.port, receivingCard: r.connection });
      const targets = [...seen.values()].slice(0, MAX_CARDS_READ_ON_CONNECT);
      const outputPorts = regions.reduce((max, r) => Math.max(max, r.port + 1), 0);
      const versions = targets.length > 0 ? await client.getReceivingCardVersions(targets) : [];
      const cards = versions.map<ReceivingCardInfo>((v) => ({
        portIndex: v.port,
        cardIndex: v.receivingCard,
        model: v.modelId === undefined ? 'Unknown' : `Unknown (${hex(v.modelId)})`,
        firmwareVersion:
          v.fpgaVersion || v.mcuVersion
            ? [v.fpgaVersion ? `FPGA ${v.fpgaVersion}` : '', v.mcuVersion ? `MCU ${v.mcuVersion}` : ''].filter(Boolean).join(' / ')
            : 'unknown',
      }));
      return { outputPorts, cards };
    } catch {
      // The card list is informational; a player that cannot answer it is still connected.
      return { outputPorts: 0, cards: [] };
    }
  }

  async function connect(id: string): Promise<ControllerInfo> {
    const entry = lookup(id);
    if (!entry.client || entry.client.connection.closed) {
      entry.client = undefined;
      // Credentials are single-use: forget them whatever happens next.
      const credentials = entry.credentials;
      entry.credentials = undefined;
      if (!credentials) {
        throw new DeviceError('PERMISSION', 'a Taurus password is required: call setTaurusCredentials before connect');
      }
      const client = await openClient(entry.player);
      try {
        const login = await client.login({
          sn: entry.player.sn,
          password: credentials.password,
          ...(credentials.username ? { username: credentials.username } : {}),
        });
        if (!login.logined) {
          throw new DeviceError('PERMISSION', 'the Taurus rejected the login (wrong username or password)');
        }
      } catch (err) {
        client.close();
        // A refused login may come back as a non-zero response status instead of `logined: false`.
        if (err instanceof TaurusResponseError) {
          throw new DeviceError('PERMISSION', `the Taurus rejected the login (status 0x${err.status.toString(16)})`);
        }
        throw mapTaurusError(err);
      }
      entry.client = client;
    }
    const client = entry.client;
    try {
      const { outputPorts, cards } = await readCards(client);
      return {
        id,
        family: 'taurus',
        model: entry.player.productName || 'Taurus',
        // The library exposes no player firmware version (searched: firmware, version, mcu/fpga of
        // the player itself); only receiving-card versions exist, listed in receivingCards.
        firmwareVersion: 'unknown',
        outputPorts,
        receivingCards: cards,
      };
    } catch (err) {
      await disconnect(id);
      throw mapTaurusError(err);
    }
  }

  async function disconnect(id: string): Promise<void> {
    const entry = lookup(id);
    entry.credentials = undefined;
    dropClient(entry);
  }

  async function readBrightness(client: TaurusClient): Promise<BrightnessState> {
    const b = await client.getBrightness();
    // The library writes `ratio: percent`, so `ratio` is the percentage. `brightness` is only a
    // fallback for a player that omits `ratio` (UNVERIFIED what unit it uses).
    const percent = b.ratio ?? b.brightness;
    if (percent === undefined) throw new DeviceError('PROTOCOL', 'the Taurus did not report a brightness');
    return { percent: Math.min(100, Math.max(0, Math.round(percent))), red: 100, green: 100, blue: 100 };
  }

  async function getBrightness(id: string): Promise<BrightnessState> {
    return use(id, readBrightness);
  }

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
      if (key !== 'percent' && v !== 100) {
        throw new DeviceError('INVALID_ARGUMENT', `not supported on Taurus: ${key} gain (only brightness percent can be set)`);
      }
    }
    clientOf(id);
    requireAdvanced('setting the brightness');
    return use(id, async (client) => {
      if (value.percent !== undefined) await client.setBrightness(Math.round(value.percent), false);
      return readBrightness(client);
    });
  }

  async function setTestPattern(id: string, _pattern: TestPattern): Promise<void> {
    lookup(id);
    throw new DeviceError('INVALID_ARGUMENT', 'not supported on Taurus: test patterns (@novastar/taurus has no such command)');
  }

  async function setDisplayMode(id: string, _mode: DisplayMode): Promise<void> {
    lookup(id);
    throw new DeviceError('INVALID_ARGUMENT', 'not supported on Taurus: blackout / freeze (@novastar/taurus has no such command)');
  }

  // ---- TaurusApi -----------------------------------------------------------------------------

  async function setTaurusCredentials(id: string, credentials: TaurusCredentials): Promise<void> {
    const entry = lookup(id);
    if (
      typeof credentials !== 'object' ||
      credentials === null ||
      typeof credentials.password !== 'string' ||
      credentials.password.length === 0 ||
      (credentials.username !== undefined && typeof credentials.username !== 'string')
    ) {
      throw new DeviceError('INVALID_ARGUMENT', 'credentials need a non-empty password string');
    }
    entry.credentials = { password: credentials.password, ...(credentials.username ? { username: credentials.username } : {}) };
  }

  async function getTaurusInfo(id: string): Promise<TaurusInfo> {
    const p = lookup(id).player;
    // `key` (present in some discovery answers) is deliberately not forwarded.
    return {
      sn: p.sn,
      productName: p.productName ?? '',
      modelId: p.modelId,
      aliasName: p.aliasName ?? '',
      platform: p.platform ?? '',
      address: p.address,
      tcpPort: p.tcpPort,
      ...(p.ftpPort !== undefined ? { ftpPort: p.ftpPort } : {}),
      privacy: p.privacy === true,
      width: p.width,
      height: p.height,
      rotation: p.rotation,
    };
  }

  async function getTaurusSyncMode(id: string): Promise<TaurusSyncState> {
    return use(id, async (client) => {
      const v = await client.getVideoConfiguration();
      const mode =
        v.mode === TaurusVideoMode.Scheduled
          ? 'other'
          : v.source === TaurusVideoSource.Hdmi
            ? 'synchronous'
            : v.mode === TaurusVideoMode.Manual
              ? 'asynchronous'
              : 'other';
      return {
        mode,
        videoMode: videoModeName(v.mode),
        videoSource: videoSourceName(v.source),
        fallbackToInternal: v.mode === TaurusVideoMode.HdmiPreferred,
        scaling: v.scaling,
        offset: { ...v.offset },
      };
    });
  }

  async function setTaurusSyncMode(
    id: string,
    mode: 'synchronous' | 'asynchronous',
    opts?: { fallbackToInternal?: boolean },
  ): Promise<void> {
    if (mode !== 'synchronous' && mode !== 'asynchronous') {
      throw new DeviceError('INVALID_ARGUMENT', `unknown sync mode: ${String(mode)}`);
    }
    clientOf(id);
    requireAdvanced('changing the sync mode');
    await use(id, async (client) => {
      if (mode === 'synchronous') await client.setSynchronousMode({ fallbackToInternal: opts?.fallbackToInternal === true });
      else await client.setAsynchronousMode();
    });
  }

  async function getTaurusVideoSources(id: string): Promise<TaurusVideoSources> {
    return use(id, async (client) => {
      const list = await client.getVideoSources();
      // Both extras are best effort: a player without an HDMI input simply fails them.
      const active = await client.getCurrentVideoSource().then(videoSourceName, () => undefined);
      const hdmiInput = await client.getHdmiInputResolution().then(
        (r) => ({ width: r.width, height: r.height, frameRate: r.frameRate }),
        () => undefined,
      );
      return {
        current: videoSourceName(list.currentSource),
        ...(active !== undefined ? { active } : {}),
        sources: list.sources.map((s) => ({
          source: s.source,
          name: s.name,
          internal: s.internal,
          connected: s.connected,
          width: s.width,
          height: s.height,
          frameRate: s.frameRate,
          supportedResolutions: s.supportedResolutions.map((r) => ({
            width: r.width,
            height: r.height,
            frameRates: [...r.frameRates],
          })),
        })),
        ...(hdmiInput !== undefined ? { hdmiInput } : {}),
      };
    });
  }

  async function getTaurusLightSensor(id: string): Promise<TaurusLightSensor> {
    return use(id, async (client) => {
      try {
        return { available: true, value: await client.getEnvironmentBrightness() };
      } catch (err) {
        // The library throws exactly this message when the value is missing or -1000.
        if (err instanceof Error && /ambient light sensor is unavailable/i.test(err.message)) return { available: false };
        throw err;
      }
    });
  }

  async function readTaurusScreenConfig(id: string): Promise<TaurusScreenConfig> {
    return use(id, async (client) => {
      const config = await client.getLedScreenConfiguration();
      return {
        screens: config.screens.map((s) => ({
          id: s.id,
          columns: s.columns,
          rows: s.rows,
          offset: { ...s.offset },
          width: s.size.width,
          height: s.size.height,
          portNumber: s.portNumber,
          receivingCards: s.receivingCards.length,
        })),
      };
    });
  }

  async function saveTaurusBrightness(id: string): Promise<BrightnessState> {
    clientOf(id);
    requireAdvanced('saving the brightness');
    return use(id, async (client) => {
      const current = await readBrightness(client);
      await client.setBrightness(current.percent, true);
      return readBrightness(client);
    });
  }

  /** Record a discovery answer; an existing entry keeps its live client and credentials. */
  const register = (player: TaurusPlayerInfo): DiscoveredController => {
    const controller = taurusController(player);
    const existing = registry.get(controller.id);
    if (existing) {
      existing.controller = controller;
      existing.player = player;
    } else {
      registry.set(controller.id, { controller, player });
    }
    return controller;
  };

  return {
    owns: (id) => typeof id === 'string' && id.startsWith(TAURUS_ID_PREFIX),
    async probe(host, probeTimeoutMs) {
      return register(await probeTaurusHost(host, discoveryPort, probeTimeoutMs));
    },
    async broadcast(broadcastTimeoutMs) {
      return (await (options.findPlayers ?? broadcastTaurusDiscovery)(broadcastTimeoutMs)).map(register);
    },
    connect,
    disconnect,
    getBrightness,
    setBrightness,
    setTestPattern,
    setDisplayMode,
    setTaurusCredentials,
    getTaurusInfo,
    getTaurusSyncMode,
    setTaurusSyncMode,
    getTaurusVideoSources,
    getTaurusLightSensor,
    readTaurusScreenConfig,
    saveTaurusBrightness,
    async dispose() {
      for (const e of registry.values()) {
        e.credentials = undefined;
        dropClient(e);
      }
    },
  };
}
