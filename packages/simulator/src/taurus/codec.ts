// The slice of @novastar/taurus the simulator uses to read requests and write responses.
//
// The simulator is protocol-faithful by construction: it does not carry its own Taurus framing, it
// is handed the library's packet codec (TaurusPacket, decodeTaurusPacket, getTaurusPacketSize,
// calculateTaurusHeaderChecksum and the packet-type constants) by its caller. The caller passes
// `import * as taurus from '@novastar/taurus'`; this package therefore needs no dependency of its
// own on the library (packages/device and apps/desktop already depend on it).
//
// The types below are structural subsets of the library's exports, so passing the module namespace
// to `startTaurusSimulator` is checked by the compiler against the real typings.

export interface TaurusWirePacket {
  sequence: number;
  packetType: number;
  what: number;
  req: { action: number; type: number };
  res: { status: number; action: number; type: number };
  length: number;
  encodeType: number;
  checksum: number;
  readonly body: Buffer;
}

export interface TaurusCodec {
  TAURUS_HEADER_SIZE: number;
  TAURUS_REQUEST: number;
  TAURUS_RESPONSE: number;
  TAURUS_DISCOVERY: number;
  TaurusPacket: {
    new (size: number): TaurusWirePacket;
    raw(packet: TaurusWirePacket): Buffer;
  };
  getTaurusPacketSize(buffer: Uint8Array): number | undefined;
  decodeTaurusPacket(buffer: Uint8Array): TaurusWirePacket;
  calculateTaurusHeaderChecksum(header: Uint8Array): number;
}

/** Encode a packet with the library's struct: used for responses and discovery answers. */
export function encodeResponse(
  codec: TaurusCodec,
  packetType: number,
  fields: { sequence: number; what: number; status: number; action: number; type: number },
  body: string | Buffer = '',
): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const packet = new codec.TaurusPacket(codec.TAURUS_HEADER_SIZE + payload.length);
  packet.sequence = fields.sequence;
  packet.packetType = packetType;
  packet.what = fields.what;
  packet.res.status = fields.status;
  packet.res.action = fields.action;
  packet.res.type = fields.type;
  packet.length = payload.length;
  packet.encodeType = 0;
  payload.copy(packet.body);
  const raw = codec.TaurusPacket.raw(packet);
  // Same rule the library applies to requests: header checksum over the bytes before the field.
  packet.checksum = codec.calculateTaurusHeaderChecksum(raw);
  return raw;
}
