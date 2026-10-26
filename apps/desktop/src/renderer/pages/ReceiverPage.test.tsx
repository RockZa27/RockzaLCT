import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceError, parseCabinetLibraryJson, type ReceiverParameters } from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const PARAMS: ReceiverParameters = {
  portIndex: 0,
  cardIndex: 0,
  moduleWidth: 64,
  moduleHeight: 32,
  scanMode: 16,
  physicalDataGroups: 8,
  logicalDataGroups: 8,
  driverIc: 33,
  refNumPerVs: 1920,
  grayDepth: 14,
  grayRealize: 1,
  grayMode: 2,
  gamma: 28,
};

const fakeReceiver = () =>
  makeFakeApi({
    getReceiverParameters: vi.fn(async (_id: string, port: number, card: number) => ({
      ...PARAMS,
      portIndex: port,
      cardIndex: card,
      moduleWidth: port === 1 ? 128 : 64,
    })),
    setReceiverParameters: vi.fn(async () => undefined),
    applyCabinetProfile: vi.fn(async () => undefined),
  });

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

const editGroup = () => within(screen.getByRole('group', { name: 'Edit refresh, gamma and grayscale' }));
const formGroup = () => within(screen.getByRole('group', { name: 'Cabinet definition' }));

beforeEach(() => {
  localStorage.clear();
});

