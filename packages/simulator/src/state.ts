import { DeviceMemory } from './memory.js';
import { DeviceType, ErrorType, IO, type ParsedRequest } from './protocol.js';

/**
 * Register addresses used by the real @novastar/native API (the generated companion of
 * @novastar/codec; each `dist/api/<Name>.mjs` sets `req.address`, `req.deviceType` and the read
 * length). The constant's origin is noted per entry.
 */
export const ADDR = {
  /** ReadControllerModelId: deviceType 0 (sender), 2 bytes @ 0x2 */
  controllerModelId: 0x0000_0002,
  /** ReadGlobalBrightness / SetGlobalBrightness / ReadAllBrightnessInfo: deviceType 1, u8 @ 0x02000001 */
  globalBrightness: 0x0200_0001,
  /** ReadRGBBrightness / SetRGBBrightness / ReadRedBrightness: deviceType 1, 4 bytes (R,G,B,vR) @ 0x02000002 */
  rgbBrightness: 0x0200_0002,
  /** ReadScanerCountOfSenderCard: deviceType 0, 19 bytes @ 0x02800010 */
  scannerCountOfSender: 0x0280_0010,
  /** ReadNumberOfCardOrScanBoardInPort: u16 @ base + portIndex*32 + cardType*2 (base differs for port >= 8) */
  cardCountBaseLow: 0x0310_0000,
  cardCountBaseHigh: 0x0310_0200,
  /** ReadSender_McuProgramInfo: 256 bytes @ 0x04000000; ReadSender_McuProgramEdition: u32 @ 0x04000004 */
  mcuProgramInfo: 0x0400_0000,
  mcuProgramEdition: 0x0400_0004,
  /** ReadSender_FPGAProgramEdition: u32 @ 0x04100004 */
  fpgaProgramEdition: 0x0410_0004,
} as const;

/** Address of the u16 "cards on this port" register, mirroring ReadNumberOfCardOrScanBoardInPort. */
export function cardCountAddress(portIndex: number, cardType: number): number {
  return portIndex < 8
    ? ADDR.cardCountBaseLow + portIndex * 32 + cardType * 2
    : ADDR.cardCountBaseHigh + portIndex * 32 + cardType * 2;
}

/**
 * Simulator-assigned model ids. These are NOT claimed to match real hardware ids; they only
 * need to round-trip through ReadControllerModelId.
 */
const MODEL_IDS: Record<string, number> = {
  MCTRL300: 0x0300,
  MCTRL660: 0x0660,
  MCTRL700: 0x0700,
  MCTRL4K: 0x4000,
  VX4S: 0x0104,
  VX16S: 0x0116,
};

export interface SimulatorOptions {
  /** TCP port; 0 (default 5200 only in the CLI) picks a random free port. */
  port?: number;
  host?: string;
  /** Sending-card model label, default "MCTRL660". */
  model?: string;
  /** Number of Ethernet output ports on the sending card, default 4. */
  outputPorts?: number;
  /** Number of receiving cards, spread over the output ports, default 4. */
  receivingCards?: number;
}

export interface ReceivingCardState {
  portIndex: number;
  cardIndex: number;
  memory: DeviceMemory;
}

export interface SimulatorState {
  model: string;
  outputPorts: number;
  firmwareVersion: string;
  sendingCard: DeviceMemory;
  functionCard: DeviceMemory;
  receivingCards: ReceivingCardState[];
  /** Total requests answered (any outcome); handy for tests. */
  requestCount: number;
  /** Currently open client connections. */
  connections: number;
}

const FIRMWARE = { major: 1, minor: 2, patch: 3, build: 0 };

