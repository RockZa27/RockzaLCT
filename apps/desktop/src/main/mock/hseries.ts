import {
  DeviceError,
  isHSeriesId,
  type HSeriesApi,
  type HSeriesInput,
  type HSeriesLayer,
  type HSeriesPreset,
  type HSeriesScreen,
} from '@rockzalct/shared';
import type { MockContext } from './context';

interface MockScreen extends HSeriesScreen {
  layers: { layerId: number; name: string; inputId: number; cropId: number }[];
  presets: { presetId: number; name: string }[];
  lastPresetId?: number;
  savedBrightness?: number;
}

/** State the mock device shares with the H series API (brightness / freeze / blackout / pattern). */
export interface MockHSeriesState {
  screens: MockScreen[];
  inputs: HSeriesInput[];
  blackout: boolean;
}

const INPUTS: HSeriesInput[] = [
  { inputId: 0, cropId: 255, name: 'HDMI 1', slotId: 0, interfaceId: 0, interfaceType: 5, online: true },
  { inputId: 1, cropId: 255, name: 'HDMI 2', slotId: 0, interfaceId: 1, interfaceType: 5, online: true },
  { inputId: 2, cropId: 255, name: 'DVI 1', slotId: 0, interfaceId: 2, interfaceType: 2, online: true },
  { inputId: 0, cropId: 0, name: 'HDMI 1 left half', slotId: 0, interfaceId: 0, interfaceType: 5, online: true },
];

function build(): MockHSeriesState {
  const screens: MockScreen[] = [0, 1].map((i) => ({
    screenId: i,
    name: `Screen ${i + 1}`,
    brightness: 80,
    frozen: false,
    fadeToBlack: false,
    layers: [
      { layerId: 0, name: 'Layer 1', inputId: 0, cropId: 255 },
      { layerId: 1, name: 'Layer 2', inputId: 1, cropId: 255 },
    ],
    presets: [
      { presetId: 0, name: 'Opening' },
      { presetId: 1, name: 'Show' },
      { presetId: 2, name: 'Closing' },
    ],
  }));
  return { screens, inputs: INPUTS.map((i) => ({ ...i })), blackout: false };
}

/** In-memory H series API for the one fake H5. Mirrors the rules of the real back end. */
export function createMockHSeries(ctx: MockContext): { api: HSeriesApi; state: MockHSeriesState } {
  const state = build();

  const connected = async (id: string): Promise<void> => {
    await ctx.delay();
    ctx.requireConnected(id);
    if (!isHSeriesId(id)) throw new DeviceError('INVALID_ARGUMENT', 'only supported on H series controllers');
  };
  const advanced = (what: string): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', `${what} requires the advanced user level`);
  };
  const screen = (screenId: number): MockScreen => {
    const s = state.screens.find((x) => x.screenId === screenId);
    if (!s) throw new DeviceError('INVALID_ARGUMENT', `unknown screenId ${String(screenId)}`);
    return s;
  };

  const api: HSeriesApi = {
    async listScreens(id): Promise<HSeriesScreen[]> {
      await connected(id);
      return state.screens.map(({ screenId, name, brightness, frozen, fadeToBlack }) => ({
        screenId,
        name,
        brightness,
        frozen,
        fadeToBlack,
      }));
    },
    async listPresets(id, screenId): Promise<HSeriesPreset[]> {
      await connected(id);
      const list = screenId === undefined ? state.screens : [screen(screenId)];
      return list.flatMap((s) => s.presets.map((p) => ({ screenId: s.screenId, ...p })));
    },
    async playPreset(id, screenId, presetId): Promise<void> {
      await connected(id);
      advanced('playing a preset');
      const s = screen(screenId);
      if (!s.presets.some((p) => p.presetId === presetId)) {
        throw new DeviceError('INVALID_ARGUMENT', `screen ${screenId} has no preset ${String(presetId)}`);
      }
      s.lastPresetId = presetId;
    },
    async listLayers(id, screenId): Promise<HSeriesLayer[]> {
      await connected(id);
      const list = screenId === undefined ? state.screens : [screen(screenId)];
      return list.flatMap((s) => s.layers.map((l) => ({ screenId: s.screenId, layerId: l.layerId, name: l.name })));
    },
    async listInputs(id): Promise<HSeriesInput[]> {
      await connected(id);
      return state.inputs.map((i) => ({ ...i }));
    },
    async setLayerInput(id, screenId, layerId, inputId, cropId = 255): Promise<void> {
      await connected(id);
      advanced('switching a layer input');
      const s = screen(screenId);
      const layer = s.layers.find((l) => l.layerId === layerId);
      if (!layer) throw new DeviceError('INVALID_ARGUMENT', `screen ${screenId} has no layer ${String(layerId)}`);
      if (!state.inputs.some((i) => i.inputId === inputId && i.cropId === cropId)) {
        throw new DeviceError('INVALID_ARGUMENT', `unknown input ${String(inputId)} (crop ${String(cropId)})`);
      }
      layer.inputId = inputId;
      layer.cropId = cropId;
    },
    async fadeToBlack(id, screenId, enabled): Promise<void> {
      await connected(id);
      advanced('fade to black');
      if (typeof enabled !== 'boolean') throw new DeviceError('INVALID_ARGUMENT', 'enabled must be a boolean');
      screen(screenId).fadeToBlack = enabled;
    },
    async saveScreenBrightness(id, screenId): Promise<void> {
      await connected(id);
      advanced('saving the brightness');
      const s = screen(screenId);
      s.savedBrightness = s.brightness;
    },
  };
  return { api, state };
}
