import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  parseModuleLibraryJson,
  serializeModuleLibrary,
  type ModuleProfile,
  type ReceiverParameters,
  type SaveToHardwareResult,
  type SmartChanges,
  type SmartSnapshot,
  type SmartWriteResult,
} from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const SNAP: SmartSnapshot = {
  portIndex: 0,
  cardIndex: 0,
  moduleWidth: 64,
  moduleHeight: 32,
  scanMode: 16,
  dataGroups: 8,
  driverIc: 33,
  decodeType: 3,
  dataDirection: 0,
  oePolarity: 0,
  rgb: { red: 0, green: 1, blue: 2, virtualRed: 0 },
};

const PARAMS: ReceiverParameters = {
  portIndex: 0,
  cardIndex: 0,
  moduleWidth: 64,
  moduleHeight: 32,
  scanMode: 16,
  physicalDataGroups: 8,
  driverIc: 33,
  refNumPerVs: 1920,
  grayDepth: 14,
  grayRealize: 1,
  grayMode: 2,
  gamma: 28,
  icPerGroup: 4,
};

const SAVE_OK: SaveToHardwareResult = { sender: null, cards: [{ portIndex: 0, cardIndex: 0, ok: true }], ok: true };

const ORDER = ['moduleWidth', 'moduleHeight', 'scanMode', 'driverIc', 'decodeType', 'dataGroups', 'dataDirection', 'rgb', 'oePolarity'];

const fakeSmart = (overrides: Parameters<typeof makeFakeApi>[0] = {}) =>
  makeFakeApi({
    readSmartSnapshot: vi.fn(async (_id: string, port: number, card: number) => ({ ...SNAP, portIndex: port, cardIndex: card })),
    writeSmartSettings: vi.fn(async (_id: string, _t: unknown, changes: SmartChanges): Promise<SmartWriteResult> => ({
      ok: true,
      written: ORDER.filter((f) => (changes as Record<string, unknown>)[f] !== undefined) as SmartWriteResult['written'],
    })),
    getReceiverParameters: vi.fn(async () => PARAMS),
    saveToHardware: vi.fn(async () => SAVE_OK),
    ...overrides,
  });

type User = ReturnType<typeof renderApp>['user'];

async function loginAdvanced(user: User) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

const confirmDialog = async (user: User) =>
  user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));

/** Connect, log in, open the page and take the snapshot. */
async function startWizard(api: ReturnType<typeof fakeSmart>, opts: { advanced?: boolean } = {}) {
  const { user } = renderApp(api);
  await connectAndGo(user, screen, 'Smart Settings');
  if (opts.advanced !== false) await loginAdvanced(user);
  await user.click(screen.getByRole('button', { name: 'Read snapshot' }));
  await screen.findByTestId('smart-snapshot-ok');
  return user;
}

const step = (user: User, name: RegExp) => user.click(screen.getByRole('button', { name }));
const writeCalls = (api: ReturnType<typeof fakeSmart>) => (api.writeSmartSettings as ReturnType<typeof vi.fn>).mock.calls;

beforeEach(() => {
  localStorage.clear();
});

