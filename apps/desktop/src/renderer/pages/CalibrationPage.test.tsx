import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COEFFICIENT_REGION,
  DeviceError,
  base64ToBytes,
  buildCoefficientFile,
  bytesToBase64,
  parseCoefficientFileJson,
  serializeCoefficientFile,
  type CalibrationCardState,
} from '@rockzalct/shared';
import { connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const NAV = 'Calibration';

const pattern = (length: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return out;
};

const STATE: CalibrationCardState = {
  portIndex: 0,
  cardIndex: 0,
  stateRaw: 3,
  enabled: true,
  type: 'brightness',
  coefficientSourceRaw: 0,
  coefficientSource: 'scan-board-flash',
  coefficientData: 'data',
};

/** A fake API backed by a byte array so uploads and downloads can be checked end to end. */
function fakeCalibration(over: Parameters<typeof makeFakeApi>[0] = {}) {
  const memory = new Uint8Array(COEFFICIENT_REGION.sizeBytes);
  memory.set(pattern(2048, 2));
  const api = makeFakeApi({
    getCalibrationState: vi.fn(async (_id: string, port: number, card: number) => ({ ...STATE, portIndex: port, cardIndex: card })),
    setCalibrationEnabled: vi.fn(async () => undefined),
    readCoefficientBlock: vi.fn(async (_id: string, _p: number, _c: number, offset: number, length: number) => ({
      offset,
      length,
      dataBase64: bytesToBase64(memory.slice(offset, offset + length)),
    })),
    writeCoefficientBlock: vi.fn(async (_id: string, _p: number, _c: number, offset: number, data: string) => {
      memory.set(base64ToBytes(data)!, offset);
    }),
    saveCoefficientsToFlash: vi.fn(async () => undefined),
    reloadCoefficientsFromFlash: vi.fn(async () => undefined),
    eraseCoefficientsInFlash: vi.fn(async () => undefined),
    ...over,
  });
  return { api, memory };
}

async function open(over: Parameters<typeof makeFakeApi>[0] = {}) {
  const fake = fakeCalibration(over);
  const { user } = renderApp(fake.api, 'en');
  await connectAndGo(user, screen, NAV);
  return { ...fake, user };
}

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

interface Download {
  name: string;
  blob: Blob;
}
const stubDownloads = (): Download[] => {
  const downloads: Download[] = [];
  let last: Blob | null = null;
  Object.assign(URL, {
    createObjectURL: vi.fn((b: Blob) => {
      last = b;
      return 'blob:test';
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: last! });
  });
  return downloads;
};
const textOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });

const CONTROLLER_INFO = { model: 'TestCtrl 9000', firmwareVersion: '9.9.9' };
const fileOf = (data: Uint8Array, port = 0, card = 0, offset = 0): string =>
  serializeCoefficientFile(buildCoefficientFile({ controller: CONTROLLER_INFO, portIndex: port, cardIndex: card, offset, data }));

