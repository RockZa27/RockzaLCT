import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { buildResponse, RequestParser } from './protocol.js';
import { createState, handleRequest, type SimulatorOptions, type SimulatorState } from './state.js';

export interface SimulatorHandle {
  /** Actual listening port (resolved when `port: 0`). */
  port: number;
  host: string;
  state: SimulatorState;
  close(): Promise<void>;
}

/** Default TCP port, @novastar/net `TCP_PORT`. */
export const DEFAULT_PORT = 5200;

export function startSimulator(opts: SimulatorOptions = {}): Promise<SimulatorHandle> {
  const state = createState(opts);
  const host = opts.host ?? '127.0.0.1';
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    state.connections += 1;
    socket.setNoDelay(true);
    const parser = new RequestParser(); // one parser per connection: frames may span chunks
    socket.on('data', (chunk) => {
      try {
        for (const req of parser.push(chunk)) {
          state.requestCount += 1;
          const { ack, data } = handleRequest(state, req);
          if (!socket.destroyed) socket.write(buildResponse(req, ack, data));
        }
      } catch {
        // Never let a bad client take the simulator down.
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      state.connections -= 1;
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      server.on('error', () => {});
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        host,
        state,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            for (const s of sockets) s.destroy();
          }),
      });
    });
  });
}