describe('SmartSettingsPage', () => {
  it('is inert while not connected and states what is out of scope', async () => {
    const api = fakeSmart();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Smart Settings' }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read snapshot' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /2\. Module basics/ })).toBeDisabled();
    expect(screen.getByTestId('smart-limit-note')).toHaveTextContent(/still need a module config file made with NovaLCT/);
    expect(api.readSmartSnapshot).not.toHaveBeenCalled();
  });

  it('shows the out-of-scope note in Thai too', async () => {
    const { user } = renderApp(fakeSmart(), 'th');
    await user.click(screen.getByRole('button', { name: 'ตั้งค่าอัจฉริยะ (Smart Settings)' }));
    expect(screen.getByTestId('smart-limit-note')).toHaveTextContent(/NovaLCT/);
    expect(screen.getByTestId('smart-limit-note')).toHaveTextContent(/ไฟล์ตั้งค่าโมดูล/);
  });

  it('reads the snapshot of the chosen card and shows every value', async () => {
    const api = fakeSmart();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Smart Settings');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Receiving card' }), '1:0');
    await user.click(screen.getByRole('button', { name: 'Read snapshot' }));
    await screen.findByTestId('smart-snapshot-ok');
    expect(api.readSmartSnapshot).toHaveBeenCalledWith(CONTROLLER.id, 1, 0);
    expect(screen.getByTestId('smart-snapshot-ok')).toHaveTextContent('Port 2 / Card 1');
    expect(screen.getByTestId('snap-moduleWidth')).toHaveTextContent('64');
    expect(screen.getByTestId('snap-driverIc')).toHaveTextContent('33 (Chip_');
    expect(screen.getByTestId('snap-decodeType')).toHaveTextContent('3 (Decode595)');
    expect(screen.getByTestId('snap-dataDirection')).toHaveTextContent('Horizontal');
    expect(screen.getByTestId('snap-oePolarity')).toHaveTextContent('High enable');
    expect(screen.getByTestId('snap-rgb')).toHaveTextContent('R=0 G=1 B=2');
    expect(writeCalls(api)).toHaveLength(0);
  });

  it('keeps every other step disabled and writes nothing when the snapshot fails', async () => {
    const api = fakeSmart({
      readSmartSnapshot: vi.fn(async () => {
        throw new DeviceError('PROTOCOL', 'boom');
      }),
    });
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Smart Settings');
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Read snapshot' }));
    expect(await screen.findByText('Communication error with the controller.')).toBeInTheDocument();
    expect(screen.queryByTestId('smart-snapshot-ok')).not.toBeInTheDocument();
    for (const name of [/2\. Module basics/, /3\. RGB order/, /4\. OE polarity/, /5\. Finish/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.queryByRole('button', { name: 'Revert to snapshot' })).not.toBeInTheDocument();
    expect(writeCalls(api)).toHaveLength(0);
  });

  it('locks every write control for normal users', async () => {
    const api = fakeSmart();
    const user = await startWizard(api, { advanced: false });
    expect(screen.getByText(/Writing is locked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revert to snapshot' })).toBeDisabled();
    await step(user, /2\. Module basics/);
    expect(screen.getByLabelText('Module width (px)')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Apply module basics/ })).toBeDisabled();
    await step(user, /5\. Finish/);
    expect(screen.getByRole('button', { name: 'Save to card flash…' })).toBeDisabled();
    expect(writeCalls(api)).toHaveLength(0);
  });

  describe('module basics', () => {
    it('writes only the changed values to the chosen card after a confirmation', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /2\. Module basics/);
      expect(screen.getByLabelText('Module width (px)')).toHaveValue(64);
      expect(screen.getByRole('button', { name: /Apply module basics/ })).toBeDisabled(); // nothing changed yet

      fireEvent.change(screen.getByLabelText('Module width (px)'), { target: { value: '96' } });
      await user.selectOptions(screen.getByLabelText('Decoder'), '7');
      await user.selectOptions(screen.getByLabelText('Data direction'), '1');
      await user.click(screen.getByRole('button', { name: /Apply module basics/ }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('smart-confirm-target')).toHaveTextContent('Port 1 / Card 1');
      expect(within(dialog).getByText(/Module width \(px\): 64 → 96/)).toBeInTheDocument();
      expect(writeCalls(api)).toHaveLength(0); // nothing sent before the confirmation
      await confirmDialog(user);

      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      expect(writeCalls(api)[0]).toEqual([
        CONTROLLER.id,
        { scope: 'card', portIndex: 0, cardIndex: 0 },
        { moduleWidth: 96, decodeType: 7, dataDirection: 1 },
        undefined,
      ]);
      await waitFor(() => expect(screen.getByTestId('smart-dirty')).toHaveTextContent('differs from the snapshot'));
      expect(screen.getByRole('button', { name: /Apply module basics/ })).toBeDisabled(); // now in sync
    });

    it('sends nothing when the dialog is cancelled', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /2\. Module basics/);
      fireEvent.change(screen.getByLabelText('Module height (px)'), { target: { value: '16' } });
      await user.click(screen.getByRole('button', { name: /Apply module basics/ }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(writeCalls(api)).toHaveLength(0);
      expect(screen.getByTestId('smart-dirty')).toHaveTextContent('still holds the snapshot');
    });

    it('rejects values outside the shared limits before any write', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /2\. Module basics/);
      fireEvent.change(screen.getByLabelText('Module width (px)'), { target: { value: '0' } });
      expect(screen.getByRole('alert')).toHaveTextContent('Module width (px)');
      expect(screen.getByLabelText('Module width (px)')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: /Apply module basics/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Module width (px)'), { target: { value: '256' } });
      expect(screen.getByRole('button', { name: /Apply module basics/ })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Scan mode (1 = static, N = 1/N)'), { target: { value: '129' } });
      expect(screen.getByRole('alert')).toHaveTextContent('Scan mode');
      expect(writeCalls(api)).toHaveLength(0);
    });

    it('prefills the basics from the module library', async () => {
      const profile: ModuleProfile = {
        name: 'P2.5 96x48', width: 96, height: 48, scanMode: 24, dataGroups: 12,
        refNumPerVs: 2400, gamma: 26, grayDepth: 13, grayRealize: 2, grayMode: 0, driverIc: 40,
      };
      localStorage.setItem('rockzalct.modules', serializeModuleLibrary([profile]));
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /2\. Module basics/);
      await user.selectOptions(screen.getByLabelText('Prefill from module library'), 'P2.5 96x48');
      await user.click(screen.getByRole('button', { name: 'Use' }));
      expect(screen.getByLabelText('Module width (px)')).toHaveValue(96);
      expect(screen.getByLabelText('Module height (px)')).toHaveValue(48);
      expect(screen.getByLabelText('Scan mode (1 = static, N = 1/N)')).toHaveValue(24);
      expect(screen.getByLabelText('Data groups')).toHaveValue(12);
      expect(screen.getByLabelText('Driver IC (chip)')).toHaveValue('40');
      // prefilling writes nothing by itself
      expect(writeCalls(api)).toHaveLength(0);
      await user.click(screen.getByRole('button', { name: /Apply module basics/ }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      expect(writeCalls(api)[0]![2]).toEqual({ moduleWidth: 96, moduleHeight: 48, scanMode: 24, driverIc: 40, dataGroups: 12 });
    });
  });

  describe('RGB order', () => {
    const answer = async (user: User, shown: string, seen: string) =>
      user.click(screen.getByRole('radio', { name: `Showing ${shown}: I see ${seen}` }));

    it('shows each colour with the test-pattern API, computes the code and writes it after a confirmation', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /3\. RGB order/);
      expect(screen.getByText(/whole screen/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Show Red' }));
      expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'red');
      await answer(user, 'Red', 'Green');
      await user.click(screen.getByRole('button', { name: 'Show Green' }));
      expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'green');
      await answer(user, 'Green', 'Red');
      expect(screen.queryByTestId('smart-rgb-preview')).not.toBeInTheDocument(); // not all answered
      await user.click(screen.getByRole('button', { name: 'Show Blue' }));
      expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'blue');
      await answer(user, 'Blue', 'Blue');

      expect(screen.getByTestId('smart-rgb-preview')).toHaveTextContent('R=1 G=0 B=2 (virtual red 0)');
      await user.click(screen.getByRole('button', { name: /Write RGB order/ }));
      expect(writeCalls(api)).toHaveLength(0);
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      expect(writeCalls(api)[0]).toEqual([
        CONTROLLER.id,
        { scope: 'card', portIndex: 0, cardIndex: 0 },
        { rgb: { red: 1, green: 0, blue: 2, virtualRed: 0 } },
        undefined,
      ]);
      expect(await screen.findByTestId('smart-rgb-retry')).toBeInTheDocument();
      // a swap has the same answer in both conventions, but the user may still try the opposite one
      expect(screen.getByRole('radio', { name: 'Showing Red: I see Green' })).not.toBeChecked(); // answers were cleared
    });

    it('says nothing needs writing when the colours are already right', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /3\. RGB order/);
      await answer(user, 'Red', 'Red');
      await answer(user, 'Green', 'Green');
      await answer(user, 'Blue', 'Blue');
      expect(screen.getByTestId('smart-rgb-ok')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Write RGB order/ })).not.toBeInTheDocument();
    });

    it('refuses answers that are not a valid order', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /3\. RGB order/);
      await answer(user, 'Red', 'Green');
      await answer(user, 'Green', 'Green');
      await answer(user, 'Blue', 'Black / other');
      expect(screen.getByTestId('smart-rgb-invalid')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Write RGB order/ })).not.toBeInTheDocument();
      expect(writeCalls(api)).toHaveLength(0);
    });

    it('offers the opposite mapping after a write and uses the same answers', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /3\. RGB order/);
      // red->green, green->blue, blue->red (a rotation, where the two conventions differ)
      await answer(user, 'Red', 'Green');
      await answer(user, 'Green', 'Blue');
      await answer(user, 'Blue', 'Red');
      await user.click(screen.getByRole('button', { name: /Write RGB order/ }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      expect(writeCalls(api)[0]![2]).toEqual({ rgb: { red: 2, green: 0, blue: 1, virtualRed: 0 } });

      await user.click(await screen.findByRole('button', { name: 'Try the opposite mapping' }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(2));
      expect(writeCalls(api)[1]![2]).toEqual({ rgb: { red: 1, green: 2, blue: 0, virtualRed: 0 } });
      expect(screen.queryByRole('button', { name: 'Try the opposite mapping' })).not.toBeInTheDocument();
    });
  });

  describe('OE polarity', () => {
    it('keeps the polarity when the white picture is normal', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /4\. OE polarity/);
      await user.click(screen.getByRole('button', { name: 'Show white' }));
      expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'white');
      await user.click(screen.getByRole('radio', { name: /Normal/ }));
      expect(screen.getByTestId('smart-oe-ok')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Write OE polarity/ })).not.toBeInTheDocument();
      expect(writeCalls(api)).toHaveLength(0);
    });

    it('toggles the polarity when the picture is dark or inverted, after a confirmation', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /4\. OE polarity/);
      await user.click(screen.getByRole('button', { name: 'Show white' }));
      await user.click(screen.getByRole('radio', { name: /Dark or inverted/ }));
      expect(screen.getByTestId('smart-oe-preview')).toHaveTextContent('from High enable (0) to Low enable (1)');
      expect(screen.getByText(/UNVERIFIED/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Write OE polarity/ }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      expect(writeCalls(api)[0]).toEqual([CONTROLLER.id, { scope: 'card', portIndex: 0, cardIndex: 0 }, { oePolarity: 1 }, undefined]);
      expect(await screen.findByTestId('smart-oe-recheck')).toBeInTheDocument();

      // still wrong: answering again toggles back from the NEW value
      await user.click(screen.getByRole('radio', { name: /Normal/ }));
      await user.click(screen.getByRole('radio', { name: /Dark or inverted/ }));
      expect(screen.getByTestId('smart-oe-preview')).toHaveTextContent('from Low enable (1) to High enable (0)');
    });
  });

  describe('finish', () => {
    async function afterTwoWrites(api: ReturnType<typeof fakeSmart>) {
      const user = await startWizard(api);
      await step(user, /2\. Module basics/);
      fireEvent.change(screen.getByLabelText('Module width (px)'), { target: { value: '96' } });
      await user.click(screen.getByRole('button', { name: /Apply module basics/ }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      await step(user, /4\. OE polarity/);
      await user.click(screen.getByRole('radio', { name: /Dark or inverted/ }));
      await user.click(screen.getByRole('button', { name: /Write OE polarity/ }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(2));
      await step(user, /5\. Finish/);
      return user;
    }

    it('shows the diff against the snapshot and saves nothing by itself', async () => {
      const api = fakeSmart();
      await afterTwoWrites(api);
      const diff = within(screen.getByTestId('smart-diff'));
      expect(diff.getByText('Module width (px)')).toBeInTheDocument();
      expect(diff.getByText('OE polarity')).toBeInTheDocument();
      expect(diff.getByText('Low enable (1)')).toBeInTheDocument();
      expect(diff.queryByText('Module height (px)')).not.toBeInTheDocument();
      expect(api.saveToHardware).not.toHaveBeenCalled();
    });

    it('Keep leaves the card in RAM: no write, no save', async () => {
      const api = fakeSmart();
      const user = await afterTwoWrites(api);
      const before = writeCalls(api).length;
      await user.click(screen.getByRole('button', { name: 'Keep (RAM only)' }));
      expect(screen.getByTestId('smart-kept')).toHaveTextContent('RAM only');
      expect(writeCalls(api)).toHaveLength(before);
      expect(api.saveToHardware).not.toHaveBeenCalled();
    });

    it('Revert writes every snapshot value back in restore mode and clears the difference', async () => {
      const api = fakeSmart();
      const user = await afterTwoWrites(api);
      await user.click(screen.getByRole('button', { name: 'Revert to snapshot' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Module width \(px\): 96 → 64/)).toBeInTheDocument();
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(3));
      const [, target, values, options] = writeCalls(api)[2]!;
      expect(target).toEqual({ scope: 'card', portIndex: 0, cardIndex: 0 });
      expect(values).toEqual({ ...SNAP, portIndex: undefined, cardIndex: undefined });
      expect(options).toEqual({ restore: true });
      await waitFor(() => expect(screen.getByTestId('smart-diff-empty')).toBeInTheDocument());
    });

    it('saves to flash only after the existing confirmation, for this card, without the sender', async () => {
      const api = fakeSmart();
      const user = await afterTwoWrites(api);
      await user.click(screen.getByRole('button', { name: 'Save to card flash…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Save to hardware?' });
      expect(within(dialog).getByText(/flash memory/)).toBeInTheDocument();
      expect(api.saveToHardware).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.saveToHardware).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Save to card flash…' }));
      await confirmDialog(user);
      await waitFor(() => expect(api.saveToHardware).toHaveBeenCalledTimes(1));
      expect(api.saveToHardware).toHaveBeenCalledWith(CONTROLLER.id, { scope: 'card', portIndex: 0, cardIndex: 0 }, { includeSender: false });
      expect(await screen.findByTestId('smart-save-result')).toHaveTextContent('Saved 1 receiving card(s).');
    });

    it('reports a failed flash save per card', async () => {
      const api = fakeSmart({
        saveToHardware: vi.fn(async (): Promise<SaveToHardwareResult> => ({
          sender: null,
          cards: [{ portIndex: 0, cardIndex: 0, ok: false, code: 'TIMEOUT', message: 'no answer' }],
          ok: false,
        })),
      });
      const user = await afterTwoWrites(api);
      await user.click(screen.getByRole('button', { name: 'Save to card flash…' }));
      await confirmDialog(user);
      expect(await screen.findByText('Port 1 / Card 1: no answer')).toBeInTheDocument();
    });

    it('saves the new basics, with the card\'s other parameters, into the module library', async () => {
      const api = fakeSmart();
      const user = await afterTwoWrites(api);
      const saveBtn = screen.getByRole('button', { name: 'Save to module library' });
      expect(saveBtn).toBeDisabled(); // a name is required
      await user.type(screen.getByLabelText('Name'), 'Wizard 96');
      await user.click(saveBtn);
      await waitFor(() => expect(localStorage.getItem('rockzalct.modules')).not.toBeNull());
      const lib = parseModuleLibraryJson(localStorage.getItem('rockzalct.modules')!);
      expect(lib).toEqual({
        ok: true,
        profiles: [
          {
            name: 'Wizard 96', width: 96, height: 32, scanMode: 16, dataGroups: 8, refNumPerVs: 1920, gamma: 28,
            grayDepth: 14, grayRealize: 1, grayMode: 2, driverIc: 33, icPerGroup: 4,
          },
        ],
      });
      expect(api.getReceiverParameters).toHaveBeenLastCalledWith(CONTROLLER.id, 0, 0);
    });
  });

  describe('failures', () => {
    const partial = (): SmartWriteResult => ({
      ok: false,
      written: ['moduleWidth'],
      failed: { field: 'moduleHeight', code: 'TIMEOUT', message: 'no answer' },
    });

    it('reports which registers were written when a write fails mid-way, blocks flash and reverts on request', async () => {
      const write = vi.fn(async (): Promise<SmartWriteResult> => partial());
      const api = fakeSmart({ writeSmartSettings: write });
      const user = await startWizard(api);
      await step(user, /2\. Module basics/);
      fireEvent.change(screen.getByLabelText('Module width (px)'), { target: { value: '96' } });
      fireEvent.change(screen.getByLabelText('Module height (px)'), { target: { value: '48' } });
      await user.click(screen.getByRole('button', { name: /Apply module basics/ }));
      await confirmDialog(user);

      const alert = await screen.findByTestId('smart-partial');
      expect(alert).toHaveTextContent('Written before the failure: Module width (px)');
      expect(alert).toHaveTextContent('Failed: Module height (px)');
      expect(alert).toHaveTextContent('Revert to snapshot');
      expect(screen.getByTestId('smart-dirty')).toHaveTextContent('differs from the snapshot');

      await step(user, /5\. Finish/);
      expect(screen.getByRole('button', { name: 'Save to card flash…' })).toBeDisabled();
      expect(screen.getByText(/card state is not certain/)).toBeInTheDocument();

      write.mockImplementation(async () => ({ ok: true, written: ORDER as SmartWriteResult['written'] }));
      await user.click(screen.getByRole('button', { name: 'Revert to snapshot' }));
      await confirmDialog(user);
      await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
      expect(write.mock.calls[1]).toMatchObject([CONTROLLER.id, { scope: 'card' }, { moduleWidth: 64, moduleHeight: 32 }, { restore: true }]);
      await waitFor(() => expect(screen.queryByTestId('smart-partial')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Save to card flash…' })).toBeEnabled();
    });

    it('shows a localised toast and keeps the wizard consistent when a write is rejected', async () => {
      const api = fakeSmart({
        writeSmartSettings: vi.fn(async () => {
          throw new DeviceError('PERMISSION', 'advanced user level required');
        }),
      });
      const user = await startWizard(api);
      await step(user, /4\. OE polarity/);
      await user.click(screen.getByRole('radio', { name: /Dark or inverted/ }));
      await user.click(screen.getByRole('button', { name: /Write OE polarity/ }));
      await confirmDialog(user);
      expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
      expect(screen.getByTestId('smart-dirty')).toHaveTextContent('still holds the snapshot');
    });

    it('does not let the card change while it differs from the snapshot', async () => {
      const api = fakeSmart();
      const user = await startWizard(api);
      await step(user, /4\. OE polarity/);
      await user.click(screen.getByRole('radio', { name: /Dark or inverted/ }));
      await user.click(screen.getByRole('button', { name: /Write OE polarity/ }));
      await confirmDialog(user);
      await waitFor(() => expect(writeCalls(api)).toHaveLength(1));
      await step(user, /1\. Snapshot/);
      expect(screen.getByRole('combobox', { name: 'Receiving card' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Read snapshot again' })).toBeDisabled();
      expect(screen.getByText(/Revert first/)).toBeInTheDocument();
    });
  });

  it('switches the test pattern off when the page is left', async () => {
    const api = fakeSmart();
    const user = await startWizard(api);
    await step(user, /3\. RGB order/);
    await user.click(screen.getByRole('button', { name: 'Show Red' }));
    expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'red');
    await user.click(screen.getByRole('button', { name: 'Connection' }));
    await waitFor(() => expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'off'));
  });

  it('does not touch the test pattern when none was shown', async () => {
    const api = fakeSmart();
    const user = await startWizard(api);
    await user.click(screen.getByRole('button', { name: 'Connection' }));
    expect(api.setTestPattern).not.toHaveBeenCalled();
  });
});
