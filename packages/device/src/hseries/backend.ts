// H series back end: implements the core DeviceApi methods for `hseries:<host>:<port>` ids plus the
// HSeriesApi, on top of the UDP client. The device service (../service.ts) routes to it.
//
// Command codes, field names and their sources are in protocol.ts. Summary of what maps to what:
//   connect          R0118 until rate = 100, then R0100 (slot inventory)
//   getBrightness    R0400 + R0401 of the first screen: `brightness` (0..100, no scaling)
//   setBrightness    W0410 per screen with the percentage as is (actions.js:515-524), then read back
//   setTestPattern   W0303 per sending-card connector (see HSERIES_PATTERN_IDS)
//   setDisplayMode   blackout = W0700 (+ W040A off); freeze = W040A on every screen (+ W0700 off)
//   HSeriesApi       R0400/R0401/R0600/W0605/R0500/R0226/W0506/W0409/W0417
//
// NOT SUPPORTED by the protocol as read from the reference (searched, see the report): RGB channel
// gains / colour temperature. getBrightness therefore reports red = green = blue = 100 and
// setBrightness rejects channel values other than 100.

import {
  DeviceError,
  HSERIES_ID_PREFIX,
  type BrightnessState,
  type ControllerInfo,
  type DiscoveredController,
  type DisplayMode,
  type HSeriesApi,
  type HSeriesInput,
  type HSeriesLayer,
  type HSeriesPreset,
  type HSeriesScreen,
  type TestPattern,
} from '@rockzalct/shared';
import { HSeriesClient } from './client.js';
import {
  DEFAULT_HSERIES_PORT,
  HSERIES_TEST_PATTERN,
  INIT_READY_RATE,
  countSenderConnectors,
  parseDeviceDetails,
  parseInitRate,
  parseInputList,
  parseLayerList,
  parseOutputList,
  parsePresetList,
  parseScreenDetails,
  parseScreenList,
  reqBlackout,
  reqDeviceDetails,
  reqInitStatus,
  reqInputList,
  reqLayerList,
  reqLoadPreset,
  reqOutputList,
  reqPresetList,
  reqSaveBrightness,
  reqScreenBrightness,
  reqScreenDetails,
  reqScreenFreeze,
  reqScreenFtb,
  reqScreenList,
  reqSourceSwitch,
  reqTestPattern,
  selectTestPatternOutputs,
} from './protocol.js';

/**
 * Our TestPattern -> W0303 `testPattern` id (ids: constant.js:146-180).
 *   off -> 0xFFFF (constant.js:147), red/green/blue/white -> 1/2/3/4 (constant.js:150-153),
 *   horizontal-lines / vertical-lines -> Lines Horizontal / Vertical (constant.js:167-168).
 * UNVERIFIED (no exact counterpart on the H series, nearest pattern chosen):
 *   slash     -> 0x0203 "Lines: Diagonal Right" (constant.js:171); 0x0202 "Diagonal Left" is the other candidate
 *   grayscale -> 0x0103 "Gradient: White (Horizontal)" (constant.js:161), a white ramp
 */
export const HSERIES_PATTERN_IDS: Record<TestPattern, number> = {
  off: HSERIES_TEST_PATTERN.off,
  red: HSERIES_TEST_PATTERN.red,
  green: HSERIES_TEST_PATTERN.green,
  blue: HSERIES_TEST_PATTERN.blue,
  white: HSERIES_TEST_PATTERN.white,
  'horizontal-lines': HSERIES_TEST_PATTERN.linesHorizontal,
  'vertical-lines': HSERIES_TEST_PATTERN.linesVertical,
  slash: HSERIES_TEST_PATTERN.linesDiagonalRight,
  grayscale: HSERIES_TEST_PATTERN.gradientWhiteHorizontal,
};

export interface HSeriesBackendOptions {
  /** Wait per UDP attempt, default 2000 ms. */
  timeoutMs?: number;
  /** Extra attempts after a silent one, default 2 (capped by the client). */
  retries?: number;
  /** Default UDP port for hosts without an explicit one, default 6000. */
  port?: number;
  /** Total time connect() waits for the device to finish initialising (R0118 rate 100), default 10000 ms. */
  handshakeTimeoutMs?: number;
  /** Pause between R0118 polls while the device is still initialising, default 500 ms. */
  handshakePollMs?: number;
  /** Whether the advanced user level is active; writes throw PERMISSION otherwise. */
  isAdvanced(): boolean;
}

