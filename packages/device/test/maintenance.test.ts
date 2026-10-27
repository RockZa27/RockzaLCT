import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DeviceError,
  FIRMWARE_WRITE_MISSING,
  MAINTENANCE_METHODS,
  buildDryRunPlan,
  checkFirmwareCompatibility,
  firmwareCapacity,
  formatProgramEdition,
  validateFirmwareFile,
  type FirmwareFileInput,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import { createDeviceService, createNetSessionFactory, type DeviceService, type SessionLike } from '../src/index.js';
import { createMaintenanceFeature, decodeSchedule } from '../src/features/maintenance.js';
import type { FeatureContext } from '../src/features/context.js';

// Register numbers seeded below, each from @novastar/native@2.5.1 dist/AddressMapping.mjs
// (the same numbers the generated dist/api/FuncCard_*.mjs put in `req.address`).
const REG = {
  model: 2, // FuncCard_ReadFuncCardModle
  golden: 4, // FuncCard_ReadGoldenFPGAVersion
  fpgaVersion: 16777220, // FuncCard_FPGAVersionAddr
  mcuVersion: 33554436, // FuncCard_MCUVersionAddr
  clock: 83886080, // FuncCard_TimeOnFuncCardAddr
  relay: 83886096, // FuncCard_PowerPortCtrlAddr (+ index)
  schedule: 83886112, // FuncCard_PowerOperTimeAddr
  mode: 83886176, // FuncCard_PowerCtrlModeAddr
  total: 83886178, // FuncCard_PowerPortCtrlTotalAddr
  senderMcu: 67108868, // ReadSender_McuProgramEdition
  senderFpga: 68157444, // ReadSender_FPGAProgramEdition
} as const;

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

const file = (size: number, fill: (i: number) => number = (i) => (i * 31 + 7) & 0xff, name = 'fw.bin'): FirmwareFileInput => ({
  name,
  bytes: Uint8Array.from({ length: size }, (_, i) => fill(i)),
});

// ---------------------------------------------------------------------------------------------
// Pure: file validation, compatibility, dry run
// ---------------------------------------------------------------------------------------------

describe('validateFirmwareFile', () => {
  it('accepts a plausible synthetic binary for the function card FPGA', () => {
    const r = validateFirmwareFile(file(1000), 'function-card-fpga');
    expect(r.valid).toBe(true);
    expect(r.format).toBe('binary');
    expect(r.capacity).toBe(33554432 - 16777472);
    expect(r.capacity).toBe(firmwareCapacity('function-card-fpga'));
    expect(firmwareCapacity('function-card-mcu')).toBe(50331648 - 33554688);
  });

  it('rejects an empty file', () => {
    const r = validateFirmwareFile({ name: 'x.bin', bytes: new Uint8Array(0) }, 'function-card-fpga');
    expect(r.valid).toBe(false);
    expect(r.format).toBe('empty');
    expect(r.findings.map((f) => f.code)).toContain('empty');
  });

  it('rejects a file larger than the register region (wrong size)', () => {
    const cap = firmwareCapacity('function-card-fpga');
    const ok = validateFirmwareFile(file(cap), 'function-card-fpga');
    expect(ok.valid).toBe(true);
    const big = validateFirmwareFile(file(cap + 1), 'function-card-fpga');
    expect(big.valid).toBe(false);
    expect(big.findings.map((f) => f.code)).toContain('too-large');
  });

  it('rejects uniform content (all 0xFF / all 0x00)', () => {
    expect(validateFirmwareFile(file(64, () => 0xff), 'function-card-fpga').findings.map((f) => f.code)).toContain('uniform');
    expect(validateFirmwareFile(file(64, () => 0), 'function-card-mcu').valid).toBe(false);
  });

  it('detects malformed Intel HEX (bad checksum, missing EOF) and accepts a valid one with a warning', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    const good = ':0300300002337A1E\n:00000001FF\n';
    const r = validateFirmwareFile({ name: 'a.hex', bytes: enc(good) }, 'function-card-mcu');
    expect(r.format).toBe('intel-hex');
    expect(r.valid).toBe(true);
    expect(r.findings.map((f) => f.code)).toContain('hex-unspecified');
    const badSum = validateFirmwareFile({ name: 'a.hex', bytes: enc(':0300300002337A1F\n:00000001FF\n') }, 'function-card-mcu');
    expect(badSum.valid).toBe(false);
    expect(badSum.findings.map((f) => f.code)).toContain('hex-corrupt');
    const noEof = validateFirmwareFile({ name: 'a.hex', bytes: enc(':0300300002337A1E\n') }, 'function-card-mcu');
    expect(noEof.valid).toBe(false);
  });

  it('warns when the extension suggests another target (wrong target)', () => {
    const r = validateFirmwareFile(file(100, undefined, 'image.rbf'), 'function-card-mcu');
    expect(r.findings.map((f) => f.code)).toContain('extension-mismatch');
    expect(r.valid).toBe(true); // a name is only a hint
  });

  it('reports an unknown target as an error', () => {
    const r = validateFirmwareFile(file(10), 'toaster' as never);
    expect(r.valid).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain('unknown-target');
  });
});

