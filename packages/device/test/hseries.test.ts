import { createSocket, type Socket } from 'node:dgram';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeviceError, type TestPattern } from '@rockzalct/shared';
import {
  startHSeriesSimulator,
  startSimulator,
  type HSeriesSimulatorHandle,
  type SimulatorHandle,
} from '@rockzalct/simulator';
import {
  HSERIES_PATTERN_IDS,
  HSeriesClient,
  MAX_RETRIES,
  createDeviceService,
  createNetSessionFactory,
  decodeReply,
  encodeRequest,
  type DeviceService,
} from '../src/index.js';
import { reqInitStatus, reqScreenList } from '../src/hseries/protocol.js';

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

/** A UDP socket that records datagrams and answers through `reply`. */
async function rawServer(reply: (msg: Buffer, send: (b: Buffer | string) => void) => void) {
  const socket: Socket = createSocket('udp4');
  const received: Buffer[] = [];
  socket.on('message', (msg, rinfo) => {
    received.push(msg);
    reply(msg, (b) => socket.send(b, rinfo.port, rinfo.address));
  });
  await new Promise<void>((res) => socket.bind(0, '127.0.0.1', res));
  return {
    port: socket.address().port,
    received,
    close: () => new Promise<void>((res) => socket.close(() => res())),
  };
}

describe('H series codec', () => {
  it('encodes the documented datagram shapes', () => {
    // R0118 carries param0 and no deviceId (reference main.js:1084); others carry deviceId 0 (index.js:12).
    expect(JSON.parse(encodeRequest(reqInitStatus()).toString())).toEqual([{ cmd: 'R0118', param0: 0 }]);
    expect(JSON.parse(encodeRequest(reqScreenList()).toString())).toEqual([{ cmd: 'R0400', deviceId: 0 }]);
  });

  it('decodes replies and rejects anything that is not a JSON array with a cmd', () => {
    expect(decodeReply('[{"cmd":"R0118","ack":"Ok","rate":100}]')).toEqual({ cmd: 'R0118', ack: 'Ok', data: { rate: 100 } });
    for (const bad of ['', 'nope', '{"cmd":"R0118"}', '[]', '[1]', '[{"ack":"Ok"}]', '[{"cmd":5}]']) {
      expect(decodeReply(bad)).toBeUndefined();
    }
  });
});

