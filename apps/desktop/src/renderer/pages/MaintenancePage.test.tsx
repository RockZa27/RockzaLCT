import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DryRunResult, FunctionCardInfo, RelayStatus } from '@rockzalct/shared';
import { buildDryRunPlan, checkFirmwareCompatibility, validateFirmwareFile } from '@rockzalct/shared';
import { connectAndGo, makeFakeApi, renderApp } from '../testUtils';
import { FUNCTION_CARD_ADDRESS_KEY } from './maintenance/address';

const NAV = 'Function card & firmware';

const INFO_FC: FunctionCardInfo = {
  functionCardAddress: 5,
  modelId: 0x0a01,
  mcuVersion: '1.2.3',
  mcuVersionRaw: 0x01020300,
  fpgaVersion: '2.0.0',
  fpgaVersionRaw: 0x02000000,
  goldenFpgaVersion: '1.0.0',
  goldenFpgaVersionRaw: 0x01000000,
  clock: { year: 26, month: 10, day: 27, weekday: 2, hour: 13, minute: 5, second: 9 },
};

const status = (relayRaw = 0): RelayStatus => ({
  functionCardAddress: 5,
  relays: Array.from({ length: 8 }, (_, index) => ({
    index,
    raw: index === 1 ? relayRaw : 0,
    state: (index === 1 ? relayRaw : 0) === 0 ? ('start' as const) : ('stop' as const),
  })),
  total: { raw: 0, state: 'start' },
  mode: 'manual',
  modeRaw: 0,
  schedule: Array.from({ length: 8 }, (_, relay) => ({ relay, open: [8, 0, 0] as [number, number, number], close: [22, 30, 0] as [number, number, number] })),
});

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

async function open(over: Parameters<typeof makeFakeApi>[0] = {}) {
  const api = makeFakeApi({
    readFunctionCardInfo: vi.fn(async () => INFO_FC),
    readRelayStatus: vi.fn(async () => status()),
    ...over,
  });
  const { user } = renderApp(api, 'en');
  await connectAndGo(user, screen, NAV);
  return { api, user };
}

const typeAddress = async (user: ReturnType<typeof renderApp>['user'], text: string) => {
  const input = screen.getByLabelText('Function card address (0-255)');
  await user.clear(input);
  await user.type(input, text);
};

beforeEach(() => {
  localStorage.clear();
});

