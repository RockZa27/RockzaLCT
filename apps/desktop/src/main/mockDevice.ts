import {
  DeviceError,
  type BrightnessState,
  type ControllerInfo,
  type DeviceApi,
  type DiscoveredController,
  type DisplayMode,
  type TestPattern,
} from '@rockzalct/shared';
import type { MockContext } from './mock/context';
import { createMockHSeries } from './mock/hseries';
import { createMockLayout } from './mock/layout';
import { createMockMonitor } from './mock/monitor';
import { createMockPersist } from './mock/persist';
import { createMockReceiver } from './mock/receiver';
import { createMockSender } from './mock/sender';

export const MOCK_ADVANCED_PASSWORD = 'rockza';

export interface MockDeviceOptions {
  /** Fixed latency in ms, or a function returning one. Default: 80-300 ms random. */
  latencyMs?: number | (() => number);
  /**
   * List the fake H5 (id `hseries:192.168.0.20:6000`) in an unfiltered discover(). Default false so
   * the two-controller default stays as it was; the H5 is always listed when `netHosts` names
   * 192.168.0.20, and always connectable by id. The desktop `mock` back end turns this on.
   */
  hseries?: boolean;
}

const PATTERNS: readonly TestPattern[] = [
  'off',
  'red',
  'green',
  'blue',
  'white',
  'horizontal-lines',
  'vertical-lines',
  'slash',
  'grayscale',
];
const MODES: readonly DisplayMode[] = ['normal', 'blackout', 'freeze'];

interface Fake {
  discovered: DiscoveredController;
  info: ControllerInfo;
  brightness: BrightnessState;
  pattern: TestPattern;
  mode: DisplayMode;
  connected: boolean;
}

const H5_ID = 'hseries:192.168.0.20:6000';

const makeCards = (ports: number, perPort: number, model: string, fw: string) =>
  Array.from({ length: ports * perPort }, (_, i) => ({
    portIndex: Math.floor(i / perPort),
    cardIndex: i % perPort,
    model,
    firmwareVersion: fw,
  }));

function buildFakes(): Fake[] {
  const serialId = 'serial:COM3';
  const netId = 'net:192.168.0.10:5200';
  return [
    {
      discovered: { id: serialId, transport: 'serial', address: 'COM3', label: 'COM3' },
      info: {
        id: serialId,
        model: 'MCTRL660 (mock)',
        firmwareVersion: '1.8.2',
        outputPorts: 4,
        receivingCards: makeCards(4, 2, 'A5s (mock)', '4.1.0'),
      },
      brightness: { percent: 80, red: 100, green: 100, blue: 100 },
      pattern: 'off',
      mode: 'normal',
      connected: false,
    },
    {
      discovered: {
        id: netId,
        transport: 'net',
        address: '192.168.0.10',
        port: 5200,
        label: '192.168.0.10:5200',
      },
      info: {
        id: netId,
        model: 'VX1000 (mock)',
        firmwareVersion: '2.3.5',
        outputPorts: 10,
        receivingCards: makeCards(10, 1, 'A8s (mock)', '5.0.3'),
      },
      brightness: { percent: 50, red: 95, green: 100, blue: 90 },
      pattern: 'off',
      mode: 'normal',
      connected: false,
    },
    {
      discovered: {
        id: H5_ID,
        transport: 'hseries',
        address: '192.168.0.20',
        port: 6000,
        label: '192.168.0.20:6000 (H series)',
      },
      info: {
        id: H5_ID,
        family: 'hseries',
        model: 'H series (mock H5)',
        firmwareVersion: 'unknown',
        outputPorts: 4,
        receivingCards: [],
      },
      // The H5 brightness lives in the H series state (per screen), see the branches below.
      brightness: { percent: 80, red: 100, green: 100, blue: 100 },
      pattern: 'off',
      mode: 'normal',
      connected: false,
    },
  ];
}

const isPercent = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;

