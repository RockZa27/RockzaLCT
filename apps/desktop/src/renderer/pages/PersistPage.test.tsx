import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  SCREEN_CONFIG_FORMAT,
  SCREEN_CONFIG_VERSION,
  parseModuleLibraryJson,
  parseScreenConfigJson,
  serializeModuleLibrary,
  serializeScreenConfig,
  type ApplyScreenConfigResult,
  type ModuleProfile,
  type ReadScreenConfigResult,
  type ReceiverTarget,
  type SaveToHardwareResult,
  type ScreenConfig,
  type ScreenConfigReceiver,
} from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

const NAV = 'Save & load';

const card = (portIndex: number, cardIndex: number, over: Partial<ScreenConfigReceiver> = {}): ScreenConfigReceiver => ({
  portIndex,
  cardIndex,
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
  ...over,
});

/** What the fake controller (testUtils INFO: 2 ports x 1 card) reports. */
const DEVICE: ScreenConfig = {
  format: SCREEN_CONFIG_FORMAT,
  version: SCREEN_CONFIG_VERSION,
  savedAt: '2026-01-02T03:04:05.000Z',
  controller: { model: 'TestCtrl 9000', firmwareVersion: '9.9.9', outputPorts: 2, receivingCards: 2 },
  sender: {
    video: {
      signalPresent: true,
      resolution: { width: 1920, height: 1080 },
      fieldRateMode: 0,
      fieldRate: 60,
      measuredFieldRate: 60,
      inputSource: 'HDMI',
      inputSourceRaw: 5,
    },
    ports: [0, 1].map((portIndex) => ({ portIndex, enabled: true, width: 0, height: 0, pixels: 0, receivingCards: 1 })),
  },
  receivers: [card(0, 0), card(1, 0)],
  layout: null,
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const readResult = (config: ScreenConfig = DEVICE, extra: Partial<ReadScreenConfigResult> = {}): ReadScreenConfigResult => ({
  config: clone(config),
  failures: [],
  warnings: [],
  complete: true,
  ...extra,
});

/** A file that differs from DEVICE in one card, the resolution and a port. */
const FILE: ScreenConfig = (() => {
  const f = clone(DEVICE);
  f.receivers[1]!.gamma = 31;
  f.sender!.video.resolution = { width: 1280, height: 720 };
  f.sender!.ports[1]!.enabled = false;
  return f;
})();

const fakePersist = (over: Parameters<typeof makeFakeApi>[0] = {}) =>
  makeFakeApi({
    readScreenConfig: vi.fn(async () => readResult()),
    saveToHardware: vi.fn(async (_id: string, target: ReceiverTarget): Promise<SaveToHardwareResult> => ({
      sender: target.scope === 'all' ? { ok: true } : null,
      cards: target.scope === 'all' ? [{ portIndex: 0, cardIndex: 0, ok: true }, { portIndex: 1, cardIndex: 0, ok: true }] : [{ portIndex: target.portIndex, cardIndex: target.cardIndex, ok: true }],
      ok: true,
    })),
    applyScreenConfig: vi.fn(async (): Promise<ApplyScreenConfigResult> => ({
      ok: true,
      steps: [
        { kind: 'receiver', portIndex: 1, cardIndex: 0, status: 'written' },
        { kind: 'sender-resolution', status: 'written' },
        { kind: 'sender-port', portIndex: 1, status: 'written' },
      ],
    })),
    ...over,
  });

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

async function open(over: Parameters<typeof makeFakeApi>[0] = {}) {
  const api = fakePersist(over);
  const { user } = renderApp(api, 'en');
  await connectAndGo(user, screen, NAV);
  return { api, user };
}

const upload = async (user: ReturnType<typeof renderApp>['user'], text: string, name = 'screen.json') => {
  await user.upload(screen.getByLabelText('Config file (.json)'), new File([text], name, { type: 'application/json' }));
};

const textOfBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('PersistPage: help and disconnected state', () => {
  it('is inert while not connected and says NovaLCT files are not supported', async () => {
    const api = fakePersist();
    const { user } = renderApp(api, 'en');
    await user.click(screen.getByRole('button', { name: NAV }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save to hardware…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Read from controller' })).toBeDisabled();
    expect(screen.getByTestId('persist-nova-note')).toHaveTextContent('.rcfgx');
    expect(screen.getByTestId('persist-nova-note')).toHaveTextContent('.scr');
    expect(screen.getByTestId('persist-nova-note')).toHaveTextContent('not documented');
    expect(api.readScreenConfig).not.toHaveBeenCalled();
  });

  it('shows the Thai text', async () => {
    const api = fakePersist();
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'บันทึก/โหลด' }));
    expect(screen.getByRole('heading', { name: 'บันทึก / โหลด' })).toBeInTheDocument();
    expect(screen.getByTestId('persist-nova-note')).toHaveTextContent('.rcfgx');
  });
});

