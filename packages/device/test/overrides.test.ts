import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CORRECTION_STATE_BITS,
  DEFAULT_HARDWARE_OVERRIDES,
  DeviceError,
  HARDWARE_OVERRIDE_KEYS,
  autoWire,
  createLayoutScreen,
  defaultHardwareOverrides,
  diffHardwareOverrides,
  mergeHardwareOverrides,
  parseHardwareOverridesJson,
  resolveHardwareOverrides,
  serializeHardwareOverrides,
  validateHardwareOverrides,
  type HardwareOverrides,
  type LayoutModel,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { DISPLAY_MODE_VALUES, createDeviceService, createNetSessionFactory, type DeviceService } from '../src/index.js';
import { CALIBRATION_COMMAND_VALUES } from '../src/features/calibration.js';
import { SAVE_COMMAND_VALUES } from '../src/features/persist.js';
import { decodeScannerXY, scannerXyWriteArgs } from '../src/features/layout.js';
import { layoutFixture, recordingSession, XY_WORD_X_HIGH, type Call } from './overridesHarness.js';

// ---------------------------------------------------------------------------------------------
// Byte-identical defaults.
//
// GOLDEN was recorded by running the same script against the code as it was BEFORE the advanced
// hardware settings existed (commit 4cdcb2c): every session call, with its arguments, that
// blackout / freeze / normal, save-to-hardware, erase, calibration enable + read and layout
// write + read produce. The session stands in for the codec Session, so these calls are exactly the
// requests the codec encodes. With default overrides the new code must reproduce them unchanged.

export const GOLDEN: Record<string, Call[]> = {
  "blackout": [
    ['SetKillMode', 0, 255, 65535, true, 1],
    ['SetLockMode', 0, 255, 65535, true, 0],
  ],
  "freeze": [
    ['SetKillMode', 0, 255, 65535, true, 0],
    ['SetLockMode', 0, 255, 65535, true, 1],
  ],
  "normal": [
    ['SetKillMode', 0, 255, 65535, true, 0],
    ['SetLockMode', 0, 255, 65535, true, 0],
  ],
  "save": [
    ['ReadScanerCountOfSenderCard', 0],
    ['ReadPortEnable', 0, 0],
    ['ReadPortWidth', 0, 0],
    ['ReadPortHeight', 0, 0],
    ['ReadNumberOfCardOrScanBoardInPort', 0, 0, 0],
    ['SetParameterStore2SpiFlash', 0, 0, 1, false, 1],
    ['SetSaveSendCardsParameters', 0, false, 1],
  ],
  "erase": [
    ['SetCoefficientInSpiFlashErase', 0, 0, 1, false, 0],
  ],
  "calOn": [
    ['SetCorrectionOn_2', 0, 0, 1, false, 3],
  ],
  "calState": [
    ['ReadCorrectionState', 0, 0, 1],
    ['ReadCoefficientSource', 0, 0, 1],
    ['ReadCorrectionDataToScan', 0, 0, 1, 256, 117440512],
  ],
  "layoutWrite": [
    ['ReadNumberOfCardOrScanBoardInPort', 0, 0, 0],
    ['SetSender_ComplexCfgScreenFlagSpace', 0, false, false],
    ['SetPortEnable', 0, false, 1, 0],
    ['SetPortOffsetX', 0, false, 0, 0],
    ['SetPortOffsetY', 0, false, 0, 0],
    ['SetPortWidth', 0, false, 256, 0],
    ['SetPortHeight', 0, false, 128, 0],
    ['SetEthernetPortScannerXY', 0, false, 0, 0, 0, 0],
    ['SetControlWidth', 0, 0, 0, false, 128],
    ['SetControlHeight', 0, 0, 0, false, 64],
    ['SetEthernetPortScannerXY', 0, false, 128, 0, 0, 1],
    ['SetControlWidth', 0, 0, 1, false, 128],
    ['SetControlHeight', 0, 0, 1, false, 64],
    ['SetEthernetPortScannerXY', 0, false, 128, 64, 0, 2],
    ['SetControlWidth', 0, 0, 2, false, 128],
    ['SetControlHeight', 0, 0, 2, false, 64],
    ['SetEthernetPortScannerXY', 0, false, 0, 64, 0, 3],
    ['SetControlWidth', 0, 0, 3, false, 128],
    ['SetControlHeight', 0, 0, 3, false, 64],
  ],
  "layoutRead": [
    ['ReadSender_ComplexCfgScreenFlagSpace', 0],
    ['ReadScanerCountOfSenderCard', 0],
    ['ReadNumberOfCardOrScanBoardInPort', 0, 0, 0],
    ['ReadPortEnable', 0, 0],
    ['ReadPortOffsetX', 0, 0],
    ['ReadPortOffsetY', 0, 0],
    ['ReadPortWidth', 0, 0],
    ['ReadPortHeight', 0, 0],
    ['ReadEthernetPortScannerXY', 0, 0, 0],
    ['ReadControlWidth', 0, 0, 0],
    ['ReadControlHeight', 0, 0, 0],
    ['ReadCabinetSerialNum', 0, 0, 0],
    ['ReadEthernetPortScannerXY', 0, 0, 1],
    ['ReadControlWidth', 0, 0, 1],
    ['ReadControlHeight', 0, 0, 1],
    ['ReadCabinetSerialNum', 0, 0, 1],
    ['ReadEthernetPortScannerXY', 0, 0, 2],
    ['ReadControlWidth', 0, 0, 2],
    ['ReadControlHeight', 0, 0, 2],
    ['ReadCabinetSerialNum', 0, 0, 2],
    ['ReadEthernetPortScannerXY', 0, 0, 3],
    ['ReadControlWidth', 0, 0, 3],
    ['ReadControlHeight', 0, 0, 3],
    ['ReadCabinetSerialNum', 0, 0, 3],
  ],
};

