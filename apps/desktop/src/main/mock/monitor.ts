import {
  DeviceError,
  portLinkStatus,
  validateCardIndex,
  type MonitorApi,
  type MonitorCardReading,
  type MonitorCardRef,
  type MonitorPortLink,
  type MonitorSnapshot,
} from '@rockzalct/shared';
import type { MockContext } from './context';

/** One fault every FAULT_CYCLE snapshots, lasting FAULT_LENGTH snapshots. */
const FAULT_CYCLE = 12;
const FAULT_FIRST = 7; // zero-based position inside the cycle where the fault starts
const FAULT_LENGTH = 3;
/** Cards that take turns being the faulty one. Even cycles: temperature spike; odd cycles: offline. */
const FAULT_CARDS: readonly MonitorCardRef[] = [
  { portIndex: 0, cardIndex: 0 },
  { portIndex: 0, cardIndex: 1 },
  { portIndex: 1, cardIndex: 0 },
];

/** The cards of the fake controllers (same shapes as mockDevice.ts: COM3 4x2, LAN 10x1). */
function defaultCards(id: string): MonitorCardRef[] {
  const [ports, perPort] = id.startsWith('net:') ? [10, 1] : [4, 2];
  return Array.from({ length: ports * perPort }, (_, i) => ({ portIndex: Math.floor(i / perPort), cardIndex: i % perPort }));
}

/** Small deterministic hash -> [0, 1). No Math.random, so a given snapshot number always reads the same. */
function noise(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p + 0x9e3779b9;
    h = Math.imul(h, 16777619);
    h ^= h >>> 15;
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Plausible monitoring data: temperature around 40 (raw) drifting slowly with a per-card phase,
 * voltage ~50 +-1, humidity ~45, all raw bytes like the real device. Every FAULT_CYCLE snapshots one
 * card misbehaves for FAULT_LENGTH snapshots: a temperature spike past the default critical
 * threshold, or the card dropping off the chain (offline, and the sender then counts one card less
 * on that port).
 */
export function createMockMonitor(ctx: MockContext): MonitorApi {
  const counters = new Map<string, number>();

  return {
    async readMonitorSnapshot(id, options): Promise<MonitorSnapshot> {
      ctx.requireConnected(id);
      await ctx.delay();
      ctx.requireConnected(id);
      if (options !== undefined && (typeof options !== 'object' || options === null)) {
        throw new DeviceError('INVALID_ARGUMENT', 'options must be an object');
      }
      for (const c of options?.cards ?? []) {
        const bad = validateCardIndex(c.portIndex, c.cardIndex);
        if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
      }
      const n = (counters.get(id) ?? 0) + 1;
      counters.set(id, n);

      const cards = options?.cards ?? defaultCards(id);
      const cycle = Math.floor((n - 1) / FAULT_CYCLE);
      const pos = (n - 1) % FAULT_CYCLE;
      const inFault = pos >= FAULT_FIRST && pos < FAULT_FIRST + FAULT_LENGTH;
      const faulty = FAULT_CARDS[cycle % FAULT_CARDS.length]!;
      const offlineFault = cycle % 2 === 1;

      const readings: MonitorCardReading[] = cards.map(({ portIndex, cardIndex }) => {
        const isFaulty = inFault && portIndex === faulty.portIndex && cardIndex === faulty.cardIndex;
        if (isFaulty && offlineFault) {
          return { portIndex, cardIndex, state: 'offline', error: 'No response was received (mock)' };
        }
        const phase = portIndex * 1.7 + cardIndex * 0.9;
        let temp = 40 + (portIndex * 3 + cardIndex * 2) % 7 + 3 * Math.sin(n / 5 + phase) + noise(n, portIndex, cardIndex) - 0.5;
        if (isFaulty) temp += 22 + 12 * (pos - FAULT_FIRST); // ~65 (warning), then ~77+ (critical)
        return {
          portIndex,
          cardIndex,
          state: 'online',
          temperatureRaw: Math.max(0, Math.min(255, Math.round(temp))),
          humidityRaw: Math.round(45 + 4 * Math.sin(n / 9 + phase)),
          voltageRaw: 50 + Math.round(noise(n, cardIndex, portIndex, 7) * 2) - 1,
        };
      });

      const expected = new Map<number, number>();
      const seen = new Map<number, number>();
      for (const r of readings) {
        expected.set(r.portIndex, (expected.get(r.portIndex) ?? 0) + 1);
        if (r.state === 'online') seen.set(r.portIndex, (seen.get(r.portIndex) ?? 0) + 1);
      }
      const portLinks: MonitorPortLink[] = [...expected.keys()]
        .sort((a, b) => a - b)
        .map((portIndex) => {
          const detected = seen.get(portIndex) ?? 0;
          const exp = expected.get(portIndex)!;
          return { portIndex, detected, expected: exp, status: portLinkStatus(detected, exp) };
        });

      return {
        controllerId: id,
        takenAt: Date.now(),
        sender: {
          portLinks,
          dviStatusRaw: 1,
          temperatureRaw: Math.round(36 + 2 * Math.sin(n / 7)),
          humidityRaw: 40,
          fanRaw: 1500 + Math.round(noise(n, 99) * 40),
        },
        cards: readings,
        requestCount: 5 + readings.length,
      };
    },
  };
}