describe('checkFirmwareCompatibility', () => {
  const device = { modelId: 0x0a01, mcuVersionRaw: 0x01020300, fpgaVersionRaw: 0x01010000 };

  it('flags targets that have no program-data function in the library', () => {
    for (const t of ['sender-mcu', 'receiver-fpga', 'function-card-mcu'] as const) {
      const c = checkFirmwareCompatibility({ report: validateFirmwareFile(file(100), t), device });
      expect(c.compatible).toBe(false);
      expect(c.findings.some((f) => f.code === 'no-program-api' || f.code === 'no-mcu-data-api')).toBe(true);
    }
  });

  it('compares versions and model for the function card FPGA', () => {
    const report = validateFirmwareFile(file(100), 'function-card-fpga');
    expect(checkFirmwareCompatibility({ report, device, declaredVersion: 0x01010001, declaredModelId: 0x0a01 })).toMatchObject({
      compatible: true,
      versionComparison: 'newer',
    });
    expect(checkFirmwareCompatibility({ report, device, declaredVersion: 0x01010000, declaredModelId: 0x0a01 }).versionComparison).toBe('same');
    const older = checkFirmwareCompatibility({ report, device, declaredVersion: 0x01000000, declaredModelId: 0x0a01 });
    expect(older.versionComparison).toBe('older');
    expect(older.findings.map((f) => f.code)).toContain('downgrade');
    const wrongModel = checkFirmwareCompatibility({ report, device, declaredVersion: 0x01010001, declaredModelId: 0x0b02 });
    expect(wrongModel.compatible).toBe(false);
    expect(wrongModel.findings.map((f) => f.code)).toContain('model-mismatch');
  });

  it('is not compatible when the card state could not be read', () => {
    const report = validateFirmwareFile(file(100), 'function-card-fpga');
    expect(checkFirmwareCompatibility({ report, device: null }).compatible).toBe(false);
  });
});

