import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionClosedError, Packet, Request, ResponseError, TimeoutError } from '@novastar/codec';
import {
  DEFAULT_MONITOR_THRESHOLDS,
  DeviceError,
  MONITOR_METHODS,
  alertEventsToCsv,
  appendCapped,
  cardHealth,
  csvCell,
  diffAlerts,
  evaluateSnapshot,
  parseThresholds,
  portLinkStatus,
  readingsToCsv,
  temperatureSeries,
  toAlertEvents,
  validateThresholds,
  worstHealth,
  type MonitorAlert,
  type MonitorCardReading,
  type MonitorSnapshot,
  type MonitorThresholds,
} from '@rockzalct/shared';
import { startSimulator, type SimulatorHandle } from '@rockzalct/simulator';
import {
  createDeviceService,
  createNetSessionFactory,
  type DeviceService,
  type SessionFactory,
  type SessionLike,
} from '../src/index.js';
import {
  ALL_STATUS_LENGTH,
  ALL_STATUS_OFFSETS as O,
  MONITOR_REGISTERS as R,
  decodeAllStatus,
  decodeFuncMonitorInfo,
  decodeScanCardWord,
  type MonitorSession,
} from '../src/features/monitor.js';

const timeoutError = (): TimeoutError => new TimeoutError(new Request(1), 'test');
const responseError = (ack = 0): ResponseError => {
  const res = new Packet(Packet.baseSize);
  res.ack = ack;
  return new ResponseError(res, 'test');
};
/** What the sending card answers for a receiving card that is not on the chain (ErrorType.Timeout). */
const downstreamTimeout = (): ResponseError => responseError(1);

const expectCode = async (p: Promise<unknown>, code: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  expect((err as DeviceError).code).toBe(code);
};

// ---------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------

const card = (portIndex: number, cardIndex: number, extra: Partial<MonitorCardReading> = {}): MonitorCardReading => ({
  portIndex,
  cardIndex,
  state: 'online',
  ...extra,
});

const snap = (
  cards: MonitorCardReading[],
  takenAt = 1_000,
  sender: Partial<MonitorSnapshot['sender']> = {},
): MonitorSnapshot => ({
  controllerId: 'net:test:5200',
  takenAt,
  sender: { portLinks: [], ...sender },
  cards,
  requestCount: 0,
});