/** In-memory DeviceApi with two fake controllers (one serial, one net). */
export function createMockDevice(options: MockDeviceOptions = {}): DeviceApi {
  const fakes = buildFakes();
  let advanced = false;

  const latency = (): number => {
    const l = options.latencyMs;
    if (typeof l === 'function') return l();
    if (typeof l === 'number') return l;
    return 80 + Math.random() * 220;
  };
  const delay = async (): Promise<void> => {
    const ms = latency();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  };

  const find = (id: string): Fake => {
    const f = fakes.find((x) => x.discovered.id === id);
    if (!f) throw new DeviceError('NOT_FOUND', `Controller ${id} not found`);
    return f;
  };
  const connectedFake = (id: string): Fake => {
    const f = find(id);
    if (!f.connected) throw new DeviceError('NOT_CONNECTED', `Controller ${id} is not connected`);
    return f;
  };

  const ctx: MockContext = {
    requireConnected: (id) => void connectedFake(id),
    delay,
    isAdvanced: () => advanced,
  };

  const hs = createMockHSeries(ctx);
  const isH = (f: Fake): boolean => f.info.family === 'hseries';
  const requireAdvanced = (what: string): void => {
    if (!advanced) throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
  };

  const sender = createMockSender(ctx);
  const receiver = createMockReceiver(ctx);
  const layout = createMockLayout(ctx);

  return {
    ...sender,
    ...receiver,
    ...layout,
    ...createMockPersist(ctx, { sender, receiver, layout }),
    ...createMockMonitor(ctx),
    ...hs.api,
    async discover(opts) {
      await delay();
      const hosts = opts?.netHosts?.map((h) => h.trim()).filter(Boolean) ?? [];
      return fakes
        .filter((f) =>
          isH(f)
            ? hosts.includes(f.discovered.address) || (options.hseries === true && hosts.length === 0)
            : f.discovered.transport === 'serial' || hosts.length === 0 || hosts.includes(f.discovered.address),
        )
        .map((f) => ({ ...f.discovered }));
    },

    async connect(id) {
      await delay();
      const f = find(id);
      f.connected = true;
      return structuredClone(f.info);
    },

    async disconnect(id) {
      await delay();
      const f = find(id);
      f.connected = false;
      f.pattern = 'off';
      f.mode = 'normal';
    },

    async getBrightness(id) {
      await delay();
      const f = connectedFake(id);
      // H series: brightness is per screen, the controller value is the first screen's; no RGB gain.
      if (isH(f)) return { percent: hs.state.screens[0]!.brightness, red: 100, green: 100, blue: 100 };
      return { ...f.brightness };
    },

    async setBrightness(id, value) {
      await delay();
      const f = connectedFake(id);
      for (const key of ['percent', 'red', 'green', 'blue'] as const) {
        const v = value[key];
        if (v !== undefined && !isPercent(v)) {
          throw new DeviceError('INVALID_ARGUMENT', `${key} must be a number between 0 and 100`);
        }
      }
      if (isH(f)) {
        for (const key of ['red', 'green', 'blue'] as const) {
          if (value[key] !== undefined && value[key] !== 100) {
            throw new DeviceError('INVALID_ARGUMENT', `not supported on H series: ${key} gain`);
          }
        }
        requireAdvanced('setting the brightness');
        if (value.percent !== undefined) for (const s of hs.state.screens) s.brightness = Math.round(value.percent);
        return { percent: hs.state.screens[0]!.brightness, red: 100, green: 100, blue: 100 };
      }
      f.brightness = {
        percent: Math.round(value.percent ?? f.brightness.percent),
        red: Math.round(value.red ?? f.brightness.red),
        green: Math.round(value.green ?? f.brightness.green),
        blue: Math.round(value.blue ?? f.brightness.blue),
      };
      return { ...f.brightness };
    },

    async setTestPattern(id, pattern) {
      await delay();
      const f = connectedFake(id);
      if (!PATTERNS.includes(pattern)) throw new DeviceError('INVALID_ARGUMENT', `Unknown pattern ${String(pattern)}`);
      if (isH(f)) requireAdvanced('showing a test pattern');
      f.pattern = pattern;
    },

    async setDisplayMode(id, mode) {
      await delay();
      const f = connectedFake(id);
      if (!MODES.includes(mode)) throw new DeviceError('INVALID_ARGUMENT', `Unknown mode ${String(mode)}`);
      if (isH(f)) {
        requireAdvanced('changing the display mode');
        hs.state.blackout = mode === 'blackout';
        for (const s of hs.state.screens) s.frozen = mode === 'freeze';
      }
      f.mode = mode;
    },

    async login(password) {
      await delay();
      advanced = password === MOCK_ADVANCED_PASSWORD;
      return advanced;
    },
  };
}