type Options = Parameters<typeof createDeviceService>[0];

async function open(extra: Options = {}, xyWord: number = XY_WORD_X_HIGH): Promise<{ svc: DeviceService; id: string; calls: Call[] }> {
  const calls: Call[] = [];
  const session = recordingSession(calls, xyWord);
  const svc = createDeviceService({
    sessionFactory: { open: async () => session },
    serialDiscovery: false,
    hseriesDiscovery: false,
    timeoutMs: 200,
    ...extra,
  });
  const [found] = await svc.discover({ netHosts: ['10.0.0.1'] });
  const id = found!.id;
  await svc.connect(id);
  calls.length = 0;
  return { svc, id, calls };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeviceError);
    return (e as DeviceError).code;
  }
  throw new Error('expected rejection');
};

/** The fixed script whose session calls GOLDEN holds. */
async function runScript(svc: DeviceService, id: string, calls: Call[]): Promise<Record<string, Call[]>> {
  const out: Record<string, Call[]> = {};
  const take = (name: string): void => {
    out[name] = calls.splice(0);
  };
  const card = { scope: 'card', portIndex: 0, cardIndex: 1 } as const;
  await svc.setDisplayMode(id, 'blackout');
  take('blackout');
  await svc.setDisplayMode(id, 'freeze');
  take('freeze');
  await svc.setDisplayMode(id, 'normal');
  take('normal');
  await svc.saveToHardware(id, card, { includeSender: true });
  take('save');
  await svc.eraseCoefficientsInFlash(id, 0, 1);
  take('erase');
  await svc.setCalibrationEnabled(id, card, true, 'brightness');
  take('calOn');
  await svc.getCalibrationState(id, 0, 1);
  take('calState');
  await svc.writeLayout(id, layoutFixture());
  take('layoutWrite');
  await svc.readLayout(id);
  take('layoutRead');
  return out;
}

