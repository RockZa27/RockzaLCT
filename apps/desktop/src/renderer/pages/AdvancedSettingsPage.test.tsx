import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HARDWARE_OVERRIDES,
  DeviceError,
  parseHardwareOverridesJson,
  serializeHardwareOverrides,
  type ControllerInfo,
  type HardwareOverrides,
} from '@rockzalct/shared';
import { dictionaries } from '../i18n/dictionary';
import { INFO, connectAndGo, makeFakeApi, renderApp } from '../testUtils';
import { OVERRIDE_META, descKey, groupKey, labelKey } from './advanced/meta';

const NAV = 'Advanced hardware settings';

/** A fake device whose overrides behave like the real service (merge, reset), minus validation (the UI validates first). */
function fakeApi(over: Parameters<typeof makeFakeApi>[0] = {}, start: Partial<HardwareOverrides> = {}) {
  let state: HardwareOverrides = { ...DEFAULT_HARDWARE_OVERRIDES, ...start };
  return makeFakeApi({
    getHardwareOverrides: vi.fn(async () => ({ ...state })),
    setHardwareOverrides: vi.fn(async (partial: Partial<HardwareOverrides>) => (state = { ...state, ...partial })),
    resetHardwareOverrides: vi.fn(async () => (state = { ...DEFAULT_HARDWARE_OVERRIDES })),
    ...over,
  });
}

async function loginAdvanced(user: ReturnType<typeof renderApp>['user']) {
  await user.click(screen.getByRole('button', { name: 'Advanced login' }));
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByText('Level: Advanced');
}

async function open(over: Parameters<typeof makeFakeApi>[0] = {}, start: Partial<HardwareOverrides> = {}, advanced = false) {
  const api = fakeApi(over, start);
  const { user } = renderApp(api, 'en');
  await user.click(screen.getByRole('button', { name: NAV }));
  await screen.findByTestId('adv-row-killOn');
  if (advanced) await loginAdvanced(user);
  return { api, user };
}

const textOfBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(blob);
  });

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

const field = (key: string) => screen.getByLabelText(new RegExp(`\\(${key}\\)`));

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('AdvancedSettingsPage: what is shown', () => {
  it('lists every value with current, default, explanation, checklist step and a red UNVERIFIED tag', async () => {
    await open();
    expect(screen.getAllByText('UNVERIFIED')).toHaveLength(OVERRIDE_META.length);
    expect(OVERRIDE_META).toHaveLength(10);
    for (const m of OVERRIDE_META) {
      const row = screen.getByTestId(`adv-row-${m.key}`);
      expect(within(row).getByText(dictionaries.en[labelKey(m.key)])).toBeInTheDocument();
      expect(within(row).getByText(dictionaries.en[descKey(m.key)])).toBeInTheDocument();
      expect(within(row).getByText('UNVERIFIED')).toHaveClass('tag-unverified');
    }
    expect(screen.getByTestId('adv-current-killOn')).toHaveTextContent('1 (0x01)');
    expect(screen.getByTestId('adv-default-killOff')).toHaveTextContent('0 (0x00)');
    expect(screen.getByTestId('adv-current-correctionBrightnessTypeBit')).toHaveTextContent('bit 1 (0x02)');
    expect(screen.getByTestId('adv-current-scannerXyOrder')).toHaveTextContent('X in the high 16 bits (default)');
  });

  it('cites the checklist steps that test each value (calibration has none yet)', async () => {
    await open();
    expect(screen.getByTestId('adv-step-killOn')).toHaveTextContent('Tested in checklist step 7 (7a)');
    expect(screen.getByTestId('adv-step-lockOn')).toHaveTextContent('Tested in checklist step 7 (7b)');
    expect(screen.getByTestId('adv-step-saveReceiver')).toHaveTextContent('Tested in checklist step 12');
    expect(screen.getByTestId('adv-step-scannerXyOrder')).toHaveTextContent('Tested in checklist step 10, 13');
    expect(screen.getByTestId('adv-step-eraseSpiFlash')).toHaveTextContent('No checklist step yet');
  });

  it('marks a value that differs from its default', async () => {
    await open({}, { lockOn: 2 });
    expect(within(screen.getByTestId('adv-row-lockOn')).getByText('differs from default')).toBeInTheDocument();
    expect(within(screen.getByTestId('adv-row-killOn')).queryByText('differs from default')).not.toBeInTheDocument();
    expect(screen.getByTestId('adv-current-lockOn')).toHaveTextContent('2 (0x02)');
  });

  it('is in the menu for every family and says it only applies to MCTRL / VX', async () => {
    const h: ControllerInfo = { ...INFO, family: 'hseries', model: 'H5', outputPorts: 0, receivingCards: [] };
    const api = fakeApi({ connect: vi.fn(async () => h) });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, NAV);
    expect(screen.getByRole('button', { name: NAV })).toBeInTheDocument();
    expect(screen.getByTestId('adv-scope')).toHaveTextContent('H series or Taurus');
    expect(screen.getByTestId('adv-scope')).toHaveTextContent('only apply to MCTRL / VX');
  });

  it('shows the MCTRL / VX scope line for a sending card or nothing connected', async () => {
    await open();
    expect(screen.getByTestId('adv-scope')).toHaveTextContent('Applies to MCTRL / VX sending cards only.');
  });

  it('has an English and a Thai text for every row', () => {
    for (const lang of ['en', 'th'] as const) {
      for (const m of OVERRIDE_META) {
        for (const k of [labelKey(m.key), descKey(m.key), groupKey(m.group)]) {
          expect(dictionaries[lang][k], `${lang} ${k}`).toBeTruthy();
        }
      }
    }
    expect(dictionaries.th['nav.advanced']).toBe('ตั้งค่าฮาร์ดแวร์ขั้นสูง');
  });
});

