import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceError, parseModuleLibraryJson, type ReceiverParameters } from '@rockzalct/shared';
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
    applyModuleProfile: vi.fn(async () => undefined),
  });

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

const confirmDialog = async (user: ReturnType<typeof renderApp>['user']) =>
  user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));

const editGroup = () => within(screen.getByRole('group', { name: 'Edit refresh, gamma and grayscale' }));
const formGroup = () => within(screen.getByRole('group', { name: 'Module definition' }));

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
    await user.click(screen.getByRole('button', { name: 'Save module' }));
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
    await confirmDialog(user);
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
    await confirmDialog(user);
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
    await confirmDialog(user);
    expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
    expect(screen.queryByText('Receiving card settings applied')).not.toBeInTheDocument();
    expect(editGroup().getByLabelText('Gamma (raw register value)')).toHaveValue(30);
  });

  it('manages the module library: validate, save, persist, apply, delete', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);

    // an invalid draft (no name, width 0) is rejected with an inline alert and nothing is stored
    fireEvent.change(formGroup().getByLabelText('Width (px)'), { target: { value: '0' } });
    await user.click(screen.getByRole('button', { name: 'Save module' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid values: Name, Width (px)');
    expect(screen.getByText(/No modules yet/)).toBeInTheDocument();
    expect(localStorage.getItem('rockzalct.modules')).toBeNull();

    await user.type(formGroup().getByLabelText('Name'), 'P2.5 outdoor');
    fireEvent.change(formGroup().getByLabelText('Width (px)'), { target: { value: '96' } });
    fireEvent.change(formGroup().getByLabelText('Height (px)'), { target: { value: '48' } });
    fireEvent.change(formGroup().getByLabelText('Driver IC code (optional)'), { target: { value: '40' } });
    await user.selectOptions(formGroup().getByLabelText('Grayscale method'), '2');
    await user.click(screen.getByRole('button', { name: 'Save module' }));
    expect(await screen.findByText('Module saved: P2.5 outdoor')).toBeInTheDocument();

    const stored = parseModuleLibraryJson(localStorage.getItem('rockzalct.modules') ?? '');
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
    await confirmDialog(user);
    await waitFor(() =>
      expect(api.applyModuleProfile).toHaveBeenCalledWith(
        CONTROLLER.id,
        { scope: 'card', portIndex: 0, cardIndex: 0 },
        expect.objectContaining({ name: 'P2.5 outdoor', width: 96, height: 48, grayRealize: 2, driverIc: 40 }),
      ),
    );
    expect(await screen.findByText('Module applied: P2.5 outdoor')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete P2.5 outdoor' }));
    expect(screen.getByText(/No modules yet/)).toBeInTheDocument();
    expect(parseModuleLibraryJson(localStorage.getItem('rockzalct.modules') ?? '')).toEqual({ ok: true, profiles: [] });
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
    await user.click(screen.getByRole('button', { name: 'Save module' }));
    await user.click(screen.getByRole('button', { name: 'Export to text' }));
    const box = screen.getByLabelText('Library JSON') as HTMLTextAreaElement;
    expect(parseModuleLibraryJson(box.value)).toMatchObject({ ok: true, profiles: [{ name: 'Captured', width: 64 }] });

    // bad text is reported, library untouched
    fireEvent.change(box, { target: { value: '{"format":"nope"}' } });
    await user.click(screen.getByRole('button', { name: 'Import from text' }));
    expect(screen.getByText(/Import failed/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2); // header + Captured

    // good text merges entries
    const incoming = JSON.stringify({
      format: 'rockzalct.module-library',
      version: 1,
      profiles: [{ name: 'Imported', width: 40, height: 20, scanMode: 8, dataGroups: 4, refNumPerVs: 960, gamma: 22, grayDepth: 12, grayRealize: 0, grayMode: 1 }],
    });
    fireEvent.change(box, { target: { value: incoming } });
    await user.click(screen.getByRole('button', { name: 'Import from text' }));
    expect(await screen.findByText('Imported 1 modules')).toBeInTheDocument();
    expect(screen.getByText('Imported')).toBeInTheDocument();
    expect(screen.getByText('Captured')).toBeInTheDocument();
  });

  it('renders in Thai', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'การ์ดรับ' }));
    expect(screen.getByRole('heading', { name: 'การ์ดรับ' })).toBeInTheDocument();
    expect(screen.getByText('ไลบรารีโมดูล')).toBeInTheDocument();
    expect(screen.getByText('กรุณาเชื่อมต่อตัวควบคุมก่อน')).toBeInTheDocument();
  });
});