describe('HSeriesClient over real UDP', () => {
  it('retries a silent device up to the cap, then reports TIMEOUT', async () => {
    const silent = await rawServer(() => {});
    const client = new HSeriesClient({ host: '127.0.0.1', port: silent.port, timeoutMs: 40, retries: 2 });
    try {
      expect(await codeOf(client.request(reqInitStatus()))).toBe('TIMEOUT');
      expect(silent.received).toHaveLength(3); // 1 + 2 retries
      silent.received.length = 0;
      expect(await codeOf(client.request(reqInitStatus(), { retries: 99, timeoutMs: 20 }))).toBe('TIMEOUT');
      expect(silent.received).toHaveLength(1 + MAX_RETRIES); // capped
    } finally {
      client.close();
      await silent.close();
    }
  });

  it('fails requests queued behind a timed-out one immediately, but tries later ones normally', async () => {
    let answer = false;
    const dev = await rawServer((_m, send) => {
      if (answer) send('[{"cmd":"R0118","ack":"Ok","rate":100}]');
    });
    const client = new HSeriesClient({ host: '127.0.0.1', port: dev.port, timeoutMs: 60, retries: 0 });
    try {
      const t0 = Date.now();
      const codes = await Promise.all([1, 2, 3, 4].map(() => codeOf(client.request(reqInitStatus()))));
      expect(codes).toEqual(['TIMEOUT', 'TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
      expect(dev.received).toHaveLength(1); // only the first one touched the network
      expect(Date.now() - t0).toBeLessThan(200);
      answer = true; // a request made afterwards is a fresh attempt
      expect((await client.request(reqInitStatus())).data).toEqual({ rate: 100 });
    } finally {
      client.close();
      await dev.close();
    }
  });

  it('succeeds on a retry when only the first datagram is lost', async () => {
    let n = 0;
    const flaky = await rawServer((_msg, send) => {
      n += 1;
      if (n >= 2) send('[{"cmd":"R0118","ack":"Ok","rate":100}]');
    });
    const client = new HSeriesClient({ host: '127.0.0.1', port: flaky.port, timeoutMs: 60, retries: 2 });
    try {
      expect((await client.request(reqInitStatus())).data).toEqual({ rate: 100 });
      expect(flaky.received).toHaveLength(2);
    } finally {
      client.close();
      await flaky.close();
    }
  });

  it('ignores replies for other commands and matches by cmd', async () => {
    const dev = await rawServer((_m, send) => {
      send('[{"cmd":"R0400","ack":"Ok","screens":[]}]'); // stray, different command
      send('[{"cmd":"R0118","ack":"Ok","rate":100}]');
    });
    const client = new HSeriesClient({ host: '127.0.0.1', port: dev.port, timeoutMs: 200, retries: 0 });
    try {
      expect((await client.request(reqInitStatus())).cmd).toBe('R0118');
    } finally {
      client.close();
      await dev.close();
    }
  });

  it('maps ack other than Ok to PROTOCOL and names the ack', async () => {
    const dev = await rawServer((_m, send) => send('[{"cmd":"R0118","ack":"Busy"}]'));
    const client = new HSeriesClient({ host: '127.0.0.1', port: dev.port, timeoutMs: 200, retries: 0 });
    try {
      const p = client.request(reqInitStatus());
      expect(await codeOf(p)).toBe('PROTOCOL');
      expect(await messageOf(client.request(reqInitStatus()))).toContain('Busy');
    } finally {
      client.close();
      await dev.close();
    }
  });

  it('reports malformed replies as PROTOCOL instead of TIMEOUT, and a missing ack as PROTOCOL', async () => {
    const garbage = await rawServer((_m, send) => send('definitely { not json'));
    const noAck = await rawServer((_m, send) => send('[{"cmd":"R0118","rate":100}]'));
    const a = new HSeriesClient({ host: '127.0.0.1', port: garbage.port, timeoutMs: 40, retries: 1 });
    const b = new HSeriesClient({ host: '127.0.0.1', port: noAck.port, timeoutMs: 40, retries: 0 });
    try {
      expect(await messageOf(a.request(reqInitStatus()))).toMatch(/malformed/);
      expect(await codeOf(b.request(reqInitStatus()))).toBe('PROTOCOL');
    } finally {
      a.close();
      b.close();
      await garbage.close();
      await noAck.close();
    }
  });

  it('fails fast when nothing listens on the port, and after close()', async () => {
    const probe = await rawServer(() => {});
    const port = probe.port;
    await probe.close(); // the port is now closed
    const client = new HSeriesClient({ host: '127.0.0.1', port, timeoutMs: 1000, retries: 2 });
    const t0 = Date.now();
    expect(await codeOf(client.request(reqInitStatus()))).toBe('PROTOCOL');
    expect(Date.now() - t0).toBeLessThan(900);
    client.close();
    expect(await codeOf(client.request(reqInitStatus()))).toBe('NOT_CONNECTED');
  });

  it('serialises concurrent requests', async () => {
    const sim = await startHSeriesSimulator();
    const client = new HSeriesClient({ host: '127.0.0.1', port: sim.port, timeoutMs: 500 });
    try {
      const replies = await Promise.all([
        client.request(reqInitStatus()),
        client.request(reqScreenList()),
        client.request(reqInitStatus()),
      ]);
      expect(replies.map((r) => r.cmd)).toEqual(['R0118', 'R0400', 'R0118']);
    } finally {
      client.close();
      await sim.close();
    }
  });
});

describe('H series through the device service', () => {
  let hsim: HSeriesSimulatorHandle;
  let mctrl: SimulatorHandle;
  let svc: DeviceService;
  let id: string;

  beforeAll(async () => {
    mctrl = await startSimulator({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await mctrl.close();
  });

  beforeEach(async () => {
    hsim = await startHSeriesSimulator({ screens: 2 });
    svc = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: mctrl.port }),
      netPort: mctrl.port,
      hseriesPort: hsim.port,
      hseriesRetries: 1,
      hseriesHandshakePollMs: 20,
      serialDiscovery: false,
      timeoutMs: 300,
    });
    const found = await svc.discover({ netHosts: ['127.0.0.1'] });
    id = found.find((c) => c.transport === 'hseries')!.id;
    hsim.state.received.length = 0; // forget the discovery probe
  });
  afterEach(async () => {
    await svc.dispose();
    await hsim.close();
  });

  const loginAndConnect = async () => {
    await svc.login('admin');
    return svc.connect(id);
  };
  const cmds = () => hsim.state.received.map((r) => r.cmd);

  it('discover finds both families side by side, with the id contract, and tolerates a dead host', async () => {
    const found = await svc.discover({ netHosts: ['127.0.0.1', '127.0.0.1:1', 'not a host:::'] });
    expect(found.map((c) => c.id).sort()).toEqual([`hseries:127.0.0.1:${hsim.port}`, `net:127.0.0.1:${mctrl.port}`]);
    const h = found.find((c) => c.transport === 'hseries')!;
    expect(h).toEqual({
      id: `hseries:127.0.0.1:${hsim.port}`,
      transport: 'hseries',
      address: '127.0.0.1',
      port: hsim.port,
      label: `127.0.0.1:${hsim.port} (H series)`,
    });
    const targets = svc.lastDiscoveryErrors.map((e) => e.target);
    expect(targets).toContain('hseries:127.0.0.1:1'); // dead host: recorded, not fatal
    expect(targets).toContain('not a host:::');
  });

  it('discover with only a dead H host returns nothing and does not throw', async () => {
    const only = createDeviceService({
      sessionFactory: createNetSessionFactory(),
      hseriesPort: 1,
      serialDiscovery: false,
      timeoutMs: 300,
    });
    expect(await only.discover({ netHosts: ['127.0.0.1:1'] })).toEqual([]);
    await only.dispose();
  });

  it('discover can be limited to MCTRL with hseriesDiscovery: false', async () => {
    const mc = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: mctrl.port }),
      netPort: mctrl.port,
      hseriesPort: hsim.port,
      hseriesDiscovery: false,
      serialDiscovery: false,
    });
    expect((await mc.discover({ netHosts: ['127.0.0.1'] })).map((c) => c.transport)).toEqual(['net']);
    await mc.dispose();
  });

  it('connect performs the handshake and reads device info', async () => {
    const info = await loginAndConnect();
    expect(info).toEqual({
      id,
      family: 'hseries',
      model: 'H series',
      firmwareVersion: 'unknown',
      outputPorts: 4, // connectors on the sender slot of R0100, not the fake grid of R0300
      receivingCards: [],
    });
    expect(cmds().slice(0, 2)).toEqual(['R0118', 'R0100']);
  });

  it('connect waits while the device is still initialising (rate < 100)', async () => {
    hsim.state.initPolls = 3;
    await svc.connect(id);
    expect(cmds().filter((c) => c === 'R0118')).toHaveLength(4);
  });

  it('connect gives up with PROTOCOL if the device never finishes initialising', async () => {
    const slow = createDeviceService({
      sessionFactory: createNetSessionFactory(),
      hseriesPort: hsim.port,
      hseriesHandshakeTimeoutMs: 100,
      hseriesHandshakePollMs: 20,
      serialDiscovery: false,
    });
    const [h] = await slow.discover({ netHosts: ['127.0.0.1'] });
    hsim.state.initPolls = 1000;
    expect(await codeOf(slow.connect(h!.id))).toBe('PROTOCOL');
    await slow.dispose();
  });

  it('connect fails with TIMEOUT when the device goes silent', async () => {
    hsim.state.mute = true;
    expect(await codeOf(svc.connect(id))).toBe('TIMEOUT');
  });

  it('brightness round trip: percent goes to the wire unscaled on every screen; RGB reads 100', async () => {
    await loginAndConnect();
    expect(await svc.getBrightness(id)).toEqual({ percent: 80, red: 100, green: 100, blue: 100 });
    const set = await svc.setBrightness(id, { percent: 35 });
    expect(set).toEqual({ percent: 35, red: 100, green: 100, blue: 100 });
    expect(hsim.state.screens.map((s) => s.brightness)).toEqual([35, 35]);
    const w = hsim.state.received.filter((r) => r.cmd === 'W0410');
    expect(w.map((r) => r.body['brightness'])).toEqual([35, 35]);
    expect(await svc.getBrightness(id)).toMatchObject({ percent: 35 });
    // The UI sends all four channels; 100 is the only gain the protocol can express.
    expect(await svc.setBrightness(id, { percent: 50, red: 100, green: 100, blue: 100 })).toMatchObject({ percent: 50 });
  });

  it('brightness validation: out of range, non-numbers and RGB gains are INVALID_ARGUMENT', async () => {
    await loginAndConnect();
    for (const bad of [{ percent: 101 }, { percent: -1 }, { percent: Number.NaN }, { percent: '5' as unknown as number }]) {
      expect(await codeOf(svc.setBrightness(id, bad))).toBe('INVALID_ARGUMENT');
    }
    expect(await messageOf(svc.setBrightness(id, { red: 50 }))).toMatch(/not supported on H series/);
    expect(await codeOf(svc.setBrightness(id, null as unknown as object))).toBe('INVALID_ARGUMENT');
    expect(cmds()).not.toContain('W0410');
  });

  it('writes need the advanced level (PERMISSION) and send nothing before login', async () => {
    await svc.connect(id);
    const before = hsim.state.received.length;
    expect(await codeOf(svc.setTestPattern(id, 'red'))).toBe('PERMISSION');
    expect(await codeOf(svc.setDisplayMode(id, 'blackout'))).toBe('PERMISSION');
    expect(await codeOf(svc.playPreset(id, 0, 1))).toBe('PERMISSION');
    expect(await codeOf(svc.setLayerInput(id, 0, 0, 1))).toBe('PERMISSION');
    expect(await codeOf(svc.fadeToBlack(id, 0, true))).toBe('PERMISSION');
    expect(await codeOf(svc.saveScreenBrightness(id, 0))).toBe('PERMISSION');
    expect(hsim.state.received).toHaveLength(before);
    // reads are allowed at the normal level
    expect(await svc.listScreens(id)).toHaveLength(2);
    // volatile brightness is allowed at the normal level too, like MCTRL
    expect((await svc.setBrightness(id, { percent: 10 })).percent).toBe(10);
  });

  it('every TestPattern maps to a W0303 id and reaches the real sender connectors only', async () => {
    await loginAndConnect();
    const expected: Record<TestPattern, number> = {
      off: 0xffff,
      red: 1,
      green: 2,
      blue: 3,
      white: 4,
      'horizontal-lines': 0x0200,
      'vertical-lines': 0x0201,
      slash: 0x0203,
      grayscale: 0x0103,
    };
    expect(HSERIES_PATTERN_IDS).toEqual(expected);
    for (const [pattern, wire] of Object.entries(expected)) {
      await svc.setTestPattern(id, pattern as TestPattern);
      const patterns = hsim.state.outputs.map((o) => o.testPattern.testPattern);
      // sender connectors 0..3 are real; 4..7 are the fake grid slots; 8..11 are on a non-sender card
      expect(patterns.slice(0, 4)).toEqual([wire, wire, wire, wire]);
      expect(patterns.slice(4)).toEqual(new Array(8).fill(0xffff));
    }
    const last = hsim.state.received.filter((r) => r.cmd === 'W0303').at(-1)!;
    expect(last.body).toMatchObject({ testPattern: 0x0103, bright: 3, grid: 5, speed: 3 });
  });

  it('an unsupported test pattern is INVALID_ARGUMENT "not supported on H series"', async () => {
    await loginAndConnect();
    const p = svc.setTestPattern(id, 'plaid' as unknown as TestPattern);
    expect(await messageOf(p)).toMatch(/not supported on H series: test pattern plaid/);
    expect(await codeOf(svc.setTestPattern(id, 'plaid' as unknown as TestPattern))).toBe('INVALID_ARGUMENT');
    expect(cmds()).not.toContain('W0303');
  });

  it('display modes: blackout (W0700), freeze (W040A on all screens), normal clears both', async () => {
    await loginAndConnect();
    await svc.setDisplayMode(id, 'blackout');
    expect(hsim.state.blackout).toBe(1);
    expect(hsim.state.screens.map((s) => s.freeze)).toEqual([0, 0]);

    await svc.setDisplayMode(id, 'freeze');
    expect(hsim.state.blackout).toBe(0);
    expect(hsim.state.screens.map((s) => s.freeze)).toEqual([1, 1]);
    expect((await svc.listScreens(id)).map((s) => s.frozen)).toEqual([true, true]);

    await svc.setDisplayMode(id, 'blackout');
    expect(hsim.state.blackout).toBe(1);
    expect(hsim.state.screens.map((s) => s.freeze)).toEqual([0, 0]);

    await svc.setDisplayMode(id, 'normal');
    expect(hsim.state.blackout).toBe(0);
    expect(hsim.state.screens.map((s) => s.freeze)).toEqual([0, 0]);
    expect(await codeOf(svc.setDisplayMode(id, 'sepia' as never))).toBe('INVALID_ARGUMENT');
  });

  it('lists screens with brightness / freeze / FTB read from R0401 (FTB flag is inverted)', async () => {
    await loginAndConnect();
    hsim.state.screens[1]!.ftb = 0; // device says "FTB on"
    hsim.state.screens[0]!.freeze = 1;
    expect(await svc.listScreens(id)).toEqual([
      { screenId: 0, name: 'Screen 1', brightness: 80, frozen: true, fadeToBlack: false },
      { screenId: 1, name: 'Screen 2', brightness: 80, frozen: false, fadeToBlack: true },
    ]);
  });

  it('fade to black and save brightness hit the right screen', async () => {
    await loginAndConnect();
    await svc.fadeToBlack(id, 1, true);
    expect(hsim.state.screens.map((s) => s.ftb)).toEqual([1, 0]);
    expect(hsim.state.received.filter((r) => r.cmd === 'W0409').at(-1)!.body).toMatchObject({ screenId: 1, type: 0 });
    await svc.fadeToBlack(id, 1, false);
    expect(hsim.state.screens[1]!.ftb).toBe(1);

    await svc.setBrightness(id, { percent: 42 });
    await svc.saveScreenBrightness(id, 0);
    expect(hsim.state.screens.map((s) => s.savedBrightness)).toEqual([42, undefined]);

    expect(await codeOf(svc.fadeToBlack(id, 9, true))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.fadeToBlack(id, 0, 'yes' as unknown as boolean))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.saveScreenBrightness(id, -1))).toBe('INVALID_ARGUMENT');
  });

  it('presets: list per screen / all screens, play, and reject unknown ones', async () => {
    await loginAndConnect();
    expect((await svc.listPresets(id, 0)).map((p) => p.name)).toEqual(['Opening', 'Show', 'Closing']);
    expect(await svc.listPresets(id)).toHaveLength(6);
    expect((await svc.listPresets(id)).at(-1)).toEqual({ screenId: 1, presetId: 2, name: 'Closing' });
    await svc.playPreset(id, 1, 2);
    expect(hsim.state.screens.map((s) => s.lastPresetId)).toEqual([undefined, 2]);
    expect(hsim.state.received.filter((r) => r.cmd === 'W0605').at(-1)!.body).toMatchObject({ screenId: 1, presetId: 2 });
    expect(await codeOf(svc.playPreset(id, 1, 77))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.playPreset(id, 5, 0))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.listPresets(id, 5))).toBe('INVALID_ARGUMENT');
  });

  it('layers and inputs: offline inputs are hidden, crops follow their source, W0506 switches a layer', async () => {
    await loginAndConnect();
    expect((await svc.listLayers(id, 0)).map((l) => l.name)).toEqual(['Layer 1', 'Layer 2']);
    expect(await svc.listLayers(id)).toHaveLength(4);

    const inputs = await svc.listInputs(id);
    expect(inputs.map((i) => [i.inputId, i.cropId, i.name])).toEqual([
      [0, 255, 'HDMI 1'],
      [1, 255, 'HDMI 2'],
      [2, 255, 'DVI 1'],
      [0, 0, 'HDMI 1 left half'],
    ]);
    expect(inputs[0]).toMatchObject({ slotId: 0, interfaceId: 0, interfaceType: 5, online: true });

    await svc.setLayerInput(id, 1, 0, 2);
    expect(hsim.state.screens[1]!.layers[0]).toMatchObject({ inputId: 2, cropId: 255 });
    const w = hsim.state.received.filter((r) => r.cmd === 'W0506').at(-1)!.body;
    expect(w).toMatchObject({ screenId: 1, layerId: 0, inputId: 2, cropId: 255, sourceType: 1, streamId: 0, templateId: 0, slotId: 0, interfaceType: 2 });

    await svc.setLayerInput(id, 0, 1, 0, 0); // a crop of input 0
    expect(hsim.state.screens[0]!.layers[1]).toMatchObject({ inputId: 0, cropId: 0 });

    expect(await codeOf(svc.setLayerInput(id, 0, 0, 3))).toBe('INVALID_ARGUMENT'); // offline input
    expect(await codeOf(svc.setLayerInput(id, 0, 0, 1, 7))).toBe('INVALID_ARGUMENT'); // no such crop
    expect(await codeOf(svc.setLayerInput(id, 0, 9, 1))).toBe('INVALID_ARGUMENT'); // no such layer
    expect(await codeOf(svc.setLayerInput(id, 4, 0, 1))).toBe('INVALID_ARGUMENT'); // no such screen
  });

  it('the device rejecting a command (ack Fail) surfaces as PROTOCOL', async () => {
    await loginAndConnect();
    hsim.state.failFor.add('W0410');
    const p = svc.setBrightness(id, { percent: 20 });
    expect(await messageOf(p)).toMatch(/W0410 rejected.*Fail/);
    expect(await codeOf(svc.setBrightness(id, { percent: 20 }))).toBe('PROTOCOL');
  });

  it('a garbage reply is PROTOCOL; a silent device is TIMEOUT', async () => {
    await loginAndConnect();
    hsim.state.garbageFor.add('R0400');
    expect(await codeOf(svc.getBrightness(id))).toBe('PROTOCOL');
    hsim.state.garbageFor.clear();
    hsim.state.mute = true;
    expect(await codeOf(svc.getBrightness(id))).toBe('TIMEOUT');
    hsim.state.mute = false;
    expect(await svc.getBrightness(id)).toMatchObject({ percent: 80 }); // recovers on the same client
  });

  it('id handling: NOT_FOUND, NOT_CONNECTED, and disconnect', async () => {
    expect(await codeOf(svc.connect('hseries:10.9.9.9:6000'))).toBe('NOT_FOUND');
    expect(await codeOf(svc.getBrightness(id))).toBe('NOT_CONNECTED');
    expect(await codeOf(svc.listScreens(id))).toBe('NOT_CONNECTED');
    await svc.connect(id);
    await svc.disconnect(id);
    expect(await codeOf(svc.listScreens(id))).toBe('NOT_CONNECTED');
    await svc.connect(id); // can reconnect
    expect(await svc.listScreens(id)).toHaveLength(2);
  });

  it('MCTRL-only features reject H series ids; H-only features reject MCTRL ids', async () => {
    await loginAndConnect();
    const p = svc.getSenderVideo(id);
    expect(await codeOf(p)).toBe('INVALID_ARGUMENT');
    expect(await messageOf(svc.getSenderVideo(id))).toBe('not supported on H series');
    expect(await codeOf(svc.readMonitorSnapshot(id))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(svc.getSenderPorts(id))).toBe('INVALID_ARGUMENT');

    const net = `net:127.0.0.1:${mctrl.port}`;
    expect(await codeOf(svc.listScreens(net))).toBe('INVALID_ARGUMENT');
    // and the MCTRL path is untouched
    await svc.connect(net);
    expect(await svc.getSenderVideo(net)).toHaveProperty('resolution');
  });

  it('answers unknown commands and ignores junk datagrams (simulator side)', async () => {
    const client = new HSeriesClient({ host: '127.0.0.1', port: hsim.port, timeoutMs: 200, retries: 0 });
    try {
      const msg = await messageOf(client.request({ cmd: 'R9999' as never, body: {} }));
      expect(msg).toMatch(/R9999 rejected/);
      expect(cmds()).toContain('R9999');
    } finally {
      client.close();
    }
    const raw = createSocket('udp4');
    let replies = 0;
    raw.on('message', () => (replies += 1));
    for (const junk of ['garbage', '{"cmd":"R0118"}', '[]', '[{"nocmd":1}]']) {
      await new Promise<void>((res) => raw.send(junk, hsim.port, '127.0.0.1', () => res()));
    }
    await new Promise((r) => setTimeout(r, 100));
    raw.close();
    expect(replies).toBe(0);
    expect(hsim.state.malformedRequests).toBe(4);
  });
});