describe('monitor logic (pure)', () => {
  it('lists every MonitorApi method', () => {
    expect(Object.keys(MONITOR_METHODS)).toEqual(['readMonitorSnapshot']);
  });

  it('classifies port links from detected vs expected cards', () => {
    expect(portLinkStatus(2, 2)).toBe('up');
    expect(portLinkStatus(3, 2)).toBe('up');
    expect(portLinkStatus(1, 2)).toBe('partial');
    expect(portLinkStatus(0, 2)).toBe('down');
    expect(portLinkStatus(0, 0)).toBe('idle');
    expect(portLinkStatus(0, null)).toBe('idle');
    expect(portLinkStatus(4, null)).toBe('up');
    expect(portLinkStatus(1, 0)).toBe('up');
  });

  it('validates and parses thresholds, falling back to defaults', () => {
    expect(validateThresholds(DEFAULT_MONITOR_THRESHOLDS)).toEqual([]);
    expect(validateThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, temperatureWarnRaw: 80 })).toHaveLength(1);
    expect(validateThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, voltageLowRaw: 60, voltageHighRaw: 50 })).toHaveLength(1);
    expect(validateThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, temperatureWarnRaw: 300, temperatureCriticalRaw: null })).toHaveLength(1);
    expect(validateThresholds({ ...DEFAULT_MONITOR_THRESHOLDS, temperatureWarnRaw: 1.5 })).toHaveLength(1);

    expect(parseThresholds(null)).toEqual(DEFAULT_MONITOR_THRESHOLDS);
    expect(parseThresholds('not json')).toEqual(DEFAULT_MONITOR_THRESHOLDS);
    expect(parseThresholds('[1,2]')).toEqual(DEFAULT_MONITOR_THRESHOLDS);
    expect(parseThresholds('{"temperatureWarnRaw":"hot"}')).toEqual(DEFAULT_MONITOR_THRESHOLDS);
    expect(parseThresholds('{"temperatureWarnRaw":90,"temperatureCriticalRaw":50}')).toEqual(DEFAULT_MONITOR_THRESHOLDS);
    expect(parseThresholds('{"temperatureWarnRaw":50,"voltageLowRaw":40,"voltageHighRaw":60}')).toEqual({
      temperatureWarnRaw: 50,
      temperatureCriticalRaw: 75,
      voltageLowRaw: 40,
      voltageHighRaw: 60,
    });
    expect(parseThresholds('{"temperatureWarnRaw":null}').temperatureWarnRaw).toBeNull();
  });

  it('evaluates temperature: warning, critical, boundary and disabled limits', () => {
    const th: MonitorThresholds = { ...DEFAULT_MONITOR_THRESHOLDS };
    const sev = (t: number | undefined, thresholds = th) =>
      evaluateSnapshot(snap([card(0, 0, t === undefined ? {} : { temperatureRaw: t })]), thresholds).map((a) => a.severity);
    expect(sev(59)).toEqual([]);
    expect(sev(60)).toEqual(['warning']);
    expect(sev(74)).toEqual(['warning']);
    expect(sev(75)).toEqual(['critical']);
    expect(sev(undefined)).toEqual([]); // invalid temperature block: nothing to compare
    expect(sev(200, { ...th, temperatureWarnRaw: null, temperatureCriticalRaw: null })).toEqual([]);
    expect(sev(70, { ...th, temperatureWarnRaw: null })).toEqual([]);
    const [alert] = evaluateSnapshot(snap([card(1, 2, { temperatureRaw: 80 })]), th);
    expect(alert).toMatchObject({ key: 'card:1:2:temperature', kind: 'temperature-high', value: 80, threshold: 75, portIndex: 1, cardIndex: 2 });
  });

  it('evaluates voltage low / high only when limits are set', () => {
    const cards = [card(0, 0, { voltageRaw: 30 }), card(0, 1, { voltageRaw: 90 }), card(0, 2, { voltageRaw: 50 })];
    expect(evaluateSnapshot(snap(cards), DEFAULT_MONITOR_THRESHOLDS)).toEqual([]);
    const alerts = evaluateSnapshot(snap(cards), { ...DEFAULT_MONITOR_THRESHOLDS, voltageLowRaw: 40, voltageHighRaw: 60 });
    expect(alerts.map((a) => [a.key, a.kind])).toEqual([
      ['card:0:0:voltage', 'voltage-low'],
      ['card:0:1:voltage', 'voltage-high'],
    ]);
  });

  it('evaluates offline / error cards, port links, sender and function-card problems', () => {
    const s = snap(
      [
        card(0, 0, { state: 'offline', error: 'timeout', temperatureRaw: 99 }),
        card(0, 1, { state: 'error', error: 'bad ack' }),
        card(1, 0, { temperatureRaw: 30 }),
      ],
      1,
      {
        error: 'sender down',
        portLinks: [
          { portIndex: 0, detected: 0, expected: 2, status: 'down' },
          { portIndex: 1, detected: 1, expected: 2, status: 'partial' },
          { portIndex: 2, detected: 1, expected: 1, status: 'up' },
        ],
      },
    );
    s.functionCard = { state: 'offline', error: 'no answer' };
    const alerts = evaluateSnapshot(s);
    expect(alerts.map((a) => `${a.key}:${a.kind}:${a.severity}`)).toEqual([
      'card:0:0:state:card-offline:critical', // offline card: temperature is not evaluated
      'card:0:1:state:card-error:warning',
      'function-card:state:function-card-error:critical',
      'port:0:link:port-down:critical',
      'port:1:link:port-partial:warning',
      'sender:error:sender-error:warning',
    ]);
    expect(alerts.find((a) => a.kind === 'card-offline')?.detail).toBe('timeout');
    expect(alerts.find((a) => a.kind === 'port-partial')).toMatchObject({ value: 1, threshold: 2 });
  });

  it('diffs two alert lists into raised / cleared / escalated / relaxed', () => {
    const a = (key: string, severity: MonitorAlert['severity'], value = 1): MonitorAlert => ({
      key,
      kind: 'temperature-high',
      severity,
      value,
    });
    expect(diffAlerts([], [])).toEqual([]);
    const prev = [a('k1', 'warning'), a('k2', 'critical'), a('k3', 'warning'), a('k4', 'warning', 61)];
    const next = [a('k1', 'critical'), a('k2', 'warning'), a('k4', 'warning', 70), a('k5', 'warning')];
    const t = diffAlerts(prev, next);
    expect(t.map((x) => `${x.alert.key}:${x.type}`)).toEqual(['k1:escalated', 'k2:relaxed', 'k3:cleared', 'k5:raised']);
    expect(t[0]!.previous?.severity).toBe('warning');
    expect(t[2]!.alert.severity).toBe('warning'); // cleared keeps the alert that went away
    // a changed value at the same severity is not a transition
    expect(diffAlerts([a('k4', 'warning', 61)], [a('k4', 'warning', 70)])).toEqual([]);
  });

  it('works end to end: two snapshots -> transitions -> stamped events', () => {
    const before = snap([card(0, 0, { temperatureRaw: 50 })], 1000);
    const after = snap([card(0, 0, { temperatureRaw: 80 })], 2000);
    const transitions = diffAlerts(evaluateSnapshot(before), evaluateSnapshot(after));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ type: 'raised', alert: { severity: 'critical' } });
    const events = toAlertEvents(transitions, after);
    expect(events[0]).toMatchObject({ at: 2000, controllerId: 'net:test:5200', type: 'raised' });
    const cleared = diffAlerts(evaluateSnapshot(after), evaluateSnapshot(before));
    expect(cleared.map((x) => x.type)).toEqual(['cleared']);
  });

  it('derives card health, worst first', () => {
    const cards = [
      card(0, 0, { temperatureRaw: 40 }),
      card(0, 1, { temperatureRaw: 65 }),
      card(0, 2, { temperatureRaw: 90 }),
      card(0, 3, { state: 'offline' }),
      card(0, 4, { state: 'error' }),
      card(0, 10, { temperatureRaw: 65 }),
    ];
    const alerts = evaluateSnapshot(snap(cards));
    expect(cards.map((c) => cardHealth(c, alerts))).toEqual(['ok', 'warning', 'critical', 'offline', 'warning', 'warning']);
    // card 1 and card 10 must not leak into each other through a key prefix
    expect(cardHealth(card(0, 1), evaluateSnapshot(snap([card(0, 10, { temperatureRaw: 90 })])))).toBe('ok');
    expect(worstHealth('warning', 'critical')).toBe('critical');
    expect(worstHealth('offline', 'critical')).toBe('offline');
    expect(worstHealth('ok', 'ok')).toBe('ok');
  });

  it('caps history to the newest entries', () => {
    expect(appendCapped([1, 2, 3], [4, 5], 4)).toEqual([2, 3, 4, 5]);
    expect(appendCapped([], [1], 5)).toEqual([1]);
    expect(appendCapped([1, 2], [3], 0)).toEqual([]);
    expect(appendCapped([1, 2], [], 5)).toEqual([1, 2]);
  });

  it('builds a temperature series with gaps for offline cards', () => {
    const h = [
      snap([card(0, 0, { temperatureRaw: 40 })], 1),
      snap([card(0, 0, { state: 'offline' })], 2),
      snap([card(0, 0)], 3), // online but temperature block invalid
      snap([card(1, 1, { temperatureRaw: 9 })], 4), // card missing from the snapshot
      snap([card(0, 0, { temperatureRaw: 45 })], 5),
    ];
    expect(temperatureSeries(h, 0, 0)).toEqual([
      { at: 1, value: 40 },
      { at: 2, value: null },
      { at: 3, value: null },
      { at: 4, value: null },
      { at: 5, value: 45 },
    ]);
  });

  it('exports CSV with quoting and formula neutralisation', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell(-5)).toBe('-5'); // numbers are never prefixed
    expect(csvCell(undefined)).toBe('');

    const csv = readingsToCsv([
      snap([card(0, 0, { temperatureRaw: 41, humidityRaw: 7, voltageRaw: 50 }), card(0, 1, { state: 'offline', error: 'no, answer' })], Date.UTC(2026, 0, 2, 3, 4, 5)),
    ]);
    expect(csv.split('\r\n')).toEqual([
      'time,controller,port,card,state,temperature_raw,humidity_raw,voltage_raw,error',
      '2026-01-02T03:04:05.000Z,net:test:5200,0,0,online,41,7,50,',
      '2026-01-02T03:04:05.000Z,net:test:5200,0,1,offline,,,,"no, answer"',
      '',
    ]);

    const ev = toAlertEvents(diffAlerts([], evaluateSnapshot(snap([card(2, 3, { temperatureRaw: 99 })], 0))), snap([], 0));
    expect(alertEventsToCsv(ev).split('\r\n')).toEqual([
      'time,controller,event,severity,kind,port,card,value_raw,threshold_raw,detail',
      '1970-01-01T00:00:00.000Z,net:test:5200,raised,critical,temperature-high,2,3,99,75,',
      '',
    ]);
    expect(readingsToCsv([])).toBe('time,controller,port,card,state,temperature_raw,humidity_raw,voltage_raw,error\r\n');
  });
});

