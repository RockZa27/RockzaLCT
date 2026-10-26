import { connect, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { net, type NetSession } from '@novastar/net';
import { DeviceType, ErrorType, Packet, Request, ResponseError } from '@novastar/codec';
// Real generated API from @novastar/native: each import adds methods to Session.prototype.
import '@novastar/native/api/ReadGlobalBrightness';
import '@novastar/native/api/SetGlobalBrightness';
import '@novastar/native/api/ReadRGBBrightness';
import '@novastar/native/api/SetRGBBrightness';
import '@novastar/native/api/ReadAllBrightnessInfo';
import '@novastar/native/api/ReadControllerModelId';
import '@novastar/native/api/ReadSender_McuProgramEdition';
import '@novastar/native/api/ReadSender_McuProgramInfo';
import '@novastar/native/api/ReadSender_FPGAProgramEdition';
import '@novastar/native/api/ReadNumberOfCardOrScanBoardInPort';
import '@novastar/native/api/ReadScanerCountOfSenderCard';
import { startSimulator, computeCrc, type SimulatorHandle } from '../src/index.js';

// The generated methods are added to Session at runtime; type them loosely here.
type Api = NetSession & {
  ReadGlobalBrightness(a: number, p: number, r: number): Promise<number>;
  SetGlobalBrightness(a: number, p: number, r: number, b: boolean, v: number): Promise<void>;
  ReadRGBBrightness(a: number, p: number, r: number): Promise<number>;
  SetRGBBrightness(
    a: number, p: number, r: number, b: boolean, R: number, G: number, B: number, V: number,
  ): Promise<void>;
  ReadAllBrightnessInfo(a: number, p: number, r: number): Promise<Buffer>;
  ReadControllerModelId(a: number): Promise<number>;
  ReadSender_McuProgramEdition(a: number): Promise<number>;
  ReadSender_McuProgramInfo(a: number): Promise<Buffer>;
  ReadSender_FPGAProgramEdition(a: number): Promise<number>;
  ReadNumberOfCardOrScanBoardInPort(a: number, port: number, cardType: number): Promise<number>;
  ReadScanerCountOfSenderCard(a: number): Promise<Buffer>;
};

let sim: SimulatorHandle;
const sessions: NetSession[] = [];

const open = async (): Promise<Api> => {
  const s = net.open(`127.0.0.1:${sim.port}`) as Api;
  sessions.push(s);
  return s;
};

beforeAll(async () => {
  sim = await startSimulator({ port: 0, host: '127.0.0.1', outputPorts: 2, receivingCards: 4 });
});
/** net.release() closes sockets asynchronously and net.open() caches sessions by address. */
const settle = async (): Promise<void> => {
  net.release();
  for (let i = 0; i < 100 && (Object.keys(net.sessions).length > 0 || sim.state.connections > 0); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
};
afterEach(async () => {
  await settle();
  sessions.length = 0;
});
afterAll(async () => {
  await sim.close();
});

/** Encode a request exactly as the codec's NovastarEncoder does. */
function encode(req: Request<boolean>): Buffer {
  Request.crc(req, true);
  return Buffer.from(Request.raw(req));
}

/** Raw socket helper that collects decoded response packets. */
function rawClient(): Promise<{ sock: Socket; next(): Promise<Packet>; send(b: Buffer): void }> {
  return new Promise((resolve, reject) => {
    const sock = connect(sim.port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const waiters: Array<(p: Packet) => void> = [];
    const ready: Packet[] = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < Packet.baseSize) return;
        const total = buf.readUInt16LE(16) + Packet.baseSize;
        if (buf.length < total) return;
        const pkt = new Packet(buf.subarray(0, total));
        buf = buf.subarray(total);
        const w = waiters.shift();
        if (w) w(pkt);
        else ready.push(pkt);
      }
    });
    sock.once('error', reject);
    sock.once('connect', () =>
      resolve({
        sock,
        send: (b) => void sock.write(b),
        next: () =>
          new Promise<Packet>((res, rej) => {
            const p = ready.shift();
            if (p) return res(p);
            const t = setTimeout(() => rej(new Error('timeout waiting for response')), 3000);
            waiters.push((x) => {
              clearTimeout(t);
              res(x);
            });
          }),
      }),
    );
  });
}

