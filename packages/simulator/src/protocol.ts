/**
 * Device-side NovaStar framing. Everything here mirrors @novastar/codec (2.2.x),
 * whose TypeScript sources ship in dist/index.mjs.map:
 *
 *  - Packet layout ........ src/Packet.ts  (`Packet` Struct; baseSize 20, data at offset 18)
 *  - CRC .................. src/Packet.ts  (`CRC16LE` calc: 0x5555 + sum of bytes, mod 0x10000,
 *                            summed from byte offset 2 up to the CRC field)
 *  - Request framing ...... src/Request.ts (a read request carries NO data bytes even though
 *                            `length` holds the requested size; a write carries `length` bytes
 *                            -- see Request.makeChunks: bufSize = baseSize + (Write ? length : 0))
 *  - Response framing ..... src/NovastarDecoder.ts (`recognize`: preamble AA 55, frame size =
 *                            length + baseSize, bad CRC => resync one byte later, a response is
 *                            only delivered when destination === COMPUTER 0xFE)
 *  - serno matching ....... src/Connection.ts (`listener` matches response.serno to request.serno)
 *  - ack codes ............ src/Packet.ts `ErrorType`
 */

/** Packet.ts REQUEST (0xaa55, UInt16LE => bytes 55 AA) */
export const REQUEST = 0xaa55;
/** Packet.ts RESPONSE (0x55aa, UInt16LE => bytes AA 55) */
export const RESPONSE = 0x55aa;
/** Packet.ts COMPUTER */
export const COMPUTER = 0xfe;

/** Packet.ts DeviceType */
export const DeviceType = { SendingCard: 0, ReceivingCard: 1, FunctionCard: 2 } as const;
/** Packet.ts IO */
export const IO = { Read: 0, Write: 1 } as const;
/** Packet.ts ErrorType */
export const ErrorType = {
  Succeeded: 0,
  Timeout: 1,
  RequestCRCError: 2,
  ResponseCRCError: 3,
  UnknownCommand: 4,
} as const;

/** Field offsets, derived from the Packet Struct definition order in Packet.ts. */
export const OFF = {
  head: 0, // UInt16LE
  ack: 2,
  serno: 3,
  source: 4,
  destination: 5,
  deviceType: 6,
  port: 7,
  rcvIndex: 8, // UInt16LE
  io: 10,
  // 11: seek(1) padding
  address: 12, // UInt32LE
  length: 16, // UInt16LE
  data: 18,
} as const;

/** Packet.baseSize: header (18) + CRC16 (2). */
export const BASE_SIZE = 20;

/** Packet.ts CRC16LE calc, start: 2. `frame` includes the trailing 2 CRC bytes. */
export function computeCrc(frame: Buffer): number {
  let crc = 0x5555;
  for (let i = 2; i < frame.length - 2; i += 1) crc = (crc + frame[i]!) % 0x10000;
  return crc;
}

export interface ParsedRequest {
  ack: number;
  serno: number;
  source: number;
  destination: number;
  deviceType: number;
  port: number;
  rcvIndex: number;
  io: number;
  address: number;
  length: number;
  data: Buffer;
}

const REQUEST_PREAMBLE = Buffer.from([REQUEST & 0xff, REQUEST >>> 8]); // 55 AA
/** Upper bound on buffered bytes while waiting for a frame (max frame is 20 + 65535). */
const MAX_BUFFERED = BASE_SIZE + 0xffff;

/**
 * Incremental request parser, the device-side twin of NovastarDecoder.recognize():
 * accumulates chunks, hunts for the preamble, waits for a full frame, validates the CRC
 * and, on any mismatch, resynchronises one byte after the failed preamble.
 */
export class RequestParser {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk; returns every complete, CRC-valid request found. */
  push(chunk: Buffer): ParsedRequest[] {
    const out: ParsedRequest[] = [];
    this.buf = Buffer.concat([this.buf, chunk]);
    let offset = 0;
    for (;;) {
      const rest = this.buf.length - offset;
      if (rest <= 0) {
        this.buf = Buffer.alloc(0);
        break;
      }
      const start = this.buf.indexOf(
        rest < REQUEST_PREAMBLE.length ? REQUEST_PREAMBLE.subarray(0, rest) : REQUEST_PREAMBLE,
        offset,
      );
      if (start === -1) {
        this.buf = Buffer.alloc(0);
        break;
      }
      const frame = this.buf.subarray(start);
      if (frame.length < BASE_SIZE) {
        this.buf = Buffer.from(frame);
        break;
      }
      const io = frame[OFF.io]!;
      const length = frame.readUInt16LE(OFF.length);
      const total = BASE_SIZE + (io === IO.Write ? length : 0);
      if (frame.length < total) {
        this.buf = Buffer.from(frame);
        break;
      }
      const raw = frame.subarray(0, total);
      if (computeCrc(raw) === raw.readUInt16LE(total - 2)) {
        out.push({
          ack: raw[OFF.ack]!,
          serno: raw[OFF.serno]!,
          source: raw[OFF.source]!,
          destination: raw[OFF.destination]!,
          deviceType: raw[OFF.deviceType]!,
          port: raw[OFF.port]!,
          rcvIndex: raw.readUInt16LE(OFF.rcvIndex),
          io,
          address: raw.readUInt32LE(OFF.address),
          length,
          data: Buffer.from(raw.subarray(OFF.data, OFF.data + (io === IO.Write ? length : 0))),
        });
        offset = start + total;
      } else {
        offset = start + 1; // NovastarDecoder: `if (offset <= start) offset = start + 1`
      }
    }
    if (this.buf.length > MAX_BUFFERED) this.buf = Buffer.alloc(0);
    return out;
  }
}

/**
 * Build a response frame. Mirrors the Packet struct: head RESPONSE, serno echoed (Connection.listener
 * matches on it), destination COMPUTER (NovastarDecoder drops anything else), CRC appended.
 */
export function buildResponse(req: ParsedRequest, ack: number, data: Buffer): Buffer {
  const frame = Buffer.alloc(BASE_SIZE + data.length);
  frame.writeUInt16LE(RESPONSE, OFF.head);
  frame[OFF.ack] = ack;
  frame[OFF.serno] = req.serno;
  frame[OFF.source] = req.destination; // reply comes from the addressed device
  frame[OFF.destination] = COMPUTER;
  frame[OFF.deviceType] = req.deviceType;
  frame[OFF.port] = req.port;
  frame.writeUInt16LE(req.rcvIndex, OFF.rcvIndex);
  frame[OFF.io] = req.io;
  frame.writeUInt32LE(req.address >>> 0, OFF.address);
  frame.writeUInt16LE(data.length, OFF.length); // decoder sizes the frame from this field
  data.copy(frame, OFF.data);
  frame.writeUInt16LE(computeCrc(frame), frame.length - 2);
  return frame;
}
