import { DeviceError, type DiscoveredController } from '@rockzalct/shared';
import { net, type NetSession } from '@novastar/net';
import { serial } from '@novastar/serial';
// Side-effect imports: each adds one method to the codec Session prototype.
import '@novastar/native/api/ReadControllerModelId';
import '@novastar/native/api/ReadSender_McuProgramEdition';
import '@novastar/native/api/ReadSender_FPGAProgramEdition';
import '@novastar/native/api/ReadScanerCountOfSenderCard';
import '@novastar/native/api/ReadNumberOfCardOrScanBoardInPort';
import '@novastar/native/api/ReadScanner_McuProgramEdition';
import '@novastar/native/api/ReadAllBrightnessInfo';
import '@novastar/native/api/SetGlobalBrightness';
import '@novastar/native/api/SetRGBBrightness';
import '@novastar/native/api/SetRedBrightness';
import '@novastar/native/api/SetGreenBrightness';
import '@novastar/native/api/SetBlueBrightness';
import '@novastar/native/api/SetSelfTestMode';
import '@novastar/native/api/SetKillMode';
import '@novastar/native/api/SetLockMode';
import type { OpenOptions, SessionFactory, SessionLike } from './session.js';

export const DEFAULT_NET_PORT = 5200;
export const DEFAULT_BAUD_RATE = 115200;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface NetFactoryOptions {
  /** TCP port used when the controller has none (default 5200). */
  port?: number;
}

/** Session factory for LAN controllers (TCP) using the real `@novastar/net` binding. */
export function createNetSessionFactory(opts: NetFactoryOptions = {}): SessionFactory {
  const addressOf = (c: DiscoveredController): string =>
    `${c.address}:${c.port ?? opts.port ?? DEFAULT_NET_PORT}`;

  return {
    async open(controller: DiscoveredController, { timeoutMs }: OpenOptions): Promise<SessionLike> {
      const address = addressOf(controller);
      let session: NetSession;
      try {
        session = net.open(address);
      } catch (err) {
        throw new DeviceError('PROTOCOL', `cannot open ${address}: ${(err as Error).message}`);
      }
      // @novastar/net builds its Connection already "open", so isConnected says nothing about the
      // TCP handshake: wait on the socket itself.
      const socket = session.connection.stream;
      if (socket.destroyed) throw new DeviceError('PROTOCOL', `connection to ${address} is closed`);
      if (socket.connecting) {
        await new Promise<void>((resolve, reject) => {
          const done = (err?: DeviceError): void => {
            clearTimeout(timer);
            socket.off('connect', onConnect);
            socket.off('close', onClose);
            socket.off('error', onError);
            if (err) reject(err);
            else resolve();
          };
          const onConnect = (): void => done();
          const onClose = (): void => done(new DeviceError('PROTOCOL', `connection to ${address} failed or was closed`));
          const onError = (e: Error): void => done(new DeviceError('PROTOCOL', `cannot reach ${address}: ${e.message}`));
          const timer = setTimeout(() => {
            net.close(address);
            done(new DeviceError('TIMEOUT', `timed out connecting to ${address}`));
          }, timeoutMs);
          socket.once('connect', onConnect);
          socket.once('close', onClose);
          socket.once('error', onError);
        });
      }
      session.connection.timeout = timeoutMs;
      return session as unknown as SessionLike;
    },
    async close(controller: DiscoveredController): Promise<void> {
      const address = addressOf(controller);
      net.close(address);
      // net.close() destroys the socket; the session entry disappears asynchronously.
      for (let i = 0; i < 100 && net.sessions[address] !== undefined; i += 1) await sleep(10);
    },
  };
}

export interface SerialFactoryOptions {
  baudRate?: number;
}

/** Session factory for USB/COM controllers using the real `@novastar/serial` binding. */
export function createSerialSessionFactory(opts: SerialFactoryOptions = {}): SessionFactory {
  return {
    async open(controller: DiscoveredController, { timeoutMs }: OpenOptions): Promise<SessionLike> {
      try {
        const session = await serial.open({
          path: controller.address,
          baudRate: opts.baudRate ?? DEFAULT_BAUD_RATE,
        });
        session.connection.timeout = timeoutMs;
        return session as unknown as SessionLike;
      } catch (err) {
        throw new DeviceError('PROTOCOL', `cannot open ${controller.address}: ${(err as Error).message}`);
      }
    },
    async close(controller: DiscoveredController): Promise<void> {
      serial.close(controller.address);
    },
  };
}

/** Routes to the serial or net factory by `controller.transport`. */
export function createDefaultSessionFactory(
  opts: { net?: NetFactoryOptions; serial?: SerialFactoryOptions } = {},
): SessionFactory {
  const n = createNetSessionFactory(opts.net);
  const s = createSerialSessionFactory(opts.serial);
  const pick = (c: DiscoveredController): SessionFactory => (c.transport === 'serial' ? s : n);
  return {
    open: (c, o) => pick(c).open(c, o),
    close: async (c, session) => {
      await pick(c).close?.(c, session);
    },
  };
}