// ---------------------------------------------------------------------------------------------
// Decoders (layout from AddressMapping.d.cts, see monitor.ts)
// ---------------------------------------------------------------------------------------------

function block(): Buffer {
  const b = Buffer.alloc(ALL_STATUS_LENGTH);
  b[O.tempValid] = 1;
  b[O.tempValue] = 41;
  b[O.humidity] = 55;
  b[O.voltage] = 50;
  return b;
}

describe('decoders', () => {
  it('decodes the 4-byte scan-card word little-endian: [tempValid, temp, humidity, voltage]', () => {
    const word = Buffer.from([1, 41, 55, 50]).readUInt32LE(0);
    expect(decodeScanCardWord(word)).toEqual({ temperatureRaw: 41, humidityRaw: 55, voltageRaw: 50 });
    // top bit set must not go negative
    expect(decodeScanCardWord(Buffer.from([1, 0, 0, 200]).readUInt32LE(0))).toMatchObject({ voltageRaw: 200 });
    // valid byte 0 -> no temperature
    expect(decodeScanCardWord(Buffer.from([0, 41, 55, 50]).readUInt32LE(0))).toEqual({ humidityRaw: 55, voltageRaw: 50 });
  });

  it('decodes the 82-byte block without a monitor card', () => {
    expect(decodeAllStatus(block())).toEqual({ temperatureRaw: 41, humidityRaw: 55, voltageRaw: 50 });
    const b = block();
    b[O.tempValid] = 0;
    expect(decodeAllStatus(b)).not.toHaveProperty('temperatureRaw');
    // monitor-card bytes are ignored when the card says no monitor card is attached
    const c = block();
    c[O.monitorFan] = 9;
    expect(decodeAllStatus(c)).not.toHaveProperty('monitorCard');
  });

  it('decodes an attached monitor card from the documented offsets', () => {
    const b = block();
    b[O.monitorCardExists] = 1;
    b[O.monitorTempValid] = 1;
    b[O.monitorTempValue] = 33;
    b[O.monitorHumidity] = 44;
    b[O.monitorSmoke] = 1;
    [10, 20, 30, 40].forEach((v, i) => (b[O.monitorFan + i] = v));
    for (let i = 0; i < 9; i += 1) b[O.monitorVoltage + i] = 100 + i;
    b[O.monitorGeneralStatus] = 7;
    for (let i = 0; i < 16; i += 1) b[O.monitorModuleStatus + i] = i;
    const { monitorCard } = decodeAllStatus(b);
    expect(monitorCard).toEqual({
      temperatureRaw: 33,
      humidityRaw: 44,
      smokeRaw: 1,
      fanRaw: [10, 20, 30, 40],
      voltageRaw: [100, 101, 102, 103, 104, 105, 106, 107, 108],
      generalStatusRaw: 7,
      moduleStatusRaw: Array.from({ length: 16 }, (_, i) => i),
    });
  });

  it('accepts a short block (4 bytes) and rejects anything shorter', () => {
    expect(decodeAllStatus(Buffer.from([1, 41, 55, 50]))).toEqual({ temperatureRaw: 41, humidityRaw: 55, voltageRaw: 50 });
    expect(() => decodeAllStatus(Buffer.from([1, 2, 3]))).toThrow(DeviceError);
  });

  it('decodes the function-card monitor block (link, temp, humidity, smoke, 4 fans, 5 voltages)', () => {
    const b = Buffer.from([2, 1, 38, 60, 1, 11, 12, 13, 14, 21, 22, 23, 24, 25]);
    expect(decodeFuncMonitorInfo(b)).toEqual({
      linkStateRaw: 2,
      monitorTemperatureRaw: 38,
      monitorHumidityRaw: 60,
      smokeRaw: 1,
      fanRaw: [11, 12, 13, 14],
      voltageRawList: [21, 22, 23, 24, 25],
    });
    b[1] = 0;
    expect(decodeFuncMonitorInfo(b)).not.toHaveProperty('monitorTemperatureRaw');
    expect(() => decodeFuncMonitorInfo(Buffer.alloc(13))).toThrow(DeviceError);
  });
});