describe('PersistPage: save to hardware', () => {
  it('needs the advanced level and warns that the save value is unverified', async () => {
    const { api } = await open();
    expect(screen.getByRole('button', { name: 'Save to hardware…' })).toBeDisabled();
    expect(screen.getAllByText(/needs an advanced login/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not documented by the device library/)).toBeInTheDocument();
    expect(api.saveToHardware).not.toHaveBeenCalled();
  });

  it('asks for confirmation, and only a confirmed save reaches the device', async () => {
    const { api, user } = await open();
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Save to hardware…' }));
    const dialog = screen.getByRole('dialog', { name: 'Save to hardware?' });
    expect(dialog).toHaveTextContent('all receiving cards');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.saveToHardware).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save to hardware…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.saveToHardware).toHaveBeenCalledWith(CONTROLLER.id, { scope: 'all' }, { includeSender: true }));
    expect(await within(await screen.findByTestId('save-result')).findByText(/Saved 2 receiving card\(s\)\./)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('saves one chosen card without the sender by default', async () => {
    const { api, user } = await open();
    await loginAdvanced(user);
    await user.selectOptions(screen.getByLabelText('Save which cards'), 'Port 1 / Card 0');
    expect(screen.getByLabelText('Also save the sending card')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save to hardware…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('port 1 / card 0');
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() =>
      expect(api.saveToHardware).toHaveBeenCalledWith(CONTROLLER.id, { scope: 'card', portIndex: 1, cardIndex: 0 }, { includeSender: false }),
    );
  });

  it('lists the cards that failed to save', async () => {
    const { user } = await open({
      saveToHardware: vi.fn(async (): Promise<SaveToHardwareResult> => ({
        sender: { ok: false, code: 'TIMEOUT', message: 'sender timed out' },
        cards: [{ portIndex: 0, cardIndex: 0, ok: true }, { portIndex: 1, cardIndex: 0, ok: false, code: 'PROTOCOL', message: 'no ack' }],
        ok: false,
      })),
    });
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Save to hardware…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    const res = await screen.findByTestId('save-result');
    expect(res).toHaveTextContent('Some items could not be saved:');
    expect(res).toHaveTextContent('Port 1 / Card 0: no ack');
    expect(res).toHaveTextContent('Sending card: sender timed out');
    expect(res).not.toHaveTextContent('Port 0 / Card 0');
  });

  it('shows a device error as a toast and no result', async () => {
    const { user } = await open({ saveToHardware: vi.fn(async () => Promise.reject(new DeviceError('TIMEOUT', 'slow'))) });
    await loginAdvanced(user);
    await user.click(screen.getByRole('button', { name: 'Save to hardware…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    expect(await screen.findByText('The controller did not respond in time.')).toBeInTheDocument();
    expect(screen.queryByTestId('save-result')).not.toBeInTheDocument();
  });
});

describe('PersistPage: read back and save a file', () => {
  const stubDownload = () => {
    let blob: Blob | null = null;
    let name = '';
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => {
        blob = b;
        return 'blob:test';
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    return { blob: () => blob, name: () => name };
  };

  it('reads at normal level, summarises and downloads a loadable file', async () => {
    const dl = stubDownload();
    const { api, user } = await open();
    expect(screen.queryByTestId('read-result')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Read from controller' }));
    await waitFor(() => expect(api.readScreenConfig).toHaveBeenCalledWith(CONTROLLER.id));
    const result = await screen.findByTestId('read-result');
    expect(result).toHaveTextContent('2 receiving card(s) on 2 port(s) read. Layout: not available.');

    await user.click(screen.getByRole('button', { name: 'Save config file…' }));
    expect(dl.name()).toMatch(/^rockzalct-screen-config-\d{8}-\d{6}\.json$/);
    const parsed = parseScreenConfigJson(await textOfBlob(dl.blob()!));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.controller.model).toBe('TestCtrl 9000');
      expect(parsed.config.receivers).toHaveLength(2);
      expect(parsed.config).not.toHaveProperty('moduleLibrary');
    }
  });

  it('includes the module library only when asked', async () => {
    const profile: ModuleProfile = { name: 'P3', width: 64, height: 32, scanMode: 16, dataGroups: 8, refNumPerVs: 3840, gamma: 28, grayDepth: 14, grayRealize: 1, grayMode: 2 };
    localStorage.setItem('rockzalct.modules', serializeModuleLibrary([profile]));
    const dl = stubDownload();
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Read from controller' }));
    await user.click(await screen.findByLabelText('Include my module library (1 module(s))'));
    await user.click(screen.getByRole('button', { name: 'Save config file…' }));
    const parsed = parseScreenConfigJson(await textOfBlob(dl.blob()!));
    expect(parsed.ok && parsed.config.moduleLibrary).toEqual([profile]);
  });

  it('reports parts that could not be read, and warnings, without hiding the rest', async () => {
    const partial = readResult(
      { ...DEVICE, receivers: [card(0, 0)] },
      {
        complete: false,
        failures: [{ part: 'receiver', portIndex: 1, cardIndex: 0, code: 'PROTOCOL', message: 'card not answering' }],
        warnings: [{ code: 'layout-not-a-grid' }],
      },
    );
    const { user } = await open({ readScreenConfig: vi.fn(async () => partial) });
    await user.click(screen.getByRole('button', { name: 'Read from controller' }));
    const result = await screen.findByTestId('read-result');
    expect(result).toHaveTextContent('Receiving card port 1 / card 0: card not answering');
    expect(result).toHaveTextContent('do not form a regular grid');
    expect(result).toHaveTextContent('The snapshot is incomplete');
    expect(within(result).getByRole('button', { name: 'Save config file…' })).toBeEnabled();
  });
});

describe('PersistPage: open a file and apply it', () => {
  it('rejects malformed, wrong-version and wrong-format files with the reasons', async () => {
    const { user } = await open();
    await upload(user, '{not json');
    expect(await screen.findByTestId('load-errors')).toHaveTextContent(/invalid JSON/);
    expect(screen.queryByTestId('loaded-file')).not.toBeInTheDocument();

    await upload(user, JSON.stringify({ ...FILE, version: 2 }));
    await waitFor(() => expect(screen.getByTestId('load-errors')).toHaveTextContent(/version 2 is newer/));

    await upload(user, JSON.stringify({ hello: 'world' }));
    await waitFor(() => expect(screen.getByTestId('load-errors')).toHaveTextContent(/format must be "rockzalct.screen-config"/));

    const bad = clone(FILE) as unknown as { receivers: { gamma: number }[] };
    bad.receivers[0]!.gamma = 999;
    await upload(user, JSON.stringify(bad));
    await waitFor(() => expect(screen.getByTestId('load-errors')).toHaveTextContent('receivers[0].gamma'));
  });

  it('loads a valid file, diffs it against the controller and applies after confirmation', async () => {
    const { api, user } = await open();
    await loginAdvanced(user);
    await upload(user, serializeScreenConfig(FILE), 'wall.json');
    expect(await screen.findByTestId('loaded-file')).toHaveTextContent('wall.json: controller TestCtrl 9000, saved 2026-01-02T03:04:05.000Z, 2 receiving card(s).');
    expect(api.applyScreenConfig).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Compare with the controller' }));
    const table = await screen.findByTestId('diff-table');
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows).toEqual([
      ['Receiving card', 'Port 1 / Card 0', 'Gamma (raw)', '28', '31'],
      ['Sending card', 'Screen', 'Input resolution', '1920x1080', '1280x720'],
      ['Sending card', 'Port 1', 'Port enabled', 'true', 'false'],
    ]);
    expect(screen.getByText('3 change(s) would be written:')).toBeInTheDocument();
    expect(api.applyScreenConfig).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply to controller…' }));
    const dialog = screen.getByRole('dialog', { name: 'Apply this file?' });
    expect(dialog).toHaveTextContent('3 change(s) will be written');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.applyScreenConfig).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Apply to controller…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.applyScreenConfig).toHaveBeenCalledTimes(1));
    const [id, config, options] = (api.applyScreenConfig as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(id).toBe(CONTROLLER.id);
    expect(config).toEqual(FILE);
    expect(options).toEqual({ parts: { receivers: true, layout: true, sender: true }, saveToHardware: false, allowModelMismatch: false, skipMissingCards: false });
    const result = await screen.findByTestId('apply-result');
    expect(result).toHaveTextContent('Applied: 3 step(s) written.');
    expect(within(result).getAllByRole('listitem')).toHaveLength(3);
    expect(within(result).getAllByRole('listitem')[0]).toHaveTextContent('Receiving card port 1 / card 0: written');
  });

  it('cannot apply at normal level, but can still compare', async () => {
    const { api, user } = await open();
    await upload(user, serializeScreenConfig(FILE));
    await user.click(await screen.findByRole('button', { name: 'Compare with the controller' }));
    await screen.findByTestId('diff-table');
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeDisabled();
    expect(api.applyScreenConfig).not.toHaveBeenCalled();
  });

  it('says so, and offers nothing to apply, when the controller already matches', async () => {
    const { user } = await open();
    await loginAdvanced(user);
    await upload(user, serializeScreenConfig(DEVICE));
    await user.click(await screen.findByRole('button', { name: 'Compare with the controller' }));
    expect(await screen.findByTestId('up-to-date')).toHaveTextContent('already matches this file');
    expect(screen.queryByTestId('diff-table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeDisabled();
    // ... unless the user still wants to save to flash
    await user.click(screen.getByLabelText('Save to hardware afterwards'));
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeEnabled();
  });

  it('blocks a model mismatch until the user accepts it, and passes the choice on', async () => {
    const other = clone(FILE);
    other.controller.model = 'OtherCtrl';
    const { api, user } = await open();
    await loginAdvanced(user);
    await upload(user, serializeScreenConfig(other));
    await user.click(await screen.findByRole('button', { name: 'Compare with the controller' }));
    expect(await screen.findByText('The file is for "OtherCtrl" but the connected controller is "TestCtrl 9000".')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeDisabled();
    await user.click(screen.getByLabelText('Apply anyway'));
    await user.click(screen.getByRole('button', { name: 'Apply to controller…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.applyScreenConfig).toHaveBeenCalled());
    expect((api.applyScreenConfig as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ allowModelMismatch: true });
  });

  it('blocks cards the controller does not have until they are skipped', async () => {
    const extra = clone(FILE);
    extra.receivers.push(card(1, 4));
    const { api, user } = await open();
    await loginAdvanced(user);
    await upload(user, serializeScreenConfig(extra));
    await user.click(await screen.findByRole('button', { name: 'Compare with the controller' }));
    expect(await screen.findByText('The controller has no receiving card at: 1/4.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeDisabled();
    await user.click(screen.getByLabelText('Skip those cards and apply the rest'));
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeEnabled();
    // turning the receiver part off makes the missing card irrelevant
    await user.click(screen.getByLabelText('Skip those cards and apply the rest'));
    await user.click(screen.getByLabelText('Receiving cards'));
    expect(screen.getByRole('button', { name: 'Apply to controller…' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Apply to controller…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.applyScreenConfig).toHaveBeenCalled());
    expect((api.applyScreenConfig as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({
      parts: { receivers: false, layout: true, sender: true },
      skipMissingCards: false,
    });
  });

  it('shows which step stopped the run', async () => {
    const failed: ApplyScreenConfigResult = {
      ok: false,
      steps: [
        { kind: 'receiver', portIndex: 1, cardIndex: 0, status: 'written' },
        { kind: 'layout', status: 'failed', code: 'PROTOCOL', message: 'port 0 refused' },
      ],
      failedStep: { kind: 'layout', status: 'failed', code: 'PROTOCOL', message: 'port 0 refused' },
    };
    const { user } = await open({ applyScreenConfig: vi.fn(async () => failed) });
    await loginAdvanced(user);
    await upload(user, serializeScreenConfig(FILE));
    await user.click(await screen.findByRole('button', { name: 'Compare with the controller' }));
    await screen.findByTestId('diff-table');
    await user.click(screen.getByRole('button', { name: 'Apply to controller…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    const result = await screen.findByTestId('apply-result');
    expect(result).toHaveTextContent('Stopped at: Screen layout. Nothing after this step was written. port 0 refused');
    const items = within(result).getAllByRole('listitem');
    expect(items[1]).toHaveAttribute('data-status', 'failed');
    expect(items[1]).toHaveTextContent('Screen layout: failed');
    // the diff is stale after a write attempt: it must be recomputed before applying again
    expect(screen.queryByTestId('diff-table')).not.toBeInTheDocument();
  });

  it('asks for save-to-hardware in the confirmation and forwards it', async () => {
    const { api, user } = await open();
    await loginAdvanced(user);
    await upload(user, serializeScreenConfig(FILE));
    await user.click(await screen.findByRole('button', { name: 'Compare with the controller' }));
    await screen.findByTestId('diff-table');
    await user.click(screen.getByLabelText('Save to hardware afterwards'));
    await user.click(screen.getByRole('button', { name: 'Apply to controller…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('also be saved to flash memory');
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.applyScreenConfig).toHaveBeenCalled());
    expect((api.applyScreenConfig as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ saveToHardware: true });
  });

  it('imports the module library from a file into the local library', async () => {
    const profile: ModuleProfile = { name: 'From file', width: 32, height: 16, scanMode: 8, dataGroups: 4, refNumPerVs: 1920, gamma: 20, grayDepth: 13, grayRealize: 0, grayMode: 1 };
    const { user } = await open();
    await upload(user, serializeScreenConfig({ ...DEVICE, moduleLibrary: [profile] }));
    await user.click(await screen.findByRole('button', { name: 'Import the 1 module(s) in this file into my module library' }));
    const stored = parseModuleLibraryJson(localStorage.getItem('rockzalct.modules') ?? '');
    expect(stored.ok && stored.profiles).toEqual([profile]);
  });
});