export interface HSeriesBackend extends HSeriesApi {
  /** Whether `id` belongs to this back end (`hseries:` prefix). */
  owns(id: unknown): boolean;
  /**
   * Handshake with `host:port` (a single R0118, no retries, `timeoutMs` budget). Resolves with the
   * controller when a device answers "Ok"; rejects otherwise. Does not keep the client.
   */
  probe(host: string, port: number | undefined, timeoutMs: number): Promise<DiscoveredController>;
  /** Make a controller known so connect() can find it (discover() does this). */
  remember(c: DiscoveredController): DiscoveredController;
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
  client?: HSeriesClient;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const FIELDS = ['percent', 'red', 'green', 'blue'] as const;
const isIndex = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffff;

export function hseriesController(host: string, port: number): DiscoveredController {
  return {
    id: `${HSERIES_ID_PREFIX}${host}:${port}`,
    transport: 'hseries',
    address: host,
    port,
    label: `${host}:${port} (H series)`,
  };
}

export function createHSeriesBackend(options: HSeriesBackendOptions): HSeriesBackend {
  const timeoutMs = options.timeoutMs ?? 2000;
  const retries = options.retries ?? 2;
  const defaultPort = options.port ?? DEFAULT_HSERIES_PORT;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const handshakePollMs = options.handshakePollMs ?? 500;
  const registry = new Map<string, Entry>();

  const lookup = (id: unknown): Entry => {
    const entry = typeof id === 'string' ? registry.get(id) : undefined;
    if (!entry) throw new DeviceError('NOT_FOUND', `unknown controller id: ${String(id)}`);
    return entry;
  };
  const clientOf = (id: string): HSeriesClient => {
    const entry = lookup(id);
    if (!entry.client) throw new DeviceError('NOT_CONNECTED', `not connected: ${id}`);
    return entry.client;
  };
  const requireAdvanced = (what: string): void => {
    if (!options.isAdvanced()) throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
  };

  const screens = async (c: HSeriesClient) => parseScreenList((await c.request(reqScreenList())).data);
  const details = async (c: HSeriesClient, screenId: number) =>
    parseScreenDetails((await c.request(reqScreenDetails(screenId))).data);

  async function readScreens(c: HSeriesClient): Promise<HSeriesScreen[]> {
    const out: HSeriesScreen[] = [];
    for (const s of await screens(c)) {
      const d = await details(c, s.screenId);
      out.push({ screenId: s.screenId, name: s.name, brightness: d.brightness, frozen: d.frozen, fadeToBlack: d.fadeToBlack });
    }
    return out;
  }

  const requireScreen = async (c: HSeriesClient, screenId: number): Promise<void> => {
    if (!isIndex(screenId)) throw new DeviceError('INVALID_ARGUMENT', `screenId must be a non-negative integer, got ${String(screenId)}`);
    if (!(await screens(c)).some((s) => s.screenId === screenId)) {
      throw new DeviceError('INVALID_ARGUMENT', `unknown screenId ${screenId}`);
    }
  };

  async function readBrightness(c: HSeriesClient): Promise<BrightnessState> {
    const list = await screens(c);
    const first = list[0];
    if (!first) throw new DeviceError('PROTOCOL', 'the H series reports no screens, so there is no brightness to read');
    // Brightness is per screen on an H series; the controller-level value is the first screen's.
    // UNVERIFIED that this is the most useful choice when screens differ (setBrightness sets all).
    const d = await details(c, first.screenId);
    // No RGB gain on the protocol (see file header): report full gain.
    return { percent: d.brightness, red: 100, green: 100, blue: 100 };
  }

  async function handshake(c: HSeriesClient): Promise<void> {
    const deadline = Date.now() + handshakeTimeoutMs;
    for (;;) {
      const rate = parseInitRate((await c.request(reqInitStatus())).data);
      if (rate === INIT_READY_RATE) return;
      if (Date.now() + handshakePollMs > deadline) {
        throw new DeviceError('PROTOCOL', `the H series is still initialising (rate ${rate}/${INIT_READY_RATE})`);
      }
      await sleep(handshakePollMs);
    }
  }

  async function connect(id: string): Promise<ControllerInfo> {
    const entry = lookup(id);
    if (!entry.client) {
      entry.client = new HSeriesClient({
        host: entry.controller.address,
        port: entry.controller.port ?? defaultPort,
        timeoutMs,
        retries,
      });
    }
    const client = entry.client;
    try {
      await handshake(client);
      const slots = parseDeviceDetails((await client.request(reqDeviceDetails())).data);
      return {
        id,
        family: 'hseries',
        // R0100/R0118 carry no model or firmware field (searched the reference: model, firmware,
        // version, deviceType, productName, deviceName, serial), so neither can be reported.
        model: 'H series',
        firmwareVersion: 'unknown',
        // Connectors on sending cards (cardType 3) play the role of Ethernet output ports.
        outputPorts: countSenderConnectors(slots),
        // Receiving cards are not exposed by the protocol as used by the reference.
        receivingCards: [],
      };
    } catch (err) {
      await disconnect(id);
      throw err;
    }
  }

  async function disconnect(id: string): Promise<void> {
    const entry = lookup(id);
    entry.client?.close();
    entry.client = undefined;
  }

  async function getBrightness(id: string): Promise<BrightnessState> {
    return readBrightness(clientOf(id));
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
        throw new DeviceError('INVALID_ARGUMENT', `not supported on H series: ${key} gain (only brightness percent can be set)`);
      }
    }
    const client = clientOf(id);
    requireAdvanced('setting the brightness');
    if (value.percent !== undefined) {
      const brightness = Math.round(value.percent);
      for (const s of await screens(client)) await client.request(reqScreenBrightness(s.screenId, brightness));
    }
    return readBrightness(client);
  }

  async function setTestPattern(id: string, pattern: TestPattern): Promise<void> {
    const patternId = Object.prototype.hasOwnProperty.call(HSERIES_PATTERN_IDS, pattern)
      ? HSERIES_PATTERN_IDS[pattern]
      : undefined;
    if (patternId === undefined) {
      throw new DeviceError('INVALID_ARGUMENT', `not supported on H series: test pattern ${String(pattern)}`);
    }
    const client = clientOf(id);
    requireAdvanced('showing a test pattern');
    const slots = parseDeviceDetails((await client.request(reqDeviceDetails())).data);
    const outputs = selectTestPatternOutputs(parseOutputList((await client.request(reqOutputList())).data), slots);
    if (outputs.length === 0) throw new DeviceError('PROTOCOL', 'the H series reports no output connectors for a test pattern');
    for (const o of outputs) await client.request(reqTestPattern(o.outputId, patternId));
  }

  async function setDisplayMode(id: string, mode: DisplayMode): Promise<void> {
    if (mode !== 'normal' && mode !== 'blackout' && mode !== 'freeze') {
      throw new DeviceError('INVALID_ARGUMENT', `unknown display mode: ${String(mode)}`);
    }
    const client = clientOf(id);
    requireAdvanced('changing the display mode');
    // The three modes are exclusive (like kill / lock on the MCTRL): blackout is the global W0700,
    // freeze is W040A on every screen.
    await client.request(reqBlackout(mode === 'blackout'));
    for (const s of await screens(client)) await client.request(reqScreenFreeze(s.screenId, mode === 'freeze'));
  }

  // ---- HSeriesApi ----------------------------------------------------------------------------

  async function listScreens(id: string): Promise<HSeriesScreen[]> {
    return readScreens(clientOf(id));
  }

  async function listPresets(id: string, screenId?: number): Promise<HSeriesPreset[]> {
    const client = clientOf(id);
    const targets = screenId === undefined ? (await screens(client)).map((s) => s.screenId) : [screenId];
    if (screenId !== undefined) await requireScreen(client, screenId);
    const out: HSeriesPreset[] = [];
    for (const sid of targets) {
      for (const p of parsePresetList((await client.request(reqPresetList(sid))).data)) out.push({ screenId: sid, ...p });
    }
    return out;
  }

  async function playPreset(id: string, screenId: number, presetId: number): Promise<void> {
    if (!isIndex(presetId)) throw new DeviceError('INVALID_ARGUMENT', `presetId must be a non-negative integer, got ${String(presetId)}`);
    const client = clientOf(id);
    requireAdvanced('playing a preset');
    await requireScreen(client, screenId);
    if (!parsePresetList((await client.request(reqPresetList(screenId))).data).some((p) => p.presetId === presetId)) {
      throw new DeviceError('INVALID_ARGUMENT', `screen ${screenId} has no preset ${presetId}`);
    }
    await client.request(reqLoadPreset(screenId, presetId));
  }

  async function listLayers(id: string, screenId?: number): Promise<HSeriesLayer[]> {
    const client = clientOf(id);
    const targets = screenId === undefined ? (await screens(client)).map((s) => s.screenId) : [screenId];
    if (screenId !== undefined) await requireScreen(client, screenId);
    const out: HSeriesLayer[] = [];
    for (const sid of targets) {
      for (const l of parseLayerList((await client.request(reqLayerList(sid))).data)) out.push({ screenId: sid, ...l });
    }
    return out;
  }

  async function inputs(client: HSeriesClient): Promise<HSeriesInput[]> {
    return parseInputList((await client.request(reqInputList())).data);
  }

  async function listInputs(id: string): Promise<HSeriesInput[]> {
    return inputs(clientOf(id));
  }

  async function setLayerInput(id: string, screenId: number, layerId: number, inputId: number, cropId = 255): Promise<void> {
    if (!isIndex(layerId)) throw new DeviceError('INVALID_ARGUMENT', `layerId must be a non-negative integer, got ${String(layerId)}`);
    if (!isIndex(inputId)) throw new DeviceError('INVALID_ARGUMENT', `inputId must be a non-negative integer, got ${String(inputId)}`);
    if (!isIndex(cropId)) throw new DeviceError('INVALID_ARGUMENT', `cropId must be a non-negative integer, got ${String(cropId)}`);
    const client = clientOf(id);
    requireAdvanced('switching a layer input');
    await requireScreen(client, screenId);
    if (!parseLayerList((await client.request(reqLayerList(screenId))).data).some((l) => l.layerId === layerId)) {
      throw new DeviceError('INVALID_ARGUMENT', `screen ${screenId} has no layer ${layerId}`);
    }
    const src = (await inputs(client)).find((i) => i.inputId === inputId && i.cropId === cropId);
    if (!src) throw new DeviceError('INVALID_ARGUMENT', `unknown input ${inputId} (crop ${cropId})`);
    await client.request(reqSourceSwitch(screenId, layerId, src));
  }

  async function fadeToBlack(id: string, screenId: number, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new DeviceError('INVALID_ARGUMENT', 'enabled must be a boolean');
    const client = clientOf(id);
    requireAdvanced('fade to black');
    await requireScreen(client, screenId);
    await client.request(reqScreenFtb(screenId, enabled));
  }

  async function saveScreenBrightness(id: string, screenId: number): Promise<void> {
    const client = clientOf(id);
    requireAdvanced('saving the brightness');
    await requireScreen(client, screenId);
    await client.request(reqSaveBrightness(screenId));
  }

  return {
    owns: (id) => typeof id === 'string' && id.startsWith(HSERIES_ID_PREFIX),
    async probe(host, port, probeTimeoutMs) {
      const p = port ?? defaultPort;
      const client = new HSeriesClient({ host, port: p, timeoutMs: probeTimeoutMs, retries: 0 });
      let timer: NodeJS.Timeout | undefined;
      try {
        // The overall budget also covers DNS, which the per-attempt timer does not.
        await Promise.race([
          client.request(reqInitStatus()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new DeviceError('TIMEOUT', `no H series answer from ${host}:${p}`)), probeTimeoutMs);
          }),
        ]);
        return hseriesController(host, p);
      } finally {
        if (timer) clearTimeout(timer);
        client.close();
      }
    },
    remember(c) {
      const existing = registry.get(c.id);
      if (existing) return existing.controller;
      registry.set(c.id, { controller: c });
      return c;
    },
    connect,
    disconnect,
    getBrightness,
    setBrightness,
    setTestPattern,
    setDisplayMode,
    listScreens,
    listPresets,
    playPreset,
    listLayers,
    listInputs,
    setLayerInput,
    fadeToBlack,
    saveScreenBrightness,
    async dispose() {
      for (const e of registry.values()) {
        e.client?.close();
        e.client = undefined;
      }
    },
  };
}
