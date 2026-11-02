// Pixel mapping step of the Smart Settings wizard (3rd-generation path): the module point table
// (0x03000000), the scan sequence (0x1C000100) and the chip-independent geometry registers, written
// to a receiving card in RAM only.
//
// Source: our own spec of NovaLCT's Smart Settings behaviour (sections B1, B4, C, E, F of
// smartsetting-spec.md; docs/novalct-protocol-notes.md Q8), nothing copied from NovaLCT. Every address
// is in PIXEL_MAPPING_REGISTERS below with where it comes from; a device test re-derives each one
// from @novastar/native where the library has a call for it.
//
// What the wizard does, in the order of the spec:
//   start   snapshot what can be read back -> sender smart mode on, DVI offset 0,0 -> kill/lock/
//           self-test off -> geometry registers -> 0x01000013 twice, 100 ms apart (the card builds its
//           own linear run-line table, so a table position n maps to picture pixel n)
//   light   NO device write: NovaLCT lights a table position by drawing one pixel of the PC picture
//           that feeds the sender (spec C). The PixelPainter does that.
//   finish  sender smart mode off -> freeze -> geometry -> point table -> scan sequence ->
//           0x01000013 twice -> unfreeze
//   cancel  sender smart mode off -> card smart mode off -> reload the parameters from flash
//           (0x01000010, the NovaLCT wizard's own undo) -> clear freeze/kill/lock
// Never written: chip timing / OE / gamma / driver config registers (geometry only: the card keeps its
// current values) and anything that saves to flash. Never implemented: 4th-generation run-line tables.
import { DeviceType, Request, type Packet } from '@novastar/codec';
import {
  DeviceError,
  buildFinalImage,
  buildGeometryRegisters,
  collectMarking,
  planPixelMapping,
  validateReceiverTarget,
  type Cell,
  type DeviceErrorCode,
  type GeometryKey,
  type PixelDisplay,
  type PixelMappingApi,
  type PixelMappingFailure,
  type PixelMappingFinishResult,
  type PixelMappingPlan,
  type PixelMappingSnapshot,
  type PixelMappingStage,
  type PixelMappingStartRequest,
  type PixelMappingStartResult,
  type PixelMappingUndoResult,
  type PixelMappingUndoStep,
  type PixelPainter,
  type ReceiverTarget,
  type RegisterImage,
} from '@rockzalct/shared';
import type { FeatureContext, SessionLease } from './context.js';
import type { SessionLike } from '../session.js';
import { sendChunked, type ChunkConnection } from './chunkedWrite.js';

const SENDER = 0;
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;

export interface PixelRegister {
  address: number;
  /** `sender` = deviceType 0, `card` = deviceType 1 (receiving card, addressed by port + index). */
  target: 'sender' | 'card';
  /** Bytes; null = variable length (tables). */
  size: number | null;
  /** Where the address comes from. */
  source: string;
}

/**
 * Register address behind every write/read of the wizard. `source` names the native
 * node_modules/@novastar/native/dist/api/<Name>.cjs (`req.address`, width of `Request(<n>)`) where one
 * exists, and the spec section. A device test re-derives every native address from those files.
 */
