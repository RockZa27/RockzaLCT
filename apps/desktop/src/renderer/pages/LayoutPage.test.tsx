import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  autoWire,
  createLayoutScreen,
  planLayoutWrite,
  type LayoutModel,
} from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const NAV = 'Screen connection';

async function openLayout(overrides: Parameters<typeof makeFakeApi>[0] = {}) {
  const api = makeFakeApi(overrides);
  const { user } = renderApp(api, 'en');
  await connectAndGo(user, screen, NAV);
  return { api, user };
}

const cabinet = (row: number, col: number) =>
  screen.getByRole('button', { name: new RegExp(`^Cabinet row ${row}, column ${col}(,|$)`) });

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

const chainPorts = (): string[] =>
  [...screen.getByTestId('chains').querySelectorAll('g[data-port]')].map((g) => g.getAttribute('data-port')!);

describe('LayoutPage: editor', () => {
  it('starts with a valid, auto-wired 2 x 4 wall and draws one chain per port', async () => {
    await openLayout();
    expect(screen.getByLabelText('Rows')).toHaveValue(2);
    expect(screen.getByLabelText('Columns')).toHaveValue(4);
    expect(screen.getByText('The layout is valid.')).toBeInTheDocument();
    expect(chainPorts()).toEqual(['0', '1']);
    // 7 arrows (3 per row chain x 2)... each chain has cabinets-1 segments
    expect(screen.getByTestId('chains').querySelectorAll('line')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Cabinet row 1, column 1, port 1, number 1' })).toBeInTheDocument();
    // serpentine: second row of port 2 starts... row 2 col 1 is number 5
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 1, port 2, number 5' })).toBeInTheDocument();
  });

  it('shows the port load bar with the pixel count', async () => {
    await openLayout();
    const bar = screen.getByRole('progressbar', { name: 'Load of port 1: 65536 of 650000 px' });
    expect(bar).toHaveAttribute('aria-valuenow', '65536');
    expect(bar).toHaveAttribute('aria-valuemax', '650000');
  });

  it('validates live: growing the grid leaves unwired cabinets and blocks nothing until sending', async () => {
    const { user } = await openLayout();
    await user.clear(screen.getByLabelText('Rows'));
    await user.type(screen.getByLabelText('Rows'), '3');
    expect(screen.getByText(/Cabinet row 3, column 1 is not wired to any port\./)).toBeInTheDocument();
    expect(screen.queryByText('The layout is valid.')).not.toBeInTheDocument();
  });

  it('flags a port over its capacity, in the bar and in the error list', async () => {
    const { user } = await openLayout();
    const cap = screen.getByLabelText('Port capacity (px)');
    await user.clear(cap);
    await user.type(cap, '60000');
    expect(screen.getByText(/Port 1 carries 65536 px, over the 60000 px limit\./)).toBeInTheDocument();
    expect(screen.getAllByText('109%')).toHaveLength(2);
  });

  it('wires manually: clicking cabinets in order numbers them, clicking the last one undoes it', async () => {
    const { user } = await openLayout();
    await user.click(screen.getByRole('button', { name: 'Clear wiring' }));
    expect(screen.getByText('No cabinet is wired to a port yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wire port 2' }));
    await user.click(cabinet(2, 2));
    await user.click(cabinet(2, 1));
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 2, port 2, number 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 1, port 2, number 2' })).toBeInTheDocument();
    expect(chainPorts()).toEqual(['1']);
    expect(within(screen.getByRole('list', { name: 'Output ports' })).getByText('2 cabinets')).toBeInTheDocument();

    await user.click(cabinet(2, 1)); // last cabinet -> undo
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 1' })).toBeInTheDocument();
    expect(screen.getByText(/Cabinet row 1, column 1 is not wired to any port\./)).toBeInTheDocument();
  });

  it('works from the keyboard', async () => {
    const { user } = await openLayout();
    await user.click(screen.getByRole('button', { name: 'Clear wiring' }));
    cabinet(1, 1).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Cabinet row 1, column 1, port 1, number 1' })).toBeInTheDocument();
  });

  it('auto-wires with the chosen pattern, port count and split', async () => {
    const { user } = await openLayout();
    await user.selectOptions(screen.getByLabelText('Wiring pattern'), 'right-bottom-vertical');
    await user.selectOptions(screen.getByLabelText('Split by'), 'columns');
    await user.click(screen.getByRole('button', { name: 'Auto-wire' }));
    expect(chainPorts()).toEqual(['0', '1']);
    // port 1 = columns 1-2, wired from the bottom-right: that cabinet is number 1, then upwards
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 2, port 1, number 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cabinet row 1, column 2, port 1, number 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cabinet row 1, column 1, port 1, number 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 1, port 1, number 4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cabinet row 2, column 4, port 2, number 5' })).toBeInTheDocument();
    expect(screen.getByText('The layout is valid.')).toBeInTheDocument();
  });

  it('re-wires one port with a pattern, and refuses a ragged chain', async () => {
    const { user } = await openLayout();
    await user.selectOptions(screen.getByLabelText('Wiring pattern of port 1'), 'right-top-horizontal');
    expect(screen.getByRole('button', { name: 'Cabinet row 1, column 4, port 1, number 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear wiring' }));
    await user.click(cabinet(1, 1));
    await user.click(cabinet(2, 2));
    await user.selectOptions(screen.getByLabelText('Wiring pattern of port 1'), 'left-top-vertical');
    expect(screen.getByText(/Port 1 does not cover a full rectangle/)).toBeInTheDocument();
  });

  it('complex screen: editing one cabinet size switches the type and changes the screen size', async () => {
    const { user } = await openLayout();
    expect(screen.getByText('Screen size: 512 x 256 px, 8 cabinets')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit cabinet size' }));
    await user.click(cabinet(1, 1));
    const width = screen.getAllByLabelText('Cabinet width (px)')[0]!;
    await user.clear(width);
    await user.type(width, '200');
    await user.click(screen.getByRole('button', { name: 'Apply size' }));
    expect(screen.getByLabelText('Screen type')).toHaveValue('complex');
    // row 1 is now 200 + 3*128 wide
    expect(screen.getByText('Screen size: 584 x 256 px, 8 cabinets')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(screen.getByText('Screen size: 512 x 256 px, 8 cabinets')).toBeInTheDocument();
  });
});

describe('LayoutPage: hardware', () => {
  it('works offline: read/send are disabled and a hint is shown', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api, 'en');
    await user.click(screen.getByRole('button', { name: NAV }));
    expect(screen.getByText(/Connect to a controller to read or send the layout/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read from hardware' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send to hardware' })).toBeDisabled();
    await user.click(cabinet(1, 1)); // the editor itself still works
    expect(api.readLayout).not.toHaveBeenCalled();
  });

  it('reads the layout from the controller and shows it', async () => {
    const wall3x3: LayoutModel = (() => {
      const s = createLayoutScreen(3, 3, 96, 96);
      return { screen: s, ports: autoWire(s, { pattern: 'left-bottom-vertical', ports: 3, split: 'columns' }) };
    })();
    const { api, user } = await openLayout({ readLayout: vi.fn(async () => planLayoutWrite(wall3x3)) });
    await user.click(screen.getByRole('button', { name: 'Read from hardware' }));
    expect(api.readLayout).toHaveBeenCalledWith(CONTROLLER.id);
    await screen.findByText('Screen size: 288 x 288 px, 9 cabinets');
    expect(screen.getByLabelText('Rows')).toHaveValue(3);
    expect(chainPorts()).toEqual(['0', '1', '2']);
    // left-bottom-vertical: bottom-left cabinet is number 1
    expect(screen.getByRole('button', { name: 'Cabinet row 3, column 1, port 1, number 1' })).toBeInTheDocument();
  });

  it('keeps the editor and explains when the controller has no layout', async () => {
    const { user } = await openLayout({
      readLayout: async () => ({
        complexScreen: false,
        ports: [],
        cards: [{ port: 0, index: 0, x: 0, y: 0, width: 0, height: 0, cabinetNumber: 0 }],
      }),
    });
    await user.click(screen.getByRole('button', { name: 'Read from hardware' }));
    expect(await screen.findByText(/The controller has no configured layout yet\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Columns')).toHaveValue(4);
  });

  it('a failed read shows the localised error toast and leaves the layout alone', async () => {
    const { user } = await openLayout({
      readLayout: async () => {
        throw new DeviceError('TIMEOUT', 'slow');
      },
    });
    await user.click(screen.getByRole('button', { name: 'Read from hardware' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The controller did not respond in time.');
    expect(screen.getByLabelText('Rows')).toHaveValue(2);
  });

  it('send is locked until the advanced login, then asks for confirmation before writing', async () => {
    const { api, user } = await openLayout();
    expect(screen.getByRole('button', { name: 'Send to hardware' })).toBeDisabled();
    expect(screen.getByText('Sending needs an advanced login.')).toBeInTheDocument();
    await loginAdvanced(user);

    const send = screen.getByRole('button', { name: 'Send to hardware' });
    expect(send).toBeEnabled();
    await user.click(send);
    const dialog = screen.getByRole('dialog', { name: 'Send layout to the controller?' });
    expect(dialog).toHaveTextContent('rewrites the position and size of 8 receiving cards on 2 ports');
    expect(api.writeLayout).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.writeLayout).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send to hardware' }));
    await user.click(screen.getByRole('button', { name: 'Send layout' }));
    expect(api.writeLayout).toHaveBeenCalledTimes(1);
    const [id, model, options] = (api.writeLayout as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(id).toBe(CONTROLLER.id);
    expect(options).toEqual({ portCapacity: 650000 });
    const sent = model as LayoutModel;
    expect(sent.screen).toMatchObject({ rows: 2, cols: 4, cabinetWidth: 128, cabinetHeight: 128, kind: 'standard' });
    expect(sent.ports.map((p) => p.cabinets.length)).toEqual([4, 4]);
  });

  it('send stays disabled while the layout has errors', async () => {
    const { user } = await openLayout();
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Clear wiring' }));
    expect(screen.getByRole('button', { name: 'Send to hardware' })).toBeDisabled();
    expect(screen.getByText('Fix the errors above before sending.')).toBeInTheDocument();
  });

  it('a write rejected by the device is reported, not swallowed', async () => {
    const { user } = await openLayout({
      writeLayout: async () => {
        throw new DeviceError('PERMISSION', 'no');
      },
    });
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Send to hardware' }));
    await user.click(screen.getByRole('button', { name: 'Send layout' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied.');
  });

  it('shows and hides cabinet numbers on the wall (advanced only)', async () => {
    const { api, user } = await openLayout();
    expect(screen.getByRole('button', { name: 'Show cabinet numbers on screen' })).toBeDisabled();
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Show cabinet numbers on screen' }));
    expect(api.showCabinetNumbers).toHaveBeenLastCalledWith(CONTROLLER.id, expect.objectContaining({ ports: expect.any(Array) }), true);
    expect(screen.getByText('Cabinet numbers are being shown on the wall.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide cabinet numbers' }));
    expect(api.showCabinetNumbers).toHaveBeenLastCalledWith(CONTROLLER.id, expect.anything(), false);
    expect(screen.queryByText('Cabinet numbers are being shown on the wall.')).not.toBeInTheDocument();
  });
});

describe('LayoutPage: language', () => {
  it('renders in Thai', async () => {
    const { user } = await openLayout();
    await user.click(screen.getByRole('button', { name: 'ไทย' }));
    expect(screen.getByRole('heading', { name: 'ผังการเชื่อมต่อจอ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ส่งลงฮาร์ดแวร์' })).toBeDisabled();
    expect(screen.getByText('ผังถูกต้อง')).toBeInTheDocument();
  });
});