// ---------------------------------------------------------------------------------------------
// Against the simulator (real codec + TCP)
// ---------------------------------------------------------------------------------------------

describe('readMonitorSnapshot against the simulator', () => {
  let sim: SimulatorHandle;
  let service: DeviceService;
  let id: string;

  beforeAll(async () => {
    // 2 ports x 2 cards: sim card index k -> (port k % 2, chain position floor(k / 2)).
    sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
  });
  afterAll(async () => {
    await sim.close();
  });
  afterEach(async () => {
    await service.dispose();
  });

  const mem = (port: number, cardIdx: number) =>
    sim.state.receivingCards.find((c) => c.portIndex === port && c.cardIndex === cardIdx)!.memory;

  const seedCard = (port: number, cardIdx: number, v: { temp?: number; humi?: number; volt?: number; monitor?: boolean }): void => {
    const b = Buffer.alloc(ALL_STATUS_LENGTH);
    if (v.temp !== undefined) {
      b[O.tempValid] = 1;
      b[O.tempValue] = v.temp;
    }
    b[O.humidity] = v.humi ?? 0;
    b[O.voltage] = v.volt ?? 0;
    if (v.monitor) {
      b[O.monitorCardExists] = 1;
      b[O.monitorTempValid] = 1;
      b[O.monitorTempValue] = 36;
      b[O.monitorFan] = 99;
      b[O.monitorSmoke] = 0;
    }
    mem(port, cardIdx).write(R.scannerAllStatus, b);
  };

  const fresh = async (): Promise<void> => {
    service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 400,
    });
    id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
    await service.connect(id);
  };

  it('reads each card from its own registers, at normal user level, 1 request per card', async () => {
    await fresh();
    expect(service.getUserLevel().level).toBe('normal');
    seedCard(0, 0, { temp: 41, humi: 55, volt: 50 });
    seedCard(1, 1, { temp: 63, humi: 20, volt: 48, monitor: true });
    seedCard(1, 0, {}); // temperature block flagged invalid
    const cards = [
      { portIndex: 0, cardIndex: 0 },
      { portIndex: 0, cardIndex: 1 },
      { portIndex: 1, cardIndex: 0 },
      { portIndex: 1, cardIndex: 1 },
    ];
    const before = sim.state.requestCount;
    const s = await service.readMonitorSnapshot(id, { cards });
    const sent = sim.state.requestCount - before;

    expect(s.controllerId).toBe(id);
    expect(s.cards.map((c) => c.state)).toEqual(['online', 'online', 'online', 'online']);
    expect(s.cards[0]).toMatchObject({ portIndex: 0, cardIndex: 0, temperatureRaw: 41, humidityRaw: 55, voltageRaw: 50 });
    expect(s.cards[0]).not.toHaveProperty('monitorCard');
    expect(s.cards[1]).not.toHaveProperty('temperatureRaw'); // all-zero block: valid byte 0
    expect(s.cards[2]).not.toHaveProperty('temperatureRaw');
    expect(s.cards[3]).toMatchObject({ temperatureRaw: 63, humidityRaw: 20, voltageRaw: 48 });
    expect(s.cards[3]!.monitorCard).toMatchObject({ temperatureRaw: 36, fanRaw: [99, 0, 0, 0], smokeRaw: 0 });
    expect(s.cards[3]!.monitorCard!.voltageRaw).toHaveLength(9);
    expect(s.cards[3]!.monitorCard!.moduleStatusRaw).toHaveLength(16);

    // 5 sender requests + 1 per card; the snapshot's own counter matches what the simulator saw.
    expect(s.requestCount).toBe(5 + 4);
    expect(sent).toBe(s.requestCount);
    expect(Math.abs(Date.now() - s.takenAt)).toBeLessThan(5000);
  });

  it('reports an offline card (not on the chain) and keeps going', async () => {
    await fresh();
    seedCard(0, 0, { temp: 40, volt: 50 });
    seedCard(1, 1, { temp: 42, volt: 50 });
    const cards = [
      { portIndex: 0, cardIndex: 0 },
      { portIndex: 3, cardIndex: 0 }, // port 3 has no cards: the simulator never answers
      { portIndex: 1, cardIndex: 1 },
    ];
    const before = sim.state.requestCount;
    const s = await service.readMonitorSnapshot(id, { cards });
    expect(s.cards.map((c) => c.state)).toEqual(['online', 'offline', 'online']);
    expect(s.cards[1]!.error).toBeTruthy();
    expect(s.cards[1]).not.toHaveProperty('temperatureRaw');
    expect(s.cards[2]).toMatchObject({ temperatureRaw: 42 });
    // the offline card cost exactly one request
    expect(s.requestCount).toBe(5 + 3);
    expect(sim.state.requestCount - before).toBe(s.requestCount);

    const alerts = evaluateSnapshot(s);
    expect(alerts.map((a) => `${a.key}:${a.kind}`)).toContain('card:3:0:state:card-offline');
  });

  it('derives per-port link status from the sender (partial when fewer cards than expected)', async () => {
    await fresh();
    const s = await service.readMonitorSnapshot(id, {
      cards: [
        { portIndex: 0, cardIndex: 0 },
        { portIndex: 0, cardIndex: 1 },
        { portIndex: 1, cardIndex: 0 },
        { portIndex: 1, cardIndex: 1 },
        { portIndex: 1, cardIndex: 2 }, // 3 expected on port 1, sender counts 2
        { portIndex: 2, cardIndex: 0 }, // port 2 expected but sender counts 0
      ],
    });
    expect(s.sender.portLinks).toEqual([
      { portIndex: 0, detected: 2, expected: 2, status: 'up' },
      { portIndex: 1, detected: 2, expected: 3, status: 'partial' },
      { portIndex: 2, detected: 0, expected: 1, status: 'down' },
    ]);
    expect(s.cards.map((c) => c.state)).toEqual(['online', 'online', 'online', 'online', 'offline', 'offline']);
    const kinds = evaluateSnapshot(s).map((a) => `${a.key}:${a.kind}`);
    expect(kinds).toContain('port:1:link:port-partial');
    expect(kinds).toContain('port:2:link:port-down');
  });

  it('discovers the cards itself when none are passed (ports that report cards only)', async () => {
    await fresh();
    seedCard(1, 1, { temp: 55 });
    const before = sim.state.requestCount;
    const s = await service.readMonitorSnapshot(id);
    expect(s.cards.map((c) => `${c.portIndex}/${c.cardIndex}`)).toEqual(['0/0', '0/1', '1/0', '1/1']);
    expect(s.cards.find((c) => c.portIndex === 1 && c.cardIndex === 1)).toMatchObject({ temperatureRaw: 55 });
    expect(s.sender.portLinks.map((p) => p.status)).toEqual(['up', 'up']);
    // 5 sender + 2 per-port configured counts + 4 cards
    expect(s.requestCount).toBe(5 + 2 + 4);
    expect(sim.state.requestCount - before).toBe(s.requestCount);
  });

  it('reads the sender-side raw values', async () => {
    await fresh();
    sim.state.sendingCard.writeU8(R.senderDviStatus, 3);
    sim.state.sendingCard.writeU16LE(R.senderTemperature, 0x0123);
    sim.state.sendingCard.writeU16LE(R.senderHumidity, 77);
    sim.state.sendingCard.writeU16LE(R.senderFan, 1200);
    const s = await service.readMonitorSnapshot(id, { cards: [] });
    expect(s.sender).toMatchObject({ dviStatusRaw: 3, temperatureRaw: 0x123, humidityRaw: 77, fanRaw: 1200 });
    expect(s.cards).toEqual([]);
    expect(s.requestCount).toBe(5);
  });

  it('adds one request per online card for bit-error data, raw', async () => {
    await fresh();
    mem(0, 0).write(R.bitErrorRate, Buffer.from([1, 2, 3]));
    const s = await service.readMonitorSnapshot(id, {
      cards: [
        { portIndex: 0, cardIndex: 0 },
        { portIndex: 5, cardIndex: 0 },
      ],
      includeBitErrorRate: true,
    });
    expect(s.cards[0]!.bitErrorRaw).toEqual([1, 2, 3]);
    expect(s.cards[1]!.state).toBe('offline');
    expect(s.cards[1]).not.toHaveProperty('bitErrorRaw');
    expect(s.requestCount).toBe(5 + 2 + 1);
  });

  it('removes duplicate cards and rejects bad arguments before any I/O', async () => {
    await fresh();
    const dup = await service.readMonitorSnapshot(id, {
      cards: [
        { portIndex: 0, cardIndex: 0 },
        { portIndex: 0, cardIndex: 0 },
      ],
    });
    expect(dup.cards).toHaveLength(1);
    const before = sim.state.requestCount;
    await expectCode(service.readMonitorSnapshot(id, { cards: [{ portIndex: -1, cardIndex: 0 }] }), 'INVALID_ARGUMENT');
    await expectCode(service.readMonitorSnapshot(id, { cards: [{ portIndex: 0, cardIndex: 1.5 }] }), 'INVALID_ARGUMENT');
    await expectCode(service.readMonitorSnapshot(id, { cards: 'x' as never }), 'INVALID_ARGUMENT');
    await expectCode(service.readMonitorSnapshot(id, { cards: [null as never] }), 'INVALID_ARGUMENT');
    await expectCode(service.readMonitorSnapshot(id, { includeBitErrorRate: 1 as never }), 'INVALID_ARGUMENT');
    await expectCode(service.readMonitorSnapshot(id, { functionCardAddress: 300 }), 'INVALID_ARGUMENT');
    await expectCode(service.readMonitorSnapshot(id, 5 as never), 'INVALID_ARGUMENT');
    expect(sim.state.requestCount).toBe(before);
  });

  it('refuses unknown and disconnected controllers', async () => {
    await fresh();
    await expectCode(service.readMonitorSnapshot('net:nope:1'), 'NOT_FOUND');
    await service.disconnect(id);
    await expectCode(service.readMonitorSnapshot(id), 'NOT_CONNECTED');
  });
});

