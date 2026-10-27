import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  type SenderPortStatus,
  type SenderRedundancyStatus,
  type SenderVideoStatus,
} from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const VIDEO: SenderVideoStatus = {
  signalPresent: true,
  resolution: { width: 1920, height: 1080 },
  fieldRateMode: 1,
  fieldRate: 60,
  measuredFieldRate: 5994,
  inputSource: 'HDMI',
  inputSourceRaw: 5,
};
const PORTS: SenderPortStatus[] = [
  { portIndex: 0, enabled: true, width: 1024, height: 512, pixels: 524288, receivingCards: 2 },
  { portIndex: 1, enabled: false, width: 640, height: 480, pixels: 307200, receivingCards: 1 },
];
const RED: SenderRedundancyStatus = {
  loadMode: 'backup',
  spaces: [
    { space: 'legacy', raw: [0, 1], ports: [{ portIndex: 0, state: 'ok' }, { portIndex: 1, state: 'error' }] },
    { space: 'new', raw: [255, 0], ports: [{ portIndex: 0, state: 'unknown' }, { portIndex: 1, state: 'ok' }] },
  ],
};

const senderApi = (over: Parameters<typeof makeFakeApi>[0] = {}) =>
  makeFakeApi({
    getSenderVideo: vi.fn(async () => VIDEO),
    getSenderPorts: vi.fn(async () => PORTS),
    getSenderRedundancy: vi.fn(async () => RED),
    setSenderResolution: vi.fn(async (_id: string, r: { width: number; height: number }) => ({
      ...VIDEO,
      resolution: r,
    })),
    setSenderFieldRate: vi.fn(async (_id: string, fieldRate: number) => ({ ...VIDEO, fieldRate })),
    setSenderInputSource: vi.fn(async (_id: string, s: SenderVideoStatus['inputSource']) => ({
      ...VIDEO,
      inputSource: s,
    })),
    setSenderPortEnabled: vi.fn(async (_id: string, i: number, enabled: boolean) =>
      PORTS.map((p) => (p.portIndex === i ? { ...p, enabled } : p)),
    ),
    ...over,
  });