describe('real @novastar/net + codec client against the simulator', () => {
  it('connects and reads default brightness', async () => {
    const s = await open();
    expect(await s.ReadGlobalBrightness(0, 0, 0)).toBe(204);
  });

  it('writes brightness and reads it back (and persists across connections)', async () => {
    const s = await open();
    await s.SetGlobalBrightness(0, 1, 0, false, 77);
    expect(await s.ReadGlobalBrightness(0, 1, 0)).toBe(77);
    // other card untouched
    expect(await s.ReadGlobalBrightness(0, 0, 0)).toBe(204);
    await settle();
    const s2 = await open();
    expect(await s2.ReadGlobalBrightness(0, 1, 0)).toBe(77);
  });

  it('reads/writes RGB gains and the combined brightness block', async () => {
    const s = await open();
    expect(await s.ReadRGBBrightness(0, 0, 0)).toBe(0xffffffff);
    await s.SetRGBBrightness(0, 0, 1, false, 250, 240, 230, 255);
    const rgb = await s.ReadRGBBrightness(0, 0, 1);
    expect(rgb & 0xff).toBe(250);
    expect((rgb >>> 8) & 0xff).toBe(240);
    expect((rgb >>> 16) & 0xff).toBe(230);
    const all = await s.ReadAllBrightnessInfo(0, 0, 1);
    expect([...all]).toEqual([204, 250, 240, 230, 255]);
  });

  it('reads device info: model id, firmware editions, card counts', async () => {
    const s = await open();
    expect(await s.ReadControllerModelId(0)).toBe(0x0660);
    const mcu = await s.ReadSender_McuProgramEdition(0);
    expect(mcu).toBe(sim.state.sendingCard.read(0x04000004, 4).readUInt32LE(0));
    expect(mcu >>> 24).toBe(1); // major
    expect(await s.ReadSender_FPGAProgramEdition(0)).toBe(mcu);
    const info = await s.ReadSender_McuProgramInfo(0);
    expect(info.length).toBe(256);
    expect(info.toString('ascii', 8).replace(/\0+$/, '')).toContain('MCTRL660 MCU v1.2.3');
    // 4 cards over 2 ports => 2 per port
    expect(await s.ReadNumberOfCardOrScanBoardInPort(0, 0, 0)).toBe(2);
    expect(await s.ReadNumberOfCardOrScanBoardInPort(0, 1, 0)).toBe(2);
    expect(await s.ReadNumberOfCardOrScanBoardInPort(0, 2, 0)).toBe(0);
    const scan = await s.ReadScanerCountOfSenderCard(0);
    expect(scan.length).toBe(19);
    expect([scan[0], scan[1], scan[2]]).toEqual([2, 2, 0]);
  });

  it('a card that is not on the chain yields a non-fatal downstream-timeout ack', async () => {
    const s = await open();
    await expect(s.ReadGlobalBrightness(0, 0, 9)).rejects.toBeInstanceOf(ResponseError);
    // connection still fine
    expect(await s.ReadGlobalBrightness(0, 0, 0)).toBe(204);
  });

  it('handles many sequential and concurrent requests on one connection', async () => {
    const s = await open();
    for (let i = 0; i < 50; i += 1) {
      await s.SetGlobalBrightness(0, 0, 0, false, i);
      expect(await s.ReadGlobalBrightness(0, 0, 0)).toBe(i);
    }
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => s.ReadGlobalBrightness(0, i % 2, 0)),
    );
    expect(results).toHaveLength(40);
  });

  it('supports multiple concurrent clients', async () => {
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => {
        const sock = connect(sim.port, '127.0.0.1');
        return new Promise<Socket>((r) => sock.once('connect', () => r(sock)));
      }),
    );
    try {
      for (let i = 0; i < 100 && sim.state.connections < 5; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(sim.state.connections).toBeGreaterThanOrEqual(5);
      // every client gets its own, independent answers
      const bufs = await Promise.all(clients.map((c, i) => {
        const req = new Request(1);
        req.deviceType = DeviceType.ReceivingCard;
        req.address = 0x02000001;
        req.rcvIndex = i % 2;
        return new Promise<Packet>((resolve) => {
          c.once('data', (d) => resolve(new Packet(d)));
          c.write(encode(req));
        });
      }));
      expect(bufs.every((p) => p.ack === 0 && p.data.length === 1)).toBe(true);
    } finally {
      clients.forEach((c) => c.destroy());
    }
    const s = await open();
    expect(await s.ReadControllerModelId(0)).toBe(0x0660);
  });
});

