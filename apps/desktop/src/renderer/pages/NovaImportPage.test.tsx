import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RcfgxInfo, RcfgxParseResult, RcfgxProgress, ScrParseResult, SendRcfgxResult } from '@rockzalct/shared';
import { parseRcfgx, parseScr } from '@rockzalct/device';
import { connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const NAV = 'Import NovaLCT file';
// Real files, shared with the device package tests.
const FIXTURES = join(__dirname, '../../../../../packages/device/test/fixtures/novalct');
const raw = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(join(FIXTURES, name)));
const SAMPLE = 'Q8_ICND2153_40x40.rcfgx';
const USER = 'user_NV7516_64x128_2x5.rcfgx';

const parsedInfo = (name: string): RcfgxInfo => {
  const res = parseRcfgx({ name, bytes: raw(name) });
  if (!res.ok) throw new Error(res.message);
  return res.parsed.info;
};
const file = (name: string): File => new File([raw(name)], name);

const SENT_OK: SendRcfgxResult = {
  ok: true,
  fileId: 'x',
  recordsTotal: 41,
  recordsWritten: 41,
  bytesTotal: 6598,
  bytesWritten: 6598,
  commandRecordsWritten: 6,
};

function fakeImportApi(over: Record<string, unknown> = {}) {
  return makeFakeApi({
    parseRcfgxFile: vi.fn(async ({ name, bytes }: { name: string; bytes: Uint8Array }): Promise<RcfgxParseResult> => {
      const res = parseRcfgx({ name, bytes });
      return res.ok ? { ok: true, info: res.parsed.info } : res;
    }),
    parseScreenFile: vi.fn(async ({ name, bytes }: { name: string; bytes: Uint8Array }): Promise<ScrParseResult> => parseScr({ name, bytes })),
    sendRcfgx: vi.fn(async () => SENT_OK),
    getRcfgxProgress: vi.fn(async () => null),
    // the embedded save section reads the card list from the controller info only
    saveToHardware: vi.fn(async () => ({ sender: null, cards: [], ok: true })),
    ...over,
  } as never);
}

type User = ReturnType<typeof renderApp>['user'];
async function loginAdvanced(user: User) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}
const fileInput = (label: string): HTMLInputElement => screen.getByTestId(/\(\.rcfgx\)/.test(label) ? 'imp-rc-file' : 'imp-scr-file') as HTMLInputElement;

async function openSample(user: User, name = SAMPLE) {
  await user.upload(fileInput('Receiving-card config (.rcfgx)'), file(name));
  await screen.findByTestId('imp-rc-summary');
}

