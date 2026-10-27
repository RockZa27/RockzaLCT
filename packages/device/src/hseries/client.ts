// UDP client for the H series JSON protocol (see protocol.ts for the wire format and sources).
//
// Behaviour:
//  - One connected UDP socket per client (`socket.connect(port, host)`), so only datagrams from the
//    device are delivered and "nothing listens there" surfaces as ECONNREFUSED right away instead
//    of after a full timeout.
//  - Requests are serialised (one in flight at a time) and replies are matched by `cmd`, which is
//    how the reference module matches them too (index.js:42). Replies for other commands (late
//    answers to an earlier timed-out request, device chatter) are ignored.
//  - When a request times out, the requests that were already queued behind it fail at once with
//    TIMEOUT instead of each burning its own retries against a device that just went silent (a
//    page refreshing four lists would otherwise wait four times as long). Requests made after the
//    timeout are tried normally.
//  - Each attempt waits `timeoutMs`; on silence the datagram is re-sent, up to `retries` extra
//    attempts (capped at MAX_RETRIES), then DeviceError('TIMEOUT').
//  - ack other than "Ok" -> DeviceError('PROTOCOL') (the reference module drops such replies
//    silently, main.js:981-986; we surface them instead).
//  - A datagram that is not a JSON array with a `cmd` is "malformed": ignored, but if the request
//    then times out the error is PROTOCOL ("malformed reply") rather than TIMEOUT, so a device
//    that answers garbage is distinguishable from one that is silent.

import { createSocket, type Socket } from 'node:dgram';
import { DeviceError } from '@rockzalct/shared';
import { decodeReply, encodeRequest, type HSeriesReply, type HSeriesRequest } from './protocol.js';

/** Upper bound for `retries`, whatever the caller asks for. */
export const MAX_RETRIES = 5;

export interface HSeriesClientOptions {
  host: string;
  port: number;
  /** Wait per attempt, default 2000 ms. */
  timeoutMs?: number;
  /** Extra attempts after the first on silence, default 2, capped at MAX_RETRIES. */
  retries?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
}

interface Pending {
  cmd: string;
  resolve(reply: HSeriesReply): void;
  reject(err: DeviceError): void;
}

export class HSeriesClient {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private socket: Socket | undefined;
  private ready: Promise<Socket> | undefined;
  private pending: Pending | undefined;
  private malformed = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Bumped on every TIMEOUT; requests queued under an older epoch are failed without I/O. */
  private epoch = 0;

  constructor(opts: HSeriesClientOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.retries = clampRetries(opts.retries ?? 2);
  }

  /** Send `req` and resolve with the matching reply. Queued behind earlier requests. */
  request(req: HSeriesRequest, opts: RequestOptions = {}): Promise<HSeriesReply> {
    const epoch = this.epoch;
    const run = (): Promise<HSeriesReply> => this.exchange(req, opts, epoch);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Close the socket; in-flight and later requests fail with NOT_CONNECTED. */
  close(): void {
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new DeviceError('NOT_CONNECTED', `H series client for ${this.host}:${this.port} is closed`));
    const socket = this.socket;
    this.socket = undefined;
    this.ready = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  private open(): Promise<Socket> {
    if (this.closed) {
      return Promise.reject(new DeviceError('NOT_CONNECTED', `H series client for ${this.host}:${this.port} is closed`));
    }
    if (this.ready) return this.ready;
    const ready = new Promise<Socket>((resolve, reject) => {
      const socket = createSocket('udp4');
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // ignore
        }
        this.ready = undefined;
        reject(new DeviceError('PROTOCOL', `cannot open UDP ${this.host}:${this.port}: ${err.message}`));
      };
      socket.once('error', fail);
      socket.on('message', (msg) => this.onMessage(msg));
      socket.on('error', (err: NodeJS.ErrnoException) => this.onSocketError(err));
      try {
        socket.connect(this.port, this.host, () => {
          if (settled) return;
          settled = true;
          socket.off('error', fail);
          this.socket = socket;
          resolve(socket);
        });
      } catch (err) {
        fail(err as Error);
      }
    });
    this.ready = ready;
    return ready;
  }

  private onMessage(msg: Buffer): void {
    const pending = this.pending;
    if (!pending) return;
    const reply = decodeReply(msg);
    if (!reply) {
      this.malformed += 1;
      return;
    }
    if (reply.cmd !== pending.cmd) return; // not ours (late reply / unsolicited)
    this.pending = undefined;
    if (reply.ack !== 'Ok') {
      pending.reject(
        new DeviceError('PROTOCOL', `${pending.cmd} rejected by the device (ack=${JSON.stringify(reply.ack ?? null)})`),
      );
      return;
    }
    pending.resolve(reply);
  }

  /** ICMP "port unreachable" on a connected UDP socket arrives here as ECONNREFUSED. */
  private onSocketError(err: NodeJS.ErrnoException): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const why =
      err.code === 'ECONNREFUSED'
        ? `nothing is listening on UDP ${this.host}:${this.port}`
        : `UDP error for ${this.host}:${this.port}: ${err.message}`;
    pending.reject(new DeviceError('PROTOCOL', why));
  }

  private async exchange(req: HSeriesRequest, opts: RequestOptions, epoch: number): Promise<HSeriesReply> {
    if (epoch !== this.epoch) {
      throw new DeviceError('TIMEOUT', `${req.cmd}: skipped, an earlier request to ${this.host}:${this.port} timed out`);
    }
    const socket = await this.open();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const attempts = 1 + clampRetries(opts.retries ?? this.retries);
    const datagram = encodeRequest(req);
    this.malformed = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const outcome = await new Promise<HSeriesReply | 'silent'>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending === entry) this.pending = undefined;
          resolve('silent');
        }, timeoutMs);
        const entry: Pending = {
          cmd: req.cmd,
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        this.pending = entry;
        socket.send(datagram, (err) => {
          if (!err || this.pending !== entry) return;
          this.pending = undefined;
          clearTimeout(timer);
          reject(new DeviceError('PROTOCOL', `UDP send to ${this.host}:${this.port} failed: ${err.message}`));
        });
      });
      if (outcome !== 'silent') return outcome;
    }
    if (this.malformed > 0) {
      throw new DeviceError('PROTOCOL', `${req.cmd}: device answered with malformed data (${this.malformed} datagram(s))`);
    }
    this.epoch += 1;
    throw new DeviceError('TIMEOUT', `${req.cmd}: no reply from ${this.host}:${this.port} after ${attempts} attempt(s)`);
  }
}

function clampRetries(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_RETRIES, Math.max(0, Math.floor(n))) : 0;
}
