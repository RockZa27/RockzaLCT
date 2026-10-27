import { createSocket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import {
  createHSeriesState,
  handleHSeriesCommand,
  type HSeriesSimulatorOptions,
  type HSeriesSimulatorState,
} from './state.js';

export interface HSeriesSimulatorHandle {
  /** Actual UDP port (resolved when `port: 0`). */
  port: number;
  host: string;
  state: HSeriesSimulatorState;
  close(): Promise<void>;
}

/** Default UDP port of H series controllers (reference main.js:59). */
export const DEFAULT_HSERIES_PORT = 6000;

/**
 * UDP H series simulator. Every datagram is a JSON array of command objects; each element is
 * executed and answered with its own datagram `[{"cmd":..,"ack":"Ok",..payload}]`. Failures answer
 * ack "Fail" with a `msg` (UNVERIFIED: the reference only shows that success is exactly "Ok").
 * Datagrams that are not a JSON array of objects with a string `cmd` get no reply.
 */
export function startHSeriesSimulator(opts: HSeriesSimulatorOptions = {}): Promise<HSeriesSimulatorHandle> {
  const state = createHSeriesState(opts);
  const host = opts.host ?? '127.0.0.1';
  const socket = createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    if (state.mute) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.toString('utf8'));
    } catch {
      state.malformedRequests += 1;
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      state.malformedRequests += 1;
      return;
    }
    for (const item of parsed as unknown[]) {
      if (typeof item !== 'object' || item === null || typeof (item as { cmd?: unknown }).cmd !== 'string') {
        state.malformedRequests += 1;
        continue;
      }
      const { cmd, ...body } = item as { cmd: string } & Record<string, unknown>;
      state.received.push({ cmd, body });
      let out: Buffer;
      if (state.garbageFor.has(cmd)) {
        out = Buffer.from('this is not json');
      } else if (state.failFor.has(cmd)) {
        out = Buffer.from(JSON.stringify([{ cmd, ack: 'Fail', msg: 'forced failure' }]));
      } else {
        const result = handleHSeriesCommand(state, cmd, body);
        out = Buffer.from(
          JSON.stringify([
            result.ok ? { cmd, ack: 'Ok', deviceId: 0, ...result.data } : { cmd, ack: 'Fail', deviceId: 0, msg: result.message },
          ]),
        );
      }
      socket.send(out, rinfo.port, rinfo.address);
    }
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(opts.port ?? 0, host, () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      const { port } = socket.address() as AddressInfo;
      resolve({
        port,
        host,
        state,
        close: () =>
          new Promise<void>((res) => {
            try {
              socket.close(() => res());
            } catch {
              res();
            }
          }),
      });
    });
  });
}
