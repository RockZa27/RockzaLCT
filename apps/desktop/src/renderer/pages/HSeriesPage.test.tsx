import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  type ControllerInfo,
  type DiscoveredController,
  type HSeriesInput,
  type HSeriesLayer,
  type HSeriesPreset,
  type HSeriesScreen,
} from '@rockzalct/shared';
import { connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const H_CONTROLLER: DiscoveredController = {
  id: 'hseries:10.0.0.5:6000',
  transport: 'hseries',
  address: '10.0.0.5',
  port: 6000,
  label: '10.0.0.5:6000 (H series)',
};
const H_INFO: ControllerInfo = {
  id: H_CONTROLLER.id,
  family: 'hseries',
  model: 'H series',
  firmwareVersion: 'unknown',
  outputPorts: 4,
  receivingCards: [],
};
const SCREENS: HSeriesScreen[] = [
  { screenId: 0, name: 'Stage', brightness: 80, frozen: false, fadeToBlack: false },
  { screenId: 1, name: 'Wall', brightness: 55, frozen: true, fadeToBlack: true },
];
const PRESETS: HSeriesPreset[] = [
  { screenId: 0, presetId: 0, name: 'Opening' },
  { screenId: 0, presetId: 1, name: 'Show' },
];
const LAYERS: HSeriesLayer[] = [
  { screenId: 0, layerId: 0, name: 'Layer 1' },
  { screenId: 1, layerId: 0, name: 'Layer 1' },
];
const INPUTS: HSeriesInput[] = [
  { inputId: 0, cropId: 255, name: 'HDMI 1', online: true },
  { inputId: 1, cropId: 255, name: 'HDMI 2', online: true },
  { inputId: 2, cropId: 255, name: 'Unplugged', online: false },
  { inputId: 0, cropId: 0, name: 'HDMI 1', online: true },
];

const hApi = (over: Parameters<typeof makeFakeApi>[0] = {}) =>
  makeFakeApi({
    discover: vi.fn(async () => [H_CONTROLLER]),
    connect: vi.fn(async () => H_INFO),
    getBrightness: vi.fn(async () => ({ percent: 80, red: 100, green: 100, blue: 100 })),
    listScreens: vi.fn(async () => SCREENS),
    listPresets: vi.fn(async () => PRESETS),
    listLayers: vi.fn(async () => LAYERS),
    listInputs: vi.fn(async () => INPUTS),
    ...over,
  });

async function login(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

const navNames = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('button')
    .map((b) => b.textContent);

describe('navigation per controller family', () => {
  it('shows every page when nothing is connected', () => {
    renderApp(makeFakeApi());
    expect(navNames()).toEqual([
      'Connection',
      'Brightness',
      'Test & Display',
      'H series',
      'Taurus',
      'Sending card',
      'Receiving card',
      'Screen connection',
      'Save & load',
      'Monitoring',
      'Calibration',
      'Function card & firmware',
      'Advanced hardware settings',
    ]);
  });

  it('an H series hides the MCTRL-only pages and keeps Brightness and Test & Display', async () => {
    const { user } = renderApp(hApi());
    await connectAndGo(user, screen);
    expect(navNames()).toEqual(['Connection', 'Brightness', 'Test & Display', 'H series', 'Advanced hardware settings']);
  });

  it('an MCTRL/VX hides the H series page', async () => {
    const { user } = renderApp(makeFakeApi());
    await connectAndGo(user, screen);
    expect(navNames()).not.toContain('H series');
    expect(navNames()).toContain('Sending card');
  });

  it('returns to every page after disconnecting', async () => {
    const { user } = renderApp(hApi());
    await connectAndGo(user, screen);
    await user.click(screen.getAllByRole('button', { name: 'Disconnect' })[0]!);
    await waitFor(() => expect(navNames()).toContain('Sending card'));
  });
});

describe('HSeriesPage', () => {
  it('is disabled while not connected and reads nothing', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'H series' }));
    expect(screen.getByText('Connect to an H series controller first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(api.listScreens).not.toHaveBeenCalled();
  });

  it('reads screens, presets, layers and inputs on open; offline inputs are not offered', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'H series');

    expect(await screen.findByTestId('hs-brightness-0')).toBeInTheDocument();
    expect(api.listScreens).toHaveBeenCalledWith(H_CONTROLLER.id);
    expect(api.listPresets).toHaveBeenCalledWith(H_CONTROLLER.id);
    expect(api.listLayers).toHaveBeenCalledWith(H_CONTROLLER.id);
    expect(api.listInputs).toHaveBeenCalledWith(H_CONTROLLER.id);

    expect(screen.getByTestId('hs-brightness-0')).toHaveTextContent('80%');
    expect(screen.getByTestId('hs-state-0')).toHaveTextContent('Live');
    expect(screen.getByTestId('hs-state-1')).toHaveTextContent('Frozen, Fade to black');
    expect(screen.getByRole('button', { name: 'Play: Stage / Opening' })).toBeInTheDocument();

    const select = screen.getByLabelText('Input: Stage / Layer 1');
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose an input', 'HDMI 1', 'HDMI 2', 'HDMI 1 (crop 1)']);
  });

  it('writes are locked at the normal level and send nothing', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'H series');
    await screen.findByTestId('hs-brightness-0');
    expect(screen.getByTestId('advanced-note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play: Stage / Opening' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fade to black: Stage' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save brightness: Stage' })).toBeDisabled();
    expect(screen.getByLabelText('Input: Stage / Layer 1')).toBeDisabled();
    expect(api.playPreset).not.toHaveBeenCalled();
  });

  it('plays a preset, then re-reads the screens', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'H series');
    await screen.findByTestId('hs-brightness-0');
    await login(user);
    const before = vi.mocked(api.listScreens).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Play: Stage / Show' }));
    expect(api.playPreset).toHaveBeenCalledWith(H_CONTROLLER.id, 0, 1);
    expect(await screen.findByText('Preset played: Show')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.listScreens).mock.calls.length).toBe(before + 1));
  });

  it('toggles fade to black from the reported state and saves brightness', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'H series');
    await screen.findByTestId('hs-brightness-0');
    await login(user);

    await user.click(screen.getByRole('button', { name: 'Fade to black: Stage' }));
    expect(api.fadeToBlack).toHaveBeenLastCalledWith(H_CONTROLLER.id, 0, true);
    // Wall is already faded: the button offers to cancel it
    await user.click(screen.getByRole('button', { name: 'Cancel fade: Wall' }));
    expect(api.fadeToBlack).toHaveBeenLastCalledWith(H_CONTROLLER.id, 1, false);

    await user.click(screen.getByRole('button', { name: 'Save brightness: Wall' }));
    expect(api.saveScreenBrightness).toHaveBeenCalledWith(H_CONTROLLER.id, 1);
  });

  it('switches a layer input only after one is chosen', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'H series');
    await screen.findByTestId('hs-brightness-0');
    await login(user);

    const apply = screen.getByRole('button', { name: 'Apply: Stage / Layer 1' });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Input: Stage / Layer 1'), { target: { value: '0:0' } });
    expect(apply).toBeEnabled();
    await user.click(apply);
    expect(api.setLayerInput).toHaveBeenCalledWith(H_CONTROLLER.id, 0, 0, 0, 0);

    fireEvent.change(screen.getByLabelText('Input: Wall / Layer 1'), { target: { value: '1:255' } });
    await user.click(screen.getByRole('button', { name: 'Apply: Wall / Layer 1' }));
    expect(api.setLayerInput).toHaveBeenLastCalledWith(H_CONTROLLER.id, 1, 0, 1, 255);
  });

  it('shows a localised error toast and no success message when the device refuses', async () => {
    const api = hApi({
      playPreset: vi.fn(async () => {
        throw new DeviceError('PERMISSION', 'nope');
      }),
    });
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'H series');
    await screen.findByTestId('hs-brightness-0');
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Play: Stage / Opening' }));
    expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
    expect(screen.queryByText('Preset played: Opening')).not.toBeInTheDocument();
  });

  it('renders in Thai', async () => {
    const { user } = renderApp(hApi(), 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    await user.click(await screen.findByRole('button', { name: 'H series' }));
    expect(await screen.findByText('วิดีโอวอลล์ H series')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'เล่น: Stage / Opening' })).toBeInTheDocument();
  });
});

