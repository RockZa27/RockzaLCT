import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ResponseError, Packet } from '@novastar/codec';
import {
  DeviceError,
  PERSIST_METHODS,
  SCREEN_CONFIG_FORMAT,
  SCREEN_CONFIG_MAX_BYTES,
  SCREEN_CONFIG_VERSION,
  autoWire,
  createLayoutScreen,
  diffScreenConfig,
  parseScreenConfigJson,
  receiverWritePlan,
  serializeScreenConfig,
  validateScreenConfig,
  type LayoutModel,
  type ModuleProfile,
  type ScreenConfig,
  type ScreenConfigReceiver,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { createDeviceService, createNetSessionFactory, type DeviceService, type SessionFactory } from '../src/index.js';
import { SAVE_COMMAND_VALUES, createPersistFeature } from '../src/features/persist.js';
import { RECEIVER_REGISTERS as R } from '../src/features/receiver.js';

// Register addresses of the two save commands, copied from the generated api files
// (node_modules/@novastar/native/dist/api/<Name>.cjs, `req.address`) so the tests check the bytes on
// the wire independently of the implementation:
//   SetSaveSendCardsParameters.cjs  16777217 = 0x01000001  (sender)
//   SetParameterStore2SpiFlash.cjs  16777233 = 0x01000011  (receiving card)
const SAVE_SENDER = 0x0100_0001;
const SAVE_CARD = 0x0100_0011;

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

// ---------------------------------------------------------------------------------------------
// Pure model

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

const wall = (): LayoutModel => {
  const screen = createLayoutScreen(2, 2, 128, 64);
  return { screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 2, split: 'rows' }) };
};

const sample = (): ScreenConfig => ({
  format: SCREEN_CONFIG_FORMAT,
  version: SCREEN_CONFIG_VERSION,
  savedAt: '2026-01-02T03:04:05.000Z',
  controller: { model: 'MCTRL660', firmwareVersion: '1.2.3', outputPorts: 2, receivingCards: 4 },
  sender: {
    video: {
      signalPresent: true,
      resolution: { width: 1920, height: 1080 },
      fieldRateMode: 0,
      fieldRate: 60,
      measuredFieldRate: 59,
      inputSource: 'HDMI',
      inputSourceRaw: 5,
    },
    ports: [0, 1].map((portIndex) => ({ portIndex, enabled: true, width: 256, height: 64, pixels: 256 * 64, receivingCards: 2 })),
  },
  receivers: [card(0, 0), card(0, 1, { icPerGroup: 4 }), card(1, 0), card(1, 1)],
  layout: wall(),
});