async function login(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

describe('SenderPage', () => {
  it('is fully disabled while not connected and reads nothing', async () => {
    const api = senderApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Sending card' }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply resolution' })).toBeDisabled();
    expect(screen.getByLabelText('Width (px)')).toBeDisabled();
    expect(screen.getByLabelText('Input source')).toBeDisabled();
    expect(api.getSenderVideo).not.toHaveBeenCalled();
    expect(api.getSenderPorts).not.toHaveBeenCalled();
    expect(api.getSenderRedundancy).not.toHaveBeenCalled();
  });

  it('reads values from the device on open and shows ports and redundancy', async () => {
    const api = senderApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Sending card');

    await waitFor(() => expect(screen.getByLabelText('Width (px)')).toHaveValue(1920));
    expect(api.getSenderVideo).toHaveBeenCalledWith(CONTROLLER.id);
    expect(screen.getByLabelText('Height (px)')).toHaveValue(1080);
    expect(screen.getByLabelText('Refresh rate (raw register)')).toHaveValue(60);
    expect(screen.getByLabelText('Input source')).toHaveValue('HDMI');
    expect(screen.getByTestId('video-signal')).toHaveTextContent('Detected');
    expect(screen.getByTestId('video-measured')).toHaveTextContent('5994');

    const row1 = await screen.findByTestId('port-row-1');
    expect(within(row1).getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByTestId('port-pixels-0')).toHaveTextContent('524,288');
    expect(screen.getByTestId('redundancy-mode')).toHaveTextContent('Backup load');
    expect(screen.getByTestId('redundancy-legacy-1')).toHaveTextContent('Error');
    expect(screen.getByTestId('redundancy-new-0')).toHaveTextContent('Unknown');
  });

  it('locks every writing control at the normal level', async () => {
    const api = senderApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Sending card');
    await waitFor(() => expect(screen.getByLabelText('Width (px)')).toHaveValue(1920));

    expect(screen.getByTestId('advanced-note')).toBeInTheDocument();
    expect(screen.getAllByTestId('locked-badge').length).toBeGreaterThanOrEqual(3);
    for (const name of ['Apply resolution', 'Apply refresh rate', 'Apply input source']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Height (px)')).toBeDisabled();
    expect(screen.getByLabelText('Refresh rate (raw register)')).toBeDisabled();
    expect(screen.getByLabelText('Input source')).toBeDisabled();
    expect(screen.getByLabelText('Port 1 enabled')).toBeDisabled();
    // Refresh stays available.
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('unlocks after advanced login and writes with the right arguments', async () => {
    const api = senderApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Sending card');
    await login(user);
    await waitFor(() => expect(screen.getByLabelText('Width (px)')).toHaveValue(1920));
    expect(screen.queryByTestId('advanced-note')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '1280' } });
    fireEvent.change(screen.getByLabelText('Height (px)'), { target: { value: '720' } });
    await user.click(screen.getByRole('button', { name: 'Apply resolution' }));
    await waitFor(() =>
      expect(api.setSenderResolution).toHaveBeenCalledWith(CONTROLLER.id, { width: 1280, height: 720 }),
    );
    expect(await screen.findByText('Resolution applied')).toBeInTheDocument();
    // The page adopts what the device reports back.
    expect(screen.getByLabelText('Width (px)')).toHaveValue(1280);

    fireEvent.change(screen.getByLabelText('Refresh rate (raw register)'), { target: { value: '50' } });
    await user.click(screen.getByRole('button', { name: 'Apply refresh rate' }));
    await waitFor(() => expect(api.setSenderFieldRate).toHaveBeenCalledWith(CONTROLLER.id, 50));

    await user.selectOptions(screen.getByLabelText('Input source'), 'DP');
    await user.click(screen.getByRole('button', { name: 'Apply input source' }));
    await waitFor(() => expect(api.setSenderInputSource).toHaveBeenCalledWith(CONTROLLER.id, 'DP'));

    await user.click(screen.getByLabelText('Port 2 enabled'));
    await waitFor(() => expect(api.setSenderPortEnabled).toHaveBeenCalledWith(CONTROLLER.id, 1, true));
    await waitFor(() => expect(screen.getByLabelText('Port 2 enabled')).toBeChecked());
  });

  it('clamps width to 1..65535', async () => {
    const { user } = renderApp(senderApi());
    await connectAndGo(user, screen, 'Sending card');
    await login(user);
    const w = await screen.findByLabelText('Width (px)');
    await waitFor(() => expect(w).toHaveValue(1920));
    fireEvent.change(w, { target: { value: '999999' } });
    expect(w).toHaveValue(65535);
    fireEvent.change(w, { target: { value: '0' } });
    expect(w).toHaveValue(1);
  });

  it('shows a localised toast and keeps the old values when a write fails', async () => {
    const api = senderApi({
      setSenderResolution: vi.fn(async () => {
        throw new DeviceError('PERMISSION', 'nope');
      }),
    });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Sending card');
    await login(user);
    await waitFor(() => expect(screen.getByLabelText('Width (px)')).toHaveValue(1920));
    fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '800' } });
    await user.click(screen.getByRole('button', { name: 'Apply resolution' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied. Advanced login required.');
    expect(screen.queryByText('Resolution applied')).not.toBeInTheDocument();
  });

  it('shows a localised error toast when the initial read fails', async () => {
    const api = senderApi({
      getSenderVideo: vi.fn(async () => {
        throw new DeviceError('TIMEOUT', 'slow');
      }),
    });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Sending card');
    expect(await screen.findByText('The controller did not respond in time.')).toBeInTheDocument();
    // The other sections still load.
    expect(await screen.findByTestId('port-row-0')).toBeInTheDocument();
  });

  it('flags an input-select value that maps to no known source', async () => {
    const api = senderApi({
      getSenderVideo: vi.fn(async () => ({ ...VIDEO, inputSource: null, inputSourceRaw: 200 })),
    });
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Sending card');
    expect(await screen.findByTestId('source-unknown')).toHaveTextContent('Unknown (raw 200)');
  });

  it('renders in Thai', async () => {
    const { user } = renderApp(senderApi(), 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'การ์ดส่ง' }));
    expect(await screen.findByText('พอร์ตเอาต์พุตอีเทอร์เน็ต')).toBeInTheDocument();
    expect(screen.getByTestId('redundancy-mode')).toHaveTextContent('โหลดสำรอง');
  });

  it('Refresh re-reads from the device', async () => {
    const api = senderApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Sending card');
    await waitFor(() => expect(api.getSenderVideo).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(api.getSenderVideo).toHaveBeenCalledTimes(2));
    expect(api.getSenderPorts).toHaveBeenCalledTimes(2);
    expect(api.getSenderRedundancy).toHaveBeenCalledTimes(2);
  });
});

describe('SenderPage: review regressions', () => {
  it('keeps input source, refresh rate and resolution disabled until the video status was read; Retry recovers', async () => {
    const getSenderVideo = vi
      .fn()
      .mockRejectedValueOnce(new DeviceError('TIMEOUT', 'x'))
      .mockResolvedValue(VIDEO);
    const api = senderApi({ getSenderVideo });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Sending card');
    await login(user);
    expect(await screen.findByTestId('sender-load-error')).toBeInTheDocument();
    for (const name of ['Apply input source', 'Apply refresh rate', 'Apply resolution']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Input source')).toBeDisabled();
    expect(api.setSenderInputSource).not.toHaveBeenCalled();
    expect(api.setSenderFieldRate).not.toHaveBeenCalled();

    await user.click(within(screen.getByTestId('sender-load-error')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply input source' })).toBeEnabled());
    expect(screen.getByLabelText('Input source')).toHaveValue('HDMI');
    expect(screen.getByRole('button', { name: 'Apply refresh rate' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Apply resolution' })).toBeEnabled();
  });
});