describe('defaults are byte-identical to the behaviour before the advanced settings existed', () => {
  it('produces exactly the recorded requests (blackout, freeze, save, erase, calibration, layout write/read)', async () => {
    const { svc, id, calls } = await open();
    await svc.login('admin');
    expect(await runScript(svc, id, calls)).toEqual(GOLDEN);
  });

  it('also holds after set -> reset (reset really restores the defaults)', async () => {
    const { svc, id, calls } = await open();
    await svc.login('admin');
    await svc.setHardwareOverrides({ killOn: 9, saveReceiver: 7, eraseSpiFlash: 3, correctionEnabledBit: 0x10, correctionBrightnessTypeBit: 0x20, scannerXyOrder: 'x-low' });
    await svc.resetHardwareOverrides();
    expect(await runScript(svc, id, calls)).toEqual(GOLDEN);
  });

  it('the legacy constants still equal the defaults', () => {
    expect(DISPLAY_MODE_VALUES).toEqual({ killOn: 1, killOff: 0, lockOn: 1, lockOff: 0 });
    expect(SAVE_COMMAND_VALUES).toEqual({ sender: 1, receiver: 1 });
    expect(CALIBRATION_COMMAND_VALUES).toEqual({ eraseSpiFlash: 0 });
    expect(CORRECTION_STATE_BITS).toEqual({ enabled: 1, brightnessType: 2 });
    expect(DEFAULT_HARDWARE_OVERRIDES).toEqual({
      killOn: DISPLAY_MODE_VALUES.killOn,
      killOff: DISPLAY_MODE_VALUES.killOff,
      lockOn: DISPLAY_MODE_VALUES.lockOn,
      lockOff: DISPLAY_MODE_VALUES.lockOff,
      saveSender: SAVE_COMMAND_VALUES.sender,
      saveReceiver: SAVE_COMMAND_VALUES.receiver,
      eraseSpiFlash: CALIBRATION_COMMAND_VALUES.eraseSpiFlash,
      correctionEnabledBit: CORRECTION_STATE_BITS.enabled,
      correctionBrightnessTypeBit: CORRECTION_STATE_BITS.brightnessType,
      scannerXyOrder: 'x-high',
    });
  });
});