const PROFILE: ModuleProfile = {
  name: 'P3',
  width: 64,
  height: 32,
  scanMode: 16,
  dataGroups: 8,
  refNumPerVs: 3840,
  gamma: 28,
  grayDepth: 14,
  grayRealize: 1,
  grayMode: 2,
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fieldsOf = (v: ReturnType<typeof validateScreenConfig>): string[] => (v.ok ? [] : v.errors.map((e) => e.field));

describe('screen config model (pure)', () => {
  it('lists every PersistApi method', () => {
    expect(Object.keys(PERSIST_METHODS).sort()).toEqual(['applyScreenConfig', 'readScreenConfig', 'saveToHardware']);
  });

  it('round-trips through JSON and is stable', () => {
    const cfg = { ...sample(), moduleLibrary: [PROFILE] };
    const text = serializeScreenConfig(cfg);
    const res = parseScreenConfigJson(text);
    expect(res).toEqual({ ok: true, config: cfg });
    if (res.ok) {
      // normalisation is idempotent: a saved-then-loaded file serialises to the same text again
      const again = serializeScreenConfig(res.config);
      const res2 = parseScreenConfigJson(again);
      expect(res2.ok && serializeScreenConfig(res2.config)).toBe(again);
    }
    expect(JSON.parse(text)).toMatchObject({ format: 'rockzalct.screen-config', version: 1 });
  });

  it('accepts null sender / layout, an empty receiver list and a BOM', () => {
    const cfg: ScreenConfig = { ...sample(), sender: null, layout: null, receivers: [] };
    expect(parseScreenConfigJson('﻿' + serializeScreenConfig(cfg))).toEqual({ ok: true, config: cfg });
  });

  it('drops unknown keys, recomputes port pixels and drops telemetry-like extras', () => {
    const raw = clone(sample()) as unknown as Record<string, unknown>;
    raw.extra = 1;
    (raw.receivers as Record<string, unknown>[])[0]!.temperatureRaw = 40;
    (raw.receivers as Record<string, unknown>[])[0]!.junk = 'x';
    ((raw.sender as { ports: Record<string, unknown>[] }).ports[0]!).pixels = 7;
    const res = validateScreenConfig(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config).not.toHaveProperty('extra');
      expect(res.config.receivers[0]).not.toHaveProperty('temperatureRaw');
      expect(res.config.receivers[0]).not.toHaveProperty('junk');
      expect(res.config.sender!.ports[0]!.pixels).toBe(256 * 64);
    }
  });

  it('rejects non-objects, invalid JSON, wrong format and non-string / oversized input', () => {
    for (const v of [null, undefined, 3, 'x', [], true]) expect(validateScreenConfig(v).ok).toBe(false);
    expect(validateScreenConfig({ ...sample(), format: 'rockzalct.module-library' }).ok).toBe(false);
    expect(validateScreenConfig({ ...sample(), format: undefined })).toMatchObject({ ok: false, errors: [{ field: 'format' }] });
    const bad = parseScreenConfigJson('{nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]!.message).toMatch(/invalid JSON/);
    expect(parseScreenConfigJson('').ok).toBe(false);
    expect(parseScreenConfigJson(123 as unknown as string).ok).toBe(false);
    const huge = parseScreenConfigJson(' '.repeat(SCREEN_CONFIG_MAX_BYTES + 1));
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.errors[0]!.message).toMatch(/larger than/);
  });

  it('rejects other versions, saying when the file is newer', () => {
    for (const version of [0, 2, 99, -1, 1.5, '1', null, undefined]) {
      const res = validateScreenConfig({ ...sample(), version });
      expect(res.ok).toBe(false);
      expect(fieldsOf(res)).toEqual(['version']);
    }
    const newer = validateScreenConfig({ ...sample(), version: 2 });
    if (!newer.ok) expect(newer.errors[0]!.message).toMatch(/newer/);
  });

  it('reports bad header fields', () => {
    const cfg = clone(sample()) as unknown as Record<string, any>;
    cfg.savedAt = 'yesterday';
    cfg.controller = { model: '', outputPorts: 99, receivingCards: -1 };
    const res = validateScreenConfig(cfg);
    expect(fieldsOf(res).sort()).toEqual(['controller.model', 'controller.outputPorts', 'controller.receivingCards', 'savedAt']);
    expect(fieldsOf(validateScreenConfig({ ...sample(), controller: 'x' }))).toEqual(['controller']);
    expect(fieldsOf(validateScreenConfig({ ...sample(), savedAt: 5 }))).toEqual(['savedAt']);
    const missing = clone(sample()) as unknown as Record<string, unknown>;
    delete missing.sender;
    delete missing.layout;
    expect(fieldsOf(validateScreenConfig(missing)).sort()).toEqual(['layout', 'sender']);
  });

  it('validates the sender section', () => {
    const cfg = clone(sample()) as unknown as Record<string, any>;
    cfg.sender.video.resolution.width = 70000;
    cfg.sender.video.fieldRate = 1.5;
    cfg.sender.video.inputSource = 'SCART';
    cfg.sender.video.signalPresent = 'yes';
    cfg.sender.ports[1].portIndex = 0; // duplicate
    cfg.sender.ports[0].enabled = 1;
    const fields = fieldsOf(validateScreenConfig(cfg));
    expect(fields).toEqual(
      expect.arrayContaining([
        'sender.video.resolution.width',
        'sender.video.fieldRate',
        'sender.video.inputSource',
        'sender.video.signalPresent',
        'sender.ports[1].portIndex',
        'sender.ports[0].enabled',
      ]),
    );
    expect(fieldsOf(validateScreenConfig({ ...sample(), sender: 'x' }))).toEqual(['sender']);
    expect(fieldsOf(validateScreenConfig({ ...sample(), sender: { video: 1, ports: 'x' } })).sort()).toEqual(['sender.ports', 'sender.video']);
    const many = clone(sample()) as unknown as Record<string, any>;
    many.sender.ports = Array.from({ length: 33 }, (_, i) => ({ ...many.sender.ports[0], portIndex: i % 32 }));
    expect(fieldsOf(validateScreenConfig(many))).toEqual(['sender.ports']);
  });

  it('validates receiving cards: ranges, types, addresses and duplicates', () => {
    const cfg = clone(sample()) as unknown as Record<string, any>;
    cfg.receivers[0].moduleWidth = 256;
    cfg.receivers[0].gamma = -1;
    cfg.receivers[1].refNumPerVs = 'many';
    cfg.receivers[1].icPerGroup = 3.5;
    cfg.receivers[2].portIndex = 255; // collides with the broadcast value
    cfg.receivers[3].portIndex = 0; // duplicates receivers[0] (0,0)
    cfg.receivers[3].cardIndex = 0;
    delete cfg.receivers[3].scanMode;
    const fields = fieldsOf(validateScreenConfig(cfg));
    expect(fields).toEqual(
      expect.arrayContaining(['receivers[0].moduleWidth', 'receivers[0].gamma', 'receivers[1].refNumPerVs', 'receivers[1].icPerGroup', 'receivers[2]', 'receivers[3]', 'receivers[3].scanMode']),
    );
    expect(fieldsOf(validateScreenConfig({ ...sample(), receivers: {} }))).toEqual(['receivers']);
    expect(fieldsOf(validateScreenConfig({ ...sample(), receivers: [5] }))).toEqual(['receivers[0]']);
    const tooMany = { ...sample(), receivers: Array.from({ length: 4097 }, (_, i) => card(i % 200, Math.floor(i / 200))) };
    expect(fieldsOf(validateScreenConfig(tooMany))).toEqual(['receivers']);
  });

  it('validates the layout and guards against huge grids', () => {
    expect(fieldsOf(validateScreenConfig({ ...sample(), layout: { screen: 1 } }))).toEqual(['layout']);
    const unassigned = { ...wall(), ports: [] };
    const bad = validateScreenConfig({ ...sample(), layout: unassigned });
    expect(bad.ok).toBe(false);
    expect(fieldsOf(bad).every((f) => f === 'layout')).toBe(true);
    // 1e9 cabinets must be refused up front, not enumerated
    const huge = wall();
    huge.screen = { ...huge.screen, rows: 30000, cols: 30000 };
    const t0 = Date.now();
    expect(fieldsOf(validateScreenConfig({ ...sample(), layout: huge }))).toEqual(['layout.screen']);
    expect(Date.now() - t0).toBeLessThan(500);
    const manyPorts = wall();
    manyPorts.ports = Array.from({ length: 40 }, (_, port) => ({ port, cabinets: [] }));
    expect(validateScreenConfig({ ...sample(), layout: manyPorts }).ok).toBe(false);
    // a port beyond the 32 the sender has
    const high = wall();
    high.ports = [{ port: 40, cabinets: high.ports.flatMap((p) => p.cabinets) }];
    expect(validateScreenConfig({ ...sample(), layout: high }).ok).toBe(false);
  });

  it('validates the optional module library', () => {
    expect(validateScreenConfig({ ...sample(), moduleLibrary: [PROFILE] }).ok).toBe(true);
    const dup = validateScreenConfig({ ...sample(), moduleLibrary: [PROFILE, { ...PROFILE, name: 'p3' }] });
    expect(fieldsOf(dup)).toEqual(['moduleLibrary[1].name']);
    expect(fieldsOf(validateScreenConfig({ ...sample(), moduleLibrary: [{ name: 'x' }] })).every((f) => f.startsWith('moduleLibrary[0].'))).toBe(true);
    expect(fieldsOf(validateScreenConfig({ ...sample(), moduleLibrary: 'x' }))).toEqual(['moduleLibrary']);
    expect(validateScreenConfig({ ...sample(), moduleLibrary: null }).ok).toBe(true);
  });

  it('plans receiver writes: profile, unconfigured, invalid', () => {
    const ok = receiverWritePlan(card(1, 2, { icPerGroup: 4 }));
    expect(ok).toMatchObject({ kind: 'profile', profile: { name: 'P1C2', width: 64, height: 32, dataGroups: 8, driverIc: 33, icPerGroup: 4 } });
    const unknownIc = receiverWritePlan(card(0, 0, { driverIc: 255 }));
    expect(unknownIc.kind === 'profile' && unknownIc.profile.driverIc).toBe(undefined);
    expect(receiverWritePlan(card(0, 0, { moduleWidth: 0 }))).toMatchObject({ kind: 'skip', reason: 'unconfigured' });
    expect(receiverWritePlan(card(0, 0, { moduleHeight: 0 }))).toMatchObject({ kind: 'skip', reason: 'unconfigured' });
    const bad = receiverWritePlan(card(0, 0, { scanMode: 0, grayRealize: 9 }));
    expect(bad).toMatchObject({ kind: 'skip', reason: 'invalid' });
    if (bad.kind === 'skip') expect(bad.errors).toHaveLength(2);
  });
});

