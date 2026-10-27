import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  type ControllerInfo,
  type DiscoveredController,
  type TaurusInfo,
  type TaurusScreenConfig,
  type TaurusSyncState,
  type TaurusVideoSources,
} from '@rockzalct/shared';
import { makeFakeApi, renderApp } from '../testUtils';

const T_CONTROLLER: DiscoveredController = {
  id: 'taurus:10.0.0.7',
  transport: 'taurus',
  address: '10.0.0.7',
  port: 16606,
  label: 'TB60 10.0.0.7 (SN ABC)',
};
const T_INFO: ControllerInfo = {
  id: T_CONTROLLER.id,
  family: 'taurus',
  model: 'TB60',
  firmwareVersion: 'unknown',
  outputPorts: 1,
  receivingCards: [{ portIndex: 0, cardIndex: 0, model: 'Unknown (0x1A01)', firmwareVersion: 'FPGA 1 / MCU 2' }],
};
const PLAYER: TaurusInfo = {
  sn: 'ABC',
  productName: 'TB60',
  modelId: 1,
  aliasName: '',
  platform: 'android',
  address: '10.0.0.7',
  tcpPort: 16606,
  privacy: true,
  width: 1920,
  height: 1080,
  rotation: 0,
};
const SYNC: TaurusSyncState = {
  mode: 'asynchronous',
  videoMode: 'manual',
  videoSource: 'internal',
  fallbackToInternal: false,
  scaling: false,
  offset: { x: 0, y: 0 },
};
const SOURCES: TaurusVideoSources = {
  current: 'internal',
  active: 'internal',
  sources: [
    { source: 0, name: 'Internal', internal: true, connected: true, width: 1920, height: 1080, frameRate: 60, supportedResolutions: [] },
    { source: 1, name: 'HDMI', internal: false, connected: false, width: 0, height: 0, frameRate: 0, supportedResolutions: [] },
  ],
  hdmiInput: { width: 1920, height: 1080, frameRate: 60 },
};
const SCREENS: TaurusScreenConfig = {
  screens: [{ id: 0, columns: 2, rows: 1, offset: { x: 0, y: 0 }, width: 256, height: 128, portNumber: 1, receivingCards: 2 }],
};

const tApi = (over: Parameters<typeof makeFakeApi>[0] = {}) =>
  makeFakeApi({
    discover: vi.fn(async () => [T_CONTROLLER]),
    connect: vi.fn(async () => T_INFO),
    getBrightness: vi.fn(async () => ({ percent: 65, red: 100, green: 100, blue: 100 })),
    getTaurusInfo: vi.fn(async () => PLAYER),
    getTaurusLightSensor: vi.fn(async () => ({ available: true, value: 321 })),
    readTaurusScreenConfig: vi.fn(async () => SCREENS),
    getTaurusSyncMode: vi.fn(async () => SYNC),
    getTaurusVideoSources: vi.fn(async () => SOURCES),
    setTaurusCredentials: vi.fn(async () => undefined),
    ...over,
  });

type User = ReturnType<typeof renderApp>['user'];

/** Scan, press Connect on the Taurus, type the password in the prompt and submit. */
async function connectTaurus(user: User, password = 'pw', username?: string) {
  await user.click(screen.getByRole('button', { name: 'Scan' }));
  await user.click(await screen.findByRole('button', { name: 'Connect' }));
  const dialog = await screen.findByRole('dialog');
  if (username) await user.type(within(dialog).getByLabelText('Username (optional)'), username);
  await user.type(within(dialog).getByLabelText('Player password'), password);
  await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
}

async function login(user: User) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

const navNames = () =>
  within(screen.getByRole('navigation', { name: 'Main' }))
    .getAllByRole('button')
    .map((b) => b.textContent);