describe('ReceiverPage: review regressions', () => {
  it('discards a late response for card A after switching to card B, and never writes A values to B', async () => {
    let resolveA: (v: ReceiverParameters) => void = () => {};
    const api = makeFakeApi({
      getReceiverParameters: vi.fn((_id: string, port: number) =>
        port === 0
          ? new Promise<ReceiverParameters>((r) => {
              resolveA = r;
            })
          : Promise.resolve({ ...PARAMS, portIndex: 1, refNumPerVs: 2222, gamma: 30 }),
      ) as never,
      setReceiverParameters: vi.fn(async () => undefined),
    });
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await loginAdvanced(user);
    // card A (port 0) is still loading: Apply must be disabled
    expect(editGroup().getByRole('button', { name: 'Apply' })).toBeDisabled();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiving card' }), '1:0');
    await waitFor(() => expect(screen.getByTestId('rp-refresh')).toHaveTextContent('2222'));
    resolveA({ ...PARAMS, refNumPerVs: 1111, gamma: 22 }); // stale response arrives late
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('rp-refresh')).toHaveTextContent('2222');
    expect(editGroup().getByLabelText('Refreshes per frame')).toHaveValue(2222);

    await user.click(editGroup().getByRole('button', { name: 'Apply' }));
    await confirmDialog(user);
    await waitFor(() =>
      expect(api.setReceiverParameters).toHaveBeenCalledWith(
        CONTROLLER.id,
        { scope: 'card', portIndex: 1, cardIndex: 0 },
        expect.objectContaining({ refNumPerVs: 2222, gamma: 30 }),
      ),
    );
  });

  it('clears the form while the newly selected card is loading', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);
    vi.mocked(api.getReceiverParameters).mockImplementationOnce(() => new Promise(() => {}));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiving card' }), '1:0');
    expect(screen.queryByTestId('rp-size')).not.toBeInTheDocument();
    expect(editGroup().getByLabelText('Refreshes per frame')).toHaveValue(null);
    expect(editGroup().getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  it('asks for confirmation naming the exact card before writing settings, and Cancel writes nothing', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);

    await user.click(editGroup().getByRole('button', { name: 'Apply' }));
    expect(screen.getByTestId('rcv-confirm-target')).toHaveTextContent('Port 1 / Card 1');
    expect(api.setReceiverParameters).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setReceiverParameters).not.toHaveBeenCalled();
  });

  it('names "all N receiving cards" in the confirmation, for settings and module profiles, and flags the sticky checkbox', async () => {
    const api = fakeReceiver();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Receiving card');
    await screen.findByTestId('rp-size');
    await loginAdvanced(user);
    await user.type(formGroup().getByLabelText('Name'), 'M1');
    await user.click(screen.getByRole('button', { name: 'Save module' }));

    expect(screen.queryByTestId('rcv-all-warning')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Apply to all receiving cards (broadcast)'));
    expect(screen.getByTestId('rcv-all-warning')).toHaveTextContent('all 2 receiving cards');
    for (const b of screen.getAllByTestId('rcv-target')) expect(b).toHaveTextContent('all 2 receiving cards');

    await user.click(screen.getByRole('button', { name: 'Apply to card M1' }));
    expect(screen.getByTestId('rcv-confirm-target')).toHaveTextContent('all 2 receiving cards');
    expect(api.applyModuleProfile).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.applyModuleProfile).not.toHaveBeenCalled();

    await user.click(editGroup().getByRole('button', { name: 'Apply' }));
    expect(screen.getByTestId('rcv-confirm-target')).toHaveTextContent('all 2 receiving cards');
    await confirmDialog(user);
    await waitFor(() => expect(api.setReceiverParameters).toHaveBeenCalledWith(CONTROLLER.id, { scope: 'all' }, expect.anything()));
  });
});