export const PIXEL_MAPPING_REGISTERS = {
  // sender
  senderSmartMode: { address: 0x0200_0040, target: 'sender', size: 1, source: 'SetSenderCardSmartSetMode.cjs (33554496); spec B1 step 1, F' },
  dviOffsetX: { address: 0x0200_0028, target: 'sender', size: 2, source: 'ReadDviOffsetX/SetDviOffsetX.cjs (33554472 + 8*index, index 0); spec B1 step 1.2' },
  dviOffsetY: { address: 0x0200_002a, target: 'sender', size: 2, source: 'ReadDviOffsetY/SetDviOffsetY.cjs (33554474 + 8*index, index 0); spec B1 step 1.2' },
  // card: modes
  killMode: { address: 0x0200_0100, target: 'card', size: 1, source: 'ReadKillMode/SetKillMode.cjs (33554688); spec B1 step 7, F' },
  selfTest: { address: 0x0200_0101, target: 'card', size: 1, source: 'ReadSelfTestMode/SetSelfTestMode.cjs (33554689); spec B2 item 8 (0x20 = ParaFreeze), 24 (0 = unfreeze)' },
  lockMode: { address: 0x0200_0102, target: 'card', size: 1, source: 'ReadLockMode/SetLockMode.cjs (33554690); spec B1 step 7, F' },
  smartSetMode: { address: 0x0200_0104, target: 'card', size: 1, source: 'ReadSmartSetMode/SetSmartSetMode.cjs (33554692); spec B1 step 6 SendEndSmartSetType, F' },
  // card: geometry (spec B1 steps 4-6, E)
  dataDirection: { address: 0x0200_0009, target: 'card', size: 1, source: 'ReadDataDirection/SetDataDirection.cjs (33554441); spec B1 step 4' },
  scanMode: { address: 0x0200_000d, target: 'card', size: 1, source: 'ReadScanMode/SetScanMode.cjs (33554445); spec B1 step 6' },
  groupNumInModule: { address: 0x0200_0010, target: 'card', size: 1, source: 'ReadGroupNumInModule/SetGroupNumInModule.cjs (33554448); spec B1 step 4' },
  dataGroupSequence: { address: 0x0200_0011, target: 'card', size: 4, source: 'ReadDataGroupSequence.cjs (33554449, 4 bytes; the library has no Set call, written as a plain request); spec B1 step 5' },
  controlWidth: { address: 0x0200_0017, target: 'card', size: 2, source: 'ReadControlWidth/SetControlWidth.cjs (33554455); spec B1 step 6' },
  controlHeight: { address: 0x0200_0019, target: 'card', size: 2, source: 'ReadControlHeight/SetControlHeight.cjs (33554457); spec B1 step 6' },
  physicalTotalDataGroupNum: { address: 0x0200_001b, target: 'card', size: 1, source: 'ReadPhysicalTotalDataGroupNum/SetPhysicalTotalDataGroupNum.cjs (33554459); spec B1 step 6' },
  totalPointInTable: { address: 0x0200_001d, target: 'card', size: 2, source: 'ReadTotalPointInTable/SetTotalPointInTable.cjs (33554461); spec B1 step 6, B4' },
  pointNumPerDrive: { address: 0x0200_001f, target: 'card', size: 2, source: 'ReadPointNumPerDrive/SetPointNumPerDrive.cjs (33554463); spec B1 step 6' },
  logicalTotalDataGroupNum: { address: 0x0200_0022, target: 'card', size: 1, source: 'ReadLogicalTotalDataGroupNum/SetLogicalTotalDataGroupNum.cjs (33554466); spec B1 step 6, D1' },
  shiftUnitNumPerSubField: { address: 0x0200_0032, target: 'card', size: 2, source: 'SetShiftUnitNumPerSubField.cjs (33554482); spec B1 step 6' },
  rowsCtrlByDataGroup: { address: 0x0200_0047, target: 'card', size: 8, source: 'ReadRowsCtrlByDataGroup/SetRowsCtrlByDataGroup.cjs (33554503, 8 bytes); spec B1 step 5' },
  startPositionOfDataGroup: { address: 0x0200_0083, target: 'card', size: 8, source: 'ReadStartPositionOfDataGroup/SetStartPositionOfDataGroup.cjs (33554563, 8 bytes); spec B1 step 5' },
  addrExtend: { address: 0x0200_00b5, target: 'card', size: 1, source: 'SetAddrExtend.cjs (33554613); spec B1 step 6 SendEndSmartSetType' },
  logicShiftUnitNumPerSubField: { address: 0x0200_00e8, target: 'card', size: 2, source: 'SetLogicShiftUnitNumPerSubField.cjs (33554664); spec B1 step 6' },
  realPhysicalGroupNum: { address: 0x0200_01d6, target: 'card', size: 1, source: 'SetRealPhysicalGroup.cjs (33554902); spec B1 step 6' },
  // card: commands and tables
  parameterReload: { address: 0x0100_0010, target: 'card', size: 1, source: 'SetParameterReloadFromSpiFlash.cjs (16777232); spec B1 step 2 "Back", step 7, F (the wizard undo)' },
  genLinearRunLineTable: { address: 0x0100_0013, target: 'card', size: 1, source: 'SetGenLinearScanBoardRunLineTable.cjs (16777235); spec B3, B4, C step 1, E' },
  moduleRunLineTable: { address: 0x0300_0000, target: 'card', size: null, source: 'no Set call; AddressMapping.ModuleRunLineTableAddr = 50331648, ModuleRunLineTableOccupancy = 1664 bytes; spec B4 (X byte, Y byte per entry)' },
  moduleScanSequenceInfo: { address: 0x1c00_0100, target: 'card', size: null, source: 'ReadModuleScanSequenceInfo/SetModuleScanSequenceInfo.cjs (469762304, read 128 bytes; AddressMapping.Module_ScanSequenceInfoAddr = 469762304 = 0x1C000100, Occupancy 128. The spec text says 0x1C000000, which is 469762048: the decimal and the library win); spec B4' },
} as const satisfies Record<string, PixelRegister>;

