import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  type PixelDisplay,
  type PixelMappingFinishResult,
  type PixelMappingStartRequest,
  type PixelMappingStartResult,
  type PixelMappingUndoResult,
  type SmartSnapshot,
} from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

// A small module so that a whole marking fits in a test: 8 x 2 px, 1/2 scan, 1 data group, horizontal:
// 8 table entries (grid 8 columns x 2 rows) and one more click for the first point of scan 2 = 9 steps.
const SNAP: SmartSnapshot = {
  portIndex: 0,
  cardIndex: 0,
  moduleWidth: 8,
  moduleHeight: 2,
  scanMode: 2,
  dataGroups: 1,
  driverIc: 33,
  decodeType: 3,
  dataDirection: 0,
  oePolarity: 0,
  rgb: { red: 0, green: 1, blue: 2, virtualRed: 0 },
};

const DISPLAYS: PixelDisplay[] = [
  { index: 0, label: 'Display 1', width: 1920, height: 1080, primary: true },
  { index: 1, label: 'Display 2', width: 1920, height: 1080, primary: false },
];

const START_OK = (): PixelMappingStartResult => ({
  ok: true,
  written: ['senderSmartMode'],
  snapshot: {
    portIndex: 0,
    cardIndex: 0,
    controlWidth: 8,
    controlHeight: 2,
    totalPointInTable: 8,
    pointNumPerDrive: 8,
    groupNumInModule: 1,
    smartSetMode: 0,
    scanSequence: new Array<number>(128).fill(0),
    rowsCtrlByDataGroup: new Array<number>(8).fill(2),
    startPositionOfDataGroup: new Array<number>(8).fill(0),
    dataGroupSequence: [0x10, 0x32, 0x54, 0x76],
    dviOffsetX: 0,
    dviOffsetY: 0,
  },
});
const FINISH_OK: PixelMappingFinishResult = { ok: true, written: ['senderSmartMode'] };
const UNDO_OK: PixelMappingUndoResult = { ok: true, steps: [{ step: 'senderSmartMode', ok: true }, { step: 'parameterReload', ok: true }] };

const fake = (over: Parameters<typeof makeFakeApi>[0] = {}) =>
  makeFakeApi({
    readSmartSnapshot: vi.fn(async (_id: string, port: number, card: number) => ({ ...SNAP, portIndex: port, cardIndex: card })),
    listPixelDisplays: vi.fn(async () => DISPLAYS),
    startPixelMapping: vi.fn(async (_id: string, _r: PixelMappingStartRequest) => START_OK()),
    lightPixelMappingStep: vi.fn(async (_id: string, i: number) => ({ pixel: { x: i % 8, y: Math.floor(i / 8) } })),
    finishPixelMapping: vi.fn(async () => FINISH_OK),
    cancelPixelMapping: vi.fn(async () => UNDO_OK),
    getPixelMappingStatus: vi.fn(async () => ({ stage: 'idle' as const, stepCount: 0 })),
    ...over,
  });
type Api = ReturnType<typeof fake>;
type User = ReturnType<typeof renderApp>['user'];
const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;

async function loginAdvanced(user: User) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}
const confirmDialog = async (user: User) => user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));

/** Connect, log in (unless told not to), read the snapshot and open the pixel mapping step. */
async function openStep(api: Api, opts: { advanced?: boolean; thai?: boolean } = {}) {
  const { user, unmount } = renderApp(api, 'en');
  await connectAndGo(user, screen, 'Smart Settings');
  if (opts.advanced !== false) await loginAdvanced(user);
  await user.click(screen.getByRole('button', { name: 'Read snapshot' }));
  await screen.findByTestId('smart-snapshot-ok');
  if (opts.thai) await user.click(screen.getByRole('button', { name: 'ไทย' }));
  await user.click(screen.getByRole('button', { name: /6\. (Pixel mapping|แมปพิกเซล)/ }));
  await screen.findByTestId('pmap-chip-note');
  return { user, unmount };
}