describe('wire-level behaviour', () => {
  it('echoes serno, uses 55AA response framing and a codec-valid CRC', async () => {
    const c = await rawClient();
    const req = new Request(4);
    req.deviceType = DeviceType.ReceivingCard;
    req.address = 0x02000002;
    const res = await (async () => {
      c.send(encode(req));
      return c.next();
    })();
    expect(res.head).toBe(0x55aa);
    expect(res.serno).toBe(req.serno);
    expect(res.destination).toBe(0xfe);
    expect(res.ack).toBe(ErrorType.Succeeded);
    expect(res.address).toBe(0x02000002);
    expect([...res.data]).toEqual([255, 255, 255, 255]);
    expect(Packet.crc(res)).toBe(res.crc); // codec's own checksum agrees
    expect(computeCrc(Buffer.from(Packet.raw(res)))).toBe(res.crc);
    c.sock.destroy();
  });

  it('unwritten addresses read as zeros', async () => {
    const c = await rawClient();
    const req = new Request(8);
    req.deviceType = DeviceType.SendingCard;
    req.address = 0x0badf00d;
    c.send(encode(req));
    const res = await c.next();
    expect([...res.data]).toEqual(new Array(8).fill(0));
    c.sock.destroy();
  });

  it('reassembles a request split across TCP chunks (byte by byte)', async () => {
    const c = await rawClient();
    const w = new Request([123]);
    w.deviceType = DeviceType.ReceivingCard;
    w.address = 0x02000001;
    const wb = encode(w);
    for (const byte of wb) {
      c.send(Buffer.from([byte]));
      await new Promise((r) => setTimeout(r, 1));
    }
    const ack = await c.next();
    expect(ack.serno).toBe(w.serno);
    expect(ack.ack).toBe(0);

    // two reads glued together and cut mid-frame
    const r1 = new Request(1);
    r1.deviceType = DeviceType.ReceivingCard;
    r1.address = 0x02000001;
    const r2 = new Request(1);
    r2.deviceType = DeviceType.ReceivingCard;
    r2.address = 0x02000001;
    const both = Buffer.concat([encode(r1), encode(r2)]);
    c.send(both.subarray(0, 27));
    await new Promise((r) => setTimeout(r, 20));
    c.send(both.subarray(27));
    const a = await c.next();
    const b = await c.next();
    expect([a.serno, b.serno]).toEqual([r1.serno, r2.serno]);
    expect(a.data[0]).toBe(123);
    expect(b.data[0]).toBe(123);
    c.sock.destroy();
  });

  it('survives garbage, bad CRC, truncated and unknown packets', async () => {
    const c = await rawClient();
    c.send(Buffer.from('this is not a novastar packet at all\n'));
    c.send(Buffer.from([0x55, 0xaa, 0x55, 0xaa, 0x00])); // preamble spam, truncated
    const bad = new Request(2);
    bad.deviceType = DeviceType.SendingCard;
    bad.address = 2;
    const badBuf = encode(bad);
    badBuf[badBuf.length - 1] ^= 0xff; // corrupt CRC
    c.send(badBuf);
    const weird = new Request(2); // unknown device type 9 + valid CRC
    weird.deviceType = 9;
    weird.address = 2;
    c.send(encode(weird));
    const unk = await c.next();
    expect(unk.serno).toBe(weird.serno);
    expect(unk.ack).toBe(ErrorType.UnknownCommand);

    // the server still answers a good request on the same connection ...
    const good = new Request(2);
    good.deviceType = DeviceType.SendingCard;
    good.address = 2;
    c.send(encode(good));
    const res = await c.next();
    expect(res.serno).toBe(good.serno);
    expect(res.data.readUInt16LE(0)).toBe(0x0660);
    c.sock.destroy();

    // ... and for brand-new clients
    const s = await open();
    expect(await s.ReadControllerModelId(0)).toBe(0x0660);
  });
});