const upload = async (user: ReturnType<typeof renderApp>['user'], text: string, name = 'coef.json') => {
  await user.upload(screen.getByLabelText('Coefficient file (.json)'), new File([text], name, { type: 'application/json' }));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CalibrationPage: state and switch', () => {
  it('is inert while not connected', async () => {
    const { api } = fakeCalibration();
    const { user } = renderApp(api, 'en');
    await user.click(screen.getByRole('button', { name: NAV }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    expect(screen.getByLabelText('Receiving card')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download from card' })).toBeDisabled();
    expect(api.getCalibrationState).not.toHaveBeenCalled();
  });

  it('reads and shows the state of the selected card', async () => {
    const { api, user } = await open();
    await waitFor(() => expect(api.getCalibrationState).toHaveBeenCalledWith('serial:COM9', 0, 0));
    expect(await screen.findByTestId('cal-enabled')).toHaveTextContent('On');
    expect(screen.getByTestId('cal-type')).toHaveTextContent('Brightness');
    expect(screen.getByTestId('cal-source')).toHaveTextContent('Receiving card flash');
    expect(screen.getByTestId('cal-data')).toHaveTextContent('Contains data');
    expect(screen.getByTestId('cal-raw')).toHaveTextContent('0x03');

    await user.selectOptions(screen.getByLabelText('Receiving card'), '1:0');
    await waitFor(() => expect(api.getCalibrationState).toHaveBeenCalledWith('serial:COM9', 1, 0));
  });

  it('switches calibration at the normal level, for one card or all', async () => {
    const { api, user } = await open();
    await screen.findByTestId('cal-enabled');
    await user.selectOptions(screen.getByLabelText('Type to apply'), 'chroma');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(api.setCalibrationEnabled).toHaveBeenCalledWith('serial:COM9', { scope: 'card', portIndex: 0, cardIndex: 0 }, true, 'chroma'),
    );
    expect(await screen.findByText('Calibration turned on for port 1 / card 1.')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'All receiving cards' }));
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.setCalibrationEnabled).toHaveBeenLastCalledWith('serial:COM9', { scope: 'all' }, false, undefined));
    expect(await screen.findByText('Calibration turned off for all receiving cards.')).toBeInTheDocument();
  });

  it('lists what is not supported', async () => {
    await open();
    const list = within(screen.getByTestId('cal-unsupported'));
    expect(list.getByText(/Seam \/ bright-dark line fix/)).toBeInTheDocument();
    expect(list.getByText(/Searched for: BrightDarkLine, DarkLine/)).toBeInTheDocument();
    expect(list.getByText(/Selected-area adjustment/)).toBeInTheDocument();
  });

  it('renders in Thai', async () => {
    const { api } = fakeCalibration();
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'คาลิเบรต' }));
    expect(await screen.findByRole('heading', { name: 'คาลิเบรต' })).toBeInTheDocument();
    expect(await screen.findByText('สถานะคาลิเบรต')).toBeInTheDocument();
  });
});

describe('CalibrationPage: download', () => {
  it('reads block by block with progress and saves a loadable file', async () => {
    const downloads = stubDownloads();
    const { api, memory, user } = await open();
    await user.clear(screen.getByLabelText('Length (bytes)'));
    await user.type(screen.getByLabelText('Length (bytes)'), '600');
    await user.clear(screen.getByLabelText('Start offset (bytes)'));
    await user.type(screen.getByLabelText('Start offset (bytes)'), '100');
    await user.click(screen.getByRole('button', { name: 'Download from card' }));

    await waitFor(() => expect(screen.getByTestId('cal-dl-result')).toHaveTextContent('Saved 600 bytes to rockzalct-coefficients-p1c1-'));
    expect(api.readCoefficientBlock).toHaveBeenCalledTimes(3);
    expect((api.readCoefficientBlock as ReturnType<typeof vi.fn>).mock.calls.map((c) => [c[3], c[4]])).toEqual([
      [100, 256],
      [356, 256],
      [612, 88],
    ]);
    expect(downloads).toHaveLength(1);
    const parsed = parseCoefficientFileJson(await textOf(downloads[0]!.blob));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.card).toEqual({ portIndex: 0, cardIndex: 0 });
      expect(parsed.file.region).toMatchObject({ offset: 100, length: 600 });
      expect(parsed.file.controller).toEqual(CONTROLLER_INFO);
      expect(parsed.bytes).toEqual(memory.slice(100, 700));
    }
    expect(screen.queryByTestId('cal-progress')).not.toBeInTheDocument();
  });

  it('refuses a range outside the coefficient memory without reading', async () => {
    const downloads = stubDownloads();
    const { api, user } = await open();
    await user.clear(screen.getByLabelText('Start offset (bytes)'));
    await user.type(screen.getByLabelText('Start offset (bytes)'), '5');
    await user.click(screen.getByRole('button', { name: 'Download from card' }));
    expect(screen.getByTestId('cal-dl-result')).toHaveTextContent('must be whole numbers inside the 2097152-byte coefficient memory');
    expect(api.readCoefficientBlock).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it('can be cancelled and then saves no file', async () => {
    const downloads = stubDownloads();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const { api, user } = await open({
      readCoefficientBlock: vi.fn(async (_id: string, _p: number, _c: number, offset: number, length: number) => {
        reads += 1;
        if (reads === 2) await gate;
        return { offset, length, dataBase64: bytesToBase64(new Uint8Array(length)) };
      }),
    });
    await user.clear(screen.getByLabelText('Length (bytes)'));
    await user.type(screen.getByLabelText('Length (bytes)'), '1024');
    await user.click(screen.getByRole('button', { name: 'Download from card' }));
    const progress = await screen.findByTestId('cal-progress');
    expect(progress).toHaveTextContent('Reading…');
    expect(screen.getByLabelText('Receiving card')).toBeDisabled();
    await user.click(within(progress).getByRole('button', { name: 'Cancel transfer' }));
    release();
    await waitFor(() => expect(screen.getByTestId('cal-dl-result')).toHaveTextContent('Stopped after 512 of 1024 bytes. No file was saved.'));
    expect(api.readCoefficientBlock).toHaveBeenCalledTimes(2);
    expect(downloads).toHaveLength(0);
    expect(screen.getByLabelText('Receiving card')).not.toBeDisabled();
  });
});

