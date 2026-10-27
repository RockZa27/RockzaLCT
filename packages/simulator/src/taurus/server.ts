import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { encodeResponse, type TaurusCodec } from './codec.js';
import {
  createTaurusState,
  discoveryInfo,
  handleTaurusCommand,
  type TaurusSession,
  type TaurusSimulatorOptions,
  type TaurusSimulatorState,
} from './state.js';

/** Default TCP management port of Taurus players (library TAURUS_MANAGEMENT_PORT). */
export const DEFAULT_TAURUS_PORT = 16606;
/** Default UDP discovery port (library TAURUS_DISCOVERY_PORT). */
export const DEFAULT_TAURUS_DISCOVERY_PORT = 16601;
/** `what` of the library's discovery request (encodeTaurusDiscoveryRequest). */
const DISCOVERY_REQUEST_WHAT = 129;
/** `what` of a discovery answer the library accepts (parseTaurusDiscoveryResponse). */
const DISCOVERY_RESPONSE_WHAT = 1;

export interface TaurusSimulatorHandle {
  /** Actual TCP management port. */
  port: number;
  /** Actual UDP discovery port, when a discovery socket is running. */
  discoveryPort?: number;
  host: string;
  state: TaurusSimulatorState;
  close(): Promise<void>;
}

/**
 * Taurus management-protocol simulator: TCP (plain, or TLS with `opts.tls`) + optional UDP
 * discovery. Packets are read and written with the library codec handed in as `codec`
 * (`import * as taurus from '@novastar/taurus'`), so framing and checksums cannot drift from it.
 */
export async function startTaurusSimulator(codec: TaurusCodec, opts: TaurusSimulatorOptions = {}): Promise<TaurusSimulatorHandle> {
  const state = createTaurusState(opts);
  const host = opts.host ?? '127.0.0.1';
  const sockets = new Set<Socket>();

  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const session: TaurusSession = { authed: false };
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        let size: number | undefined;
        try {
          size = codec.getTaurusPacketSize(buffer);
        } catch {
          socket.destroy(); // bad magic: not a Taurus client
          return;
        }
        if (size === undefined || buffer.length < size) return;
        const raw = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        let packet;
        try {
          packet = codec.decodeTaurusPacket(raw);
        } catch {
          socket.destroy(); // bad header checksum
          return;
        }
        if (packet.packetType !== codec.TAURUS_REQUEST || state.mute) continue;
        const text = packet.body.toString('utf8');
        let body: unknown;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
        }
        const reply = handleTaurusCommand(state, session, packet.what, packet.req.type, packet.req.action, body);
        const payload = reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        socket.write(
          encodeResponse(
            codec,
            codec.TAURUS_RESPONSE,
            { sequence: packet.sequence, what: packet.what, status: reply.status, action: packet.req.action, type: packet.req.type },
            payload,
          ),
        );
      }
    });
  };

  const server: Server = opts.tls ? createTlsServer({ key: opts.tls.key, cert: opts.tls.cert }, onConnection) : createTcpServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_TAURUS_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let udp: UdpSocket | undefined;
  let discoveryPort: number | undefined;
  let udpClosed = false;
  const udpPort = opts.discoveryPort === undefined ? DEFAULT_TAURUS_DISCOVERY_PORT : opts.discoveryPort;
  if (udpPort !== null) {
    udp = createSocket('udp4');
    udp.on('message', (msg, remote) => {
      if (state.mute) return;
      let packet;
      try {
        packet = codec.decodeTaurusPacket(msg);
      } catch {
        return;
      }
      if (packet.packetType !== codec.TAURUS_DISCOVERY || packet.what !== DISCOVERY_REQUEST_WHAT) return;
      const answer = encodeResponse(
        codec,
        codec.TAURUS_DISCOVERY,
        { sequence: packet.sequence, what: DISCOVERY_RESPONSE_WHAT, status: 0, action: 0, type: 0 },
        JSON.stringify(discoveryInfo(state, port, opts.tls !== undefined)),
      );
      udp?.send(answer, remote.port, remote.address);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        udp?.once('error', reject);
        udp?.bind(udpPort, host, () => {
          udp?.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      server.close();
      try {
        udp.close();
      } catch {
        // not bound
      }
      throw err;
    }
    udp.on('error', () => {});
    discoveryPort = (udp.address() as AddressInfo).port;
  }

  return {
    port,
    ...(discoveryPort !== undefined ? { discoveryPort } : {}),
    host,
    state,
    close: async () => {
      // Idempotent: tests close a simulator early to play a dead player, and again in cleanup.
      for (const s of sockets) s.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (udp && !udpClosed) {
        udpClosed = true;
        await new Promise<void>((resolve) => udp.close(() => resolve()));
      }
    },
  };
}