describe('buildDryRunPlan', () => {
  it('computes exact block count, addresses and sample for a synthetic image', () => {
    const report = validateFirmwareFile(file(1000), 'function-card-fpga');
    const plan = buildDryRunPlan(report, 256)!;
    expect(plan.blockCount).toBe(4); // 256+256+256+232
    expect(plan.executable).toBe(false);
    expect(plan.requestsSent).toBe(0);
    expect(plan.blockSample.map((b) => [b.index, b.offset, b.address, b.length])).toEqual([
      [0, 256, 16777216 + 256, 256],
      [1, 512, 16777216 + 512, 256],
      [2, 768, 16777216 + 768, 256],
      [3, 1024, 16777216 + 1024, 232],
    ]);
    expect(plan.steps.map((s) => [s.call, s.address, s.length])).toEqual([
      ['FuncCard_SetFuncCardFPGALength', 16777216, 4],
      ['FuncCard_SetFuncCardFPGAVersion', 16777220, 4],
      ['FuncCard_SetFPGAData', 16777472, 1000],
    ]);
    expect(plan.blockers).toEqual([...FIRMWARE_WRITE_MISSING]);
  });

  it('samples only the first and last three blocks of a big image', () => {
    const plan = buildDryRunPlan(validateFirmwareFile(file(256 * 100 + 5), 'function-card-fpga'), 256)!;
    expect(plan.blockCount).toBe(101);
    expect(plan.blockSample.map((b) => b.index)).toEqual([0, 1, 2, 98, 99, 100]);
    expect(plan.blockSample.at(-1)!.length).toBe(5);
  });

  it('returns null for targets without a data writer or invalid files, and rejects a bad block size', () => {
    expect(buildDryRunPlan(validateFirmwareFile(file(100), 'receiver-mcu'))).toBeNull();
    expect(buildDryRunPlan(validateFirmwareFile(file(0), 'function-card-fpga'))).toBeNull();
    expect(() => buildDryRunPlan(validateFirmwareFile(file(100), 'function-card-fpga'), 0)).toThrow(RangeError);
  });
});

describe('decodeSchedule / formatProgramEdition', () => {
  it('decodes 8 x (open hms, close hms)', () => {
    const data = Buffer.alloc(48);
    data.set([8, 30, 0, 22, 15, 45], 6); // relay 1
    const s = decodeSchedule(data);
    expect(s).toHaveLength(8);
    expect(s[1]).toEqual({ relay: 1, open: [8, 30, 0], close: [22, 15, 45] });
    expect(s[0]).toEqual({ relay: 0, open: [0, 0, 0], close: [0, 0, 0] });
  });
  it('formats editions like the other features', () => {
    expect(formatProgramEdition(0x01020300)).toBe('1.2.3');
    expect(formatProgramEdition(0x01020304)).toBe('1.2.3.4');
  });
});

it('MAINTENANCE_METHODS lists every API method', () => {
  expect(Object.keys(MAINTENANCE_METHODS).sort()).toEqual(
    ['dryRunFirmware', 'getFirmwareWriteStatus', 'readFunctionCardInfo', 'readProgramVersions', 'readRelayStatus', 'setPowerControlMode', 'setRelay', 'writeFirmware'],
  );
});

// ---------------------------------------------------------------------------------------------
// Device layer against the simulator (function card requests share the sender memory)
// ---------------------------------------------------------------------------------------------

