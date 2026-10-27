// Taurus: the real @novastar/taurus client (through our back end) against the Taurus simulator.
// Plain TCP is exercised everywhere; the TLS ("privacy mode") path has its own test that needs the
// `openssl` command to create a throw-away self-signed certificate and is skipped without it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as taurusLib from '@novastar/taurus';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DeviceError,
  HSERIES_METHODS,
  LAYOUT_METHODS,
  MONITOR_METHODS,
  PERSIST_METHODS,
  RECEIVER_METHODS,
  SENDER_METHODS,
  TAURUS_METHODS,
  type ControllerInfo,
  type DiscoveredController,
} from '@rockzalct/shared';
import {
  STATUS_NOT_LOGGED_IN,
  startTaurusSimulator,
  type TaurusSimulatorHandle,
  type TaurusSimulatorOptions,
} from '@rockzalct/simulator';
import { createDeviceService, probeTaurusHost, type DeviceService } from '../src/index.js';

const PASSWORD = 'correct horse';

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof DeviceError ? e.code : `non-DeviceError: ${String(e)}`),
  );
const messageOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => '',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Rig {
  sim: TaurusSimulatorHandle;
  svc: DeviceService;
  /** The Taurus found by discover(). */
  controller: DiscoveredController;
  id: string;
}

async function startSim(opts: TaurusSimulatorOptions = {}): Promise<TaurusSimulatorHandle> {
  const sim = await startTaurusSimulator(taurusLib, { port: 0, discoveryPort: 0, password: PASSWORD, ...opts });
  cleanups.push(() => sim.close());
  return sim;
}

function makeService(sim: TaurusSimulatorHandle, extra: Parameters<typeof createDeviceService>[0] = {}): DeviceService {
  const svc = createDeviceService({
    serialDiscovery: false,
    hseriesDiscovery: false,
    netHosts: ['127.0.0.1'],
    taurusDiscovery: true,
    taurusDiscoveryPort: sim.discoveryPort,
    timeoutMs: 600,
    ...extra,
  });
  cleanups.push(() => svc.dispose());
  return svc;
}

/** Simulator + service, with the player already discovered. */
async function rig(opts: TaurusSimulatorOptions = {}): Promise<Rig> {
  const sim = await startSim(opts);
  const svc = makeService(sim);
  const found = await svc.discover();
  const controller = found.find((c) => c.transport === 'taurus');
  if (!controller) throw new Error('simulator not discovered');
  return { sim, svc, controller, id: controller.id };
}

async function connected(opts: TaurusSimulatorOptions = {}, advanced = false): Promise<Rig & { info: ControllerInfo }> {
  const r = await rig(opts);
  await r.svc.setTaurusCredentials(r.id, { password: PASSWORD });
  const info = await r.svc.connect(r.id);
  if (advanced) expect(await r.svc.login('admin')).toBe(true);
  return { ...r, info };
}

