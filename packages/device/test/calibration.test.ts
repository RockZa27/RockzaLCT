import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Packet, ResponseError } from '@novastar/codec';
import {
  CALIBRATION_METHODS,
  CALIBRATION_UNSUPPORTED,
  COEFFICIENT_FILE_FORMAT,
  COEFFICIENT_REGION,
  DeviceError,
  base64ToBytes,
  buildCoefficientFile,
  bytesToBase64,
  checkCoefficientFileTarget,
  coefficientIoFromApi,
  composeCorrectionState,
  crc32Hex,
  decodeCorrectionState,
  downloadCoefficients,
  mergeCoefficientRanges,
  parseCoefficientFileJson,
  planCoefficientBlocks,
  serializeCoefficientFile,
  uploadCoefficients,
  validateCoefficientFile,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import {
  createDeviceService,
  createNetSessionFactory,
  type DeviceService,
  type SessionFactory,
} from '../src/index.js';
import {
  CALIBRATION_COMMAND_VALUES,
  CALIBRATION_REGISTERS as R,
  createCalibrationFeature,
} from '../src/features/calibration.js';
import type { FeatureContext } from '../src/features/context.js';

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

const pattern = (length: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return out;
};

const CONTROLLER = { model: 'MCTRL660', firmwareVersion: '1.2.3' };

describe('pure helpers', () => {
  it('lists every CalibrationApi method', () => {
    expect(Object.keys(CALIBRATION_METHODS).sort()).toEqual(
      [
        'eraseCoefficientsInFlash',
        'getCalibrationState',
        'readCoefficientBlock',
        'reloadCoefficientsFromFlash',
        'saveCoefficientsToFlash',
        'setCalibrationEnabled',
        'writeCoefficientBlock',
      ].sort(),
    );
  });

  it('documents what is unsupported, with the search terms', () => {
    expect(CALIBRATION_UNSUPPORTED.map((u) => u.id).sort()).toEqual(
      ['area-adjust', 'bright-dark-line-fix', 'camera', 'iic-flash', 'slave-flash'].sort(),
    );
    for (const u of CALIBRATION_UNSUPPORTED) expect(u.searched.length).toBeGreaterThan(1);
  });

  it('encodes the correction-state byte and reads it back', () => {
    expect(composeCorrectionState('chroma')).toBe(1);
    expect(composeCorrectionState('brightness')).toBe(3);
    expect(decodeCorrectionState(0)).toEqual({ enabled: false, type: 'chroma' });
    expect(decodeCorrectionState(3)).toEqual({ enabled: true, type: 'brightness' });
    expect(decodeCorrectionState(2)).toEqual({ enabled: false, type: 'brightness' });
  });

  it('base64 round-trips every length and rejects malformed text', () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = pattern(n, n);
      const text = bytesToBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(text)).toEqual(bytes);
    }
    for (const bad of ['A', 'AAA', 'AA=A', 'A===', 'AA==AAAA', 'AA!=', ' AAA', 'AB==', 'AAF=']) {
      expect(base64ToBytes(bad), bad).toBeNull();
    }
    expect(base64ToBytes('QQ==')).toEqual(new Uint8Array([0x41]));
  });

  it('computes the standard CRC-32', () => {
    expect(crc32Hex(new TextEncoder().encode('123456789'))).toBe('cbf43926');
    expect(crc32Hex(new Uint8Array(0))).toBe('00000000');
  });

  it('plans blocks and merges adjacent ranges', () => {
    expect(planCoefficientBlocks(100, 600)).toEqual([
      { offset: 100, length: 256 },
      { offset: 356, length: 256 },
      { offset: 612, length: 88 },
    ]);
    expect(mergeCoefficientRanges([{ offset: 0, length: 256 }, { offset: 256, length: 256 }, { offset: 1024, length: 8 }])).toEqual([
      { offset: 0, length: 512 },
      { offset: 1024, length: 8 },
    ]);
  });
});