describe('validator, merge and file format (shared)', () => {
  const good = (): HardwareOverrides => defaultHardwareOverrides();

  it('accepts the defaults and a full valid set', () => {
    expect(validateHardwareOverrides(good())).toEqual([]);
    expect(validateHardwareOverrides({ ...good(), killOn: 255, lockOff: 0, correctionEnabledBit: 128, correctionBrightnessTypeBit: 4, scannerXyOrder: 'x-low' })).toEqual([]);
  });

  it.each([
    ['killOn', -1],
    ['killOff', 256],
    ['lockOn', 1.5],
    ['lockOff', NaN],
    ['saveSender', '1'],
    ['saveReceiver', null],
    ['eraseSpiFlash', Infinity],
  ])('rejects byte %s = %s', (key, value) => {
    const errors = validateHardwareOverrides({ ...good(), [key]: value });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(key);
  });

  it.each([0, 3, 6, 0x81, 256, -2, 1.5])('rejects a bit mask that is not a single bit: %s', (mask) => {
    expect(validateHardwareOverrides({ ...good(), correctionEnabledBit: mask })).toHaveLength(1);
    expect(validateHardwareOverrides({ ...good(), correctionBrightnessTypeBit: mask })).toHaveLength(1);
  });

  it('rejects equal bit masks, a bad order, unknown keys and non-objects', () => {
    expect(validateHardwareOverrides({ ...good(), correctionEnabledBit: 4, correctionBrightnessTypeBit: 4 })).toEqual([
      'correctionEnabledBit and correctionBrightnessTypeBit must be different bits',
    ]);
    expect(validateHardwareOverrides({ ...good(), scannerXyOrder: 'x-middle' })).toHaveLength(1);
    expect(validateHardwareOverrides({ ...good(), surprise: 1 })).toEqual(['surprise: unknown setting']);
    expect(validateHardwareOverrides(null)).toHaveLength(1);
    expect(validateHardwareOverrides([])).toHaveLength(1);
    expect(validateHardwareOverrides({ killOn: 1 })).not.toEqual([]); // a partial set is not a complete set
  });

  it('merges without mutating, skips undefined, and validates the merged whole', () => {
    const base = good();
    const merged = mergeHardwareOverrides(base, { killOn: 5, lockOn: undefined });
    expect(merged).toEqual({ ...base, killOn: 5 });
    expect(base.killOn).toBe(1);
    expect(resolveHardwareOverrides(base, { correctionEnabledBit: 2 })).toMatchObject({ ok: false }); // collides with brightnessType = 2
    expect(resolveHardwareOverrides(base, { correctionEnabledBit: 2, correctionBrightnessTypeBit: 8 })).toMatchObject({ ok: true });
    const evil = JSON.parse('{"__proto__": {"killOn": 1}}') as Partial<HardwareOverrides>;
    expect(resolveHardwareOverrides(base, evil)).toMatchObject({ ok: false });
    expect(resolveHardwareOverrides(base, 'x')).toMatchObject({ ok: false });
  });

  it('diffs only changed keys, in display order', () => {
    expect(diffHardwareOverrides(good(), { ...good(), lockOn: 2, killOn: 3 })).toEqual([
      { key: 'killOn', from: 1, to: 3 },
      { key: 'lockOn', from: 1, to: 2 },
    ]);
    expect(HARDWARE_OVERRIDE_KEYS).toHaveLength(Object.keys(DEFAULT_HARDWARE_OVERRIDES).length);
  });

  it('round-trips through the versioned export file', () => {
    const values: HardwareOverrides = { ...good(), lockOn: 2, scannerXyOrder: 'x-low' };
    const text = serializeHardwareOverrides(values, 'lock needed 2');
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw).toMatchObject({ format: 'rockzalct.hardware-overrides', version: 1, note: 'lock needed 2', values });
    expect(parseHardwareOverridesJson(text)).toEqual({ ok: true, values, note: 'lock needed 2' });
    expect(JSON.parse(serializeHardwareOverrides(values))).not.toHaveProperty('note');
  });

  it('import fills missing settings with defaults and rejects everything else', () => {
    const file = (over: Record<string, unknown>): string =>
      JSON.stringify({ format: 'rockzalct.hardware-overrides', version: 1, values: {}, ...over });
    expect(parseHardwareOverridesJson(file({ values: { lockOn: 2 } }))).toEqual({ ok: true, values: { ...good(), lockOn: 2 } });
    for (const bad of [
      'not json',
      '[]',
      file({ format: 'other' }),
      file({ version: 2 }),
      file({ values: undefined }),
      file({ values: { killOn: 300 } }),
      file({ values: { nope: 1 } }),
      file({ values: { correctionEnabledBit: 3 } }),
      file({ values: 'x' }),
      file({ note: 5 }),
    ]) {
      const res = parseHardwareOverridesJson(bad);
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('service: permissions, validation and call-time reading', () => {
  it('get works at any level and returns a copy', async () => {
    const { svc } = await open();
    const a = await svc.getHardwareOverrides();
    expect(a).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    a.killOn = 99;
    expect(await svc.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });

  it('set and reset need the advanced level and change nothing without it', async () => {
    const onChange = vi.fn();
    const { svc } = await open({ onHardwareOverridesChange: onChange });
    expect(await codeOf(svc.setHardwareOverrides({ killOn: 5 }))).toBe('PERMISSION');
    expect(await codeOf(svc.resetHardwareOverrides())).toBe('PERMISSION');
    expect(await svc.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('refuses invalid values with INVALID_ARGUMENT and keeps the old ones', async () => {
    const { svc } = await open();
    await svc.login('admin');
    expect(await codeOf(svc.setHardwareOverrides({ killOn: 256 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setHardwareOverrides({ correctionBrightnessTypeBit: 1 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setHardwareOverrides({ scannerXyOrder: 'sideways' as never }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setHardwareOverrides(null as never))).toBe('INVALID_ARGUMENT');
    expect(await svc.getHardwareOverrides()).toEqual(DEFAULT_HARDWARE_OVERRIDES);
  });

  it('a change applies to the very next command on the same connection (no reconnect)', async () => {
    const { svc, id, calls } = await open();
    await svc.login('admin');
    await svc.setDisplayMode(id, 'blackout');
    expect(calls).toEqual([
      ['SetKillMode', 0, 255, 65535, true, 1],
      ['SetLockMode', 0, 255, 65535, true, 0],
    ]);
    calls.length = 0;
    await svc.setHardwareOverrides({ killOn: 5, killOff: 6, lockOn: 2, lockOff: 7 });
    expect(calls).toEqual([]); // changing a setting sends nothing to the controller
    await svc.setDisplayMode(id, 'blackout');
    await svc.setDisplayMode(id, 'freeze');
    expect(calls).toEqual([
      ['SetKillMode', 0, 255, 65535, true, 5],
      ['SetLockMode', 0, 255, 65535, true, 7],
      ['SetKillMode', 0, 255, 65535, true, 6],
      ['SetLockMode', 0, 255, 65535, true, 2],
    ]);
  });

  it('applies the save, erase and correction-bit settings to the next command', async () => {
    const { svc, id, calls } = await open();
    await svc.login('admin');
    const card = { scope: 'card', portIndex: 0, cardIndex: 1 } as const;
    await svc.setHardwareOverrides({
      saveSender: 12,
      saveReceiver: 13,
      eraseSpiFlash: 14,
      correctionEnabledBit: 0x10,
      correctionBrightnessTypeBit: 0x40,
    });
    calls.length = 0;
    await svc.saveToHardware(id, card, { includeSender: true });
    expect(calls.filter((c) => c[0].startsWith('SetParameterStore') || c[0].startsWith('SetSaveSend'))).toEqual([
      ['SetParameterStore2SpiFlash', 0, 0, 1, false, 13],
      ['SetSaveSendCardsParameters', 0, false, 12],
    ]);
    calls.length = 0;
    await svc.eraseCoefficientsInFlash(id, 0, 1);
    expect(calls).toEqual([['SetCoefficientInSpiFlashErase', 0, 0, 1, false, 14]]);
    calls.length = 0;
    await svc.setCalibrationEnabled(id, card, true, 'brightness');
    await svc.setCalibrationEnabled(id, card, true, 'chroma');
    expect(calls).toEqual([
      ['SetCorrectionOn_2', 0, 0, 1, false, 0x50],
      ['SetCorrectionOn_2', 0, 0, 1, false, 0x10],
    ]);
    // ...and decoding the state byte uses the same masks: 0x40 = brightness type, 0x10 = enabled
    const state = await svc.getCalibrationState(id, 0, 1); // canned state byte is 0x03
    expect(state).toMatchObject({ stateRaw: 3, enabled: false, type: 'chroma' });
  });

  it('an explicit per-call save value still beats the setting', async () => {
    const { svc, id, calls } = await open();
    await svc.login('admin');
    await svc.setHardwareOverrides({ saveReceiver: 13 });
    calls.length = 0;
    await svc.saveToHardware(id, { scope: 'card', portIndex: 0, cardIndex: 1 }, { includeSender: false, receiverValue: 99 });
    expect(calls.filter((c) => c[0] === 'SetParameterStore2SpiFlash')).toEqual([['SetParameterStore2SpiFlash', 0, 0, 1, false, 99]]);
  });

  it('notifies the persistence hook with the new values; a throwing hook does not break the change', async () => {
    const seen: HardwareOverrides[] = [];
    const { svc } = await open({
      onHardwareOverridesChange: (v) => {
        seen.push(v);
        if (seen.length === 1) throw new Error('disk full');
      },
    });
    await svc.login('admin');
    const after = await svc.setHardwareOverrides({ lockOn: 2 });
    expect(after.lockOn).toBe(2);
    expect((await svc.getHardwareOverrides()).lockOn).toBe(2);
    await svc.resetHardwareOverrides();
    expect(seen.map((v) => v.lockOn)).toEqual([2, 1]);
  });

  it('constructor options become the initial values (legacy displayModeValues, then hardwareOverrides on top)', async () => {
    const legacy = await open({ displayModeValues: { lockOn: 2 } });
    expect((await legacy.svc.getHardwareOverrides()).lockOn).toBe(2);
    await legacy.svc.setDisplayMode(legacy.id, 'freeze');
    expect(legacy.calls.map((c) => c[5])).toEqual([0, 2]);

    const both = await open({ displayModeValues: { lockOn: 2, killOn: 4 }, hardwareOverrides: { lockOn: 3, saveReceiver: 8 } });
    expect(await both.svc.getHardwareOverrides()).toEqual({ ...DEFAULT_HARDWARE_OVERRIDES, killOn: 4, lockOn: 3, saveReceiver: 8 });

    expect(() => createDeviceService({ hardwareOverrides: { killOn: 999 } })).toThrow(DeviceError);
  });
});

describe('receiving-card X/Y word order', () => {
  it('decodeScannerXY and scannerXyWriteArgs are mirror images', () => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(((300 << 16) | 70) >>> 0);
    expect(decodeScannerXY(b)).toEqual({ x: 300, y: 70 }); // default = x-high, as before
    expect(decodeScannerXY(b, 'x-high')).toEqual({ x: 300, y: 70 });
    expect(decodeScannerXY(b, 'x-low')).toEqual({ x: 70, y: 300 });
    expect(scannerXyWriteArgs(300, 70, 'x-high')).toEqual([300, 70]);
    expect(scannerXyWriteArgs(300, 70, 'x-low')).toEqual([70, 300]);
    for (const order of ['x-high', 'x-low'] as const) {
      // library word for the arguments we hand it, decoded with the same order, gives x, y back
      const [a1, a2] = scannerXyWriteArgs(300, 70, order);
      const word = Buffer.alloc(4);
      word.writeUInt32LE(((a1 << 16) + a2) >>> 0);
      expect(decodeScannerXY(word, order)).toEqual({ x: 300, y: 70 });
    }
  });

  it('x-low: reads the same word the other way round, and writes the swapped arguments', async () => {
    const { svc, id, calls } = await open({ hardwareOverrides: { scannerXyOrder: 'x-low' } });
    await svc.login('admin');
    const hw = await svc.readLayout(id);
    expect(hw.cards[0]).toMatchObject({ x: 70, y: 300 }); // canned word is (300 << 16) | 70
    calls.length = 0;
    await svc.writeLayout(id, layoutFixture());
    const writes = calls.filter((c) => c[0] === 'SetEthernetPortScannerXY');
    // card 2 sits at x = 128, y = 64: handed to the library as (y, x)
    expect(writes.map((c) => c.slice(3, 7))).toEqual([
      [0, 0, 0, 0],
      [0, 128, 0, 1],
      [64, 128, 0, 2],
      [64, 0, 0, 3],
    ]);
  });

  it('switching the order applies to the next read without reconnecting', async () => {
    const { svc, id } = await open();
    await svc.login('admin');
    expect((await svc.readLayout(id)).cards[0]).toMatchObject({ x: 300, y: 70 });
    await svc.setHardwareOverrides({ scannerXyOrder: 'x-low' });
    expect((await svc.readLayout(id)).cards[0]).toMatchObject({ x: 70, y: 300 });
    await svc.setHardwareOverrides({ scannerXyOrder: 'x-high' });
    expect((await svc.readLayout(id)).cards[0]).toMatchObject({ x: 300, y: 70 });
  });
});

// Round trip through the real codec and the simulator: what writeLayout puts on the wire, readLayout
// must read back, for both orders (read and write stay consistent).
describe('X/Y order round trip through the real codec and the simulator', () => {
  let sim: SimulatorHandle;
  beforeAll(async () => {
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });

  const XY = (port: number, card: number): number => 0x0300_0000 + 4096 * port + 4 * card;
  const wall = (split: 'rows' | 'columns'): LayoutModel => {
    const screen = createLayoutScreen(2, 2, 128, 64);
    return { screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 2, split }) };
  };

  const session = async (order: 'x-high' | 'x-low'): Promise<{ svc: DeviceService; id: string }> => {
    const svc = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      hseriesDiscovery: false,
      timeoutMs: 1500,
      hardwareOverrides: { scannerXyOrder: order },
    });
    const id = (await svc.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await svc.connect(id);
    await svc.login('admin');
    return { svc, id };
  };

  // 'rows' puts card 1 of port 0 at x = 128, 'columns' puts it at y = 64 (positions are relative to the port).
  it.each([
    ['x-high', 'rows', [0, 0, 128, 0]],
    ['x-low', 'rows', [128, 0, 0, 0]],
    ['x-high', 'columns', [64, 0, 0, 0]],
    ['x-low', 'columns', [0, 0, 64, 0]],
  ] as const)('%s / %s: wire bytes as expected and the layout reads back unchanged', async (order, split, bytes) => {
    const { svc, id } = await session(order);
    try {
      const model = wall(split);
      await svc.writeLayout(id, model);
      expect([...sim.state.sendingCard.read(XY(0, 1), 4)]).toEqual(bytes);
      const cards = (await svc.readLayout(id)).cards.filter((c) => c.port === 0).map((c) => ({ index: c.index, x: c.x, y: c.y }));
      expect(cards).toEqual([
        { index: 0, x: 0, y: 0 },
        { index: 1, x: split === 'rows' ? 128 : 0, y: split === 'rows' ? 0 : 64 },
      ]);
    } finally {
      await svc.dispose();
    }
  });

  it('a mismatched order is visible: write with x-high, read with x-low swaps the axes', async () => {
    const writer = await session('x-high');
    await writer.svc.writeLayout(writer.id, wall('rows'));
    await writer.svc.dispose();
    const reader = await session('x-low');
    try {
      const card1 = (await reader.svc.readLayout(reader.id)).cards.find((c) => c.port === 0 && c.index === 1)!;
      expect({ x: card1.x, y: card1.y }).toEqual({ x: 0, y: 128 });
    } finally {
      await reader.svc.dispose();
    }
  });
});