describe('connecting to a Taurus', () => {
  it('asks for the password first, sends credentials then connects, and does not connect before submitting', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('dialog', { name: /TB60 10\.0\.0\.7/ })).toBeInTheDocument();
    expect(api.connect).not.toHaveBeenCalled();
    // submit is disabled until a password is typed
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Username (optional)'), 'ops');
    await user.type(within(dialog).getByLabelText('Player password'), 'hunter2');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(api.connect).toHaveBeenCalledWith(T_CONTROLLER.id));
    expect(api.setTaurusCredentials).toHaveBeenCalledWith(T_CONTROLLER.id, { password: 'hunter2', username: 'ops' });
    // credentials are sent before the connect
    expect(vi.mocked(api.setTaurusCredentials).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(api.connect).mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByTestId('controller-info')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('omits the username when left empty', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user, 'pw');
    await waitFor(() => expect(api.setTaurusCredentials).toHaveBeenCalledWith(T_CONTROLLER.id, { password: 'pw' }));
  });

  it('a rejected password shows an inline error, keeps the prompt open and shows no error toast', async () => {
    const api = tApi({
      connect: vi.fn(async () => {
        throw new DeviceError('PERMISSION', 'rejected');
      }),
    });
    const { user } = renderApp(api);
    await connectTaurus(user, 'nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('The player rejected the login');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('Permission denied. Advanced login required.')).not.toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Not connected');
  });

  it('any other failure shows the usual localised error toast', async () => {
    const api = tApi({
      connect: vi.fn(async () => {
        throw new DeviceError('TIMEOUT', 'slow');
      }),
    });
    const { user } = renderApp(api);
    await connectTaurus(user);
    expect(await screen.findByText('The controller did not respond in time.')).toBeInTheDocument();
  });

  it('cancel closes the prompt without connecting', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setTaurusCredentials).not.toHaveBeenCalled();
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('an MCTRL controller connects without any prompt', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByTestId('controller-info');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setTaurusCredentials).not.toHaveBeenCalled();
  });
});

describe('navigation with a Taurus connected', () => {
  it('hides the MCTRL-only and H series pages and keeps Brightness, Test & Display and Taurus', async () => {
    const { user } = renderApp(tApi());
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    expect(navNames()).toEqual(['Connection', 'Brightness', 'Test & Display', 'Taurus']);
  });

  it('an MCTRL/VX hides the Taurus page', async () => {
    const { user } = renderApp(makeFakeApi());
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByTestId('controller-info');
    expect(navNames()).not.toContain('Taurus');
  });
});