describe('CalibrationPage: upload', () => {
  it('is locked at the normal level and never sends a write', async () => {
    const { api, user } = await open();
    await upload(user, fileOf(pattern(300)));
    expect(await screen.findByTestId('cal-file-summary')).toHaveTextContent('port 1 / card 1, offset 0, 300 bytes, checksum correct');
    expect(screen.getByRole('button', { name: 'Upload to card…' })).toBeDisabled();
    expect(screen.getAllByText(/need an advanced login/).length).toBeGreaterThan(0);
    expect(api.writeCoefficientBlock).not.toHaveBeenCalled();
  });

  it('confirms by naming the card, backs up first (the default) and then writes', async () => {
    const downloads = stubDownloads();
    const { api, memory, user } = await open();
    await loginAdvanced(user);
    const before = memory.slice(0, 300);
    const data = pattern(300, 9);
    await upload(user, fileOf(data));
    await screen.findByTestId('cal-file-summary');
    expect(screen.getByRole('checkbox', { name: /Back up the card's current coefficients/ })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Upload to card…' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Upload coefficients?' }));
    expect(dialog.getByText(/written to port 1 \/ card 1, replacing 300 bytes/)).toBeInTheDocument();
    expect(dialog.getByText('A backup file of the current coefficients is saved first.')).toBeInTheDocument();

    // "No, go back" changes nothing
    await user.click(dialog.getByRole('button', { name: 'No, go back' }));
    expect(api.readCoefficientBlock).not.toHaveBeenCalled();
    expect(api.writeCoefficientBlock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Upload to card…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(screen.getByTestId('cal-up-result')).toHaveTextContent('Uploaded 300 bytes to port 1 / card 1.'));

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toMatch(/^rockzalct-backup-p1c1-/);
    const backup = parseCoefficientFileJson(await textOf(downloads[0]!.blob));
    expect(backup.ok && backup.bytes).toEqual(before); // the backup holds what the card had BEFORE the write
    expect(memory.slice(0, 300)).toEqual(data);
    expect(screen.getByText(/Backup saved to rockzalct-backup-p1c1-/)).toBeInTheDocument();
    // backup was read before the first write
    const firstRead = (api.readCoefficientBlock as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const firstWrite = (api.writeCoefficientBlock as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(firstRead).toBeLessThan(firstWrite);
  });

  it('warns and skips the backup when the user turns it off', async () => {
    const downloads = stubDownloads();
    const { api, user } = await open();
    await loginAdvanced(user);
    await upload(user, fileOf(pattern(100, 4)));
    await screen.findByTestId('cal-file-summary');
    await user.click(screen.getByRole('checkbox', { name: /Back up the card's current coefficients/ }));
    expect(screen.getByText(/Without a backup, the current coefficients are lost/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Upload to card…' }));
    expect(within(screen.getByRole('dialog')).getByText('No backup will be made.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(screen.getByTestId('cal-up-result')).toHaveTextContent('Uploaded 100 bytes'));
    expect(api.readCoefficientBlock).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it('writes nothing when the backup cannot be completed', async () => {
    stubDownloads();
    const { api, memory, user } = await open({
      readCoefficientBlock: vi.fn(async () => {
        throw new DeviceError('TIMEOUT', 'no answer');
      }),
    });
    await loginAdvanced(user);
    const before = memory.slice();
    await upload(user, fileOf(pattern(100, 4)));
    await screen.findByTestId('cal-file-summary');
    await user.click(screen.getByRole('button', { name: 'Upload to card…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    const result = await screen.findByTestId('cal-up-result');
    expect(result).toHaveTextContent('Nothing was written to the card.');
    expect(result).toHaveTextContent('The controller did not respond in time.');
    expect(api.writeCoefficientBlock).not.toHaveBeenCalled();
    expect(memory).toEqual(before);
  });

  it('rejects malformed, damaged and wrong-size files', async () => {
    const { api, user } = await open();
    await loginAdvanced(user);

    await upload(user, 'not json at all');
    expect(await screen.findByTestId('cal-file-error')).toHaveTextContent('file is not valid JSON');

    const good = JSON.parse(fileOf(pattern(300))) as Record<string, any>;
    const flipped = pattern(300);
    flipped[3] = flipped[3]! ^ 1;
    await upload(user, JSON.stringify({ ...good, data: bytesToBase64(flipped) }));
    expect(await screen.findByTestId('cal-file-error')).toHaveTextContent('checksum does not match the data');

    await upload(user, JSON.stringify({ ...good, region: { ...good.region, length: 299 } }));
    expect(await screen.findByTestId('cal-file-error')).toHaveTextContent('data holds 300 bytes but region.length is 299');

    await upload(user, JSON.stringify({ ...good, version: 7 }));
    expect(await screen.findByTestId('cal-file-error')).toHaveTextContent('unsupported version 7');

    expect(screen.queryByTestId('cal-file-summary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload to card…' })).toBeDisabled();
    expect(api.writeCoefficientBlock).not.toHaveBeenCalled();
  });

  it('refuses a file from another card until the user insists', async () => {
    const { api, user } = await open();
    await loginAdvanced(user);
    await upload(user, fileOf(pattern(100), 1, 0));
    await screen.findByTestId('cal-file-summary');
    expect(screen.getByTestId('cal-file-summary')).toHaveTextContent('port 2 / card 1');
    expect(screen.getByRole('button', { name: 'Upload to card…' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /saved from another card.*port 2 \/ card 1, not port 1 \/ card 1/ }));
    expect(screen.getByRole('button', { name: 'Upload to card…' })).toBeEnabled();
    expect(api.writeCoefficientBlock).not.toHaveBeenCalled();
  });

  it('reports exactly which byte ranges a failed upload wrote', async () => {
    stubDownloads();
    let writes = 0;
    const { memory, user } = await open({
      writeCoefficientBlock: vi.fn(async (_id: string, _p: number, _c: number, offset: number, data: string) => {
        writes += 1;
        if (writes === 3) throw new DeviceError('TIMEOUT', 'no answer');
        memory.set(base64ToBytes(data)!, offset);
      }),
    });
    await loginAdvanced(user);
    await upload(user, fileOf(pattern(1000, 6)));
    await screen.findByTestId('cal-file-summary');
    await user.click(screen.getByRole('checkbox', { name: /Back up the card's current coefficients/ }));
    await user.click(screen.getByRole('button', { name: 'Upload to card…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    const result = await screen.findByTestId('cal-up-result');
    expect(result).toHaveTextContent('PARTLY WRITTEN');
    expect(screen.getByTestId('cal-up-written')).toHaveTextContent('Byte ranges written: 0x000000–0x000200');
    expect(result).toHaveTextContent('Failed at offset 512 (256 bytes)');
    expect(result).toHaveTextContent('Upload the file again to finish, or upload the backup file to go back.');
    expect(memory.slice(0, 512)).toEqual(pattern(1000, 6).slice(0, 512));
    expect(memory.slice(512, 768)).toEqual(pattern(2048, 2).slice(512, 768)); // untouched
  });

  it('stops on request and says the card is partly written', async () => {
    stubDownloads();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let writes = 0;
    const { memory, user } = await open({
      writeCoefficientBlock: vi.fn(async (_id: string, _p: number, _c: number, offset: number, data: string) => {
        writes += 1;
        if (writes === 2) await gate;
        memory.set(base64ToBytes(data)!, offset);
      }),
    });
    await loginAdvanced(user);
    await upload(user, fileOf(pattern(1000, 6)));
    await screen.findByTestId('cal-file-summary');
    await user.click(screen.getByRole('checkbox', { name: /Back up the card's current coefficients/ }));
    await user.click(screen.getByRole('button', { name: 'Upload to card…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    const progress = await screen.findByTestId('cal-progress');
    expect(progress).toHaveTextContent('Uploading…');
    await user.click(within(progress).getByRole('button', { name: 'Cancel transfer' }));
    release();
    const result = await screen.findByTestId('cal-up-result');
    expect(result).toHaveTextContent('The upload did not finish (cancelled). The card is PARTLY WRITTEN.');
    expect(screen.getByTestId('cal-up-written')).toHaveTextContent('0x000000–0x000200');
    expect(writes).toBe(2);
  });
});

// Only a backup of the whole coefficient region unlocks store / erase.
const backUpSelectedCard = async (user: ReturnType<typeof renderApp>['user'], bytes: number = COEFFICIENT_REGION.sizeBytes) => {
  await user.clear(screen.getByLabelText('Length (bytes)'));
  await user.type(screen.getByLabelText('Length (bytes)'), String(bytes));
  await user.click(screen.getByRole('button', { name: 'Download from card' }));
  // a whole-region backup is 8192 block reads
  await waitFor(() => expect(screen.getByTestId('cal-dl-result')).toHaveTextContent('Saved'), { timeout: 30_000 });
};

describe('CalibrationPage: flash', () => {
  it('is locked at the normal level', async () => {
    const { api } = await open();
    for (const name of ['Store to flash…', 'Reload from flash…', 'Erase flash…']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(api.saveCoefficientsToFlash).not.toHaveBeenCalled();
  });

  it('keeps store and erase disabled, with the reason, until THIS card was downloaded to a file', async () => {
    const downloads = stubDownloads();
    const { api, user } = await open();
    await loginAdvanced(user);
    expect(screen.getByTestId('cal-needs-backup')).toHaveTextContent('port 1 / card 1');
    expect(screen.getByRole('button', { name: 'Store to flash…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Erase flash…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload from flash…' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Back up now (whole memory)' })).toBeEnabled();

    // a backup of ANOTHER card does not unlock card 1
    await user.selectOptions(screen.getByLabelText('Receiving card'), '1:0');
    await backUpSelectedCard(user);
    expect(downloads).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Store to flash…' })).toBeEnabled(); // card 2 itself is unlocked
    await user.selectOptions(screen.getByLabelText('Receiving card'), '0:0');
    expect(screen.getByTestId('cal-needs-backup')).toHaveTextContent('port 1 / card 1');
    expect(screen.getByRole('button', { name: 'Store to flash…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Erase flash…' })).toBeDisabled();

    // a download that was cancelled / failed does not unlock either
    (api.readCoefficientBlock as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new DeviceError('TIMEOUT', 'x');
    });
    await user.click(screen.getByRole('button', { name: 'Download from card' }));
    await waitFor(() => expect(screen.getByTestId('cal-dl-result')).toHaveTextContent('Reading failed'));
    expect(screen.getByRole('button', { name: 'Erase flash…' })).toBeDisabled();

    // a completed but PARTIAL download of card 1 saves a file yet does not unlock: erase wipes everything
    await backUpSelectedCard(user, 300);
    expect(downloads).toHaveLength(2);
    expect(screen.getByTestId('cal-needs-backup')).toHaveTextContent('port 1 / card 1');
    expect(screen.getByRole('button', { name: 'Erase flash…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Store to flash…' })).toBeDisabled();

    // a completed download of card 1's whole region unlocks it
    await backUpSelectedCard(user);
    expect(downloads).toHaveLength(3);
    expect(screen.queryByTestId('cal-needs-backup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Store to flash…' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Erase flash…' })).toBeEnabled();
    expect(api.saveCoefficientsToFlash).not.toHaveBeenCalled();
    expect(api.eraseCoefficientsInFlash).not.toHaveBeenCalled();
  }, 60_000);

  it('offers a Back up now shortcut that unlocks the card once the file was saved', async () => {
    const downloads = stubDownloads();
    const { api, user } = await open({
      readCoefficientBlock: vi.fn(async (_id: string, _p: number, _c: number, offset: number, length: number) => ({
        offset,
        length,
        dataBase64: bytesToBase64(new Uint8Array(length)),
      })),
    });
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Back up now (whole memory)' }));
    await waitFor(() => expect(screen.getByTestId('cal-flash-backup-result')).toHaveTextContent('Saved 2097152 bytes'), { timeout: 20000 });
    expect(api.readCoefficientBlock).toHaveBeenCalledTimes(8192);
    expect(downloads).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Erase flash…' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Back up now (whole memory)' })).not.toBeInTheDocument();
  }, 30000);

  it('names the card in every confirmation and does nothing until confirmed', async () => {
    stubDownloads();
    const { api, user } = await open();
    await loginAdvanced(user);
    await user.selectOptions(screen.getByLabelText('Receiving card'), '1:0');
    await backUpSelectedCard(user);

    await user.click(screen.getByRole('button', { name: 'Store to flash…' }));
    let dialog = within(screen.getByRole('dialog', { name: 'Store coefficients to flash?' }));
    expect(dialog.getByText(/of port 2 \/ card 1 \(Standard\) will be copied/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'No, go back' }));
    expect(api.saveCoefficientsToFlash).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Store to flash…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.saveCoefficientsToFlash).toHaveBeenCalledWith('serial:COM9', 1, 0, 'standard'));
    expect(await screen.findByText('Done for port 2 / card 1.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Coefficient set'), 'multi-layer');
    await user.click(screen.getByRole('button', { name: 'Reload from flash…' }));
    dialog = within(screen.getByRole('dialog', { name: 'Reload coefficients from flash?' }));
    expect(dialog.getByText(/flash of port 2 \/ card 1 \(Multi-layer\)/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.reloadCoefficientsFromFlash).toHaveBeenCalledWith('serial:COM9', 1, 0, 'multi-layer'));
  }, 60_000);

  it('erase needs the card position typed exactly', async () => {
    stubDownloads();
    const { api, user } = await open();
    await loginAdvanced(user);
    await user.selectOptions(screen.getByLabelText('Receiving card'), '1:0');
    await backUpSelectedCard(user);

    await user.click(screen.getByRole('button', { name: 'Erase flash…' }));
    let dialog = within(screen.getByRole('dialog', { name: 'Erase coefficients in flash?' }));
    expect(dialog.getByText(/flash of port 2 \/ card 1 will be ERASED/)).toBeInTheDocument();
    expect(dialog.getByText(/not documented by the device library/)).toBeInTheDocument();
    const confirm = dialog.getByRole('button', { name: 'Yes, continue' });
    expect(confirm).toBeDisabled();
    const input = dialog.getByLabelText('Type 2-1 (port-card) to confirm the erase');
    for (const wrong of ['1-1', '2-2', '21', '2 -1']) {
      await user.clear(input);
      await user.type(input, wrong);
      expect(confirm).toBeDisabled();
    }
    await user.click(confirm); // disabled: nothing happens
    expect(api.eraseCoefficientsInFlash).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: 'No, go back' }));
    expect(api.eraseCoefficientsInFlash).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Erase flash…' }));
    dialog = within(screen.getByRole('dialog', { name: 'Erase coefficients in flash?' }));
    expect(dialog.getByRole('button', { name: 'Yes, continue' })).toBeDisabled(); // the typed text does not survive
    await user.type(dialog.getByLabelText('Type 2-1 (port-card) to confirm the erase'), '2-1');
    expect(dialog.getByRole('button', { name: 'Yes, continue' })).toBeEnabled();
    await user.click(dialog.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.eraseCoefficientsInFlash).toHaveBeenCalledWith('serial:COM9', 1, 0));
  }, 60_000);
});