const startMarking = async (user: User) => {
  await user.click(screen.getByRole('button', { name: /Start marking/ }));
  await confirmDialog(user);
  await screen.findByTestId('pmap-progress');
};
const cell = (x: number, y: number) => screen.getByTestId(`pmap-cell-${x}-${y}`);
const progressText = () => screen.getByTestId('pmap-progress').textContent;

beforeEach(() => {
  localStorage.clear();
});

describe('pixel mapping step: setup', () => {
  it('is the 6th step, says plainly that chip timing is untouched and links to the file import page', async () => {
    const { user } = await openStep(fake());
    expect(screen.getByTestId('pmap-chip-note')).toHaveTextContent(/Chip timing, OE table, gamma and driver settings are NOT touched/);
    expect(screen.getByTestId('pmap-chip-note')).toHaveTextContent(/\.rcfgx/);
    expect(screen.getByText(/Everything is written to RAM only/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open the NovaLCT file import page' }));
    expect(await screen.findByRole('heading', { name: /NovaLCT/ })).toBeInTheDocument();
  });

  it('is available in Thai too', async () => {
    await openStep(fake(), { thai: true });
    expect(screen.getByTestId('pmap-chip-note')).toHaveTextContent(/ไทมิ่งชิป/);
    expect(screen.getByTestId('pmap-chip-note')).toHaveTextContent(/\.rcfgx/);
  });

  it('prefills from the card, plans, and keeps Start disabled until an advanced login', async () => {
    const api = fake();
    await openStep(api, { advanced: false });
    expect(screen.getByLabelText('Module width (px)')).toHaveValue(8);
    expect(screen.getByTestId('pmap-plan')).toHaveTextContent('Table entries 8, marking grid 8 x 2, clicks needed 9, control size 8 x 2');
    expect(screen.getByRole('button', { name: /Start marking/ })).toBeDisabled();
    expect(screen.getByLabelText('Module width (px)')).toBeDisabled();
    expect(api.startPixelMapping).not.toHaveBeenCalled();
  });

  it('reports an impossible plan instead of starting', async () => {
    const { user } = await openStep(fake());
    const groups = screen.getByLabelText('Data groups');
    await user.clear(groups);
    await user.type(groups, '3');
    expect(screen.getByTestId('pmap-plan-invalid')).toHaveTextContent(/Cannot plan/);
    expect(screen.getByRole('button', { name: /Start marking/ })).toBeDisabled();
  });

  it('starts only after a confirmation that names the target, RAM only and the undo; Cancel sends nothing', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await user.click(screen.getByRole('button', { name: /Start marking/ }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByTestId('pmap-confirm-body')).toHaveTextContent('Port 1 / Card 1');
    expect(within(dlg).getByTestId('pmap-confirm-body')).toHaveTextContent(/RAM only/);
    expect(within(dlg).getByTestId('pmap-confirm-undo')).toHaveTextContent(/reloads the card parameters from its flash/);
    expect(within(dlg).getByText(/Chip timing, OE table, gamma/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(api.startPixelMapping).not.toHaveBeenCalled();

    await startMarking(user);
    expect(calls(api.startPixelMapping)).toEqual([
      [
        CONTROLLER.id,
        {
          target: { scope: 'card', portIndex: 0, cardIndex: 0 },
          reference: { portIndex: 0, cardIndex: 0 },
          inputs: { moduleWidth: 8, moduleHeight: 2, scanCount: 2, dataGroups: 1, dataDirection: 0, modulesAcross: 1, modulesDown: 1, cascade: 'horizontal', lineBias: 0 },
          display: 1, // the first display that is not the primary one
          origin: { x: 0, y: 0 },
        },
      ],
    ]);
    expect(calls(api.lightPixelMappingStep)).toEqual([[CONTROLLER.id, 0]]);
    expect(progressText()).toBe('Step 1 / 9');
    expect(screen.getByTestId('pmap-lit')).toHaveTextContent('(0, 0)');
  });

  it('a rejected start (nothing written) leaves the wizard in setup', async () => {
    const api = fake({
      startPixelMapping: vi.fn(async () => {
        throw new DeviceError('TIMEOUT', 'card did not answer');
      }),
    });
    const { user } = await openStep(api);
    await user.click(screen.getByRole('button', { name: /Start marking/ }));
    await confirmDialog(user);
    expect(await screen.findByText('The controller did not respond in time.')).toBeInTheDocument();
    expect(screen.queryByTestId('pmap-progress')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start marking/ })).toBeEnabled();
  });

  describe('broadcast', () => {
    it('shows what broadcast means and needs an explicit tick in the confirmation', async () => {
      const api = fake();
      const { user } = await openStep(api);
      await user.click(screen.getByRole('radio', { name: /Send to ALL cards/ }));
      expect(screen.getByTestId('pmap-broadcast-warn')).toHaveTextContent(/NovaLCT broadcasts this wizard to every card/);
      await user.click(screen.getByRole('button', { name: /Start marking/ }));
      const dlg = await screen.findByRole('dialog');
      expect(within(dlg).getByText(/EVERY card of the controller/)).toBeInTheDocument();
      expect(within(dlg).getByRole('button', { name: 'Yes, continue' })).toBeDisabled();
      await user.click(within(dlg).getByRole('checkbox'));
      await user.click(within(dlg).getByRole('button', { name: 'Yes, continue' }));
      await screen.findByTestId('pmap-progress');
      const req = calls(api.startPixelMapping)[0]![1] as PixelMappingStartRequest;
      expect(req.target).toEqual({ scope: 'all' });
      expect(req.confirmBroadcast).toBe(true);
      expect(req.reference).toEqual({ portIndex: 0, cardIndex: 0 });
    });
  });
});

describe('pixel mapping step: marking', () => {
  const firstScan = async (user: User) => {
    for (let x = 0; x < 8; x += 1) await user.click(cell(x, 0));
  };

  it('lights the next pixel after each click and counts steps', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    await user.click(cell(0, 0));
    expect(progressText()).toBe('Step 2 / 9');
    await user.click(cell(1, 0));
    expect(progressText()).toBe('Step 3 / 9');
    expect(calls(api.lightPixelMappingStep).map((c) => c[1])).toEqual([0, 1, 2]);
    expect(screen.getByTestId('pmap-counts')).toHaveTextContent('Marked 2 of 9, invalid 0');
    expect(screen.getByTestId('pmap-instruction')).toHaveTextContent('First scan line: click the cell where the lit LED is (point 3 of 8)');
    expect(cell(0, 0)).toHaveTextContent('1');
    expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
    expect(cell(2, 0)).toHaveAttribute('aria-selected', 'false');
  });

  it('refuses a cell that is already used, with a message, and does not advance', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    await user.click(cell(3, 1));
    await user.click(cell(3, 1));
    expect(screen.getByTestId('pmap-rejection')).toHaveTextContent('That cell is already used');
    expect(progressText()).toBe('Step 2 / 9');
    expect(calls(api.lightPixelMappingStep)).toHaveLength(2);
  });

  it('undo takes back the last click and lights that position again; clear starts over', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    await user.click(cell(0, 0));
    await user.click(cell(1, 0));
    await user.click(screen.getByRole('button', { name: 'Undo last click' }));
    expect(progressText()).toBe('Step 2 / 9');
    expect(cell(1, 0)).toHaveAttribute('aria-selected', 'false');
    expect(calls(api.lightPixelMappingStep).at(-1)).toEqual([CONTROLLER.id, 1]);
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(progressText()).toBe('Step 1 / 9');
    expect(calls(api.lightPixelMappingStep).at(-1)).toEqual([CONTROLLER.id, 0]);
    expect(screen.getByRole('button', { name: 'Undo last click' })).toBeDisabled();
  });

  it('auto create needs two clicks, then fills the first scan line from the last two', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    expect(screen.getByRole('button', { name: 'Auto create' })).toBeDisabled();
    await user.click(cell(0, 0));
    await user.click(cell(1, 0));
    await user.click(screen.getByRole('button', { name: 'Auto create' }));
    expect(screen.getByTestId('pmap-auto-added')).toHaveTextContent('Auto create added 6 point(s).');
    expect(progressText()).toBe('Step 9 / 9');
    expect(screen.getByTestId('pmap-instruction')).toHaveTextContent('Scan line 2: click the cell where the FIRST LED');
    expect(calls(api.lightPixelMappingStep).at(-1)).toEqual([CONTROLLER.id, 8]);
  });

  it('"no LED here" marks an invalid point that counts toward the total', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    await user.click(cell(0, 0));
    await user.click(screen.getByRole('button', { name: 'No LED here (invalid point)' }));
    expect(progressText()).toBe('Step 3 / 9');
    expect(screen.getByTestId('pmap-counts')).toHaveTextContent('invalid 1');
  });

  it('works from the keyboard: arrows move, Enter marks, Backspace undoes', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    const grid = screen.getByRole('grid');
    expect(grid).toHaveAttribute('tabindex', '0');
    expect(grid).toHaveAttribute('aria-label', expect.stringContaining('8 columns by 2 rows'));
    grid.focus();
    fireEvent.keyDown(grid, { key: 'Enter' }); // cursor starts at 0,0
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(grid).toHaveAttribute('aria-activedescendant', 'pmap-cell-1-0');
    fireEvent.keyDown(grid, { key: 'Enter' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // stops at the last row
    expect(grid).toHaveAttribute('aria-activedescendant', 'pmap-cell-1-1');
    expect(progressText()).toBe('Step 3 / 9');
    fireEvent.keyDown(grid, { key: 'Backspace' });
    expect(progressText()).toBe('Step 2 / 9');
    expect(cell(1, 0)).toHaveAttribute('aria-selected', 'false');
    expect(cell(1, 0)).toHaveAttribute('aria-label', 'column 1, row 0');
    expect(cell(0, 0)).toHaveAttribute('aria-label', 'column 0, row 0, marked as point 1');
  });

  it('locks the other steps and the revert bar while the wizard owns the controller', async () => {
    const { user } = await openStep(fake());
    await startMarking(user);
    for (const name of [/1\. Snapshot/, /2\. Module basics/, /3\. RGB order/, /4\. OE polarity/, /5\. Finish/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.queryByTestId('smart-revert-bar')).not.toBeInTheDocument();
  });

  async function finishMarking(user: User) {
    await firstScan(user);
    await user.click(cell(0, 1)); // first point of scan 2
  }
  it('previews the point table, scan sequence and registers once everything is marked, then sends after a confirmation', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    expect(screen.queryByTestId('pmap-preview')).not.toBeInTheDocument();
    await finishMarking(user);
    expect(screen.getByTestId('pmap-preview-table')).toHaveTextContent('00 00 01 00 02 00 03 00 04 00 05 00 06 00 07 00');
    expect(screen.getByTestId('pmap-preview-scan')).toHaveTextContent('00 01');
    expect(screen.getByTestId('pmap-preview-registers')).toHaveTextContent('controlWidth: 08 00');
    expect(screen.getByTestId('pmap-preview-registers')).toHaveTextContent('scanMode: 02');
    expect(api.finishPixelMapping).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Send to card/ }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByTestId('pmap-confirm-body')).toHaveTextContent(/RAM only, not saved to flash/);
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(api.finishPixelMapping).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Send to card/ }));
    await confirmDialog(user);
    const sent = await screen.findByTestId('pmap-sent');
    expect(sent).toHaveTextContent('RAM');
    const marks = calls(api.finishPixelMapping)[0]![1] as Array<{ x: number; y: number }>;
    expect(calls(api.finishPixelMapping)[0]![0]).toBe(CONTROLLER.id);
    expect(marks).toEqual([...Array.from({ length: 8 }, (_, x) => ({ x, y: 0 })), { x: 0, y: 1 }]);
    // the controller is free again: the other steps are usable and the Finish step is one click away
    await user.click(within(sent).getByRole('button', { name: 'Go to Finish' }));
    expect(screen.getByRole('button', { name: 'Save to card flash…' })).toBeInTheDocument();
    expect(api.saveToHardware).not.toHaveBeenCalled();
  });

  it('first points that do not rise or fall steadily are explained and cannot be sent', async () => {
    // 8 x 3 px, 1/3 scan: grid 8 x 3, 8 table entries + 2 first points
    const api = fake({ readSmartSnapshot: vi.fn(async () => ({ ...SNAP, moduleHeight: 3, scanMode: 3 })) });
    const { user } = await openStep(api);
    await startMarking(user);
    await firstScan(user);
    await user.click(cell(0, 2)); // scan 2 starts on row 2 ...
    await user.click(cell(0, 1)); // ... scan 3 on row 1: the first points jump back
    const preview = screen.getByTestId('pmap-preview');
    expect(preview).toHaveTextContent('The marking cannot be sent yet');
    expect(preview).toHaveTextContent('run line drawing error');
    expect(screen.queryByRole('button', { name: /Send to card/ })).not.toBeInTheDocument();
    // taking back both and marking a steady run makes it sendable
    await user.click(screen.getByRole('button', { name: 'Undo last click' }));
    await user.click(screen.getByRole('button', { name: 'Undo last click' }));
    await user.click(cell(0, 1));
    await user.click(cell(0, 2));
    expect(screen.getByRole('button', { name: /Send to card/ })).toBeEnabled();
  });
});