describe('TaurusPage', () => {
  it('is disabled while not connected and reads nothing', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Taurus' }));
    expect(screen.getByText('Connect to a Taurus player first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(api.getTaurusSyncMode).not.toHaveBeenCalled();
  });

  it('reads and shows the player, sensor, screens, mode and sources', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Taurus' }));

    expect(await screen.findByTestId('taurus-model')).toHaveTextContent('TB60');
    for (const call of [api.getTaurusInfo, api.getTaurusLightSensor, api.readTaurusScreenConfig, api.getTaurusSyncMode, api.getTaurusVideoSources]) {
      expect(call).toHaveBeenCalledWith(T_CONTROLLER.id);
    }
    expect(screen.getByTestId('taurus-light')).toHaveTextContent('321');
    expect(screen.getByTestId('taurus-screen-size-0')).toHaveTextContent('256 x 128');
    expect(screen.getByTestId('taurus-sync-mode')).toHaveTextContent('Asynchronous (internal player)');
    expect(screen.getByTestId('taurus-active-source')).toHaveTextContent('Active source: Internal');
    expect(screen.getByTestId('taurus-hdmi-input')).toHaveTextContent('1920 x 1080 @ 60 Hz');
  });

  it('says so when there is no light sensor', async () => {
    const api = tApi({ getTaurusLightSensor: vi.fn(async () => ({ available: false })) });
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Taurus' }));
    expect(await screen.findByText('Not available on this player')).toBeInTheDocument();
  });

  it('writes are locked at the normal level and send nothing', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Taurus' }));
    await screen.findByTestId('taurus-model');
    expect(screen.getByTestId('advanced-note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use HDMI (synchronous)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use internal player (asynchronous)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save brightness to the player' })).toBeDisabled();
    expect(api.setTaurusSyncMode).not.toHaveBeenCalled();
  });

  it('switches the playback source (with and without fallback) and re-reads the mode', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Taurus' }));
    await screen.findByTestId('taurus-model');
    await login(user);

    const before = vi.mocked(api.getTaurusSyncMode).mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Use HDMI (synchronous)' }));
    expect(api.setTaurusSyncMode).toHaveBeenLastCalledWith(T_CONTROLLER.id, 'synchronous', { fallbackToInternal: false });
    expect(await screen.findByText('Playback source changed')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.getTaurusSyncMode).mock.calls.length).toBe(before + 1));

    await user.click(screen.getByRole('button', { name: 'Use HDMI, fall back to internal' }));
    expect(api.setTaurusSyncMode).toHaveBeenLastCalledWith(T_CONTROLLER.id, 'synchronous', { fallbackToInternal: true });
    await user.click(screen.getByRole('button', { name: 'Use internal player (asynchronous)' }));
    expect(api.setTaurusSyncMode).toHaveBeenLastCalledWith(T_CONTROLLER.id, 'asynchronous', undefined);
  });

  it('saves the brightness to the player', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Taurus' }));
    await screen.findByTestId('taurus-model');
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Save brightness to the player' }));
    expect(api.saveTaurusBrightness).toHaveBeenCalledWith(T_CONTROLLER.id);
    expect(await screen.findByText('Brightness saved to the player')).toBeInTheDocument();
  });

  it('a refused write shows an error toast and no success message', async () => {
    const api = tApi({
      setTaurusSyncMode: vi.fn(async () => {
        throw new DeviceError('PERMISSION', 'no');
      }),
    });
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Taurus' }));
    await screen.findByTestId('taurus-model');
    await login(user);
    await user.click(screen.getByRole('button', { name: 'Use HDMI (synchronous)' }));
    expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
    expect(screen.queryByText('Playback source changed')).not.toBeInTheDocument();
  });

  it('renders in Thai', async () => {
    const { user } = renderApp(tApi(), 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('รหัสผ่านของเครื่องเล่น'), 'pw');
    await user.click(within(dialog).getByRole('button', { name: 'เชื่อมต่อ' }));
    await user.click(await screen.findByRole('button', { name: 'Taurus' }));
    expect(await screen.findByText('เครื่องเล่น Taurus')).toBeInTheDocument();
    expect(await screen.findByText('แหล่งเล่นภาพ')).toBeInTheDocument();
  });
});

describe('Brightness and Test & Display on a Taurus', () => {
  it('Brightness shows only the global slider and sends only percent', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Brightness' }));
    await waitFor(() => expect(screen.getByLabelText('Global brightness (number)')).toHaveValue(65));
    expect(screen.queryByLabelText('Red gain')).not.toBeInTheDocument();
    expect(screen.getByText(/only the global brightness is available/)).toBeInTheDocument();
    // brightness needs no login on any family
    expect(screen.queryByTestId('advanced-note')).not.toBeInTheDocument();

    await login(user);
    fireEvent.change(screen.getByLabelText('Global brightness (number)'), { target: { value: '30' } });
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.setBrightness).toHaveBeenCalledWith(T_CONTROLLER.id, { percent: 30 }));
  });

  it('Test & Display explains that it is not supported and every button is disabled', async () => {
    const api = tApi();
    const { user } = renderApp(api);
    await connectTaurus(user);
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Test & Display' }));
    expect(screen.getByTestId('taurus-unsupported')).toHaveTextContent('not supported on Taurus players');
    for (const name of ['Red', 'Off', 'Blackout', 'Freeze', 'Normal']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(api.setTestPattern).not.toHaveBeenCalled();
  });

  it('Test & Display on an MCTRL stays usable and shows no Taurus note', async () => {
    const { user } = renderApp(makeFakeApi());
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Test & Display' }));
    expect(screen.queryByTestId('taurus-unsupported')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Red' })).toBeEnabled();
  });
});