describe('Brightness and Test & Display on an H series', () => {
  it('Brightness shows only the global slider and sends only percent', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Brightness');
    await waitFor(() => expect(screen.getByLabelText('Global brightness (number)')).toHaveValue(80));
    expect(screen.queryByLabelText('Red gain')).not.toBeInTheDocument();
    expect(screen.getByText(/RGB gain is not available/)).toBeInTheDocument();

    await login(user);
    fireEvent.change(screen.getByLabelText('Global brightness (number)'), { target: { value: '30' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.setBrightness).toHaveBeenCalledWith(H_CONTROLLER.id, { percent: 30 }));
  });

  it('Test & Display works and tells the user about the advanced requirement', async () => {
    const api = hApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Test & Display');
    expect(screen.getByTestId('advanced-note')).toBeInTheDocument();
    await login(user);
    expect(screen.queryByTestId('advanced-note')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Red' }));
    expect(api.setTestPattern).toHaveBeenCalledWith(H_CONTROLLER.id, 'red');
    await user.click(screen.getByRole('button', { name: 'Blackout' }));
    expect(api.setDisplayMode).toHaveBeenCalledWith(H_CONTROLLER.id, 'blackout');
  });

  it('the Brightness page on an MCTRL still shows the RGB channels', async () => {
    const { user } = renderApp(makeFakeApi());
    await connectAndGo(user, screen, 'Brightness');
    expect(await screen.findByLabelText('Red gain')).toBeInTheDocument();
  });
});