describe('Taurus discovery', () => {
  it('finds a player on a probed host, with the data the library decodes', async () => {
    const { sim, svc, controller } = await rig();
    expect(controller).toMatchObject({
      id: 'taurus:127.0.0.1',
      transport: 'taurus',
      address: '127.0.0.1',
      port: sim.port,
    });
    expect(controller.label).toContain('TB60');
    expect(controller.label).toContain(sim.state.sn);
    const info = await svc.getTaurusInfo(controller.id);
    expect(info).toMatchObject({
      sn: sim.state.sn,
      productName: 'TB60',
      modelId: sim.state.modelId,
      tcpPort: sim.port,
      privacy: false,
      address: '127.0.0.1',
    });
    expect(info).not.toHaveProperty('key');
  });

  it('a host that does not answer, or does not resolve, never fails the scan', async () => {
    const sim = await startSim();
    const svc = makeService(sim, { netHosts: ['127.0.0.1', 'no-such-host.invalid', '   '], timeoutMs: 400 });
    const found = await svc.discover();
    expect(found.filter((c) => c.transport === 'taurus').map((c) => c.id)).toEqual(['taurus:127.0.0.1']);
    const targets = svc.lastDiscoveryErrors.map((e) => e.target);
    expect(targets).toContain('taurus:no-such-host.invalid');
    expect(targets).not.toContain('taurus:127.0.0.1');
  });

  it('a silent player is a TIMEOUT for that host only', async () => {
    const sim = await startSim();
    sim.state.mute = true;
    const svc = makeService(sim, { timeoutMs: 150 });
    const found = await svc.discover();
    expect(found.filter((c) => c.transport === 'taurus')).toEqual([]);
    expect(svc.lastDiscoveryErrors.find((e) => e.target === 'taurus:127.0.0.1')?.message).toMatch(/no Taurus answered/);
    expect(await codeOf(probeTaurusHost('127.0.0.1', sim.discoveryPort!, 100))).toBe('TIMEOUT');
  });

  it('is opt-in: without taurusDiscovery no probe is sent, so MCTRL-only scans stay as fast as before', async () => {
    const sim = await startSim();
    const svc = makeService(sim, { taurusDiscovery: false });
    expect((await svc.discover()).filter((c) => c.transport === 'taurus')).toEqual([]);
    expect(svc.lastDiscoveryErrors.map((e) => e.target)).not.toContain('taurus:127.0.0.1');
  });

  it('broadcast discovery results are merged; a failing broadcast is only recorded', async () => {
    const sim = await startSim();
    const player = await probeTaurusHost('127.0.0.1', sim.discoveryPort!, 500);
    const ok = makeService(sim, { netHosts: [], taurusUdpDiscovery: true, findTaurusPlayers: async () => [player] });
    expect((await ok.discover()).map((c) => c.id)).toEqual(['taurus:127.0.0.1']);
    const bad = makeService(sim, {
      netHosts: [],
      taurusUdpDiscovery: true,
      findTaurusPlayers: async () => {
        throw new Error('no interface');
      },
    });
    expect(await bad.discover()).toEqual([]);
    expect(bad.lastDiscoveryErrors).toEqual([{ target: 'taurus-udp', message: 'no interface' }]);
  });

  const hasInterface = Object.values(networkInterfaces()).some((l) => l?.some((i) => i.family === 'IPv4' && !i.internal));
  it.skipIf(!hasInterface)('the unmodified library discoverTaurusPlayers() reaches the simulator on UDP 16601', async () => {
    let sim: TaurusSimulatorHandle;
    try {
      sim = await startSim({ discoveryPort: 16601 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return; // port taken on this machine
      throw err;
    }
    const players = await taurusLib.discoverTaurusPlayers('127.0.0.1', 600);
    expect(players.map((p) => p.sn)).toEqual([sim.state.sn]);
    expect(players[0]).toMatchObject({ productName: 'TB60', tcpPort: sim.port });
  });
});

describe('Taurus connect and passwords', () => {
  it('needs a password: connecting without one is PERMISSION and opens nothing', async () => {
    const { sim, svc, id } = await rig();
    expect(await codeOf(svc.connect(id))).toBe('PERMISSION');
    expect(sim.state.received).toEqual([]);
    expect(sim.state.logins).toEqual({ accepted: 0, rejected: 0 });
  });

  it('a wrong password is PERMISSION, leaves no session, and is not echoed', async () => {
    const { sim, svc, id } = await rig();
    await svc.setTaurusCredentials(id, { password: 'wrong-password-xyz' });
    const msg = await messageOf(svc.connect(id));
    expect(msg).toMatch(/rejected the login/);
    expect(msg).not.toContain('wrong-password-xyz');
    expect(sim.state.logins).toEqual({ accepted: 0, rejected: 1 });
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
  });

  it('a login refused with an error status is also PERMISSION', async () => {
    const { svc, id } = await rig({ rejectLoginWithStatus: true });
    await svc.setTaurusCredentials(id, { password: 'nope' });
    expect(await codeOf(svc.connect(id))).toBe('PERMISSION');
  });

  it('a wrong username is rejected; the right one connects', async () => {
    const { svc, id } = await rig({ username: 'ops' });
    await svc.setTaurusCredentials(id, { password: PASSWORD }); // library default username: "admin"
    expect(await codeOf(svc.connect(id))).toBe('PERMISSION');
    await svc.setTaurusCredentials(id, { username: 'ops', password: PASSWORD });
    expect((await svc.connect(id)).family).toBe('taurus');
  });

  it('the right password connects and describes the player and its receiving cards', async () => {
    const { sim, info, svc, id } = await connected();
    expect(sim.state.logins).toEqual({ accepted: 1, rejected: 0 });
    expect(info).toMatchObject({
      id,
      family: 'taurus',
      model: 'TB60',
      firmwareVersion: 'unknown',
      outputPorts: 1,
    });
    expect(info.receivingCards).toEqual([
      { portIndex: 0, cardIndex: 0, model: 'Unknown (0x1A01)', firmwareVersion: 'FPGA 1.2.3.4 / MCU 2.0.1.0' },
      { portIndex: 0, cardIndex: 1, model: 'Unknown (0x1A01)', firmwareVersion: 'FPGA 1.2.3.4 / MCU 2.0.1.0' },
    ]);
    await svc.disconnect(id);
  });

  it('credentials are single use: after disconnect a new connect needs them again', async () => {
    const { sim, svc, id } = await connected();
    await svc.disconnect(id);
    expect(await codeOf(svc.connect(id))).toBe('PERMISSION');
    await svc.setTaurusCredentials(id, { password: PASSWORD });
    await svc.connect(id);
    expect(sim.state.logins.accepted).toBe(2);
  });

  it('a card list that cannot be read does not fail the connect', async () => {
    const sim = await startSim();
    sim.state.failFor.add('27:1:5'); // LED screen configuration
    const svc = makeService(sim);
    const [c] = await svc.discover();
    await svc.setTaurusCredentials(c!.id, { password: PASSWORD });
    const info = await svc.connect(c!.id);
    expect(info.receivingCards).toEqual([]);
    expect(info.outputPorts).toBe(0);
  });

  it('validates credentials and ids', async () => {
    const { svc, id } = await rig();
    expect(await codeOf(svc.setTaurusCredentials(id, { password: '' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setTaurusCredentials(id, {} as never))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setTaurusCredentials(id, { username: 5 as never, password: 'x' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.setTaurusCredentials('taurus:10.9.9.9', { password: 'x' }))).toBe('NOT_FOUND');
    expect(await codeOf(svc.connect('taurus:10.9.9.9'))).toBe('NOT_FOUND');
    expect(await codeOf(svc.setTaurusCredentials('net:1.2.3.4:5200', { password: 'x' }))).toBe('INVALID_ARGUMENT');
  });

  it('a mute player gives TIMEOUT at login and leaves nothing connected', async () => {
    const sim = await startSim();
    const svc = makeService(sim, { timeoutMs: 150 });
    const [c] = await svc.discover();
    sim.state.mute = true;
    await svc.setTaurusCredentials(c!.id, { password: PASSWORD });
    const t0 = Date.now();
    expect(await codeOf(svc.connect(c!.id))).toBe('TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await codeOf(svc.getBrightness(c!.id))).toBe('NOT_CONNECTED');
  });

  it('a dead host (nothing listening on the management port) is a PROTOCOL error, not a hang', async () => {
    const sim = await startSim();
    const svc = makeService(sim);
    const [c] = await svc.discover();
    await sim.close(); // discovery answered earlier; now the TCP port is closed
    await svc.setTaurusCredentials(c!.id, { password: PASSWORD });
    const t0 = Date.now();
    expect(await codeOf(svc.connect(c!.id))).toBe('PROTOCOL');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('losing the connection mid-session reports NOT_CONNECTED; a silent player reports TIMEOUT but stays usable', async () => {
    const { sim, svc, id } = await connected();
    sim.state.mute = true;
    expect(await codeOf(svc.getBrightness(id))).toBe('TIMEOUT');
    sim.state.mute = false;
    expect((await svc.getBrightness(id)).percent).toBe(60);
    await sim.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
  });

  it('requests before login are refused by the simulator (library client, no back end)', async () => {
    const sim = await startSim();
    const client = await taurusLib.TaurusClient.connect({ host: '127.0.0.1', port: sim.port, privacy: false, timeout: 500 });
    try {
      const err = await client.getBrightness().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(taurusLib.TaurusResponseError);
      expect((err as taurusLib.TaurusResponseError).status).toBe(STATUS_NOT_LOGGED_IN);
    } finally {
      client.close();
    }
  });
});

describe('Taurus brightness', () => {
  it('reads the percentage and reports full RGB gain', async () => {
    const { svc, id } = await connected();
    expect(await svc.getBrightness(id)).toEqual({ percent: 60, red: 100, green: 100, blue: 100 });
  });

  it('writing needs the advanced level and sends nothing without it', async () => {
    const { sim, svc, id } = await connected();
    const before = sim.state.received.length;
    expect(await codeOf(svc.setBrightness(id, { percent: 20 }))).toBe('PERMISSION');
    expect(await codeOf(svc.saveTaurusBrightness(id))).toBe('PERMISSION');
    expect(await codeOf(svc.setTaurusSyncMode(id, 'synchronous'))).toBe('PERMISSION');
    expect(sim.state.received.length).toBe(before);
    expect(sim.state.ratio).toBe(60);
  });

  it('round trip: percent goes out as ratio, volatile, and reads back', async () => {
    const { sim, svc, id } = await connected({}, true);
    expect(await svc.setBrightness(id, { percent: 35.4 })).toEqual({ percent: 35, red: 100, green: 100, blue: 100 });
    expect(sim.state.ratio).toBe(35);
    expect(sim.state.persistedRatio).toBeUndefined();
    const write = sim.state.received.filter((r) => r.what === 24 && r.action === 4);
    expect(write).toEqual([{ what: 24, type: 1, action: 4, body: { ratio: 35, solidity: false, orderId: -1 } }]);
    expect((await svc.getBrightness(id)).percent).toBe(35);
    await svc.setBrightness(id, { percent: 0 });
    expect((await svc.getBrightness(id)).percent).toBe(0);
    await svc.setBrightness(id, { percent: 100 });
    expect((await svc.getBrightness(id)).percent).toBe(100);
  });

  it('saveTaurusBrightness writes the current value with the persist flag', async () => {
    const { sim, svc, id } = await connected({}, true);
    await svc.setBrightness(id, { percent: 42 });
    expect(await svc.saveTaurusBrightness(id)).toMatchObject({ percent: 42 });
    expect(sim.state.persistedRatio).toBe(42);
    expect(sim.state.received.filter((r) => r.what === 24 && r.action === 4).at(-1)?.body).toEqual({
      ratio: 42,
      solidity: true,
      orderId: -1,
    });
  });

  it('rejects out-of-range and unsupported values before any I/O', async () => {
    const { sim, svc, id } = await connected({}, true);
    const before = sim.state.received.length;
    for (const bad of [{ percent: 101 }, { percent: -1 }, { percent: NaN }, { percent: '5' as never }]) {
      expect(await codeOf(svc.setBrightness(id, bad))).toBe('INVALID_ARGUMENT');
    }
    expect(await codeOf(svc.setBrightness(id, null as never))).toBe('INVALID_ARGUMENT');
    expect(await messageOf(svc.setBrightness(id, { red: 50 }))).toMatch(/not supported on Taurus: red gain/);
    expect(sim.state.received.length).toBe(before);
    // 100 means "no gain change" and is accepted, so the existing Brightness page can send all channels
    await svc.setBrightness(id, { percent: 10, red: 100, green: 100, blue: 100 });
    expect(sim.state.ratio).toBe(10);
  });

  it('falls back to the `brightness` field when the player sends no `ratio`, and fails when it sends neither', async () => {
    const { sim, svc, id } = await connected({}, true);
    sim.state.brightnessFields = ['brightness'];
    expect((await svc.getBrightness(id)).percent).toBe(60);
    sim.state.brightnessFields = [];
    expect(await codeOf(svc.getBrightness(id))).toBe('PROTOCOL');
  });

  it('a refused request surfaces as PROTOCOL with the status, not as a hang', async () => {
    const { sim, svc, id } = await connected({}, true);
    sim.state.failFor.add('24:1:4');
    expect(await messageOf(svc.setBrightness(id, { percent: 5 }))).toMatch(/refused the request \(status 0x102\)/);
  });

  it('needs a connection', async () => {
    const { svc, id } = await rig();
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
    expect(await codeOf(svc.setBrightness(id, { percent: 5 }))).toBe('NOT_CONNECTED');
  });
});

describe('Taurus unsupported and wrongly routed operations', () => {
  it('test patterns and display modes are INVALID_ARGUMENT (the library has no such commands)', async () => {
    const { sim, svc, id } = await connected({}, true);
    const before = sim.state.received.length;
    expect(await messageOf(svc.setTestPattern(id, 'red'))).toMatch(/^not supported on Taurus: test patterns/);
    expect(await codeOf(svc.setTestPattern(id, 'red'))).toBe('INVALID_ARGUMENT');
    expect(await messageOf(svc.setDisplayMode(id, 'blackout'))).toMatch(/^not supported on Taurus: blackout/);
    expect(await codeOf(svc.setDisplayMode(id, 'freeze'))).toBe('INVALID_ARGUMENT');
    expect(sim.state.received.length).toBe(before);
    expect(await codeOf(svc.setTestPattern('taurus:10.9.9.9', 'red'))).toBe('NOT_FOUND');
  });

  it('every MCTRL-only and H-series-only method rejects a Taurus id with INVALID_ARGUMENT', async () => {
    const { svc, id } = await connected({}, true);
    const names = [
      ...Object.keys(SENDER_METHODS),
      ...Object.keys(RECEIVER_METHODS),
      ...Object.keys(LAYOUT_METHODS),
      ...Object.keys(PERSIST_METHODS),
      ...Object.keys(MONITOR_METHODS),
      ...Object.keys(HSERIES_METHODS),
    ];
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const fn = (svc as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
      expect([name, await codeOf(fn.call(svc, id))]).toEqual([name, 'INVALID_ARGUMENT']);
    }
  });

  it('every Taurus-only method rejects a non-Taurus id with INVALID_ARGUMENT', async () => {
    const svc = createDeviceService({ serialDiscovery: false, hseriesDiscovery: false });
    for (const name of Object.keys(TAURUS_METHODS)) {
      const fn = (svc as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
      for (const other of ['net:127.0.0.1:5200', 'hseries:127.0.0.1:6000', 'serial:COM1']) {
        expect([name, other, await codeOf(fn.call(svc, other, { password: 'x' }))]).toEqual([name, other, 'INVALID_ARGUMENT']);
      }
    }
    await svc.dispose();
  });
});

describe('Taurus reads and sync mode', () => {
  it('sync mode: reads the video configuration, switches both ways, and needs the advanced level', async () => {
    const { sim, svc, id } = await connected({}, true);
    expect(await svc.getTaurusSyncMode(id)).toEqual({
      mode: 'asynchronous',
      videoMode: 'manual',
      videoSource: 'internal',
      fallbackToInternal: false,
      scaling: false,
      offset: { x: 0, y: 0 },
    });
    await svc.setTaurusSyncMode(id, 'synchronous');
    expect(sim.state.video).toMatchObject({ videoMode: 1, videoSource: 1 });
    expect(await svc.getTaurusSyncMode(id)).toMatchObject({ mode: 'synchronous', videoSource: 'hdmi', fallbackToInternal: false });
    await svc.setTaurusSyncMode(id, 'synchronous', { fallbackToInternal: true });
    expect(sim.state.video).toMatchObject({ videoMode: 0, videoSource: 1 });
    expect(await svc.getTaurusSyncMode(id)).toMatchObject({ mode: 'synchronous', videoMode: 'hdmi-preferred', fallbackToInternal: true });
    await svc.setTaurusSyncMode(id, 'asynchronous');
    expect(sim.state.video).toMatchObject({ videoMode: 1, videoSource: 0 });
    sim.state.video.videoMode = 2;
    expect((await svc.getTaurusSyncMode(id)).mode).toBe('other');
    expect(await codeOf(svc.setTaurusSyncMode(id, 'sideways' as never))).toBe('INVALID_ARGUMENT');
  });

  it('keeps the other video settings when switching mode (library read-modify-write)', async () => {
    const { sim, svc, id } = await connected({}, true);
    sim.state.video = { enable: true, isScale: true, offsetX: 4, offsetY: -2, videoMode: 1, videoSource: 0 };
    await svc.setTaurusSyncMode(id, 'synchronous');
    expect(sim.state.video).toEqual({ enable: true, isScale: true, offsetX: 4, offsetY: -2, videoMode: 1, videoSource: 1 });
  });

  it('video sources: list, active source and HDMI input resolution', async () => {
    const { svc, id } = await connected();
    const v = await svc.getTaurusVideoSources(id);
    expect(v.current).toBe('internal');
    expect(v.active).toBe('internal');
    expect(v.hdmiInput).toEqual({ width: 1920, height: 1080, frameRate: 60 });
    expect(v.sources.map((s) => [s.name, s.internal, s.connected])).toEqual([
      ['Internal', true, true],
      ['HDMI', false, true],
    ]);
    expect(v.sources[1]!.supportedResolutions[0]).toEqual({ width: 1920, height: 1080, frameRates: [30, 50, 60] });
  });

  it('video sources survive a player that cannot answer the extras', async () => {
    const { sim, svc, id } = await connected();
    sim.state.failFor.add('39:2:5').add('39:5:5');
    const v = await svc.getTaurusVideoSources(id);
    expect(v.active).toBeUndefined();
    expect(v.hdmiInput).toBeUndefined();
    expect(v.sources).toHaveLength(2);
  });

  it('light sensor: a value, or "not available" when the player reports -1000', async () => {
    const { sim, svc, id } = await connected();
    expect(await svc.getTaurusLightSensor(id)).toEqual({ available: true, value: 320 });
    sim.state.lightSensor = null;
    expect(await svc.getTaurusLightSensor(id)).toEqual({ available: false });
    sim.state.failFor.add('26:0:5');
    expect(await codeOf(svc.getTaurusLightSensor(id))).toBe('PROTOCOL');
  });

  it('screen configuration summary', async () => {
    const { svc, id } = await connected();
    expect(await svc.readTaurusScreenConfig(id)).toEqual({
      screens: [{ id: 0, columns: 2, rows: 1, offset: { x: 0, y: 0 }, width: 256, height: 128, portNumber: 1, receivingCards: 2 }],
    });
  });

  it('reads need a connection but not the advanced level', async () => {
    const { svc, id } = await rig();
    for (const call of [
      () => svc.getTaurusSyncMode(id),
      () => svc.getTaurusVideoSources(id),
      () => svc.getTaurusLightSensor(id),
      () => svc.readTaurusScreenConfig(id),
    ]) {
      expect(await codeOf(call())).toBe('NOT_CONNECTED');
    }
    expect((await svc.getTaurusInfo(id)).productName).toBe('TB60'); // discovery data needs no connection
  });
});

describe('Taurus privacy mode (TLS)', () => {
  let pem: { key: string; cert: string } | undefined;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'taurus-tls-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=taurus-sim', '-days', '1'],
      { stdio: 'ignore' },
    );
    pem = { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
    rmSync(dir, { recursive: true, force: true });
  } catch {
    pem = undefined; // no openssl: the TLS test is skipped, plain TCP is covered above
  }

  it.skipIf(pem === undefined)('discovery says privacy:true and the back end logs in over TLS (self-signed certificate)', async () => {
    const { svc, id, sim } = await rig({ tls: pem! });
    expect((await svc.getTaurusInfo(id)).privacy).toBe(true);
    await svc.setTaurusCredentials(id, { password: PASSWORD });
    expect((await svc.connect(id)).family).toBe('taurus');
    expect((await svc.getBrightness(id)).percent).toBe(60);
    expect(sim.state.logins.accepted).toBe(1);
  });
});