describe('AdvancedSettingsPage: editing needs the advanced level', () => {
  it('disables every editor and the write buttons at the normal level, but not the export', async () => {
    await open();
    expect(screen.getByTestId('adv-need-login')).toBeInTheDocument();
    for (const m of OVERRIDE_META) expect(screen.getByLabelText(dictionaries.en[labelKey(m.key)])).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save settings…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset to defaults…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import from file…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export to file' })).toBeEnabled();
  });

  it('enables them after the advanced login', async () => {
    await open({}, {}, true);
    expect(screen.queryByTestId('adv-need-login')).not.toBeInTheDocument();
    expect(field('killOn')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save settings…' })).toBeEnabled();
  });
});

describe('AdvancedSettingsPage: save', () => {
  it('asks for confirmation listing exactly what changes, then sends only those values', async () => {
    const { api, user } = await open({}, {}, true);
    await user.clear(field('lockOn'));
    await user.type(field('lockOn'), '2');
    await user.selectOptions(field('scannerXyOrder'), 'x-low');
    await user.click(screen.getByRole('button', { name: 'Save settings…' }));

    const dialog = screen.getByRole('dialog', { name: 'Apply these hardware settings?' });
    const items = within(within(dialog).getByTestId('adv-save-changes')).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Freeze ON byte (lockOn): 1 (0x01) → 2 (0x02)',
      'Card X/Y word order (scannerXyOrder): X in the high 16 bits (default) → X in the low 16 bits',
    ]);
    expect(api.setHardwareOverrides).not.toHaveBeenCalled(); // nothing before the confirmation

    await user.click(within(dialog).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.setHardwareOverrides).toHaveBeenCalledTimes(1));
    expect(api.setHardwareOverrides).toHaveBeenCalledWith({ lockOn: 2, scannerXyOrder: 'x-low' });
    await waitFor(() => expect(screen.getByTestId('adv-current-lockOn')).toHaveTextContent('2 (0x02)'));
    expect(screen.getByTestId('adv-current-scannerXyOrder')).toHaveTextContent('X in the low 16 bits');
    expect(await screen.findByText('Hardware settings applied.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Cancel sends nothing and keeps the edit', async () => {
    const { api, user } = await open({}, {}, true);
    await user.clear(field('saveSender'));
    await user.type(field('saveSender'), '9');
    await user.click(screen.getByRole('button', { name: 'Save settings…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();
    expect(field('saveSender')).toHaveValue(9);
  });

  it('says so instead of opening a dialog when nothing changed', async () => {
    const { api, user } = await open({}, {}, true);
    await user.click(screen.getByRole('button', { name: 'Save settings…' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText(/Nothing to save/)).toBeInTheDocument();
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();
  });

  it('blocks invalid values with a message and keeps Save disabled', async () => {
    const { api, user } = await open({}, {}, true);
    await user.clear(field('killOn'));
    await user.type(field('killOn'), '300');
    expect(within(screen.getByTestId('adv-row-killOn')).getByRole('alert')).toHaveTextContent('Enter a whole number from 0 to 255.');
    expect(screen.getByRole('button', { name: 'Save settings…' })).toBeDisabled();

    await user.clear(field('killOn'));
    expect(within(screen.getByTestId('adv-row-killOn')).getByRole('alert')).toBeInTheDocument(); // blank is not a number
    await user.type(field('killOn'), '255');
    expect(within(screen.getByTestId('adv-row-killOn')).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings…' })).toBeEnabled();
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();
  });

  it('rejects two equal correction bits', async () => {
    const { user } = await open({}, {}, true);
    await user.selectOptions(field('correctionBrightnessTypeBit'), '1');
    expect(within(screen.getByTestId('adv-row-correctionBrightnessTypeBit')).getByRole('alert')).toHaveTextContent('must be different');
    expect(screen.getByRole('button', { name: 'Save settings…' })).toBeDisabled();
    await user.selectOptions(field('correctionEnabledBit'), '4');
    expect(screen.getByRole('button', { name: 'Save settings…' })).toBeEnabled();
  });

  it('Discard edits puts the current values back', async () => {
    const { user } = await open({}, {}, true);
    await user.clear(field('killOff'));
    await user.type(field('killOff'), '8');
    await user.click(screen.getByRole('button', { name: 'Discard edits' }));
    expect(field('killOff')).toHaveValue(0);
  });

  it('shows a device error as a toast and keeps the old values', async () => {
    const { user } = await open({ setHardwareOverrides: vi.fn(async () => Promise.reject(new DeviceError('PERMISSION', 'no'))) }, {}, true);
    await user.clear(field('killOn'));
    await user.type(field('killOn'), '4');
    await user.click(screen.getByRole('button', { name: 'Save settings…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, continue' }));
    expect(await screen.findByText('Permission denied. Advanced login required.')).toBeInTheDocument();
    expect(screen.getByTestId('adv-current-killOn')).toHaveTextContent('1 (0x01)');
  });
});

describe('AdvancedSettingsPage: reset to defaults', () => {
  it('confirms, then resets', async () => {
    const { api, user } = await open({}, { lockOn: 2, saveSender: 5 }, true);
    await user.click(screen.getByRole('button', { name: 'Reset to defaults…' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset all to defaults?' });
    const items = within(within(dialog).getByTestId('adv-reset-changes')).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Freeze ON byte (lockOn): 2 (0x02) → 1 (0x01)',
      'Sending card save byte (saveSender): 5 (0x05) → 1 (0x01)',
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.resetHardwareOverrides).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reset to defaults…' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.resetHardwareOverrides).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('adv-current-lockOn')).toHaveTextContent('1 (0x01)'));
    expect(within(screen.getByTestId('adv-row-lockOn')).queryByText('differs from default')).not.toBeInTheDocument();
  });

  it('does not ask when everything is already the default', async () => {
    const { api, user } = await open({}, {}, true);
    await user.click(screen.getByRole('button', { name: 'Reset to defaults…' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('All values are already the defaults.')).toBeInTheDocument();
    expect(api.resetHardwareOverrides).not.toHaveBeenCalled();
  });
});

describe('AdvancedSettingsPage: export and import', () => {
  it('exports the current values (any level) as a loadable versioned file with the note', async () => {
    const dl = stubDownload();
    const { user } = await open({}, { lockOn: 2 });
    await user.type(screen.getByLabelText('Note for the developer (optional)'), 'freeze needs 2');
    await user.click(screen.getByRole('button', { name: 'Export to file' }));
    expect(dl.name()).toMatch(/^rockzalct-hardware-overrides-\d{8}-\d{6}\.json$/);
    const text = await textOfBlob(dl.blob()!);
    expect(JSON.parse(text)).toMatchObject({ format: 'rockzalct.hardware-overrides', version: 1, note: 'freeze needs 2' });
    expect(parseHardwareOverridesJson(text)).toEqual({
      ok: true,
      values: { ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 },
      note: 'freeze needs 2',
    });
  });

  const upload = async (user: ReturnType<typeof renderApp>['user'], text: string) =>
    user.upload(screen.getByLabelText('Settings file to import'), new File([text], 'overrides.json', { type: 'application/json' }));

  it('validates first, shows the diff, applies only after confirmation', async () => {
    const { api, user } = await open({}, {}, true);
    await upload(user, serializeHardwareOverrides({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2, eraseSpiFlash: 255 }, 'from the owner'));
    const dialog = await screen.findByRole('dialog', { name: 'Import these settings?' });
    const items = within(within(dialog).getByTestId('adv-import-changes')).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'Freeze ON byte (lockOn): 1 (0x01) → 2 (0x02)',
      'Calibration flash erase byte (eraseSpiFlash): 0 (0x00) → 255 (0xFF)',
    ]);
    expect(dialog).toHaveTextContent('Note in the file: from the owner');
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, continue' }));
    await waitFor(() => expect(api.setHardwareOverrides).toHaveBeenCalledWith({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2, eraseSpiFlash: 255 }));
    await waitFor(() => expect(screen.getByTestId('adv-current-eraseSpiFlash')).toHaveTextContent('255 (0xFF)'));
    expect(await screen.findByText('Settings imported and applied.')).toBeInTheDocument();
  });

  it('Cancel applies nothing', async () => {
    const { api, user } = await open({}, {}, true);
    await upload(user, serializeHardwareOverrides({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();
    expect(screen.getByTestId('adv-current-lockOn')).toHaveTextContent('1 (0x01)');
  });

  it.each([
    ['not json', 'not a JSON file'],
    [JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 2, values: {} }), 'unsupported version 2'],
    [JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 1, values: { killOn: 999 } }), 'killOn'],
    [JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 1, values: { mystery: 1 } }), 'mystery: unknown setting'],
  ])('refuses an invalid file without a dialog or a call (%#)', async (content, expected) => {
    const { api, user } = await open({}, {}, true);
    await upload(user, content);
    const problems = await screen.findByTestId('adv-import-problems');
    expect(problems).toHaveTextContent('This file cannot be used. Nothing was changed:');
    expect(problems).toHaveTextContent(expected);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();
  });

  it('says so when the file equals the current settings', async () => {
    const { api, user } = await open({}, { lockOn: 2 }, true);
    await upload(user, serializeHardwareOverrides({ ...DEFAULT_HARDWARE_OVERRIDES, lockOn: 2 }));
    expect(await screen.findByTestId('adv-import-same')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setHardwareOverrides).not.toHaveBeenCalled();
  });
});

describe('AdvancedSettingsPage: Thai', () => {
  it('shows the Thai menu item, explanations and the UNVERIFIED tag', async () => {
    const api = fakeApi();
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'ตั้งค่าฮาร์ดแวร์ขั้นสูง' }));
    const row = await screen.findByTestId('adv-row-lockOn');
    expect(row).toHaveTextContent('ค่า byte เปิดหยุดภาพ (lockOn)');
    expect(row).toHaveTextContent('UNVERIFIED');
    expect(screen.getByTestId('adv-step-lockOn')).toHaveTextContent('ทดสอบในเช็กลิสต์ขั้นที่ 7 (7b)');
  });
});