describe('maintenance against the simulator', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;

  beforeAll(async () => {
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 2 });
  });
  afterAll(async () => {
    await sim.close();
  });
  afterEach(async () => {
    await service.dispose();
  });

  const fresh = async (advanced: boolean): Promise<void> => {
    service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 400,
    });
    id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await service.connect(id);
    if (advanced) expect(await service.login('admin')).toBe(true);
  };

  const mem = () => sim.state.sendingCard;

  it('reads function card info and relay status from seeded registers (normal level, reads only)', async () => {
    await fresh(false);
    mem().writeU16LE(REG.model, 0x0a01);
    mem().writeU32LE(REG.mcuVersion, 0x01020300);
    mem().writeU32LE(REG.fpgaVersion, 0x02000001);
    mem().writeU32LE(REG.golden, 0x01000000);
    mem().write(REG.clock, Buffer.from([26, 10, 27, 2, 13, 45, 59]));
    for (let i = 0; i < 8; i += 1) mem().writeU8(REG.relay + i, i === 3 ? 1 : 0);
    mem().writeU8(REG.mode, 1);
    mem().writeU8(REG.total, 0);
    mem().write(REG.schedule + 6, Buffer.from([8, 30, 0, 22, 15, 45]));

    const before = sim.state.requestCount;
    const info = await service.readFunctionCardInfo(id, 7);
    expect(info).toMatchObject({
      functionCardAddress: 7,
      modelId: 0x0a01,
      mcuVersion: '1.2.3',
      fpgaVersion: '2.0.0.1',
      goldenFpgaVersion: '1.0.0',
      clock: { year: 26, month: 10, day: 27, weekday: 2, hour: 13, minute: 45, second: 59 },
    });
    expect(sim.state.requestCount - before).toBe(5);

    const mid = sim.state.requestCount;
    const st = await service.readRelayStatus(id, 7);
    expect(sim.state.requestCount - mid).toBe(11);
    expect(st.relays.map((r) => r.raw)).toEqual([0, 0, 0, 1, 0, 0, 0, 0]);
    expect(st.relays[3]).toEqual({ index: 3, raw: 1, state: 'stop' });
    expect(st.relays[0]!.state).toBe('start');
    expect(st.mode).toBe('auto');
    expect(st.total).toEqual({ raw: 0, state: 'start' });
    expect(st.schedule[1]).toEqual({ relay: 1, open: [8, 30, 0], close: [22, 15, 45] });
  });

  it('refuses every write at normal level with zero requests', async () => {
    await fresh(false);
    const before = sim.state.requestCount;
    await expectCode(service.setRelay(id, 1, { relay: 0, on: false, confirmed: true }), 'PERMISSION');
    await expectCode(service.setRelay(id, 1, { relay: 'all', on: false, confirmed: true }), 'PERMISSION');
    await expectCode(service.setPowerControlMode(id, 1, 'auto', true), 'PERMISSION');
    expect(sim.state.requestCount).toBe(before);
  });

  it('refuses an unconfirmed write at advanced level with zero requests', async () => {
    await fresh(true);
    const before = sim.state.requestCount;
    await expectCode(service.setRelay(id, 1, { relay: 0, on: false, confirmed: false }), 'INVALID_ARGUMENT');
    await expectCode(service.setPowerControlMode(id, 1, 'auto', false), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);
  });

  it('writes one relay and the total register at advanced level, writing exactly the documented bytes', async () => {
    await fresh(true);
    mem().writeU8(REG.relay + 5, 0);
    const r = await service.setRelay(id, 1, { relay: 5, on: false, confirmed: true });
    expect(r).toEqual({ relay: 5, written: 1, readBack: 1, verified: true });
    expect(mem().readU8(REG.relay + 5)).toBe(1); // PowerOperateType.Stop
    expect(mem().readU8(REG.relay + 4)).toBe(0); // neighbours untouched
    expect(mem().readU8(REG.relay + 6)).toBe(0);

    const on = await service.setRelay(id, 1, { relay: 5, on: true, confirmed: true });
    expect(on.written).toBe(0);
    expect(mem().readU8(REG.relay + 5)).toBe(0);

    const all = await service.setRelay(id, 1, { relay: 'all', on: false, confirmed: true });
    expect(all).toEqual({ relay: 'all', written: 1, readBack: 1, verified: true });
    expect(mem().readU8(REG.total)).toBe(1);

    const m = await service.setPowerControlMode(id, 1, 'auto', true);
    expect(m).toEqual({ mode: 'auto', readBack: 1, verified: true });
    expect(mem().readU8(REG.mode)).toBe(1);
  });

  it('validates arguments before sending anything', async () => {
    await fresh(true);
    const before = sim.state.requestCount;
    await expectCode(service.readRelayStatus(id, 256), 'INVALID_ARGUMENT');
    await expectCode(service.readFunctionCardInfo(id, -1), 'INVALID_ARGUMENT');
    await expectCode(service.setRelay(id, 1, { relay: 8, on: true, confirmed: true }), 'INVALID_ARGUMENT');
    await expectCode(service.setRelay(id, 1, { relay: 1.5, on: true, confirmed: true }), 'INVALID_ARGUMENT');
    await expectCode(service.setPowerControlMode(id, 1, 'sideways' as never, true), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);
  });

  it('reads sender and receiving card program versions (2 reads each) and a function card (3 reads)', async () => {
    await fresh(false);
    const before = sim.state.requestCount;
    const v = await service.readProgramVersions(id, {
      cards: [{ portIndex: 0, cardIndex: 0 }],
      functionCardAddress: 1,
    });
    expect(sim.state.requestCount - before).toBe(2 + 2 + 3);
    expect(v.sender.mcu).toBe('1.2.3');
    expect(v.sender.fpga).toBe('1.2.3');
    expect(v.receivers).toHaveLength(1);
    expect(v.receivers[0]).toMatchObject({ portIndex: 0, cardIndex: 0 });
    expect(v.functionCard).toMatchObject({ functionCardAddress: 1 });
  });

  it('dry run reads 3 registers, writes nothing, and changes no memory', async () => {
    await fresh(true);
    mem().writeU16LE(REG.model, 0x0a01);
    mem().writeU32LE(REG.fpgaVersion, 0x01010000);
    mem().writeU32LE(REG.mcuVersion, 0x01020300);
    const lengthBefore = mem().read(16777216, 8).toString('hex');
    const before = sim.state.requestCount;
    const res = await service.dryRunFirmware(id, {
      functionCardAddress: 1,
      target: 'function-card-fpga',
      file: file(1000),
      declaredVersion: 0x01010001,
      declaredModelId: 0x0a01,
      blockSize: 256,
    });
    expect(sim.state.requestCount - before).toBe(3);
    expect(res.writesSent).toBe(0);
    expect(res.report.valid).toBe(true);
    expect(res.compatibility).toMatchObject({ compatible: true, versionComparison: 'newer' });
    expect(res.plan!.blockCount).toBe(4);
    expect(res.plan!.executable).toBe(false);
    expect(mem().read(16777216, 8).toString('hex')).toBe(lengthBefore);
    expect(mem().read(16777472, 16).every((b) => b === 0)).toBe(true); // data area untouched
  });

  it('dry run flags an invalid file and a wrong model, and still sends no write', async () => {
    await fresh(true);
    mem().writeU16LE(REG.model, 0x0a01);
    const bad = await service.dryRunFirmware(id, { functionCardAddress: 1, target: 'function-card-fpga', file: file(0) });
    expect(bad.report.valid).toBe(false);
    expect(bad.plan).toBeNull();
    expect(bad.compatibility.compatible).toBe(false);
    const wrong = await service.dryRunFirmware(id, {
      functionCardAddress: 1,
      target: 'function-card-fpga',
      file: file(100),
      declaredModelId: 0x0b02,
    });
    expect(wrong.compatibility.findings.map((f) => f.code)).toContain('model-mismatch');
    await expectCode(service.dryRunFirmware(id, { functionCardAddress: 1, target: 'nope' as never, file: file(1) }), 'INVALID_ARGUMENT');
    await expectCode(service.dryRunFirmware(id, { functionCardAddress: 1, target: 'function-card-fpga', file: { name: 'x', bytes: [1, 2] as never } }), 'INVALID_ARGUMENT');
  });

  it('writeFirmware is refused and sends nothing (disabled by default)', async () => {
    await fresh(true);
    const before = sim.state.requestCount;
    await expectCode(
      service.writeFirmware(id, { functionCardAddress: 1, target: 'function-card-fpga', file: file(100) }),
      'PERMISSION',
    );
    const status = await service.getFirmwareWriteStatus(id);
    expect(status).toEqual({ implemented: false, enabled: false, missing: [...FIRMWARE_WRITE_MISSING] });
    expect(sim.state.requestCount).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Feature with a scripted session: request counting, failures, enableFirmwareWrite
// ---------------------------------------------------------------------------------------------

function scriptedFeature(level: 'normal' | 'advanced', options?: { enableFirmwareWrite?: boolean }, script: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const session = new Proxy(script, {
    get(target, prop: string) {
      if (prop in target) return (...a: unknown[]) => (calls.push(prop), (target[prop] as (...x: unknown[]) => unknown)(...a));
      return async () => {
        calls.push(prop);
        return 0;
      };
    },
  }) as unknown as SessionLike;
  const ctx: FeatureContext = {
    withSession: (_id, fn) => fn(session),
    userLevel: () => ({ level }),
    timeoutMs: 100,
  };
  return { api: createMaintenanceFeature(ctx, options), calls };
}

describe('writeFirmware / enableFirmwareWrite', () => {
  const req = { functionCardAddress: 1, target: 'function-card-fpga', file: file(100) } as const;

  it('is refused when enableFirmwareWrite is false (default), at both levels, with zero requests', async () => {
    for (const level of ['normal', 'advanced'] as const) {
      const { api, calls } = scriptedFeature(level);
      await expectCode(api.writeFirmware('x', req), 'PERMISSION');
      expect(calls).toEqual([]);
    }
    const off = scriptedFeature('advanced', { enableFirmwareWrite: false });
    await expectCode(off.api.writeFirmware('x', req), 'PERMISSION');
    expect(off.calls).toEqual([]);
  });

  it('even when enabled it refuses, because no writer exists, and names why', async () => {
    const { api, calls } = scriptedFeature('advanced', { enableFirmwareWrite: true });
    const err = await api.writeFirmware('x', req).then(() => undefined, (e: unknown) => e as DeviceError);
    expect(err).toBeInstanceOf(DeviceError);
    expect(err!.code).toBe('PROTOCOL');
    expect(err!.message).toMatch(/not implemented/);
    expect(calls).toEqual([]);
    expect(await api.getFirmwareWriteStatus('x')).toMatchObject({ implemented: false, enabled: true });
  });

  it('refuses at normal level even when enabled', async () => {
    const { api, calls } = scriptedFeature('normal', { enableFirmwareWrite: true });
    await expectCode(api.writeFirmware('x', req), 'PERMISSION');
    expect(calls).toEqual([]);
  });
});

describe('scripted failures', () => {
  it('readProgramVersions reports a failing card on its row and keeps going', async () => {
    const { api } = scriptedFeature('normal', undefined, {
      ReadSender_McuProgramEdition: async () => 0x01020300,
      ReadSender_FPGAProgramEdition: async () => 0x01020300,
      ReadScanner_McuProgramEdition: async (_a: number, _p: number, card: number) => {
        if (card === 1) throw new Error('boom');
        return 0x03000000;
      },
      ReadScanner_FPGAProgramEdition: async () => 0x04000000,
    });
    const v = await api.readProgramVersions('x', {
      cards: [{ portIndex: 0, cardIndex: 0 }, { portIndex: 0, cardIndex: 1 }, { portIndex: 0, cardIndex: 2 }],
    });
    expect(v.receivers.map((r) => [r.cardIndex, r.mcu, r.fpga, r.error])).toEqual([
      [0, '3.0.0', '4.0.0', undefined],
      [1, null, '4.0.0', 'boom'],
      [2, '3.0.0', '4.0.0', undefined],
    ]);
  });

  it('setRelay reports unverified when the card does not echo the value, and a failed write throws without read-back', async () => {
    const echoes = scriptedFeature('advanced', undefined, { FuncCard_ReadPowerPortCtrl: async () => 0 });
    const r = await echoes.api.setRelay('x', 1, { relay: 2, on: false, confirmed: true });
    expect(r).toEqual({ relay: 2, written: 1, readBack: 0, verified: false });

    const failing = scriptedFeature('advanced', undefined, {
      FuncCard_SetPowerPortCtrl: async () => {
        throw new Error('write failed');
      },
    });
    await expect(failing.api.setRelay('x', 1, { relay: 2, on: false, confirmed: true })).rejects.toThrow('write failed');
    expect(failing.calls).toEqual(['FuncCard_SetPowerPortCtrl']); // no read-back after a failed write
  });

  it('dryRunFirmware still returns a (non-compatible) result when the card state cannot be read', async () => {
    const { api, calls } = scriptedFeature('normal', undefined, {
      FuncCard_ReadFuncCardModle: async () => {
        throw new Error('no answer');
      },
    });
    const res = await api.dryRunFirmware('x', { functionCardAddress: 3, target: 'function-card-fpga', file: file(300) });
    expect(res.compatibility.compatible).toBe(false);
    expect(res.compatibility.findings.map((f) => f.code)).toContain('no-device-state');
    expect(res.plan!.blockCount).toBe(2);
    expect(calls.some((c) => c.startsWith('FuncCard_Set'))).toBe(false);
  });
});