describe('ReceiverPage', () => {
  it('is inert while not connected', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Receiving card' }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(api.getReceiverParameters).not.toHaveBeenCalled();
  });

  it('lists the controller cards, reads the first one and follows the picker', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');

    await waitFor(() => expect(api.getReceiverParameters).toHaveBeenCalledWith(CONTROLLER.id, 0, 0));
    expect(await screen.findByTestId('rp-size')).toHaveTextContent('64 × 32');
    expect(screen.getByTestId('rp-scan')).toHaveTextContent('16 (1/16 scan)');
    expect(screen.getByTestId('rp-refresh')).toHaveTextContent('1920');
    expect(screen.getByTestId('rp-gamma')).toHaveTextContent('28');
    expect(screen.getByTestId('rp-groups')).toHaveTextContent('8 / 8');

    const options = within(screen.getByRole('combobox', { name: 'Receiving card' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Port 1 / Card 1 (RC-A)', 'Port 2 / Card 1 (RC-B)']);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiving card' }), '1:0');
    await waitFor(() => expect(api.getReceiverParameters).toHaveBeenLastCalledWith(CONTROLLER.id, 1, 0));
    await waitFor(() => expect(screen.getByTestId('rp-size')).toHaveTextContent('128 × 32'));
  });

  it('locks every write control for normal users and unlocks them after advanced login', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');

    expect(screen.getByText(/Writing is locked/)).toBeInTheDocument();
    expect(editGroup().getByLabelText('Gamma (raw register value)')).toBeDisabled();
    expect(editGroup().getByLabelText('Refreshes per frame')).toBeDisabled();
    expect(editGroup().getByLabelText('Grayscale method')).toBeDisabled();
    expect(editGroup().getByRole('button', { name: 'Apply' })).toBeDisabled();

    // library entries can be created while locked, but not applied
    await user.type(formGroup().getByLabelText('Name'), 'Locked');
    await user.click(screen.getByRole('button', { name: 'Save cabinet' }));
    expect(screen.getByRole('button', { name: 'Apply to card Locked' })).toBeDisabled();

    await loginAdvanced(user);
    expect(screen.queryByText(/Writing is locked/)).not.toBeInTheDocument();
    expect(editGroup().getByLabelText('Gamma (raw register value)')).toBeEnabled();
    expect(editGroup().getByRole('button', { name: 'Apply' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Apply to card Locked' })).toBeEnabled();
  });

  it('writes edited values to the selected card, then reads back', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);

    fireEvent.change(editGroup().getByLabelText('Refreshes per frame'), { target: { value: '3840' } });
    fireEvent.change(editGroup().getByLabelText('Gamma (raw register value)'), { target: { value: '26' } });
    fireEvent.change(editGroup().getByLabelText('Grayscale depth (raw)'), { target: { value: '13' } });
    await user.selectOptions(editGroup().getByLabelText('Grayscale method'), '4');
    await user.selectOptions(editGroup().getByLabelText('Grayscale mode'), '3');

    const callsBefore = vi.mocked(api.getReceiverParameters).mock.calls.length;
    await user.click(editGroup().getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(api.setReceiverParameters).toHaveBeenCalledWith(
        CONTROLLER.id,
        { scope: 'card', portIndex: 0, cardIndex: 0 },
        { refNumPerVs: 3840, gamma: 26, grayDepth: 13, grayRealize: 4, grayMode: 3 },
      ),
    );
    expect(await screen.findByText('Receiving card settings applied')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(api.getReceiverParameters).mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('broadcasts when "all receiving cards" is ticked', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);

    await user.click(screen.getByLabelText('Apply to all receiving cards (broadcast)'));
    await user.click(editGroup().getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(api.setReceiverParameters).toHaveBeenCalledWith(
        CONTROLLER.id,
        { scope: 'all' },
        { refNumPerVs: 1920, gamma: 28, grayDepth: 14, grayRealize: 1, grayMode: 2 },
      ),
    );
  });

  it('shows a localised toast and keeps the form when the device refuses the write', async () => {
    const api = fakeReceiver();
    vi.mocked(api.setReceiverParameters).mockRejectedValueOnce(new DeviceError('PERMISSION', 'nope'));
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);

    fireEvent.change(editGroup().getByLabelText('Gamma (raw register value)'), { target: { value: '30' } });
    await user.click(editGroup().getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
    expect(screen.queryByText('Receiving card settings applied')).not.toBeInTheDocument();
    expect(editGroup().getByLabelText('Gamma (raw register value)')).toHaveValue(30);
  });

  it('manages the cabinet library: validate, save, persist, apply, delete', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);

    // an invalid draft (no name, width 0) is rejected with an inline alert and nothing is stored
    fireEvent.change(formGroup().getByLabelText('Width (px)'), { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'Save cabinet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid values: Name, Width (px)');
    expect(screen.getByText(/No cabinets yet/)).toBeInTheDocument();
    expect(localStorage.getItem('rockzalct.cabinets')).toBeNull();

    await user.type(formGroup().getByLabelText('Name'), 'P2.5 outdoor');
    fireEvent.change(formGroup().getByLabelText('Width (px)'), { target: { value: '96' } });
    fireEvent.change(formGroup().getByLabelText('Height (px)'), { target: { value: '48' } });
    fireEvent.change(formGroup().getByLabelText('Driver IC code (optional)'), { target: { value: '40' } });
    await user.selectOptions(formGroup().getByLabelText('Grayscale method'), '2');
    await user.click(screen.getByRole('button', { name: 'Save cabinet' }));
    expect(await screen.findByText('Cabinet saved: P2.5 outdoor')).toBeInTheDocument();

    const stored = parseCabinetLibraryJson(localStorage.getItem('rockzalct.cabinets') ?? '');
    expect(stored).toEqual({
      ok: true,
      profiles: [
        {
          name: 'P2.5 outdoor',
          width: 96,
          height: 48,
          scanMode: 16,
          dataGroups: 8,
          refNumPerVs: 1920,
          gamma: 28,
          grayDepth: 14,
          grayRealize: 2,
          grayMode: 1,
          driverIc: 40,
        },
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Apply to card P2.5 outdoor' }));
    await waitFor(() =>
      expect(api.applyCabinetProfile).toHaveBeenCalledWith(
        CONTROLLER.id,
        { scope: 'card', portIndex: 0, cardIndex: 0 },
        expect.objectContaining({ name: 'P2.5 outdoor', width: 96, height: 48, grayRealize: 2, driverIc: 40 }),
      ),
    );
    expect(await screen.findByText('Cabinet applied: P2.5 outdoor')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete P2.5 outdoor' }));
    expect(screen.getByText(/No cabinets yet/)).toBeInTheDocument();
    expect(parseCabinetLibraryJson(localStorage.getItem('rockzalct.cabinets') ?? '')).toEqual({ ok: true, profiles: [] });
  });

  it('captures the selected card into the form and round-trips the library through text', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');

    await user.click(screen.getByRole('button', { name: 'Capture from selected card' }));
    expect(formGroup().getByLabelText('Width (px)')).toHaveValue(64);
    expect(formGroup().getByLabelText('Driver IC code (optional)')).toHaveValue(33);
    expect(formGroup().getByLabelText('Grayscale method')).toHaveValue('1');

    await user.type(formGroup().getByLabelText('Name'), 'Captured');
    await user.click(screen.getByRole('button', { name: 'Save cabinet' }));
    await user.click(screen.getByRole('button', { name: 'Export to text' }));
    const box = screen.getByLabelText('Library JSON') as HTMLTextAreaElement;
    expect(parseCabinetLibraryJson(box.value)).toMatchObject({ ok: true, profiles: [{ name: 'Captured', width: 64 }] });

    // bad text is reported, library untouched
    fireEvent.change(box, { target: { value: '{"format":"nope"}' } });
    await user.click(screen.getByRole('button', { name: 'Import from text' }));
    expect(screen.getByText(/Import failed/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + Captured

    // good text merges entries
    const incoming = JSON.stringify({
      format: 'rockzalct.cabinet-library',
      version: 1,
      profiles: [{ name: 'Imported', width: 40, height: 20, scanMode: 8, dataGroups: 4, refNumPerVs: 960, gamma: 22, grayDepth: 12, grayRealize: 0, grayMode: 1 }],
    });
    fireEvent.change(box, { target: { value: incoming } });
    await user.click(screen.getByRole('button', { name: 'Import from text' }));
    expect(await screen.findByText('Imported 1 cabinets')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();
    expect(screen.getByText('Captured')).toBeInTheDocument();
  });

  it('renders in Thai', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'การ์ดรับ' }));
    expect(screen.getByRole('heading', { name: 'การ์ดรับ' })).toBeInTheDocument();
    expect(screen.getByText('ไลบรารีตู้')).toBeInTheDocument();
    expect(screen.getByText('กรุณาเชื่อมต่อตัวควบคุมก่อน')).toBeInTheDocument();
  });
});