export function createState(opts: SimulatorOptions = {}): SimulatorState {
  const model = opts.model ?? 'MCTRL660';
  const outputPorts = opts.outputPorts ?? 4;
  const count = opts.receivingCards ?? 4;
  if (!Number.isInteger(outputPorts) || outputPorts < 1 || outputPorts > 32) {
    throw new RangeError(`outputPorts must be 1..32, got ${outputPorts}`);
  }
  if (!Number.isInteger(count) || count < 0 || count > 1024) {
    throw new RangeError(`receivingCards must be 0..1024, got ${count}`);
  }

  const sendingCard = new DeviceMemory();
  const firmwareVersion = `${FIRMWARE.major}.${FIRMWARE.minor}.${FIRMWARE.patch}`;
  const edition =
    ((FIRMWARE.major << 24) | (FIRMWARE.minor << 16) | (FIRMWARE.patch << 8) | FIRMWARE.build) >>> 0;

  sendingCard.writeU16LE(ADDR.controllerModelId, MODEL_IDS[model] ?? 0x0660);
  // MCU program info block: bytes 4..7 hold the edition (it overlaps the info block in the real
  // map); the rest is simulator-defined ASCII, NUL padded.
  const info = Buffer.alloc(256);
  info.writeUInt32LE(edition, 4);
  info.write(`${model} MCU v${firmwareVersion} (RockzaLCT simulator)`, 8, 'ascii');
  sendingCard.write(ADDR.mcuProgramInfo, info);
  sendingCard.writeU32LE(ADDR.fpgaProgramEdition, edition);

  const receivingCards: ReceivingCardState[] = [];
  const perPort = new Array<number>(outputPorts).fill(0);
  for (let i = 0; i < count; i += 1) {
    const portIndex = i % outputPorts;
    const cardIndex = Math.floor(i / outputPorts);
    perPort[portIndex]! += 1;
    const memory = new DeviceMemory();
    memory.writeU8(ADDR.globalBrightness, 204); // 80 %
    memory.write(ADDR.rgbBrightness, Buffer.from([255, 255, 255, 255]));
    receivingCards.push({ portIndex, cardIndex, memory });
  }
  perPort.forEach((n, port) => {
    sendingCard.writeU16LE(cardCountAddress(port, 0), n);
    if (port < 19) sendingCard.writeU8(ADDR.scannerCountOfSender + port, n);
  });

  return {
    model,
    outputPorts,
    firmwareVersion,
    sendingCard,
    functionCard: new DeviceMemory(),
    receivingCards,
    requestCount: 0,
    connections: 0,
  };
}

export interface HandlerResult {
  ack: number;
  data: Buffer;
}

const PORT_BROADCAST = 0xff;
const RCV_BROADCAST = 0xffff;

/** Execute one parsed request against the device memories. */
export function handleRequest(state: SimulatorState, req: ParsedRequest): HandlerResult {
  const none = Buffer.alloc(0);
  if (req.io !== IO.Read && req.io !== IO.Write) return { ack: ErrorType.UnknownCommand, data: none };

  let targets: DeviceMemory[];
  switch (req.deviceType) {
    case DeviceType.SendingCard:
      targets = [state.sendingCard];
      break;
    case DeviceType.FunctionCard:
      targets = [state.functionCard];
      break;
    case DeviceType.ReceivingCard: {
      const matching = state.receivingCards.filter(
        (c) =>
          (req.port === PORT_BROADCAST || c.portIndex === req.port) &&
          (req.rcvIndex === RCV_BROADCAST || c.cardIndex === req.rcvIndex),
      );
      // A card that is not on the chain does not answer; the sender reports a downstream timeout
      // (ErrorType.Timeout, which Connection.listener treats as a normal, silent ack).
      if (matching.length === 0) return { ack: ErrorType.Timeout, data: none };
      targets = matching.map((c) => c.memory);
      break;
    }
    default:
      return { ack: ErrorType.UnknownCommand, data: none };
  }

  if (req.io === IO.Read) {
    return { ack: ErrorType.Succeeded, data: targets[0]!.read(req.address, req.length) };
  }
  for (const t of targets) t.write(req.address, req.data);
  return { ack: ErrorType.Succeeded, data: none };
}