describe('diffScreenConfig (pure)', () => {
  it('is empty for identical configs and ignores savedAt', () => {
    const a = sample();
    const b = { ...clone(a), savedAt: '2030-01-01T00:00:00.000Z' };
    expect(diffScreenConfig(a, b)).toEqual({ items: [], missingCards: [], skippedCards: [], modelMismatch: false });
  });

  it('lists changed receiver, sender and layout values with from/to', () => {
    const file = sample();
    const dev = clone(file);
    dev.receivers[2]!.gamma = 20;
    dev.receivers[2]!.driverIc = 255; // device unknown, file 33
    dev.sender!.video.resolution = { width: 1280, height: 720 };
    dev.sender!.video.fieldRate = 50;
    dev.sender!.video.inputSource = 'DVI';
    dev.sender!.ports[1]!.enabled = false;
    dev.layout = createLayoutScreen(1, 4, 64, 64) && { screen: createLayoutScreen(1, 4, 64, 64), ports: autoWire(createLayoutScreen(1, 4, 64, 64), { pattern: 'left-top-horizontal', ports: 2, split: 'columns' }) };
    const diff = diffScreenConfig(file, dev);
    const pick = (s: string, f: string) => diff.items.filter((i) => i.section === s && i.field === f);
    expect(pick('receiver', 'gamma')).toEqual([{ section: 'receiver', field: 'gamma', portIndex: 1, cardIndex: 0, from: '20', to: '28' }]);
    expect(pick('receiver', 'driverIc')).toEqual([{ section: 'receiver', field: 'driverIc', portIndex: 1, cardIndex: 0, from: null, to: '33' }]);
    expect(pick('sender', 'resolution')).toEqual([{ section: 'sender', field: 'resolution', from: '1280x720', to: '1920x1080' }]);
    expect(pick('sender', 'fieldRate')[0]).toMatchObject({ from: '50', to: '60' });
    expect(pick('sender', 'inputSource')[0]).toMatchObject({ from: 'DVI', to: 'HDMI' });
    expect(pick('sender', 'portEnabled')).toEqual([{ section: 'sender', field: 'portEnabled', portIndex: 1, from: 'false', to: 'true' }]);
    expect(diff.items.some((i) => i.section === 'layout' && i.field === 'cardRect')).toBe(true);
    expect(diff.items.some((i) => i.section === 'layout' && i.field === 'portRegion')).toBe(true);
  });

  it('treats an unreadable device side as "everything changes"', () => {
    const file = sample();
    const dev = clone(file);
    dev.sender = null;
    dev.layout = null;
    dev.receivers = dev.receivers.filter((r) => r.portIndex !== 1);
    const diff = diffScreenConfig(file, dev);
    expect(diff.items.filter((i) => i.section === 'layout')).toEqual([{ section: 'layout', field: 'layout', from: null, to: '2 x 2' }]);
    expect(diff.items.filter((i) => i.section === 'sender').every((i) => i.from === null)).toBe(true);
    // the device side has no card list (sender null) so nothing can be called missing
    expect(diff.missingCards).toEqual([]);
    expect(diff.items.filter((i) => i.section === 'receiver' && i.portIndex === 1).length).toBeGreaterThan(0);
  });

  it('reports missing cards, skipped cards and a model mismatch; honours null file sections', () => {
    const file = sample();
    file.receivers.push(card(1, 5), card(0, 3, { moduleWidth: 0 }));
    file.receivers[3] = card(1, 1, { scanMode: 0 });
    const dev = clone(file);
    dev.controller.model = 'OTHER';
    dev.receivers = [];
    const diff = diffScreenConfig({ ...file, sender: null, layout: null }, dev);
    expect(diff.modelMismatch).toBe(true);
    expect(diff.missingCards).toEqual([
      { portIndex: 0, cardIndex: 3 },
      { portIndex: 1, cardIndex: 5 },
    ]);
    expect(diff.skippedCards).toEqual([{ portIndex: 1, cardIndex: 1, reason: 'invalid' }]);
    expect(diff.items.some((i) => i.section !== 'receiver')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Against the simulator

type Call = { name: string; args: unknown[] };

const fakeResponseError = (tag: string): ResponseError =>
  new ResponseError({ serno: 1, ack: 1, source: 0, port: 0, rcvIndex: 0 } as unknown as Readonly<Packet>, `injected:${tag}`);

/**
 * Wraps the net factory: records every Set* / Write* call, and lets a test make any chosen call
 * (read or write) fail with a ResponseError like a card that does not answer.
 */
function spyFactory(port: number, calls: Call[], failIf: (c: Call) => boolean): SessionFactory {
  const inner = createNetSessionFactory({ port });
  return {
    async open(controller, options) {
      const session = await inner.open(controller, options);
      return new Proxy(session, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (typeof prop !== 'string' || typeof value !== 'function') return value;
          const fn = value as (...a: unknown[]) => unknown;
          if (prop === 'close') return fn.bind(target);
          return async (...args: unknown[]) => {
            const call = { name: prop, args };
            if (/^(Set|Write)/.test(prop)) calls.push(call);
            if (failIf(call)) throw fakeResponseError(prop);
            return fn.apply(target, args);
          };
        },
      });
    },
    ...(inner.close ? { close: (c, s) => inner.close!(c, s) } : {}),
  };
}

describe('against the simulator', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;
  let calls: Call[];
  let failIf: (c: Call) => boolean;

  beforeAll(async () => {
    // 2 ports x 2 cards: sim card k -> (port k % 2, chain position floor(k / 2)).
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });
  afterEach(async () => {
    await service.dispose();
  });

  const mem = (port: number, c: number) => sim.state.receivingCards.find((x) => x.portIndex === port && x.cardIndex === c)!.memory;
  const byte = (port: number, c: number, addr: number): number => mem(port, c).read(addr, 1)[0]!;
  const sender = () => sim.state.sendingCard;
  const writes = (): string[] => calls.filter((c) => /^Set/.test(c.name)).map((c) => c.name);

  const blank = (): void => {
    for (const k of sim.state.receivingCards) {
      for (const addr of Object.values(R)) k.memory.write(addr, Buffer.alloc(2));
      k.memory.write(SAVE_CARD, Buffer.alloc(1));
      for (const a of [0x0200_0017, 0x0200_0019, 0x0200_008b]) k.memory.write(a, Buffer.alloc(2));
    }
    sender().write(SAVE_SENDER, Buffer.alloc(1));
    sender().write(0x0200_0024, Buffer.alloc(8)); // DVI width/height
    sender().write(0x0200_0009, Buffer.alloc(2)); // field rate
    sender().write(0x0200_0023, Buffer.alloc(1)); // input select
    sender().write(0x0200_004a, Buffer.alloc(1)); // complex flag
    for (let p = 0; p < 2; p += 1) {
      sender().write(0x0200_0050 + 9 * p, Buffer.alloc(9));
      for (let i = 0; i < 2; i += 1) sender().write(0x0300_0000 + 4096 * p + 4 * i, Buffer.alloc(4));
    }
  };

  const open = async (advanced: boolean): Promise<void> => {
    blank();
    calls = [];
    failIf = () => false;
    service = createDeviceService({
      sessionFactory: spyFactory(sim.port, calls, (c) => failIf(c)),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 1500,
    });
    id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await service.connect(id);
    if (advanced) expect(await service.login('admin')).toBe(true);
    calls.length = 0;
  };

  /** Configure the simulated controller through the real APIs (advanced session). */
  const configure = async (layout: LayoutModel, gammaBase: number, resolution = { width: 1920, height: 1080 }): Promise<void> => {
    await service.setSenderResolution(id, resolution);
    await service.setSenderFieldRate(id, 60);
    await service.setSenderInputSource(id, 'HDMI');
    let n = 0;
    for (const [p, c] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) {
      await service.applyModuleProfile(id, { scope: 'card', portIndex: p, cardIndex: c }, { ...PROFILE, name: `m${n}`, gamma: gammaBase + n });
      n += 1;
    }
    await service.writeLayout(id, layout);
  };

  const columns = (): LayoutModel => {
    const screen = createLayoutScreen(1, 4, 64, 64);
    return { screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 2, split: 'columns' }) };
  };

  // ------------------------------------------------------------------------------ save
  describe('saveToHardware', () => {
    it('refuses at normal level before any I/O', async () => {
      await open(false);
      const before = sim.state.requestCount;
      await expectCode(service.saveToHardware(id, { scope: 'all' }), 'PERMISSION');
      await expectCode(service.saveToHardware(id, { scope: 'card', portIndex: 0, cardIndex: 0 }), 'PERMISSION');
      await expectCode(service.saveToHardware(id, { scope: 'bogus' } as never), 'PERMISSION');
      expect(sim.state.requestCount).toBe(before);
      expect(byte(0, 0, SAVE_CARD)).toBe(0);
    });

    it('stores one card only, without the sender by default', async () => {
      await open(true);
      const res = await service.saveToHardware(id, { scope: 'card', portIndex: 1, cardIndex: 0 });
      expect(res).toEqual({ sender: null, cards: [{ portIndex: 1, cardIndex: 0, ok: true }], ok: true });
      expect(byte(1, 0, SAVE_CARD)).toBe(SAVE_COMMAND_VALUES.receiver);
      for (const [p, c] of [[0, 0], [0, 1], [1, 1]] as const) expect(byte(p, c, SAVE_CARD)).toBe(0);
      expect(byte(0, 0, 0)).toBe(0);
      expect(sender().readU8(SAVE_SENDER)).toBe(0);
      expect(writes()).toEqual(['SetParameterStore2SpiFlash']);
    });

    it('stores every card and the sender for scope all, each card acknowledged separately', async () => {
      await open(true);
      const res = await service.saveToHardware(id, { scope: 'all' });
      expect(res.ok).toBe(true);
      expect(res.cards).toHaveLength(4);
      expect(res.sender).toEqual({ ok: true });
      for (const [p, c] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) expect(byte(p, c, SAVE_CARD)).toBe(1);
      expect(sender().readU8(SAVE_SENDER)).toBe(1);
      // per-card, not broadcast: the 4 card writes are addressed
      const cardCalls = calls.filter((c) => c.name === 'SetParameterStore2SpiFlash');
      expect(cardCalls.map((c) => [c.args[1], c.args[2], c.args[3]])).toEqual([[0, 0, false], [0, 1, false], [1, 0, false], [1, 1, false]]);
    });

    it('lets a card scope include the sender and overrides the UNVERIFIED values per call', async () => {
      await open(true);
      await service.saveToHardware(id, { scope: 'card', portIndex: 0, cardIndex: 1 }, { includeSender: true, senderValue: 0xa5, receiverValue: 2 });
      expect(byte(0, 1, SAVE_CARD)).toBe(2);
      expect(sender().readU8(SAVE_SENDER)).toBe(0xa5);
      await service.saveToHardware(id, { scope: 'all' }, { includeSender: false });
      expect(sender().readU8(SAVE_SENDER)).toBe(0xa5); // untouched
      expect(byte(1, 1, SAVE_CARD)).toBe(1);
    });

    it('rejects bad targets and options without touching the device', async () => {
      await open(true);
      const before = sim.state.requestCount;
      await expectCode(service.saveToHardware(id, { scope: 'card', portIndex: 255, cardIndex: 0 }), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware(id, null as never), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware(id, { scope: 'all' }, { senderValue: 256 }), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware(id, { scope: 'all' }, { receiverValue: -1 }), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware(id, { scope: 'all' }, { receiverValue: 1.5 }), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware(id, { scope: 'all' }, { includeSender: 'yes' } as never), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware(id, { scope: 'all' }, null as never), 'INVALID_ARGUMENT');
      expect(sim.state.requestCount).toBe(before);
      // a card that is not on the controller is refused, not silently dropped
      await expectCode(service.saveToHardware(id, { scope: 'card', portIndex: 0, cardIndex: 7 }), 'INVALID_ARGUMENT');
      await expectCode(service.saveToHardware('net:nope:1', { scope: 'all' }), 'NOT_FOUND');
      expect(writes()).toEqual([]);
    });

    it('reports a failing card per card and keeps going', async () => {
      await open(true);
      failIf = (c) => c.name === 'SetParameterStore2SpiFlash' && c.args[1] === 0 && c.args[2] === 1;
      const res = await service.saveToHardware(id, { scope: 'all' });
      expect(res.ok).toBe(false);
      expect(res.cards.map((r) => r.ok)).toEqual([true, false, true, true]);
      expect(res.cards[1]).toMatchObject({ portIndex: 0, cardIndex: 1, ok: false, code: 'PROTOCOL' });
      expect(res.sender).toEqual({ ok: true });
      expect(byte(0, 0, SAVE_CARD)).toBe(1);
      expect(byte(0, 1, SAVE_CARD)).toBe(0);
      expect(byte(1, 1, SAVE_CARD)).toBe(1);
    });

    it('honours a service-wide override of the command values', async () => {
      await open(true);
      const session = await createNetSessionFactory({ port: sim.port }).open(
        { id: 'net:x', transport: 'net', address: '127.0.0.1', port: sim.port, label: 'x' },
        { timeoutMs: 1500 },
      );
      try {
        const ctx = {
          withSession: <T,>(_id: string, fn: (s: typeof session) => Promise<T>) => fn(session),
          userLevel: () => ({ level: 'advanced' as const }),
          timeoutMs: 1500,
        };
        const feature = createPersistFeature(ctx, { sender: 77, receiver: 9 });
        expect((await feature.saveToHardware('net:x', { scope: 'all' })).ok).toBe(true);
        expect(sender().readU8(SAVE_SENDER)).toBe(77);
        expect(byte(1, 1, SAVE_CARD)).toBe(9);
        // a per-call value still wins over the override
        await feature.saveToHardware('net:x', { scope: 'card', portIndex: 0, cardIndex: 0 }, { receiverValue: 4 });
        expect(byte(0, 0, SAVE_CARD)).toBe(4);
      } finally {
        session.close();
      }
      expect(SAVE_COMMAND_VALUES).toEqual({ sender: 1, receiver: 1 });
    });
  });

  // ------------------------------------------------------------------------------ read back
  describe('readScreenConfig', () => {
    it('reads sender, every card and the layout', async () => {
      await open(true);
      await configure(wall(), 20);
      await service.setSenderPortEnabled(id, 1, false);
      const res = await service.readScreenConfig(id);
      expect(res.complete).toBe(true);
      expect(res.failures).toEqual([]);
      const cfg = res.config;
      expect(cfg.format).toBe('rockzalct.screen-config');
      expect(cfg.version).toBe(1);
      expect(Number.isFinite(Date.parse(cfg.savedAt))).toBe(true);
      expect(cfg.controller).toMatchObject({ model: 'Unknown (0x0660)', firmwareVersion: '1.2.3', outputPorts: 2, receivingCards: 4 });
      expect(cfg.sender!.video).toMatchObject({ resolution: { width: 1920, height: 1080 }, fieldRate: 60, inputSource: 'HDMI' });
      expect(cfg.sender!.ports.map((p) => [p.portIndex, p.enabled, p.receivingCards])).toEqual([[0, true, 2], [1, false, 2]]);
      expect(cfg.receivers.map((r) => [r.portIndex, r.cardIndex, r.gamma])).toEqual([[0, 0, 20], [0, 1, 21], [1, 0, 22], [1, 1, 23]]);
      expect(cfg.receivers[0]).toMatchObject({ moduleWidth: 64, moduleHeight: 32, scanMode: 16, physicalDataGroups: 8, refNumPerVs: 3840, grayDepth: 14, grayRealize: 1, grayMode: 2 });
      expect(cfg.receivers[0]).not.toHaveProperty('voltageRaw');
      expect(cfg.layout).toEqual(wall());
      // what was read is a loadable file
      expect(parseScreenConfigJson(serializeScreenConfig(cfg)).ok).toBe(true);
    });

    it('reads straight from the simulator registers (seeded, not written through the API)', async () => {
      await open(false);
      mem(1, 1).writeU8(R.moduleWidth, 128);
      mem(1, 1).writeU8(R.moduleHeight, 48);
      mem(1, 1).writeU8(R.scanMode, 8);
      mem(1, 1).writeU8(R.gamma, 31);
      mem(1, 1).writeU8(R.physicalDataGroups, 4);
      mem(1, 1).writeU8(R.driverIc, 255);
      mem(1, 1).writeU16LE(R.refNumPerVs, 960);
      mem(1, 1).write(R.temperature, Buffer.from([1, 41]));
      sender().write(0x0200_0024, Buffer.from([0x80, 0x07, 0x38, 0x04])); // ReadDviWidth u16 @0x2000024, ReadDviHeight u16 @0x2000026
      const { config } = await service.readScreenConfig(id); // normal level: reading is allowed
      expect(config.sender!.video.resolution).toEqual({ width: 1920, height: 1080 });
      const c = config.receivers.find((r) => r.portIndex === 1 && r.cardIndex === 1)!;
      expect(c).toMatchObject({ moduleWidth: 128, moduleHeight: 48, scanMode: 8, gamma: 31, physicalDataGroups: 4, driverIc: 255, refNumPerVs: 960 });
      expect(c).not.toHaveProperty('temperatureRaw');
      expect(config.layout).toBeNull(); // nothing configured yet
    });

    it('turns a stored layout that is not a grid into a warning, not a failure', async () => {
      await open(true);
      await configure(wall(), 1);
      // move one card so the four rectangles stop forming a grid
      const xy = Buffer.alloc(4);
      xy.writeUInt32LE(((37 << 16) | 5) >>> 0);
      sender().write(0x0300_0000 + 4096 * 1 + 4 * 1, xy);
      const res = await service.readScreenConfig(id);
      expect(res.config.layout).toBeNull();
      expect(res.warnings.map((w) => w.code)).toContain('layout-not-a-grid');
      expect(res.failures).toEqual([]);
      expect(res.complete).toBe(true);
    });

    it('reports a failing card and still returns everything else', async () => {
      await open(true);
      await configure(wall(), 10);
      failIf = (c) => c.name === 'ReadModuleWidth' && c.args[1] === 0 && c.args[2] === 1;
      const res = await service.readScreenConfig(id);
      expect(res.complete).toBe(false);
      expect(res.failures).toEqual([{ part: 'receiver', portIndex: 0, cardIndex: 1, code: 'PROTOCOL', message: expect.stringContaining('injected:ReadModuleWidth') }]);
      expect(res.config.receivers.map((r) => `${r.portIndex}:${r.cardIndex}`)).toEqual(['0:0', '1:0', '1:1']);
      expect(res.config.sender).not.toBeNull();
      expect(res.config.layout).toEqual(wall());
      expect(res.config.controller.receivingCards).toBe(4); // the card exists, it just did not answer
    });

    it('reports sender and layout read failures separately', async () => {
      await open(true);
      await configure(wall(), 10);
      failIf = (c) => c.name === 'ReadDviWidth' || c.name === 'ReadSender_ComplexCfgScreenFlagSpace';
      const res = await service.readScreenConfig(id);
      expect(res.failures.map((f) => f.part).sort()).toEqual(['layout', 'sender']);
      expect(res.config.sender).toBeNull();
      expect(res.config.layout).toBeNull();
      expect(res.config.receivers).toHaveLength(4); // the cards are still read
    });

    it('throws NOT_FOUND / NOT_CONNECTED instead of reporting failures for a missing connection', async () => {
      await open(false);
      await expectCode(service.readScreenConfig('net:nope:1'), 'NOT_FOUND');
      await service.disconnect(id);
      await expectCode(service.readScreenConfig(id), 'NOT_CONNECTED');
    });
  });

  // ------------------------------------------------------------------------------ apply
  describe('applyScreenConfig', () => {
    const capture = async (): Promise<ScreenConfig> => {
      await open(true);
      await configure(wall(), 20);
      await service.setSenderPortEnabled(id, 1, false);
      const { config } = await service.readScreenConfig(id);
      return config;
    };
    const strip = (c: ScreenConfig) => ({ ...c, savedAt: '' });

    it('refuses at normal level before any I/O', async () => {
      const golden = await capture();
      await service.dispose();
      await open(false);
      const before = sim.state.requestCount;
      await expectCode(service.applyScreenConfig(id, golden), 'PERMISSION');
      await expectCode(service.applyScreenConfig(id, { nonsense: true } as never), 'PERMISSION');
      expect(sim.state.requestCount).toBe(before);
    });

    it('rejects an invalid file with INVALID_ARGUMENT and writes nothing', async () => {
      const golden = await capture();
      calls.length = 0;
      const bad = { ...golden, version: 7 } as unknown as ScreenConfig;
      await expectCode(service.applyScreenConfig(id, bad), 'INVALID_ARGUMENT');
      await expectCode(service.applyScreenConfig(id, null as never), 'INVALID_ARGUMENT');
      await expectCode(service.applyScreenConfig(id, golden, null as never), 'INVALID_ARGUMENT');
      expect(writes()).toEqual([]);
    });

    it('restores a saved config exactly, writing receivers, then layout, then sender', async () => {
      const golden = await capture();
      // change everything the file covers
      await configure(columns(), 100, { width: 1280, height: 720 });
      await service.setSenderFieldRate(id, 50);
      await service.setSenderInputSource(id, 'DVI');
      await service.setSenderPortEnabled(id, 0, false);
      expect(strip((await service.readScreenConfig(id)).config)).not.toEqual(strip(golden));
      calls.length = 0;

      const res = await service.applyScreenConfig(id, golden);
      expect(res.ok).toBe(true);
      expect(res.failedStep).toBeUndefined();
      expect(res.save).toBeUndefined();
      expect(strip((await service.readScreenConfig(id)).config)).toEqual(strip(golden));

      // order: all receiver writes, then layout writes, then sender writes
      const names = writes();
      const lastReceiver = names.lastIndexOf('SetPhysicalTotalDataGroupNum');
      const firstLayout = names.indexOf('SetSender_ComplexCfgScreenFlagSpace');
      const lastLayout = names.lastIndexOf('SetControlHeight');
      const firstSender = Math.min(...['SetDviWidth', 'SetFieldRate', 'SetDviSelect_1'].map((n) => names.indexOf(n)).filter((i) => i >= 0));
      expect(lastReceiver).toBeGreaterThan(-1);
      expect(lastReceiver).toBeLessThan(firstLayout);
      expect(lastLayout).toBeLessThan(firstSender);
      expect(res.steps.map((s) => s.kind)).toEqual(['receiver', 'receiver', 'receiver', 'receiver', 'layout', 'sender-resolution', 'sender-field-rate', 'sender-input-source', 'sender-port', 'sender-port']);
      expect(res.steps.every((s) => s.status === 'written')).toBe(true);
    });

    it('writes only what differs: a second apply of the same file writes nothing', async () => {
      const golden = await capture();
      calls.length = 0;
      const res = await service.applyScreenConfig(id, golden);
      expect(res).toEqual({ ok: true, steps: [] });
      expect(writes()).toEqual([]);
      // one differing card -> exactly that card is written
      const tweaked = clone(golden);
      tweaked.receivers[3]!.gamma = 99;
      const res2 = await service.applyScreenConfig(id, tweaked);
      expect(res2.steps).toEqual([{ kind: 'receiver', portIndex: 1, cardIndex: 1, status: 'written' }]);
      expect(byte(1, 1, R.gamma)).toBe(99);
      expect(byte(1, 0, R.gamma)).toBe(22);
    });

    it('stops at the first error, reports the step and leaves later steps unwritten', async () => {
      const golden = await capture();
      await configure(columns(), 100, { width: 1280, height: 720 });
      calls.length = 0;
      failIf = (c) => c.name === 'SetGamma' && c.args[1] === 1 && c.args[2] === 0;
      const res = await service.applyScreenConfig(id, golden);
      expect(res.ok).toBe(false);
      expect(res.failedStep).toMatchObject({ kind: 'receiver', portIndex: 1, cardIndex: 0, status: 'failed', code: 'PROTOCOL' });
      expect(res.failedStep!.message).toContain('injected:SetGamma');
      expect(res.steps.map((s) => [s.kind, s.status])).toEqual([['receiver', 'written'], ['receiver', 'written'], ['receiver', 'failed']]);
      // nothing after the failure: no card (1,1), no layout, no sender
      expect(byte(1, 1, R.gamma)).toBe(103);
      expect(writes().some((n) => n === 'SetSender_ComplexCfgScreenFlagSpace' || n === 'SetDviWidth' || n === 'SetFieldRate')).toBe(false);
      const dev = (await service.readScreenConfig(id)).config;
      expect(dev.sender!.video.resolution).toEqual({ width: 1280, height: 720 });
      expect(dev.layout).toEqual(columns());
    });

    it('reports a failing layout step as the failed step and does not touch the sender', async () => {
      const golden = await capture();
      await configure(columns(), 100, { width: 1280, height: 720 });
      calls.length = 0;
      failIf = (c) => c.name === 'SetPortWidth';
      const res = await service.applyScreenConfig(id, golden);
      expect(res.ok).toBe(false);
      expect(res.failedStep).toMatchObject({ kind: 'layout', status: 'failed' });
      expect(res.steps.filter((s) => s.kind === 'receiver')).toHaveLength(4);
      expect(writes()).not.toContain('SetDviWidth');
    });

    it('refuses before writing when the file does not fit the controller', async () => {
      const golden = await capture();
      calls.length = 0;
      // a card the controller does not have
      const extraCard = clone(golden);
      extraCard.receivers.push(card(1, 5));
      await expectCode(service.applyScreenConfig(id, extraCard), 'INVALID_ARGUMENT');
      // model mismatch
      const other = clone(golden);
      other.controller.model = 'MCTRL4K';
      await expectCode(service.applyScreenConfig(id, other), 'INVALID_ARGUMENT');
      // layout wiring a different number of cards than the port has
      const wrongCount = clone(golden);
      wrongCount.layout = { screen: createLayoutScreen(1, 1, 128, 64), ports: [{ port: 0, cabinets: [{ row: 0, col: 0 }] }] };
      await expectCode(service.applyScreenConfig(id, wrongCount), 'INVALID_ARGUMENT');
      expect(writes()).toEqual([]);
    });

    it('can skip missing cards, apply across a model mismatch and apply only chosen parts', async () => {
      const golden = await capture();
      await configure(columns(), 100, { width: 1280, height: 720 });
      calls.length = 0;
      const odd = clone(golden);
      odd.receivers.push(card(1, 5));
      odd.controller.model = 'MCTRL4K';
      const res = await service.applyScreenConfig(id, odd, { skipMissingCards: true, allowModelMismatch: true, parts: { layout: false, sender: false } });
      expect(res.ok).toBe(true);
      expect(res.steps).toContainEqual({ kind: 'receiver', portIndex: 1, cardIndex: 5, status: 'skipped', message: 'the controller has no such card' });
      expect(res.steps.filter((s) => s.status === 'written').map((s) => s.kind)).toEqual(['receiver', 'receiver', 'receiver', 'receiver']);
      expect(writes()).not.toContain('SetDviWidth');
      expect(writes()).not.toContain('SetControlWidth');
      expect(byte(0, 0, R.gamma)).toBe(20);
    });

    it('skips unconfigured cards instead of failing, and reports why', async () => {
      await open(true);
      await configure(wall(), 20);
      const { config } = await service.readScreenConfig(id);
      const file = clone(config);
      file.receivers[1] = { ...file.receivers[1]!, moduleWidth: 0, moduleHeight: 0 };
      file.receivers[0]!.gamma = 55;
      calls.length = 0;
      const res = await service.applyScreenConfig(id, file);
      expect(res.ok).toBe(true);
      expect(res.steps).toEqual([
        { kind: 'receiver', portIndex: 0, cardIndex: 1, status: 'skipped', message: 'unconfigured' },
        { kind: 'receiver', portIndex: 0, cardIndex: 0, status: 'written' },
      ]);
      expect(byte(0, 1, R.moduleWidth)).toBe(64); // untouched
      expect(byte(0, 0, R.gamma)).toBe(55);
    });

    it('optionally saves to hardware at the end, only after everything else succeeded', async () => {
      const golden = await capture();
      await configure(columns(), 100, { width: 1280, height: 720 });
      calls.length = 0;
      const res = await service.applyScreenConfig(id, golden, { saveToHardware: true });
      expect(res.ok).toBe(true);
      expect(res.save).toMatchObject({ ok: true });
      expect(res.steps.at(-1)).toEqual({ kind: 'save', status: 'written' });
      const names = writes();
      expect(names.indexOf('SetParameterStore2SpiFlash')).toBeGreaterThan(names.lastIndexOf('SetPortEnable'));
      expect(names.filter((n) => n === 'SetParameterStore2SpiFlash')).toHaveLength(4);
      expect(names.filter((n) => n === 'SetSaveSendCardsParameters')).toHaveLength(1);
      for (const [p, c] of [[0, 0], [0, 1], [1, 0], [1, 1]] as const) expect(byte(p, c, SAVE_CARD)).toBe(1);

      // a failed apply never saves
      await configure(columns(), 100, { width: 1280, height: 720 });
      blankSave();
      calls.length = 0;
      failIf = (c) => c.name === 'SetDviWidth';
      const failed = await service.applyScreenConfig(id, golden, { saveToHardware: true });
      expect(failed.ok).toBe(false);
      expect(failed.failedStep).toMatchObject({ kind: 'sender-resolution' });
      expect(writes()).not.toContain('SetParameterStore2SpiFlash');
      expect(failed.save).toBeUndefined();
    });

    it('reports a failing save as the failed step with the per-card detail', async () => {
      const golden = await capture();
      calls.length = 0;
      failIf = (c) => c.name === 'SetParameterStore2SpiFlash' && c.args[1] === 1 && c.args[2] === 1;
      const res = await service.applyScreenConfig(id, golden, { saveToHardware: true, save: { receiverValue: 3 } });
      expect(res.ok).toBe(false);
      expect(res.failedStep).toMatchObject({ kind: 'save', status: 'failed', code: 'PROTOCOL' });
      expect(res.save!.cards.map((r) => r.ok)).toEqual([true, true, true, false]);
      expect(byte(0, 0, SAVE_CARD)).toBe(3);
    });

    const blankSave = (): void => {
      for (const k of sim.state.receivingCards) k.memory.write(SAVE_CARD, Buffer.alloc(1));
    };
  });
});