describe('coefficient file format', () => {
  const data = pattern(700, 3);
  const file = buildCoefficientFile({ controller: CONTROLLER, portIndex: 1, cardIndex: 2, offset: 256, data, savedAt: new Date('2026-01-02T03:04:05Z') });

  it('has a versioned JSON header and survives serialise + parse', () => {
    expect(file).toMatchObject({
      format: COEFFICIENT_FILE_FORMAT,
      version: 1,
      savedAt: '2026-01-02T03:04:05.000Z',
      card: { portIndex: 1, cardIndex: 2 },
      region: { baseAddress: 0x0700_0000, offset: 256, length: 700 },
      checksum: { algorithm: 'crc32', value: crc32Hex(data) },
      encoding: 'base64',
    });
    const parsed = parseCoefficientFileJson(serializeCoefficientFile(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.bytes).toEqual(data);
      expect(parsed.file.card).toEqual({ portIndex: 1, cardIndex: 2 });
    }
  });

  const errorsOf = (mutate: (f: Record<string, any>) => void): string[] => {
    const copy = JSON.parse(JSON.stringify(file)) as Record<string, any>;
    mutate(copy);
    const res = validateCoefficientFile(copy);
    expect(res.ok).toBe(false);
    return res.ok ? [] : res.errors.map((e) => e.field);
  };

  it('rejects malformed files', () => {
    expect(parseCoefficientFileJson('{nope').ok).toBe(false);
    expect(parseCoefficientFileJson('[]').ok).toBe(false);
    expect(parseCoefficientFileJson('null').ok).toBe(false);
    expect(errorsOf((f) => (f.format = 'rockzalct.screen-config'))).toEqual(['format']);
    expect(errorsOf((f) => (f.version = 2))).toEqual(['version']);
    expect(errorsOf((f) => delete f.card)).toContain('card');
    expect(errorsOf((f) => (f.card.portIndex = -1))).toContain('card');
    expect(errorsOf((f) => (f.region.baseAddress = 0x0600_0000))).toContain('region.baseAddress');
    expect(errorsOf((f) => (f.encoding = 'hex'))).toContain('encoding');
    expect(errorsOf((f) => (f.data = 'not base64!'))).toContain('data');
    expect(errorsOf((f) => (f.checksum.value = 'xyz'))).toContain('checksum');
    expect(errorsOf((f) => (f.savedAt = 'yesterday'))).toContain('savedAt');
  });

  it('rejects a wrong size, a damaged payload and a region outside the card memory', () => {
    expect(errorsOf((f) => (f.region.length = 699))).toEqual(['data']);
    expect(errorsOf((f) => (f.data = bytesToBase64(data.subarray(0, 600))))).toEqual(['data']);
    const flipped = data.slice();
    flipped[10] = flipped[10]! ^ 0xff;
    expect(errorsOf((f) => (f.data = bytesToBase64(flipped)))).toEqual(['checksum']);
    expect(errorsOf((f) => (f.region.offset = COEFFICIENT_REGION.sizeBytes - 10))).toContain('region');
    expect(errorsOf((f) => (f.region.length = 0))).toContain('region');
    expect(errorsOf((f) => (f.region.offset = 1.5))).toContain('region');
  });

  it('refuses a file saved from another card unless told otherwise', () => {
    expect(checkCoefficientFileTarget(file, 1, 2)).toBeNull();
    expect(checkCoefficientFileTarget(file, 0, 2)).toMatch(/port 2 \/ card 3, not port 1 \/ card 3/);
    expect(checkCoefficientFileTarget(file, 1, 3)).not.toBeNull();
    expect(checkCoefficientFileTarget(file, 0, 0, { allowOtherCard: true })).toBeNull();
  });
});