export type PixelRegisterKey = keyof typeof PIXEL_MAPPING_REGISTERS;

/** Pauses (spec B2 delays, E): between the two 0x01000013 writes, and after the reload from flash. */
export const PIXEL_MAPPING_DELAYS = { betweenRunLineWrites: 100, afterReload: 200 } as const;
/** SelfTest register value that freezes parameter updates while the final image is written (B2 item 8). */
export const PARA_FREEZE = 0x20;

/** The slice of the codec Session this feature uses. */
interface ConnectedSession {
  connection: ChunkConnection & { send(req: Request<boolean>): Promise<unknown> };
}

export interface PixelMappingOptions {
  /** Draws the marking pictures; without it the wizard refuses to start. */
  painter?: PixelPainter;
  /** Pause implementation; tests inject a recorder. Default: setTimeout. */
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);
const toDeviceError = (err: unknown): DeviceError =>
  err instanceof DeviceError ? err : new DeviceError('PROTOCOL', err instanceof Error ? err.message : String(err));

interface Where {
  port: number;
  card: number;
  broadcast: boolean;
}

/** One planned write (or pause). `name` is what is reported as written / failed. */
type Op = { name: string; key: PixelRegisterKey; data: Uint8Array } | { name: string; delayMs: number };

const opWrite = (key: PixelRegisterKey, data: ArrayLike<number>, name: string = key): Op => ({ name, key, data: Uint8Array.from(data) });
const opDelay = (delayMs: number): Op => ({ name: `wait ${delayMs} ms`, delayMs });
const geometryOps = (images: readonly RegisterImage[]): Op[] => images.map((g) => opWrite(g.key satisfies GeometryKey, g.data));
const u16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];

interface Active {
  lease: SessionLease;
  plan: PixelMappingPlan;
  where: Where;
  snapshot: PixelMappingSnapshot;
  display: number;
  origin: { x: number; y: number };
  stage: Exclude<PixelMappingStage, 'idle'>;
}

