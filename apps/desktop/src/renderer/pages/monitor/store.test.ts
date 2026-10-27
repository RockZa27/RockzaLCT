import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MONITOR_THRESHOLDS, type MonitorCardReading, type MonitorSnapshot } from '@rockzalct/shared';
import { ingest, resetMonitorStore } from './store';

const ID = 'net:test:5200';

const card = (extra: Partial<MonitorCardReading> = {}): MonitorCardReading => ({
  portIndex: 0,
  cardIndex: 0,
  state: 'online',
  ...extra,
});

const snap = (c: MonitorCardReading, takenAt: number): MonitorSnapshot => ({
  controllerId: ID,
  takenAt,
  sender: { portLinks: [] },
  cards: [c],
  requestCount: 0,
});

afterEach(() => resetMonitorStore());

describe('monitor store', () => {
  it('a hot card that drops offline and returns still hot neither clears nor re-raises its temperature alert', () => {
    const t = DEFAULT_MONITOR_THRESHOLDS;
    ingest(ID, snap(card({ temperatureRaw: 90 }), 1), t);
    ingest(ID, snap(card({ state: 'offline' }), 2), t);
    const back = ingest(ID, snap(card({ temperatureRaw: 90 }), 3), t);

    const temperatureEvents = back.events.filter((e) => e.alert.kind === 'temperature-high').map((e) => e.type);
    expect(temperatureEvents).toEqual(['raised']);
  });
});