describe('function card against its own simulator', () => {
  it('reads the 4-byte status and the 14-byte monitor block at the function-card addresses', async () => {
    const sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 1, receivingCards: 1 });
    const service = createDeviceService({
      sessionFactory: createNetSessionFactory({ port: sim.port }),
      netPort: sim.port,
      serialDiscovery: false,
      timeoutMs: 400,
    });
    try {
      const id = (await service.discover({ netHosts: ['127.0.0.1'] }))[0]!.id;
      await service.connect(id);
      // The simulator ignores the destination byte, so the function card shares the sender memory.
      sim.state.sendingCard.write(R.funcCardAllStatus, Buffer.from([1, 35, 40, 49]));
      sim.state.sendingCard.write(R.funcCardMonitorAllInfo, Buffer.from([1, 1, 29, 61, 0, 5, 6, 7, 8, 31, 32, 33, 34, 35]));
      const s = await service.readMonitorSnapshot(id, { cards: [], functionCardAddress: 1 });
      expect(s.functionCard).toEqual({
        state: 'online',
        temperatureRaw: 35,
        humidityRaw: 40,
        voltageRaw: 49,
        linkStateRaw: 1,
        monitorTemperatureRaw: 29,
        monitorHumidityRaw: 61,
        smokeRaw: 0,
        fanRaw: [5, 6, 7, 8],
        voltageRawList: [31, 32, 33, 34, 35],
      });
      expect(s.requestCount).toBe(5 + 2);
      const without = await service.readMonitorSnapshot(id, { cards: [] });
      expect(without).not.toHaveProperty('functionCard');
    } finally {
      await service.dispose();
      await sim.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Error paths with a scripted session
// ---------------------------------------------------------------------------------------------

type Script = Partial<MonitorSession>;

function scripted(script: Script): SessionLike {
  const base = {
    ReadControllerModelId: async () => 0x1234,
    ReadSender_McuProgramEdition: async () => 0x02030400,
    ReadSender_FPGAProgramEdition: async () => 0x01000000,
    ReadScanerCountOfSenderCard: async () => Buffer.from([2, 0, 0]),
    ReadNumberOfCardOrScanBoardInPort: async (_a: number, port: number) => (port === 0 ? 2 : 0),
    ReadScanner_McuProgramEdition: async () => 0x01020300,
    ReadAllBrightnessInfo: async () => Buffer.from([255, 255, 128, 0, 255]),
    SetGlobalBrightness: async () => undefined,
    SetRGBBrightness: async () => undefined,
    SetRedBrightness: async () => undefined,
    SetGreenBrightness: async () => undefined,
    SetBlueBrightness: async () => undefined,
    SetSelfTestMode: async () => undefined,
    SetKillMode: async () => undefined,
    SetLockMode: async () => undefined,
    close: () => true,
    ReadAllStatus: async () => block(),
    ReadScanCardAllStatus: async () => Buffer.from([1, 41, 55, 50]).readUInt32LE(0),
    ReadBitErrorRateData: async () => Buffer.from([0, 0, 0]),
    ReadSenderDVIStatus: async () => 1,
    ReadTemperature: async () => 30,
    ReadHumidity: async () => 40,
    ReadFan: async () => 50,
    FuncCard_ReadFuncCardAllStatus: async () => 0,
    FuncCard_ReadMonitorCardAllInfo: async () => Buffer.alloc(14),
    ...script,
  };
  return base as unknown as SessionLike;
}

async function withScript(script: Script): Promise<{ svc: DeviceService; id: string }> {
  const factory: SessionFactory = { open: async () => scripted(script) };
  const svc = createDeviceService({ sessionFactory: factory, serialDiscovery: false });
  const [found] = await svc.discover({ netHosts: ['10.0.0.1'] });
  await svc.connect(found!.id);
  return { svc, id: found!.id };
}

describe('readMonitorSnapshot error handling (scripted session)', () => {
  const two = { cards: [{ portIndex: 0, cardIndex: 0 }, { portIndex: 0, cardIndex: 1 }] };

  it('marks silent cards offline (both shapes) and a refusing card error, without aborting', async () => {
    const { svc, id } = await withScript({
      ReadAllStatus: async (_a, _p, c) => {
        if (c === 0) throw timeoutError();
        if (c === 1) throw downstreamTimeout();
        throw responseError();
      },
      ReadScanCardAllStatus: async () => {
        throw responseError();
      },
    });
    const s = await svc.readMonitorSnapshot(id, {
      cards: [0, 1, 2].map((cardIndex) => ({ portIndex: 0, cardIndex })),
    });
    expect(s.cards.map((c) => c.state)).toEqual(['offline', 'offline', 'error']);
    expect(s.cards.every((c) => typeof c.error === 'string' && c.error.length > 0)).toBe(true);
    // 5 sender + 1 + 1 (silent cards are not retried with the short read) + error (long read, then fallback = 2)
    expect(s.requestCount).toBe(5 + 1 + 1 + 2);
  });

  it('falls back to the 4-byte block when a card refuses the 82-byte read', async () => {
    const { svc, id } = await withScript({
      ReadAllStatus: async () => {
        throw responseError();
      },
    });
    const s = await svc.readMonitorSnapshot(id, two);
    expect(s.cards[0]).toMatchObject({ state: 'online', temperatureRaw: 41, humidityRaw: 55, voltageRaw: 50 });
    expect(s.requestCount).toBe(5 + 2 * 2);
  });

  it('reports a short block as an error entry', async () => {
    const { svc, id } = await withScript({ ReadAllStatus: async () => Buffer.from([1, 2]) });
    const s = await svc.readMonitorSnapshot(id, two);
    expect(s.cards.map((c) => c.state)).toEqual(['error', 'error']);
  });

  it('rejects with NOT_CONNECTED when the connection closes mid-pass', async () => {
    const { svc, id } = await withScript({
      ReadAllStatus: async (_a, _p, c) => {
        if (c === 1) throw new ConnectionClosedError();
        return block();
      },
    });
    await expectCode(svc.readMonitorSnapshot(id, two), 'NOT_CONNECTED');
    await expectCode(svc.readMonitorSnapshot(id, two), 'NOT_CONNECTED'); // session was dropped
  });

  it('keeps the cards when the sender-level read fails', async () => {
    let calls = 0; // the first call is connect()'s
    const { svc, id } = await withScript({
      ReadScanerCountOfSenderCard: async () => {
        if ((calls += 1) === 1) return Buffer.from([2, 0, 0]);
        throw timeoutError();
      },
    });
    const s = await svc.readMonitorSnapshot(id, two);
    expect(s.sender.error).toBeTruthy();
    expect(s.sender.portLinks).toEqual([]);
    expect(s.cards.map((c) => c.state)).toEqual(['online', 'online']);
    // counts failed -> the optional sender sensors are skipped: 1 + 2 cards
    expect(s.requestCount).toBe(1 + 2);
    expect(evaluateSnapshot(s).map((a) => a.kind)).toEqual(['sender-error']);
  });

  it('leaves an unsupported optional sender sensor out instead of failing', async () => {
    const { svc, id } = await withScript({
      ReadTemperature: async () => {
        throw responseError();
      },
      ReadFan: async () => {
        throw timeoutError();
      },
    });
    const s = await svc.readMonitorSnapshot(id, two);
    expect(s.sender).not.toHaveProperty('temperatureRaw');
    expect(s.sender).not.toHaveProperty('fanRaw');
    expect(s.sender).toMatchObject({ dviStatusRaw: 1, humidityRaw: 40 });
    expect(s.sender.error).toBeUndefined();
  });

  it('reports a silent function card as offline and an answering one without monitor data', async () => {
    const silent = await withScript({
      FuncCard_ReadFuncCardAllStatus: async () => {
        throw timeoutError();
      },
    });
    const s1 = await silent.svc.readMonitorSnapshot(silent.id, { cards: [], functionCardAddress: 2 });
    expect(s1.functionCard).toMatchObject({ state: 'offline' });
    expect(s1.requestCount).toBe(5 + 1);
    expect(evaluateSnapshot(s1).map((a) => a.kind)).toEqual(['function-card-error']);

    const partial = await withScript({
      FuncCard_ReadFuncCardAllStatus: async () => Buffer.from([1, 30, 40, 50]).readUInt32LE(0),
      FuncCard_ReadMonitorCardAllInfo: async () => {
        throw responseError();
      },
    });
    const s2 = await partial.svc.readMonitorSnapshot(partial.id, { cards: [], functionCardAddress: 2 });
    expect(s2.functionCard).toEqual({ state: 'online', temperatureRaw: 30, humidityRaw: 40, voltageRaw: 50 });
  });

  it('passes the function-card bus address through as the native addr argument', async () => {
    const seen: number[] = [];
    const { svc, id } = await withScript({
      FuncCard_ReadFuncCardAllStatus: async (addr) => {
        seen.push(addr);
        return 0;
      },
    });
    await svc.readMonitorSnapshot(id, { cards: [], functionCardAddress: 7 });
    expect(seen).toEqual([7]);
  });
});

describe('offline cards keep their alerts (review item 6)', () => {
  it('a hot card going offline does not report its temperature alert as cleared; a real clear needs online + below threshold', () => {
    const hot = evaluateSnapshot(snap([card(0, 0, { temperatureRaw: 90 })]));
    const off = evaluateSnapshot(snap([card(0, 0, { state: 'offline' })]), DEFAULT_MONITOR_THRESHOLDS, hot);
    expect(diffAlerts(hot, off).map((t) => [t.type, t.alert.kind])).toEqual([['raised', 'card-offline']]);
    expect(off.find((a) => a.kind === 'temperature-high')).toMatchObject({ stale: true, severity: 'critical' });
    // even without the carry-over argument (callers holding only the old list) it is not "cleared"
    const offBare = evaluateSnapshot(snap([card(0, 0, { state: 'offline' })]));
    expect(diffAlerts(hot, offBare).some((t) => t.type === 'cleared')).toBe(false);
    // back online and cool: now it really clears
    const cool = evaluateSnapshot(snap([card(0, 0, { temperatureRaw: 40 })]));
    const kinds = diffAlerts(off, cool).map((t) => [t.type, t.alert.kind]);
    expect(kinds).toContainEqual(['cleared', 'temperature-high']);
    expect(kinds).toContainEqual(['cleared', 'card-offline']);
  });
});
