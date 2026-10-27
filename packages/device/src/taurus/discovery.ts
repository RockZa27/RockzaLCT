// Taurus discovery on top of @novastar/taurus.
//
//   broadcastTaurusDiscovery  library `discoverTaurusPlayers(undefined, timeout)`: UDP broadcast to
//                             port 16601 on every non-internal IPv4 interface.
//   probeTaurusHost           the same request (library `encodeTaurusDiscoveryRequest`) sent to one
//                             host, answer decoded by library `parseTaurusDiscoveryResponse`. The
//                             library's unicast form (`discoverTaurusPlayers(host)`) is not used for
//                             probing because it sends from every interface, always waits the full
//                             timeout, and cannot target a non-default UDP port (the simulator and
//                             tests need that).

import { createSocket } from 'node:dgram';
import {
  TAURUS_DISCOVERY_PORT,
  discoverTaurusPlayers,
  encodeTaurusDiscoveryRequest,
  parseTaurusDiscoveryResponse,
  type TaurusPlayerInfo,
} from '@novastar/taurus';
import { DeviceError } from '@rockzalct/shared';

export { TAURUS_DISCOVERY_PORT };
export type { TaurusPlayerInfo };

/** Library broadcast discovery; resolves with every player that answered within `timeoutMs`. */
export function broadcastTaurusDiscovery(timeoutMs: number): Promise<TaurusPlayerInfo[]> {
  return discoverTaurusPlayers(undefined, timeoutMs);
}

/**
 * Ask one host whether it is a Taurus player. Resolves with its discovery record as soon as a valid
 * answer arrives; rejects with TIMEOUT when nothing valid arrives within `timeoutMs` (the overall
 * budget includes DNS) or with PROTOCOL when the datagram cannot be sent.
 */
export function probeTaurusHost(host: string, port: number, timeoutMs: number): Promise<TaurusPlayerInfo> {
  return new Promise<TaurusPlayerInfo>((resolve, reject) => {
    const socket = createSocket('udp4');
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      fn();
    };
    timer = setTimeout(
      () => finish(() => reject(new DeviceError('TIMEOUT', `no Taurus answered from ${host}:${port}`))),
      timeoutMs,
    );
    socket.on('error', (err) =>
      finish(() => reject(new DeviceError('PROTOCOL', `Taurus probe of ${host} failed: ${err.message}`))),
    );
    socket.on('message', (message, remote) => {
      const player = parseTaurusDiscoveryResponse(message, remote.address);
      if (player) finish(() => resolve(player));
    });
    socket.send(encodeTaurusDiscoveryRequest(), port, host, (err) => {
      if (err) {
        finish(() => reject(new DeviceError('PROTOCOL', `cannot send the Taurus probe to ${host}:${port}: ${err.message}`)));
      }
    });
  });
}