export function createPixelMappingFeature(ctx: FeatureContext, opts: PixelMappingOptions = {}): PixelMappingApi {
  const sleep = opts.sleep ?? defaultSleep;
  const active = new Map<string, Active>();

  const requireAdvanced = (): void => {
    if (ctx.userLevel().level !== 'advanced') {
      throw new DeviceError('PERMISSION', 'advanced user level required to write the pixel mapping to a receiving card');
    }
  };

  /** A lease from the service, or (contexts without one) plain per-call sessions that lock nothing. */
  const acquire = (id: string): SessionLease => {
    if (ctx.acquireExclusive) return ctx.acquireExclusive(id);
    let released = false;
    return {
      run: (fn) => ctx.withSession(id, fn),
      held: () => !released,
      release: () => {
        released = true;
      },
    };
  };

  const current = (id: string): Active | undefined => {
    const a = active.get(id);
    if (a && !a.lease.held()) {
      active.delete(id); // the connection was closed or lost: the hold is gone
      return undefined;
    }
    return a;
  };

  const connOf = (session: SessionLike): ConnectedSession['connection'] => (session as unknown as ConnectedSession).connection;

  const requestFor = (key: PixelRegisterKey, where: Where, data: Buffer | number): Request<boolean> => {
    const spec: PixelRegister = PIXEL_MAPPING_REGISTERS[key];
    const card = spec.target === 'card';
    const req = typeof data === 'number' ? new Request(data, `pixel:${key}`) : new Request(data, card && where.broadcast, `pixel:${key}`);
    req.address = spec.address;
    req.deviceType = card ? DeviceType.ReceivingCard : DeviceType.SendingCard;
    req.destination = SENDER;
    if (card) {
      req.port = where.port;
      req.rcvIndex = where.card;
    }
    return req as Request<boolean>;
  };

  const readReg = async (conn: ConnectedSession['connection'], key: PixelRegisterKey, where: Where, length: number): Promise<Buffer> => {
    const res = (await conn.send(requestFor(key, where, length))) as Packet;
    return Buffer.from(res.data);
  };
  const readNum = async (conn: ConnectedSession['connection'], key: PixelRegisterKey, where: Where, length: number): Promise<number> =>
    (await readReg(conn, key, where, length)).readUIntLE(0, length);

  /** Read what the wizard is about to change. Every read must succeed: a card that cannot be read is not touched. */
  const readSnapshot = async (conn: ConnectedSession['connection'], ref: { portIndex: number; cardIndex: number }): Promise<PixelMappingSnapshot> => {
    const w: Where = { port: ref.portIndex, card: ref.cardIndex, broadcast: false };
    const bytes = async (key: PixelRegisterKey, n: number): Promise<number[]> => [...(await readReg(conn, key, w, n))];
    return {
      portIndex: ref.portIndex,
      cardIndex: ref.cardIndex,
      controlWidth: await readNum(conn, 'controlWidth', w, 2),
      controlHeight: await readNum(conn, 'controlHeight', w, 2),
      totalPointInTable: await readNum(conn, 'totalPointInTable', w, 2),
      pointNumPerDrive: await readNum(conn, 'pointNumPerDrive', w, 2),
      groupNumInModule: await readNum(conn, 'groupNumInModule', w, 1),
      smartSetMode: await readNum(conn, 'smartSetMode', w, 1),
      rowsCtrlByDataGroup: await bytes('rowsCtrlByDataGroup', 8),
      startPositionOfDataGroup: await bytes('startPositionOfDataGroup', 8),
      dataGroupSequence: await bytes('dataGroupSequence', 4),
      scanSequence: await bytes('moduleScanSequenceInfo', 128),
      dviOffsetX: await readNum(conn, 'dviOffsetX', w, 2),
      dviOffsetY: await readNum(conn, 'dviOffsetY', w, 2),
    };
  };

  /** Run ops in order. Returns the failure of the first op that fails (the rest is not attempted). */
  async function runOps(lease: SessionLease, ops: readonly Op[], where: Where, written: string[]): Promise<{ failed: PixelMappingFailure; error: DeviceError } | null> {
    for (const op of ops) {
      try {
        if ('delayMs' in op) {
          await sleep(op.delayMs);
          continue;
        }
        await lease.run(async (session) => {
          const conn = connOf(session);
          const spec: PixelRegister = PIXEL_MAPPING_REGISTERS[op.key];
          if (spec.size !== null && op.data.length !== spec.size) throw new Error(`${op.key}: ${op.data.length} bytes, register takes ${spec.size}`);
          const req = requestFor(op.key, where, Buffer.from(op.data));
          // Tables and the like go out in the connection's own chunks, exactly like a .rcfgx import record.
          await sendChunked(conn, req, spec.target === 'card' && where.broadcast);
        });
        written.push(op.name);
      } catch (err) {
        const e = toDeviceError(err);
        return { failed: { step: op.name, code: e.code as DeviceErrorCode, message: e.message }, error: e };
      }
    }
    return null;
  }

  /** The two 0x01000013 writes, 100 ms apart (spec B3, E). */
  const buildRunLine = (): Op[] => [
    opWrite('genLinearRunLineTable', [0], 'genLinearRunLineTable'),
    opDelay(PIXEL_MAPPING_DELAYS.betweenRunLineWrites),
    opWrite('genLinearRunLineTable', [0], 'genLinearRunLineTable (2nd)'),
  ];

  const dviRestore = (s: PixelMappingSnapshot): Op[] => [
    ...(s.dviOffsetX !== 0 ? [opWrite('dviOffsetX', u16(s.dviOffsetX), 'dviOffsetX (restore)')] : []),
    ...(s.dviOffsetY !== 0 ? [opWrite('dviOffsetY', u16(s.dviOffsetY), 'dviOffsetY (restore)')] : []),
  ];

  const hidePicture = async (): Promise<void> => {
    try {
      await opts.painter?.hide();
    } catch {
      // nothing to do: the picture window is only a convenience for the operator
    }
  };

  return {
    async listPixelDisplays(_id) {
      return opts.painter ? opts.painter.listDisplays() : ([] as PixelDisplay[]);
    },

    async startPixelMapping(id, request: PixelMappingStartRequest): Promise<PixelMappingStartResult> {
      requireAdvanced();
      if (typeof request !== 'object' || request === null) throw invalid('request must be an object');
      const badTarget = validateReceiverTarget(request.target);
      if (badTarget) throw invalid(badTarget);
      const ref = request.reference;
      const badRef = validateReceiverTarget({ scope: 'card', portIndex: ref?.portIndex, cardIndex: ref?.cardIndex });
      if (badRef) throw invalid(`reference: ${badRef}`);
      const target: ReceiverTarget = request.target;
      if (target.scope === 'card' && (target.portIndex !== ref.portIndex || target.cardIndex !== ref.cardIndex)) {
        throw invalid('reference must be the target card when writing to one card');
      }
      if (target.scope === 'all' && request.confirmBroadcast !== true) {
        throw invalid('writing to all cards needs confirmBroadcast: true (NovaLCT broadcasts; every card of the controller is changed)');
      }
      const planned = planPixelMapping(request.inputs);
      if (!planned.ok) throw invalid(planned.errors.join('; '));
      const plan = planned.plan;
      if (!Number.isInteger(request.display) || request.display < 0) throw invalid('display must be a non-negative integer');
      const origin = request.origin ?? { x: 0, y: 0 };
      const originOk = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff;
      if (!originOk(origin.x) || !originOk(origin.y)) throw invalid('origin must be integers 0..65535');
      if (!opts.painter) throw new DeviceError('PROTOCOL', 'no display painter is available, so the marking pixels cannot be shown');
      if (current(id)) throw invalid('the pixel mapping wizard is already running for this controller; finish or cancel it first');

      const where: Where =
        target.scope === 'all'
          ? { port: ALL_PORTS, card: ALL_CARDS, broadcast: true }
          : { port: target.portIndex, card: target.cardIndex, broadcast: false };

      const lease = acquire(id); // NOT_FOUND / NOT_CONNECTED / busy
      let snapshot: PixelMappingSnapshot;
      try {
        // Nothing is changed unless the card answers every read (spec F: refuse to run on an unreachable card).
        snapshot = await lease.run((session) => readSnapshot(connOf(session), ref));
      } catch (err) {
        lease.release();
        throw toDeviceError(err);
      }

      const ops: Op[] = [
        opWrite('senderSmartMode', [1]),
        opWrite('dviOffsetX', [0, 0]),
        opWrite('dviOffsetY', [0, 0]),
        opWrite('killMode', [0]),
        opWrite('lockMode', [0]),
        opWrite('selfTest', [0]),
        ...geometryOps(buildGeometryRegisters(plan)),
        ...buildRunLine(),
      ];
      const written: string[] = [];
      const state: Active = { lease, plan, where, snapshot, display: request.display, origin: { ...origin }, stage: 'marking' };
      active.set(id, state);
      const fail = await runOps(lease, ops, where, written);
      if (fail) {
        if (written.length === 0) {
          // Nothing went out: a plain rejection is accurate and nothing needs undoing.
          active.delete(id);
          lease.release();
          throw fail.error;
        }
        state.stage = 'needs-undo';
        if (fail.error.code === 'NOT_CONNECTED') active.delete(id);
        return { ok: false, snapshot, written, failed: fail.failed };
      }
      return { ok: true, snapshot, written };
    },

    async lightPixelMappingStep(id, stepIndex) {
      requireAdvanced();
      const a = current(id);
      if (!a) throw invalid('the pixel mapping wizard is not running');
      if (a.stage !== 'marking') throw invalid('the card is in a mixed state; cancel (undo) first');
      const step = typeof stepIndex === 'number' && Number.isInteger(stepIndex) ? a.plan.steps[stepIndex] : undefined;
      if (!step) throw invalid(`step must be an integer 0..${a.plan.steps.length - 1}`);
      const frame = {
        width: a.origin.x + a.plan.window.width,
        height: a.origin.y + a.plan.window.height,
        x: a.origin.x + step.pixel.x,
        y: a.origin.y + step.pixel.y,
      };
      try {
        await opts.painter!.show(a.display, frame);
      } catch (err) {
        throw toDeviceError(err);
      }
      return { pixel: { x: frame.x, y: frame.y } };
    },

    async finishPixelMapping(id, marks: readonly Cell[]): Promise<PixelMappingFinishResult> {
      requireAdvanced();
      const a = current(id);
      if (!a) throw invalid('the pixel mapping wizard is not running');
      if (a.stage !== 'marking') throw invalid('the card is in a mixed state; cancel (undo) first');
      if (!Array.isArray(marks)) throw invalid('marks must be a list of cells');
      const collected = collectMarking(a.plan, marks);
      if (!collected.ok) throw invalid(collected.errors.join('; '));
      let image;
      try {
        image = buildFinalImage(a.plan, collected.marking);
      } catch (err) {
        throw invalid(err instanceof Error ? err.message : String(err));
      }
      const ops: Op[] = [
        opWrite('senderSmartMode', [0]),
        ...dviRestore(a.snapshot),
        opWrite('selfTest', [PARA_FREEZE], 'selfTest (freeze)'),
        ...geometryOps(image.geometry),
        opWrite('moduleRunLineTable', image.pointTable),
        opWrite('moduleScanSequenceInfo', image.scanSequence),
        ...buildRunLine(),
        opWrite('killMode', [0]),
        opWrite('lockMode', [0]),
        opWrite('selfTest', [0], 'selfTest (unfreeze)'),
      ];
      const written: string[] = [];
      const fail = await runOps(a.lease, ops, a.where, written);
      if (fail) {
        if (written.length === 0) throw fail.error; // nothing changed: the wizard stays at the marking step
        a.stage = 'needs-undo';
        if (fail.error.code === 'NOT_CONNECTED') active.delete(id);
        return { ok: false, written, failed: fail.failed };
      }
      await hidePicture();
      a.lease.release();
      active.delete(id);
      return { ok: true, written };
    },

    async cancelPixelMapping(id): Promise<PixelMappingUndoResult> {
      requireAdvanced();
      const a = current(id);
      if (!a) return { ok: true, steps: [] };
      await hidePicture();
      const ops: Op[] = [
        opWrite('senderSmartMode', [0]),
        ...dviRestore(a.snapshot),
        opWrite('smartSetMode', [0]),
        opWrite('parameterReload', [0]),
        opDelay(PIXEL_MAPPING_DELAYS.afterReload),
        opWrite('selfTest', [0], 'selfTest (unfreeze)'),
        opWrite('killMode', [0]),
        opWrite('lockMode', [0]),
      ];
      // The undo tries every step, even after a failure: a half-undone card is worse than a noisy one.
      const steps: PixelMappingUndoStep[] = [];
      for (const op of ops) {
        const written: string[] = [];
        const fail = await runOps(a.lease, [op], a.where, written);
        if ('delayMs' in op) continue;
        steps.push(fail ? { step: op.name, ok: false, message: fail.failed.message } : { step: op.name, ok: true });
        if (fail?.error.code === 'NOT_CONNECTED') {
          active.delete(id);
          steps.push({ step: 'connection lost; the remaining undo steps were not sent', ok: false });
          return { ok: false, steps };
        }
      }
      const ok = steps.every((s) => s.ok);
      if (ok) {
        a.lease.release();
        active.delete(id);
      } else {
        a.stage = 'needs-undo'; // stay locked and offer the undo again
      }
      return { ok, steps };
    },

    async getPixelMappingStatus(id) {
      const a = current(id);
      return a ? { stage: a.stage, stepCount: a.plan.steps.length } : { stage: 'idle', stepCount: 0 };
    },
  };
}