describe('pixel mapping step: cancel and failures', () => {
  it('Cancel / Undo explains the reload from flash, then calls the undo and returns to setup', async () => {
    const api = fake();
    const { user } = await openStep(api);
    await startMarking(user);
    await user.click(cell(0, 0));
    await user.click(screen.getByRole('button', { name: 'Cancel / Undo…' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByTestId('pmap-confirm-body')).toHaveTextContent(/reloaded from flash/);
    expect(within(dlg).getByTestId('pmap-confirm-body')).toHaveTextContent(/Nothing is saved/);
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(api.cancelPixelMapping).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel / Undo…' }));
    await confirmDialog(user);
    expect(await screen.findByTestId('pmap-undone')).toHaveTextContent('reloaded from flash');
    expect(calls(api.cancelPixelMapping)).toEqual([[CONTROLLER.id]]);
    expect(screen.getByTestId('pmap-undo-steps')).toHaveTextContent('parameterReload: done');
    expect(screen.queryByTestId('pmap-progress')).not.toBeInTheDocument();
    // the steps are free again
    expect(screen.getByRole('button', { name: /5\. Finish/ })).toBeEnabled();
    expect(api.finishPixelMapping).not.toHaveBeenCalled();
  });

  it('a start that fails part-way shows what was written and offers only the undo', async () => {
    const api = fake({
      startPixelMapping: vi.fn(async () => ({
        ...START_OK(),
        ok: false,
        written: ['senderSmartMode', 'dviOffsetX'],
        failed: { step: 'dviOffsetY', code: 'TIMEOUT' as const, message: 'sender timeout' },
      })),
    });
    const { user } = await openStep(api);
    await user.click(screen.getByRole('button', { name: /Start marking/ }));
    await confirmDialog(user);
    const box = await screen.findByTestId('pmap-partial');
    expect(box).toHaveTextContent('A write failed part-way');
    expect(box).toHaveTextContent('senderSmartMode, dviOffsetX');
    expect(box).toHaveTextContent('dviOffsetY');
    expect(box).toHaveTextContent('sender timeout');
    expect(screen.queryByTestId('pmap-progress')).not.toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(calls(api.lightPixelMappingStep)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /5\. Finish/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel / Undo…' }));
    await confirmDialog(user);
    expect(await screen.findByTestId('pmap-undone')).toBeInTheDocument();
    expect(api.cancelPixelMapping).toHaveBeenCalledTimes(1);
  });

  it('a send that fails part-way keeps the wizard locked and offers the undo; a failed undo can be retried', async () => {
    let undoCalls = 0;
    const api = fake({
      finishPixelMapping: vi.fn(async () => ({ ok: false, written: ['senderSmartMode', 'selfTest (freeze)'], failed: { step: 'moduleScanSequenceInfo', code: 'PROTOCOL' as const, message: 'bad ack' } })),
      cancelPixelMapping: vi.fn(async (): Promise<PixelMappingUndoResult> => {
        undoCalls += 1;
        return undoCalls === 1
          ? { ok: false, steps: [{ step: 'senderSmartMode', ok: true }, { step: 'parameterReload', ok: false, message: 'no answer' }] }
          : UNDO_OK;
      }),
    });
    const { user } = await openStep(api);
    await startMarking(user);
    for (let x = 0; x < 8; x += 1) await user.click(cell(x, 0));
    await user.click(cell(0, 1));
    await user.click(screen.getByRole('button', { name: /Send to card/ }));
    await confirmDialog(user);
    const box = await screen.findByTestId('pmap-partial');
    expect(box).toHaveTextContent('senderSmartMode, selfTest (freeze)');
    expect(box).toHaveTextContent('moduleScanSequenceInfo');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send to card/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel / Undo…' }));
    await confirmDialog(user);
    const failed = await screen.findByTestId('pmap-undo-failed');
    expect(failed).toHaveTextContent('Some undo steps failed');
    expect(failed).toHaveTextContent('parameterReload: failed (no answer)');
    expect(screen.getByRole('button', { name: /5\. Finish/ })).toBeDisabled(); // still locked

    await user.click(screen.getByRole('button', { name: 'Cancel / Undo…' }));
    await confirmDialog(user);
    expect(await screen.findByTestId('pmap-undone')).toBeInTheDocument();
    expect(api.cancelPixelMapping).toHaveBeenCalledTimes(2);
  });

  it('a send that is refused before anything is written leaves the marking in place', async () => {
    const api = fake({
      finishPixelMapping: vi.fn(async () => {
        throw new DeviceError('INVALID_ARGUMENT', 'bad marks');
      }),
    });
    const { user } = await openStep(api);
    await startMarking(user);
    for (let x = 0; x < 8; x += 1) await user.click(cell(x, 0));
    await user.click(cell(0, 1));
    await user.click(screen.getByRole('button', { name: /Send to card/ }));
    await confirmDialog(user);
    expect(await screen.findByText('Invalid value.')).toBeInTheDocument();
    expect(screen.getByTestId('pmap-preview')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('a picture that cannot be shown is reported and can be retried', async () => {
    let n = 0;
    const api = fake({
      lightPixelMappingStep: vi.fn(async (_id: string, i: number) => {
        n += 1;
        if (n === 1) throw new DeviceError('PROTOCOL', 'no such display');
        return { pixel: { x: i, y: 0 } };
      }),
    });
    const { user } = await openStep(api);
    await startMarking(user);
    expect(screen.getByTestId('pmap-lit-failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Light again' }));
    await waitFor(() => expect(screen.queryByTestId('pmap-lit-failed')).not.toBeInTheDocument());
    expect(screen.getByTestId('pmap-lit')).toHaveTextContent('(0, 0)');
  });

  it('leaving the page while the wizard runs undoes it', async () => {
    const api = fake();
    const { user, unmount } = await openStep(api);
    await startMarking(user);
    unmount();
    expect(calls(api.cancelPixelMapping)).toEqual([[CONTROLLER.id]]);
  });

  it('does not undo on leaving when the wizard is not running', async () => {
    const api = fake();
    const { unmount } = await openStep(api);
    unmount();
    expect(api.cancelPixelMapping).not.toHaveBeenCalled();
  });
});
