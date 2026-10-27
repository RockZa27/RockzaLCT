import {
  DeviceError,
  isTaurusId,
  type TaurusApi,
  type TaurusCredentials,
  type TaurusInfo,
  type TaurusLightSensor,
  type TaurusScreenConfig,
  type TaurusSyncState,
  type TaurusVideoSources,
} from '@rockzalct/shared';
import type { MockContext } from './context';

/** Password of the one fake Taurus (mock back end only; the real back end never defaults one). */
export const MOCK_TAURUS_PASSWORD = 'taurus';

/** State the mock device shares with the Taurus API (brightness is read by the core methods). */
export interface MockTaurusState {
  brightness: number;
  persistedBrightness?: number;
  sync: TaurusSyncState;
  lightSensor: number | null;
  credentials?: TaurusCredentials;
}

export const MOCK_TAURUS_INFO: TaurusInfo = {
  sn: 'MOCKTB60000000001',
  productName: 'TB60',
  modelId: 0x6001,
  aliasName: 'Mock Taurus',
  platform: 'mock',
  address: '192.168.0.30',
  tcpPort: 16606,
  privacy: false,
  width: 256,
  height: 128,
  rotation: 0,
};

function build(): MockTaurusState {
  return {
    brightness: 70,
    sync: {
      mode: 'asynchronous',
      videoMode: 'manual',
      videoSource: 'internal',
      fallbackToInternal: false,
      scaling: false,
      offset: { x: 0, y: 0 },
    },
    lightSensor: 320,
  };
}

/** In-memory Taurus API for the one fake TB60. Mirrors the rules of the real back end. */
export function createMockTaurus(ctx: MockContext): { api: TaurusApi; state: MockTaurusState } {
  const state = build();

  const connected = async (id: string): Promise<void> => {
    await ctx.delay();
    ctx.requireConnected(id);
    if (!isTaurusId(id)) throw new DeviceError('INVALID_ARGUMENT', 'only supported on Taurus players');
  };
  const advanced = (what: string): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
  };

  const api: TaurusApi = {
    async setTaurusCredentials(id, credentials): Promise<void> {
      await ctx.delay();
      if (!isTaurusId(id)) throw new DeviceError('INVALID_ARGUMENT', 'only supported on Taurus players');
      if (typeof credentials?.password !== 'string' || credentials.password.length === 0) {
        throw new DeviceError('INVALID_ARGUMENT', 'credentials need a non-empty password string');
      }
      state.credentials = { ...credentials };
    },
    async getTaurusInfo(id): Promise<TaurusInfo> {
      await ctx.delay();
      if (!isTaurusId(id)) throw new DeviceError('INVALID_ARGUMENT', 'only supported on Taurus players');
      return { ...MOCK_TAURUS_INFO };
    },
    async getTaurusSyncMode(id): Promise<TaurusSyncState> {
      await connected(id);
      return structuredClone(state.sync);
    },
    async setTaurusSyncMode(id, mode, options): Promise<void> {
      await connected(id);
      if (mode !== 'synchronous' && mode !== 'asynchronous') {
        throw new DeviceError('INVALID_ARGUMENT', `unknown sync mode: ${String(mode)}`);
      }
      advanced('changing the sync mode');
      const fallback = mode === 'synchronous' && options?.fallbackToInternal === true;
      state.sync = {
        ...state.sync,
        mode,
        videoMode: fallback ? 'hdmi-preferred' : 'manual',
        videoSource: mode === 'synchronous' ? 'hdmi' : 'internal',
        fallbackToInternal: fallback,
      };
    },
    async getTaurusVideoSources(id): Promise<TaurusVideoSources> {
      await connected(id);
      return {
        current: state.sync.videoSource,
        active: state.sync.videoSource,
        sources: [
          { source: 0, name: 'Internal', internal: true, connected: true, width: 1920, height: 1080, frameRate: 60, supportedResolutions: [] },
          {
            source: 1,
            name: 'HDMI',
            internal: false,
            connected: true,
            width: 1920,
            height: 1080,
            frameRate: 60,
            supportedResolutions: [{ width: 1920, height: 1080, frameRates: [30, 50, 60] }],
          },
        ],
        hdmiInput: { width: 1920, height: 1080, frameRate: 60 },
      };
    },
    async getTaurusLightSensor(id): Promise<TaurusLightSensor> {
      await connected(id);
      return state.lightSensor === null ? { available: false } : { available: true, value: state.lightSensor };
    },
    async readTaurusScreenConfig(id): Promise<TaurusScreenConfig> {
      await connected(id);
      return {
        screens: [{ id: 0, columns: 2, rows: 1, offset: { x: 0, y: 0 }, width: 256, height: 128, portNumber: 1, receivingCards: 2 }],
      };
    },
    async saveTaurusBrightness(id) {
      await connected(id);
      advanced('saving the brightness');
      state.persistedBrightness = state.brightness;
      return { percent: state.brightness, red: 100, green: 100, blue: 100 };
    },
  };
  return { api, state };
}