describe('NovaImportPage: .rcfgx summary', () => {
  it('shows the parsed file without a connection (golden values of the real sample)', async () => {
    const api = fakeImportApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: NAV }));
    expect(screen.getByText(/Not connected\. You can open and inspect files/)).toBeInTheDocument();
    await openSample(user);
    const summary = screen.getByTestId('imp-rc-summary');
    expect(within(summary).getByText('NovaLCT V5.3.0-14.09.2021 18:16:22')).toBeInTheDocument();
    expect(within(summary).getByText('MRV328')).toBeInTheDocument();
    expect(within(summary).getByText('4.5.3.0')).toBeInTheDocument();
    expect(within(summary).getByText('40 x 40')).toBeInTheDocument();
    expect(within(summary).getByText('200 x 320')).toBeInTheDocument();
    expect(within(summary).getByText('Chip_ICN2053')).toBeInTheDocument();
    expect(within(summary).getByText('Scan_5')).toBeInTheDocument();
    expect(within(summary).getByText('2 / 16')).toBeInTheDocument();
    expect(within(summary).getByText('16 / Normallight')).toBeInTheDocument();
    expect(screen.getByTestId('imp-rc-counts')).toHaveTextContent('41 writes, 6598 bytes');
    const groups = within(screen.getByTestId('imp-rc-groups'));
    expect(groups.getByText('0x03000800')).toBeInTheDocument();
    expect(groups.getAllByText('COMMAND').length).toBe(4); // 0x01000019, 5E, 9D, 12
    // the send button is locked without a connection
    expect(screen.getByRole('button', { name: /Send 41 writes/ })).toBeDisabled();
  });

  it('lists the command records with the unverified warning', async () => {
    const { user } = renderApp(fakeImportApi());
    await user.click(screen.getByRole('button', { name: NAV }));
    await openSample(user);
    const cmd = screen.getByTestId('imp-rc-commands');
    expect(within(cmd).getByRole('alert')).toHaveTextContent('UNVERIFIED');
    const items = within(cmd).getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(items[5]).toHaveTextContent('0x01000012');
    expect(items[5]).toHaveTextContent('wait 2000 ms');
    expect(items[4]).toHaveTextContent('0x0100009D');
    expect(items[4]).toHaveTextContent('FlashCabinet');
  });

  it('explains how to undo', async () => {
    const { user } = renderApp(fakeImportApi());
    await user.click(screen.getByRole('button', { name: NAV }));
    await openSample(user);
    expect(screen.getByTestId('imp-rc-undo')).toHaveTextContent(/power-cycle the cabinet/);
    expect(screen.getByTestId('imp-rc-undo')).toHaveTextContent(/unverified/);
  });

  it('shows a bad file as a localised error, not a crash', async () => {
    const { user } = renderApp(fakeImportApi());
    await user.click(screen.getByRole('button', { name: NAV }));
    await user.upload(fileInput('Receiving-card config (.rcfgx)'), new File([new Uint8Array([1, 2, 3, 4, 5, 6])], 'bad.rcfgx'));
    const err = await screen.findByTestId('imp-rc-error');
    expect(err).toHaveTextContent('not a valid .rcfgx');
    expect(screen.queryByTestId('imp-rc-summary')).toBeNull();
  });

  it('reads the 1 MB user file', async () => {
    const { user } = renderApp(fakeImportApi());
    await user.click(screen.getByRole('button', { name: NAV }));
    await openSample(user, USER);
    const summary = screen.getByTestId('imp-rc-summary');
    expect(within(summary).getByText('NV7516')).toBeInTheDocument();
    expect(within(summary).getByText('NovaLCT V5.9.2-10/26/2026 12:00:40 PM')).toBeInTheDocument();
    expect(screen.getByTestId('imp-rc-counts')).toHaveTextContent('61 writes, 532212 bytes');
  });
});