describe('transfer runners (fake transport)', () => {
  const memory = new Uint8Array(4096);
  const io = (failAt?: number) => {
    let n = 0;
    return {
      async read(offset: number, length: number) {
        return memory.slice(offset, offset + length);
      },
      async write(offset: number, data: Uint8Array) {
        n += 1;
        if (failAt === n) throw new DeviceError('TIMEOUT', 'card gone');
        memory.set(data, offset);
      },
    };
  };

  it('reports progress per block and stops on cancellation with the exact ranges', async () => {
    memory.fill(0xee);
    const data = pattern(1000);
    const seen: number[] = [];
    let cancel = false;
    const res = await uploadCoefficients(io(), 256, data, {
      onProgress: (done) => {
        seen.push(done);
        if (done >= 512) cancel = true;
      },
      isCancelled: () => cancel,
    });
    expect(seen).toEqual([256, 512]);
    expect(res).toMatchObject({ ok: false, cancelled: true, doneBytes: 512, totalBytes: 1000, ranges: [{ offset: 256, length: 512 }] });
    expect(res.failed).toBeUndefined();
    expect(memory.slice(256, 768)).toEqual(data.slice(0, 512));
    expect(memory[768]).toBe(0xee);
  });

  it('names the failed block and what was written before it', async () => {
    memory.fill(0xee);
    const res = await uploadCoefficients(io(3), 0, pattern(1000));
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(false);
    expect(res.ranges).toEqual([{ offset: 0, length: 512 }]);
    expect(res.failed).toEqual({ offset: 512, length: 256, code: 'TIMEOUT', message: 'card gone' });
    expect(memory[512]).toBe(0xee);
  });

  it('refuses a range outside the region before transferring anything', async () => {
    await expect(uploadCoefficients(io(), COEFFICIENT_REGION.sizeBytes - 1, new Uint8Array(2))).rejects.toThrow(RangeError);
    await expect(downloadCoefficients(io(), 0, 0)).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Against the simulator

type Call = { name: string; args: unknown[] };

const fakeResponseError = (tag: string): ResponseError =>
  new ResponseError({ serno: 1, ack: 1, source: 0, port: 0, rcvIndex: 0 } as unknown as Readonly<Packet>, `injected:${tag}`);

/** Wraps the net factory: records every Set* / Write* / Move* call and lets a test fail any call like a card that does not answer. */
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
            if (/^(Set|Write|Move)/.test(prop)) calls.push(call);
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

  const mem = (port: number, card: number) =>
    sim.state.receivingCards.find((c) => c.portIndex === port && c.cardIndex === card)!.memory;
  const byte = (port: number, card: number, addr: number): number => mem(port, card).readU8(addr);
  const region = (port: number, card: number, offset: number, length: number): Uint8Array =>
    new Uint8Array(mem(port, card).read(R.coefficientRegion + offset, length));
  const flash = [R.saveToFlash, R.saveToFlashMultiLayer, R.reloadFromFlash, R.reloadFromFlashMultiLayer, R.eraseSpiFlash];

  const open = async (advanced: boolean): Promise<void> => {
    for (const c of sim.state.receivingCards) {
      c.memory.writeU8(R.correctionState, 0);
      c.memory.writeU8(R.coefficientSource, 0);
      c.memory.write(R.coefficientRegion, Buffer.alloc(8192));
      for (const a of flash) c.memory.writeU8(a, 0xee); // sentinel: a command writes its trigger byte here
    }
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

  const io = (port: number, card: number) => coefficientIoFromApi(service, id, port, card);

  it('reads the calibration state of the addressed card only', async () => {
    await open(false);
    mem(1, 1).writeU8(R.correctionState, 3);
    mem(1, 1).writeU8(R.coefficientSource, 1);
    mem(1, 1).write(R.coefficientRegion, Buffer.from([9, 8, 7]));
    mem(0, 1).write(R.coefficientRegion, Buffer.alloc(COEFFICIENT_REGION.blockBytes, 0xff));

    expect(await service.getCalibrationState(id, 1, 1)).toEqual({
      portIndex: 1,
      cardIndex: 1,
      stateRaw: 3,
      enabled: true,
      type: 'brightness',
      coefficientSourceRaw: 1,
      coefficientSource: 'module-flash',
      coefficientData: 'data',
    });
    expect(await service.getCalibrationState(id, 0, 0)).toMatchObject({
      stateRaw: 0,
      enabled: false,
      type: 'chroma',
      coefficientSource: 'scan-board-flash',
      coefficientData: 'empty',
    });
    expect(await service.getCalibrationState(id, 0, 1)).toMatchObject({ coefficientData: 'erased' });
    expect(calls).toEqual([]); // reading sends no Set/Write/Move
  });

  it('omits what a card refuses to answer', async () => {
    await open(false);
    failIf = (c) => c.name === 'ReadCoefficientSource' || c.name === 'ReadCorrectionDataToScan';
    const state = await service.getCalibrationState(id, 0, 0);
    expect(state).toEqual({ portIndex: 0, cardIndex: 0, stateRaw: 0, enabled: false, type: 'chroma' });
  });

  it('enables and disables calibration of one card at the normal user level', async () => {
    await open(false);
    await service.setCalibrationEnabled(id, { scope: 'card', portIndex: 1, cardIndex: 0 }, true, 'brightness');
    expect(byte(1, 0, R.correctionState)).toBe(3);
    expect(byte(0, 0, R.correctionState)).toBe(0);
    expect(calls.map((c) => [c.name, c.args.slice(1)])).toEqual([['SetCorrectionOn_2', [1, 0, false, 3]]]);

    expect(await service.getCalibrationState(id, 1, 0)).toMatchObject({ enabled: true, type: 'brightness' });

    await service.setCalibrationEnabled(id, { scope: 'card', portIndex: 1, cardIndex: 0 }, true, 'chroma');
    expect(byte(1, 0, R.correctionState)).toBe(1);
    await service.setCalibrationEnabled(id, { scope: 'card', portIndex: 1, cardIndex: 0 }, false);
    expect(byte(1, 0, R.correctionState)).toBe(0);
    expect(await service.getCalibrationState(id, 1, 0)).toMatchObject({ enabled: false });

    calls.length = 0;
    await service.setCalibrationEnabled(id, { scope: 'card', portIndex: 0, cardIndex: 1 }, true);
    expect(byte(0, 1, R.correctionState)).toBe(1);
    expect(calls.map((c) => c.name)).toEqual(['SetCorrectionOn']);
  });

  it('broadcasts enable / disable to all cards', async () => {
    await open(false);
    await service.setCalibrationEnabled(id, { scope: 'all' }, true, 'brightness');
    for (const c of sim.state.receivingCards) expect(c.memory.readU8(R.correctionState)).toBe(3);
    expect(calls[0]!.args.slice(1)).toEqual([0xff, 0xffff, true, 3]);
    await service.setCalibrationEnabled(id, { scope: 'all' }, false);
    for (const c of sim.state.receivingCards) expect(c.memory.readU8(R.correctionState)).toBe(0);
  });

  it('validates arguments before sending anything', async () => {
    await open(true);
    const before = sim.state.requestCount;
    await expectCode(service.getCalibrationState(id, -1, 0), 'INVALID_ARGUMENT');
    await expectCode(service.setCalibrationEnabled(id, { scope: 'card', portIndex: 999, cardIndex: 0 }, true), 'INVALID_ARGUMENT');
    await expectCode(service.setCalibrationEnabled(id, { scope: 'all' }, 'yes' as unknown as boolean), 'INVALID_ARGUMENT');
    await expectCode(service.setCalibrationEnabled(id, { scope: 'all' }, true, 'red' as never), 'INVALID_ARGUMENT');
    await expectCode(service.readCoefficientBlock(id, 0, 0, 0, 257), 'INVALID_ARGUMENT');
    await expectCode(service.readCoefficientBlock(id, 0, 0, COEFFICIENT_REGION.sizeBytes - 1, 2), 'INVALID_ARGUMENT');
    await expectCode(service.readCoefficientBlock(id, 0, 0, 0.5, 2), 'INVALID_ARGUMENT');
    await expectCode(service.writeCoefficientBlock(id, 0, 0, 0, '***'), 'INVALID_ARGUMENT');
    await expectCode(service.writeCoefficientBlock(id, 0, 0, 0, ''), 'INVALID_ARGUMENT');
    await expectCode(service.writeCoefficientBlock(id, 0, 0, 0, bytesToBase64(new Uint8Array(257))), 'INVALID_ARGUMENT');
    await expectCode(service.saveCoefficientsToFlash(id, 0, 0, 'weird' as never), 'INVALID_ARGUMENT');
    await expectCode(service.getCalibrationState('nope', 0, 0), 'NOT_FOUND');
    expect(sim.state.requestCount).toBe(before);
  });

  it('downloads a card in 256-byte blocks and round-trips through a file', async () => {
    await open(true);
    const source = pattern(1000, 5);
    mem(0, 0).write(R.coefficientRegion + 100, source);
    const before = sim.state.requestCount;
    const progress: number[] = [];
    const down = await downloadCoefficients(io(0, 0), 100, 1000, { onProgress: (d) => progress.push(d) });
    expect(down).toMatchObject({ ok: true, cancelled: false, doneBytes: 1000, ranges: [{ offset: 100, length: 1000 }] });
    expect(down.data).toEqual(source);
    expect(sim.state.requestCount - before).toBe(4); // 256 + 256 + 256 + 232: one library request per block
    expect(progress).toEqual([256, 512, 768, 1000]);

    const file = buildCoefficientFile({ controller: CONTROLLER, portIndex: 0, cardIndex: 0, offset: 100, data: down.data });
    const parsed = parseCoefficientFileJson(serializeCoefficientFile(file));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // wipe the card, then upload the file back
    mem(0, 0).write(R.coefficientRegion, Buffer.alloc(2048));
    const up = await uploadCoefficients(io(0, 0), parsed.file.region.offset, parsed.bytes);
    expect(up).toMatchObject({ ok: true, doneBytes: 1000, ranges: [{ offset: 100, length: 1000 }] });
    expect(region(0, 0, 100, 1000)).toEqual(source);
    expect(region(0, 0, 0, 100)).toEqual(new Uint8Array(100));
    expect(region(0, 0, 1100, 100)).toEqual(new Uint8Array(100));
    expect(region(0, 1, 100, 1000)).toEqual(new Uint8Array(1000)); // other cards untouched
  });

  it('writes each block to the register base + offset', async () => {
    await open(true);
    const res = await uploadCoefficients(io(1, 0), 512, pattern(520));
    expect(res.ok).toBe(true);
    const writes = calls.filter((c) => c.name === 'WriteCorrectionDataToScan');
    expect(writes.map((c) => [c.args[1], c.args[2], c.args[3], (c.args[4] as Buffer).length, c.args[5], c.args[6]])).toEqual([
      [1, 0, false, 256, 256, 0x0700_0200],
      [1, 0, false, 256, 256, 0x0700_0300],
      [1, 0, false, 8, 8, 0x0700_0400],
    ]);
  });

  it('refuses every write at the normal level with zero requests sent', async () => {
    await open(false);
    const before = sim.state.requestCount;
    const data = bytesToBase64(pattern(256));
    await expectCode(service.writeCoefficientBlock(id, 0, 0, 0, data), 'PERMISSION');
    await expectCode(service.saveCoefficientsToFlash(id, 0, 0), 'PERMISSION');
    await expectCode(service.reloadCoefficientsFromFlash(id, 0, 0, 'multi-layer'), 'PERMISSION');
    await expectCode(service.eraseCoefficientsInFlash(id, 0, 0), 'PERMISSION');
    const res = await uploadCoefficients(io(0, 0), 0, pattern(600));
    expect(res).toMatchObject({ ok: false, cancelled: false, doneBytes: 0, ranges: [], failed: { offset: 0, length: 256, code: 'PERMISSION' } });
    expect(sim.state.requestCount).toBe(before);
    expect(calls).toEqual([]);
    expect(region(0, 0, 0, 256)).toEqual(new Uint8Array(256));
    for (const a of flash) expect(byte(0, 0, a)).toBe(0xee);
  });

  it('reports exactly what was written when a block fails half way', async () => {
    await open(true);
    for (const c of sim.state.receivingCards) c.memory.write(R.coefficientRegion, Buffer.alloc(2048, 0xee));
    let n = 0;
    failIf = (c) => c.name === 'WriteCorrectionDataToScan' && ++n === 3;
    const data = pattern(1024, 9);
    const res = await uploadCoefficients(io(0, 0), 0, data);
    expect(res.ok).toBe(false);
    expect(res.ranges).toEqual([{ offset: 0, length: 512 }]);
    expect(res.failed).toMatchObject({ offset: 512, length: 256 });
    expect(region(0, 0, 0, 512)).toEqual(data.slice(0, 512));
    expect(region(0, 0, 512, 512)).toEqual(new Uint8Array(512).fill(0xee));
    expect(calls.filter((c) => c.name === 'WriteCorrectionDataToScan')).toHaveLength(3); // nothing attempted after the failure
  });

  it('stops an upload on request and leaves the rest of the card alone', async () => {
    await open(true);
    for (const c of sim.state.receivingCards) c.memory.write(R.coefficientRegion, Buffer.alloc(2048, 0xee));
    const data = pattern(1024, 4);
    let cancel = false;
    const res = await uploadCoefficients(io(0, 0), 0, data, { onProgress: (done) => void (cancel = done >= 256), isCancelled: () => cancel });
    expect(res).toMatchObject({ ok: false, cancelled: true, doneBytes: 256, ranges: [{ offset: 0, length: 256 }] });
    expect(region(0, 0, 0, 256)).toEqual(data.slice(0, 256));
    expect(region(0, 0, 256, 768)).toEqual(new Uint8Array(768).fill(0xee));
  });

  it('stops a download on request and returns the prefix read so far', async () => {
    await open(false);
    mem(0, 0).write(R.coefficientRegion, pattern(1024));
    let cancel = false;
    const res = await downloadCoefficients(io(0, 0), 0, 1024, { onProgress: (d) => void (cancel = d >= 512), isCancelled: () => cancel });
    expect(res).toMatchObject({ ok: false, cancelled: true, doneBytes: 512, ranges: [{ offset: 0, length: 512 }] });
    expect(res.data).toEqual(pattern(1024).slice(0, 512));
  });

  it('reports a read that fails and keeps what was read', async () => {
    await open(false);
    mem(0, 0).write(R.coefficientRegion, pattern(1024));
    let n = 0;
    failIf = (c) => c.name === 'ReadCorrectionDataToScan' && ++n === 3;
    const res = await downloadCoefficients(io(0, 0), 0, 1024);
    expect(res.ok).toBe(false);
    expect(res.ranges).toEqual([{ offset: 0, length: 512 }]);
    expect(res.failed).toMatchObject({ offset: 512, length: 256 });
    expect(res.data).toEqual(pattern(1024).slice(0, 512));
  });

  it('refuses erase and store for all cards (broadcast address) with zero requests sent', async () => {
    await open(true);
    const before = sim.state.requestCount;
    await expectCode(service.eraseCoefficientsInFlash(id, 0xff, 0xffff), 'INVALID_ARGUMENT');
    await expectCode(service.eraseCoefficientsInFlash(id, 0xff, 0), 'INVALID_ARGUMENT');
    await expectCode(service.eraseCoefficientsInFlash(id, 0, 0xffff), 'INVALID_ARGUMENT');
    await expectCode(service.eraseCoefficientsInFlash(id, { scope: 'all' } as never, 0), 'INVALID_ARGUMENT');
    await expectCode(service.saveCoefficientsToFlash(id, 0xff, 0xffff), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);
    expect(calls).toEqual([]);
    for (const c of sim.state.receivingCards) expect(c.memory.readU8(R.eraseSpiFlash)).toBe(0xee);
  });

  it('stores to, reloads from and erases flash with the library trigger registers', async () => {
    await open(true);
    await service.saveCoefficientsToFlash(id, 1, 0);
    expect(byte(1, 0, R.saveToFlash)).toBe(0);
    expect(byte(0, 0, R.saveToFlash)).toBe(0xee); // other cards untouched
    expect(byte(1, 0, R.saveToFlashMultiLayer)).toBe(0xee);

    await service.saveCoefficientsToFlash(id, 1, 0, 'multi-layer');
    expect(byte(1, 0, R.saveToFlashMultiLayer)).toBe(0);

    await service.reloadCoefficientsFromFlash(id, 1, 0);
    expect(byte(1, 0, R.reloadFromFlash)).toBe(0);
    expect(byte(1, 0, R.reloadFromFlashMultiLayer)).toBe(0xee);
    await service.reloadCoefficientsFromFlash(id, 1, 0, 'multi-layer');
    expect(byte(1, 0, R.reloadFromFlashMultiLayer)).toBe(0);

    expect(byte(1, 0, R.eraseSpiFlash)).toBe(0xee);
    await service.eraseCoefficientsInFlash(id, 1, 0);
    expect(byte(1, 0, R.eraseSpiFlash)).toBe(CALIBRATION_COMMAND_VALUES.eraseSpiFlash);

    expect(calls.map((c) => [c.name, c.args.slice(1)])).toEqual([
      ['MoveCorrectionFromSdramToMasterFlash', [1, 0, false, 1]],
      ['MoveCorrectionFromSdramToMasterFlash', [1, 0, false, 4]],
      ['MoveCorrectionFromMasterFlashToSdram', [1, 0, false, 1]],
      ['MoveCorrectionFromMasterFlashToSdram', [1, 0, false, 4]],
      ['SetCoefficientInSpiFlashErase', [1, 0, false, 0]],
    ]);
  });

  it('uses the registers cited from the native package', () => {
    expect(R).toEqual({
      correctionState: 33554513,
      coefficientSource: 33554514,
      coefficientRegion: 117440512,
      saveToFlash: 16777220,
      saveToFlashMultiLayer: 16777392,
      reloadFromFlash: 16777222,
      reloadFromFlashMultiLayer: 16777393,
      eraseSpiFlash: 16777224,
    });
    expect(COEFFICIENT_REGION).toEqual({ baseAddress: 117440512, sizeBytes: 2097152, blockBytes: 256 });
  });
});

describe('overridable unverified values', () => {
  it('sends the configured erase value and correction bits', async () => {
    const sent: unknown[][] = [];
    const session = {
      SetCoefficientInSpiFlashErase: async (...a: unknown[]) => void sent.push(['erase', ...a]),
      SetCorrectionOn_2: async (...a: unknown[]) => void sent.push(['on2', ...a]),
    };
    const ctx: FeatureContext = {
      withSession: (_id, fn) => fn(session as never),
      userLevel: () => ({ level: 'advanced' }),
      timeoutMs: 100,
    };
    const api = createCalibrationFeature(ctx, { eraseSpiFlash: 7, correctionBits: { enabled: 0x10, brightnessType: 0x20 } });
    await api.eraseCoefficientsInFlash('x', 2, 3);
    await api.setCalibrationEnabled('x', { scope: 'card', portIndex: 0, cardIndex: 0 }, true, 'brightness');
    expect(sent).toEqual([
      ['erase', 0, 2, 3, false, 7],
      ['on2', 0, 0, 0, false, 0x30],
    ]);
  });
});