describe('MaintenancePage: function card', () => {
  it('needs an address (no default), remembers it, and reads info and relays', async () => {
    const { api, user } = await open();
    const read = screen.getByRole('button', { name: 'Read function card' });
    expect(read).toBeDisabled();
    await typeAddress(user, '300');
    expect(screen.getByRole('alert')).toHaveTextContent('0 to 255');
    expect(read).toBeDisabled();
    await user.tab(); // blur
    expect(localStorage.getItem(FUNCTION_CARD_ADDRESS_KEY)).toBeNull(); // invalid values are never remembered

    await typeAddress(user, '5');
    await user.click(read);
    expect(localStorage.getItem(FUNCTION_CARD_ADDRESS_KEY)).toBe('5');
    expect(await screen.findByTestId('fc-info')).toHaveTextContent('1.2.3');
    expect(api.readFunctionCardInfo).toHaveBeenCalledWith('serial:COM9', 5);
    expect(api.readRelayStatus).toHaveBeenCalledWith('serial:COM9', 5);
    expect(screen.getByTestId('relay-state-0')).toHaveTextContent('On (Start)');
    expect(screen.getByTestId('relay-mode')).toHaveTextContent('Manual');
    expect(screen.getAllByText('08:00:00 - 22:30:00')).toHaveLength(8);
  });

  it('restores the remembered address', async () => {
    localStorage.setItem(FUNCTION_CARD_ADDRESS_KEY, '9');
    await open();
    expect(screen.getByLabelText('Function card address (0-255)')).toHaveValue('9');
  });

  it('still works when storage is unavailable', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { user } = await open();
      await typeAddress(user, '5');
      await user.click(screen.getByRole('button', { name: 'Read function card' }));
      expect(await screen.findByTestId('fc-info')).toHaveTextContent('1.2.3');
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it('locks relay controls at normal level; no write is possible', async () => {
    const { api, user } = await open();
    await typeAddress(user, '5');
    await user.click(screen.getByRole('button', { name: 'Read function card' }));
    await screen.findByTestId('relay-status');
    expect(screen.getByRole('button', { name: 'Turn off… Relay 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Turn off… All relays' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Set mode…' })).toBeDisabled();
    expect(api.setRelay).not.toHaveBeenCalled();
  });

  it('asks for confirmation before turning a relay off, and sends nothing on cancel', async () => {
    const setRelay = vi.fn(async (_id: string, _a: number, r: { relay: number | 'all' }) => ({ relay: r.relay, written: 1, readBack: 1, verified: true }));
    const read = vi.fn().mockResolvedValueOnce(status(0)).mockResolvedValue(status(1));
    const { api, user } = await open({ setRelay, readRelayStatus: read });
    await loginAdvanced(user);
    await typeAddress(user, '5');
    await user.click(screen.getByRole('button', { name: 'Read function card' }));
    await screen.findByTestId('relay-status');

    await user.click(screen.getByRole('button', { name: 'Turn off… Relay 2' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('black out the screen');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.setRelay).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Turn off… Relay 2' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(setRelay).toHaveBeenCalledTimes(1));
    expect(setRelay).toHaveBeenCalledWith('serial:COM9', 5, { relay: 1, on: false, confirmed: true });
    await waitFor(() => expect(screen.getByTestId('relay-state-1')).toHaveTextContent('Off (Stop)'));
  });

  it('changes the power control mode only after confirmation', async () => {
    const setPowerControlMode = vi.fn(async (_i: string, _a: number, mode: 'manual' | 'auto') => ({ mode, readBack: 1, verified: true }));
    const { user } = await open({ setPowerControlMode });
    await loginAdvanced(user);
    await typeAddress(user, '5');
    await user.click(screen.getByRole('button', { name: 'Read function card' }));
    await screen.findByTestId('relay-status');
    await user.click(screen.getByRole('button', { name: 'Set mode…' }));
    expect(setPowerControlMode).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(setPowerControlMode).toHaveBeenCalledWith('serial:COM9', 5, 'auto', true));
  });
});

describe('MaintenancePage: versions', () => {
  it('reads the versions of the sender, every receiving card and the function card', async () => {
    const readProgramVersions = vi.fn(async () => ({
      sender: { mcu: '2.3.4', fpga: '1.0.0' },
      receivers: [
        { portIndex: 0, cardIndex: 0, mcu: '1.0.0', fpga: '1.1.0' },
        { portIndex: 1, cardIndex: 0, mcu: null, fpga: null, error: 'timeout' },
      ],
      functionCard: { functionCardAddress: 5, mcu: '1.2.3', fpga: '2.0.0', golden: '1.0.0' },
    }));
    const { user } = await open({ readProgramVersions });
    await typeAddress(user, '5');
    await user.click(screen.getByRole('button', { name: 'Read versions' }));
    const table = await screen.findByTestId('versions-table');
    expect(readProgramVersions).toHaveBeenCalledWith('serial:COM9', {
      cards: [
        { portIndex: 0, cardIndex: 0 },
        { portIndex: 1, cardIndex: 0 },
      ],
      functionCardAddress: 5,
    });
    expect(table).toHaveTextContent('2.3.4');
    expect(table).toHaveTextContent('could not be read');
  });
});

describe('MaintenancePage: firmware', () => {
  const fileOf = (n: number) => new File([Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff)], 'fw.bin');

  it('runs a dry run with the file bytes and shows report, compatibility and plan', async () => {
    const dryRunFirmware = vi.fn(async (_id: string, req: { file: { name: string; bytes: Uint8Array }; target: 'function-card-fpga' }): Promise<DryRunResult> => {
      const report = validateFirmwareFile(req.file, req.target);
      return {
        report,
        compatibility: checkFirmwareCompatibility({ report, device: { modelId: 0x0a01, mcuVersionRaw: 0, fpgaVersionRaw: 0x01000000 }, declaredVersion: 0x02000000, declaredModelId: 0x0a01 }),
        plan: buildDryRunPlan(report, 256),
        writesSent: 0,
      };
    });
    const { user } = await open({ dryRunFirmware: dryRunFirmware as never });
    await typeAddress(user, '5');
    await user.upload(screen.getByLabelText('Firmware file'), fileOf(1000));
    await user.type(screen.getByLabelText('Version in the file (hex, e.g. 01020300)'), '02000000');
    await user.type(screen.getByLabelText('Model id the file is for (hex, e.g. 0A01)'), '0A01');
    await user.click(screen.getByRole('button', { name: 'Check and dry run' }));
    const result = await screen.findByTestId('fw-result');
    const req = dryRunFirmware.mock.calls[0]![1];
    expect(req.file.bytes.length).toBe(1000);
    expect(req).toMatchObject({ functionCardAddress: 5, target: 'function-card-fpga', declaredVersion: 0x02000000, declaredModelId: 0x0a01, blockSize: 256 });
    expect(screen.getByTestId('fw-valid')).toHaveTextContent('passed validation');
    expect(screen.getByTestId('fw-compat')).toHaveTextContent('No blocking problem');
    expect(screen.getByTestId('fw-plan')).toHaveTextContent('4 block(s) of up to 256 bytes. Nothing was sent.');
    expect(result).toHaveTextContent('Block 3: offset 1024');
  });

  it('validates inputs before calling the device', async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Check and dry run' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a file first.');
    await user.upload(screen.getByLabelText('Firmware file'), fileOf(10));
    await user.type(screen.getByLabelText('Version in the file (hex, e.g. 01020300)'), 'xyz');
    await user.click(screen.getByRole('button', { name: 'Check and dry run' }));
    expect(screen.getByRole('alert')).toHaveTextContent('hexadecimal');
    expect(api.dryRunFirmware).not.toHaveBeenCalled();
  });

  it('shows the danger zone: writing is not offered and there is no enabling switch', async () => {
    await open();
    const zone = screen.getByTestId('fw-danger');
    expect(zone).toHaveTextContent('cannot write firmware');
    expect(zone).toHaveTextContent('No erase command');
    expect(within(zone).queryByRole('checkbox')).toBeNull();
    expect(within(zone).queryByRole('button')).toBeNull();
  });
});

describe('MaintenancePage: Thai', () => {
  it('renders the Thai page', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'การ์ดมัลติฟังก์ชัน/เฟิร์มแวร์' }));
    expect(screen.getByRole('heading', { name: 'การ์ดมัลติฟังก์ชัน/เฟิร์มแวร์' })).toBeTruthy();
    expect(screen.getByTestId('fw-danger')).toHaveTextContent('เขตอันตราย');
  });
});