describe('NovaImportPage: sending', () => {
  async function ready(api = fakeImportApi(), name = SAMPLE) {
    const { user } = renderApp(api);
    await connectAndGo(user, screen, NAV);
    await loginAdvanced(user);
    await openSample(user, name);
    return { user, api };
  }
  const sendButton = (n = 41) => screen.getByRole('button', { name: new RegExp(`Send ${n} writes`) });

  it('needs the advanced login', async () => {
    const api = fakeImportApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, NAV);
    await openSample(user);
    expect(screen.getByText('Sending needs an advanced login (top bar).')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    expect(api.sendRcfgx).not.toHaveBeenCalled();
  });

  it('stays disabled until the model and the command records are acknowledged', async () => {
    const { user } = await ready();
    expect(sendButton()).toBeDisabled();
    await user.click(screen.getByLabelText('I confirm the target card is model MRV328'));
    expect(sendButton()).toBeDisabled(); // commands not yet acknowledged
    await user.click(screen.getByLabelText(/I understand that the 6 command record\(s\)/));
    // RC-A is reported by the fake controller, i.e. a different model: the extra confirmation is also needed
    expect(screen.getByLabelText('The model differs from what the card reports and I still want to send')).not.toBeChecked();
    expect(sendButton()).toBeDisabled();
    await user.click(screen.getByLabelText('The model differs from what the card reports and I still want to send'));
    expect(sendButton()).toBeEnabled();
  });

  it('warns when the connected card reports another model and shows how it compares per target', async () => {
    const { user } = await ready();
    const model = screen.getByTestId('imp-rc-model');
    expect(model).toHaveTextContent('The file is for MRV328 but the selected card reports RC-A');
    await user.selectOptions(screen.getByLabelText('Send to'), '1:0');
    expect(screen.getByTestId('imp-rc-model')).toHaveTextContent('reports RC-B');
  });

  it('says so when the card model cannot be read', async () => {
    const api = fakeImportApi({
      connect: vi.fn(async () => ({
        id: 'serial:COM9',
        model: 'TestCtrl 9000',
        firmwareVersion: '9.9.9',
        outputPorts: 1,
        receivingCards: [{ portIndex: 0, cardIndex: 0, model: 'Unknown', firmwareVersion: '1.0.0' }],
      })),
    });
    const { user } = await ready(api);
    expect(screen.getByTestId('imp-rc-model')).toHaveTextContent('cannot read the model of the connected card');
    expect(screen.queryByLabelText('The model differs from what the card reports and I still want to send')).toBeNull();
  });

  it('warns about the slow broadcast', async () => {
    await ready(fakeImportApi(), USER);
    expect(screen.getByTestId('imp-rc-allwarn')).toHaveTextContent(/50 ms after each packet \(about 1 min \d+ s for this file\)/);
  });

  async function acknowledgeAll(user: User, mismatch = true) {
    await user.click(screen.getByLabelText('I confirm the target card is model MRV328'));
    await user.click(screen.getByLabelText(/I understand that the 6 command record\(s\)/));
    if (mismatch) await user.click(screen.getByLabelText('The model differs from what the card reports and I still want to send'));
  }

  it('asks for confirmation naming the count and the target, then sends exactly what was chosen', async () => {
    const { user, api } = await ready();
    await user.selectOptions(screen.getByLabelText('Send to'), '1:0');
    await acknowledgeAll(user);
    await user.click(sendButton());
    const dialog = await screen.findByRole('dialog', { name: 'Send this file to the card?' });
    expect(dialog).toHaveTextContent('41 register writes (6598 bytes) will be written to port 2 / card 1');
    expect(dialog).toHaveTextContent('The file contains 6 command record(s)');
    expect(dialog).toHaveTextContent("Nothing is saved to the card's flash by this program");
    expect(api.sendRcfgx).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.sendRcfgx).toHaveBeenCalledTimes(1));
    expect(api.sendRcfgx).toHaveBeenCalledWith('serial:COM9', parsedInfo(SAMPLE).fileId, { scope: 'card', portIndex: 1, cardIndex: 0 }, { confirmCardModel: 'MRV328', acknowledgeCommands: true });
    const done = await screen.findByTestId('imp-rc-result');
    expect(done).toHaveTextContent('Wrote 41 register writes (6598 bytes), including 6 command record(s).');
  });

  it('cancel in the dialog sends nothing', async () => {
    const { user, api } = await ready();
    await acknowledgeAll(user);
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.sendRcfgx).not.toHaveBeenCalled();
  });

  it('broadcast sends scope all', async () => {
    const { user, api } = await ready();
    await acknowledgeAll(user);
    await user.click(sendButton());
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ALL receiving cards');
    await user.click(within(dialog).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.sendRcfgx).toHaveBeenCalled());
    expect((api.sendRcfgx as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toEqual({ scope: 'all' });
  });

  it('after success offers the existing save flow with its own confirmation', async () => {
    const { user, api } = await ready();
    await acknowledgeAll(user);
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    const result = await screen.findByTestId('imp-rc-result');
    expect(result).toHaveTextContent('Make it permanent (optional)');
    expect(api.saveToHardware).not.toHaveBeenCalled(); // never saved implicitly
    await user.click(within(result).getByRole('button', { name: 'Save to hardware…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save to hardware?' });
    expect(api.saveToHardware).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('locks the whole screen and shows progress while sending, then releases it', async () => {
    let release!: (r: SendRcfgxResult) => void;
    const pending = new Promise<SendRcfgxResult>((r) => (release = r));
    const progress: RcfgxProgress = { fileId: 'x', running: true, recordsTotal: 41, recordsDone: 12, bytesTotal: 6598, bytesDone: 3000, currentIndex: 12, currentAddress: 0x0e00_0000, failed: false };
    const api = fakeImportApi({ sendRcfgx: vi.fn(() => pending), getRcfgxProgress: vi.fn(async () => progress) });
    const { user } = await ready(api);
    await acknowledgeAll(user);
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    const busy = await screen.findByTestId('imp-rc-busy');
    expect(busy).toHaveTextContent('All other controls are locked');
    await waitFor(() => expect(screen.getByTestId('imp-rc-progress')).toHaveTextContent('Record 12 of 41 (3000 of 6598 bytes). Now: 0x0E000000'));
    expect(screen.getByTestId('imp-rc-file')).toBeDisabled();
    release(SENT_OK);
    await waitFor(() => expect(screen.queryByTestId('imp-rc-busy')).toBeNull());
    expect(await screen.findByTestId('imp-rc-result')).toBeInTheDocument();
  });

  it('reports a partial failure with the exact count and what to do', async () => {
    const failed: SendRcfgxResult = {
      ok: false,
      fileId: 'x',
      recordsTotal: 41,
      recordsWritten: 12,
      bytesTotal: 6598,
      bytesWritten: 900,
      commandRecordsWritten: 0,
      failed: { recordIndex: 12, address: 0x0e00_0000, code: 'TIMEOUT', message: 'no answer' },
    };
    const { user } = await ready(fakeImportApi({ sendRcfgx: vi.fn(async () => failed) }));
    await acknowledgeAll(user);
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    const result = await screen.findByTestId('imp-rc-result');
    expect(result).toHaveTextContent('Stopped at record 13 (0x0E000000): no answer. 12 of 41 writes were written before it.');
    expect(result).toHaveTextContent('power-cycle the cabinet (without saving)');
    expect(within(result).queryByRole('button', { name: 'Save to hardware…' })).toBeNull();
  });

  it('shows a permission error as a toast when the device refuses', async () => {
    const { DeviceError } = await import('@rockzalct/shared');
    const { user } = await ready(fakeImportApi({ sendRcfgx: vi.fn(async () => { throw new DeviceError('PERMISSION', 'no'); }) }));
    await acknowledgeAll(user);
    await user.click(sendButton());
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
    expect(screen.queryByTestId('imp-rc-result')).toBeNull();
    expect(screen.queryByTestId('imp-rc-busy')).toBeNull();
  });
});

describe('NovaImportPage: .scr', () => {
  it('shows the layout, maps it, and loads it into the Screen connection page', async () => {
    const { user } = renderApp(fakeImportApi());
    await user.click(screen.getByRole('button', { name: NAV }));
    await user.upload(fileInput('Screen config (.scr)'), file('test.scr'));
    const summary = await screen.findByTestId('imp-scr-summary');
    expect(summary).toHaveTextContent('DVI input: 128 x 7 px (1 x 1 port(s))');
    expect(summary).toHaveTextContent('Screen 1: standard, 5 x 3 cabinets, at (0, 0)');
    expect(screen.getByTestId('imp-scr-mapped')).toHaveTextContent('3 x 5 cabinets of 40 x 40 px on 3 port(s)');
    await user.click(screen.getByRole('button', { name: 'Open in Screen connection page' }));
    expect(await screen.findByRole('heading', { name: 'Screen connection' })).toBeInTheDocument();
    expect(screen.getByText('Screen size: 200 x 120 px, 15 cabinets')).toBeInTheDocument();
  });

  it('shows an unconvertible screen read-only with the reason', async () => {
    const api = fakeImportApi({
      parseScreenFile: vi.fn(async ({ name, bytes }: { name: string; bytes: Uint8Array }): Promise<ScrParseResult> => {
        const res = await parseScr({ name, bytes });
        if (!res.ok) return res;
        return { ok: true, info: { ...res.info, screens: [{ ...res.info.screens[0]!, kind: 'complex' }], layout: { ok: false, reasons: ['not-standard'], details: [] } } };
      }),
    });
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: NAV }));
    await user.upload(fileInput('Screen config (.scr)'), file('test.scr'));
    const ro = await screen.findByTestId('imp-scr-readonly');
    expect(ro).toHaveTextContent('shown read-only');
    expect(ro).toHaveTextContent('It is not a standard screen');
    expect(screen.queryByRole('button', { name: 'Open in Screen connection page' })).toBeNull();
  });

  it('rejects a damaged file with a message', async () => {
    const { user } = renderApp(fakeImportApi());
    await user.click(screen.getByRole('button', { name: NAV }));
    const bytes = raw('test.scr');
    bytes[300] = bytes[300]! ^ 0x55;
    await user.upload(fileInput('Screen config (.scr)'), new File([bytes], 'bad.scr'));
    expect(await screen.findByTestId('imp-scr-error')).toHaveTextContent('checksum does not match');
  });
});

describe('NovaImportPage: Thai', () => {
  it('has the page, the warning and the undo text in Thai', async () => {
    const { user } = renderApp(fakeImportApi(), 'th');
    await user.click(screen.getByRole('button', { name: 'นำเข้าไฟล์ NovaLCT' }));
    expect(screen.getByRole('heading', { name: 'นำเข้าไฟล์ NovaLCT (.rcfgx / .scr)' })).toBeInTheDocument();
    await user.upload(fileInput('ไฟล์ตั้งค่าการ์ดรับ (.rcfgx)'), file(SAMPLE));
    await screen.findByTestId('imp-rc-summary');
    expect(screen.getByTestId('imp-rc-commands')).toHaveTextContent('ยังไม่ยืนยัน');
    expect(screen.getByTestId('imp-rc-undo')).toHaveTextContent('ปิด-เปิดไฟตู้ใหม่');
  });
});
