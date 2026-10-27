import { ResponseError } from '@novastar/codec';
import { TestModeEnum } from '@novastar/native/TestMode';
// Side-effect imports: each adds one method to the codec Session prototype. Every method used
// below is listed with the register it touches (sender = deviceType 0, card = deviceType 1).
import '@novastar/native/api/ReadScanerCountOfSenderCard'; //          sender, per-port card counts
import '@novastar/native/api/ReadNumberOfCardOrScanBoardInPort'; //    sender 0x03100000 + port*32 (+0x200 for port >= 8)
import '@novastar/native/api/ReadPortEnable'; //                       sender 0x02000050 + 9*port
import '@novastar/native/api/SetPortEnable';
import '@novastar/native/api/ReadPortWidth'; //                        sender 0x02000051 + 9*port
import '@novastar/native/api/SetPortWidth';
import '@novastar/native/api/ReadPortHeight'; //                       sender 0x02000053 + 9*port
import '@novastar/native/api/SetPortHeight';
import '@novastar/native/api/ReadPortOffsetX'; //                      sender 0x02000055 + 9*port
import '@novastar/native/api/SetPortOffsetX';
import '@novastar/native/api/ReadPortOffsetY'; //                      sender 0x02000057 + 9*port
import '@novastar/native/api/SetPortOffsetY';
import '@novastar/native/api/ReadEthernetPortScannerXY'; //            sender 0x03000000 + 4096*port + 4*card
import '@novastar/native/api/SetEthernetPortScannerXY';
import '@novastar/native/api/ReadControlWidth'; //                     card 0x02000017
import '@novastar/native/api/SetControlWidth';
import '@novastar/native/api/ReadControlHeight'; //                    card 0x02000019
import '@novastar/native/api/SetControlHeight';
import '@novastar/native/api/ReadCabinetSerialNum'; //                 card 0x0200008B
import '@novastar/native/api/SetvCabinetSerialNum';
import '@novastar/native/api/ReadSender_ComplexCfgScreenFlagSpace'; // sender 0x0200004A
import '@novastar/native/api/SetSender_ComplexCfgScreenFlagSpace';
import '@novastar/native/api/SetSelfTestMode'; //                      card 0x02000101
import {
  DeviceError,
  describeLayoutIssue,
  layoutHasErrors,
  parseLayoutModel,
  planLayoutWrite,
  validateLayout,
  type LayoutApi,
  type ScannerXyOrder,
  type LayoutHardwareCard,
  type LayoutHardwarePort,
  type LayoutHardwareState,
  type LayoutModel,
  type WriteLayoutOptions,
  type WriteLayoutResult,
} from '@rockzalct/shared';
import type { SessionLike } from '../session.js';
import { currentOverrides, type FeatureContext } from './context.js';

const SENDER = 0;
const ALL_PORTS = 0xff;
const ALL_CARDS = 0xffff;
/** `cardType` argument of ReadNumberOfCardOrScanBoardInPort: 0 = receiving card. */
const CARD_TYPE_RECEIVING = 0;

/** The @novastar/native methods this feature calls (see the import list above for addresses). */
interface LayoutSession {
  ReadNumberOfCardOrScanBoardInPort(addr: number, portIndex: number, cardType: number): Promise<number>;
  ReadScanerCountOfSenderCard(addr: number): Promise<Buffer>;
  ReadPortEnable(addr: number, index: number): Promise<number>;
  SetPortEnable(addr: number, broadcast: boolean, enable: number, index: number): Promise<void>;
  ReadPortWidth(addr: number, index: number): Promise<number>;
  SetPortWidth(addr: number, broadcast: boolean, value: number, index: number): Promise<void>;
  ReadPortHeight(addr: number, index: number): Promise<number>;
  SetPortHeight(addr: number, broadcast: boolean, value: number, index: number): Promise<void>;
  ReadPortOffsetX(addr: number, index: number): Promise<number>;
  SetPortOffsetX(addr: number, broadcast: boolean, value: number, index: number): Promise<void>;
  ReadPortOffsetY(addr: number, index: number): Promise<number>;
  SetPortOffsetY(addr: number, broadcast: boolean, value: number, index: number): Promise<void>;
  ReadEthernetPortScannerXY(addr: number, portIndex: number, scannerIndex: number): Promise<Buffer>;
  SetEthernetPortScannerXY(
    addr: number,
    broadcast: boolean,
    x: number,
    y: number,
    portIndex: number,
    scannerIndex: number,
  ): Promise<void>;
  ReadControlWidth(addr: number, port: number, card: number): Promise<number>;
  SetControlWidth(addr: number, port: number, card: number, broadcast: boolean, value: number): Promise<void>;
  ReadControlHeight(addr: number, port: number, card: number): Promise<number>;
  SetControlHeight(addr: number, port: number, card: number, broadcast: boolean, value: number): Promise<void>;
  ReadCabinetSerialNum(addr: number, port: number, card: number): Promise<number>;
  SetvCabinetSerialNum(addr: number, port: number, card: number, broadcast: boolean, value: number): Promise<void>;
  ReadSender_ComplexCfgScreenFlagSpace(addr: number): Promise<number>;
  SetSender_ComplexCfgScreenFlagSpace(addr: number, broadcast: boolean, complex: boolean): Promise<void>;
  SetSelfTestMode(addr: number, port: number, card: number, broadcast: boolean, mode: number): Promise<void>;
}

const asLayout = (s: SessionLike): LayoutSession => s as unknown as LayoutSession;

/**
 * The sender stores each card's position as one 32-bit word written by SetEthernetPortScannerXY as
 * `(x << 16) + y` little-endian, i.e. bytes 0-1 = y, bytes 2-3 = x (the same byte positions
 * ReadEthernetPortScannerX uses: base + 2). Decoding mirrors that.
 *
 * UNVERIFIED ON HARDWARE: AddressMapping.d.cts documents X at +0 and Y at +2 (the opposite), and
 * the generated single-axis SetEthernetPortScannerY writes at +4, so the library is not
 * self-consistent. The vendor functions (not the constants) are what NovaLCT's code path runs, so
 * those are followed here.
 *
 * `order` is the advanced hardware setting HardwareOverrides.scannerXyOrder: 'x-high' (default, the
 * description above) or 'x-low' (x in the low 16 bits). The write path honours the same setting, see
 * `scannerXyWriteArgs`.
 */
export function decodeScannerXY(data: Buffer, order: ScannerXyOrder = 'x-high'): { x: number; y: number } {
  if (data.length < 4) throw new DeviceError('PROTOCOL', `short card position block (${data.length} bytes)`);
  const word = data.readUInt32LE(0);
  const high = word >>> 16;
  const low = word & 0xffff;
  return order === 'x-low' ? { x: low, y: high } : { x: high, y: low };
}

/**
 * The (x, y) arguments to hand to the library's SetEthernetPortScannerXY so that the word on the
 * wire matches `order`. The library always writes `(arg1 << 16) + arg2`, i.e. arg1 lands in the high
 * half. 'x-high' passes (x, y) unchanged (original behaviour); 'x-low' passes (y, x) so x ends up in
 * the low half. Mirror image of decodeScannerXY, which keeps read and write consistent.
 */
export function scannerXyWriteArgs(x: number, y: number, order: ScannerXyOrder): [number, number] {
  return order === 'x-low' ? [y, x] : [x, y];
}

export function createLayoutFeature(ctx: FeatureContext): LayoutApi {
  const requireAdvanced = (): void => {
    if (ctx.userLevel().level !== 'advanced') {
      throw new DeviceError('PERMISSION', 'changing the screen layout requires an advanced user login');
    }
  };

  const checkedModel = (raw: unknown, portCapacity?: number): LayoutModel => {
    const model = parseLayoutModel(raw);
    if (!model) throw new DeviceError('INVALID_ARGUMENT', 'layout has the wrong shape');
    const issues = validateLayout(model, portCapacity === undefined ? {} : { portCapacity });
    const errors = issues.filter((i) => i.severity === 'error');
    if (layoutHasErrors(issues)) {
      throw new DeviceError(
        'INVALID_ARGUMENT',
        `layout is invalid: ${errors.slice(0, 5).map(describeLayoutIssue).join('; ')}${errors.length > 5 ? '; ...' : ''}`,
      );
    }
    return model;
  };

  async function readLayout(id: string): Promise<LayoutHardwareState> {
    return ctx.withSession(id, async (session) => {
      const s = asLayout(session);
      const xyOrder = currentOverrides(ctx).scannerXyOrder; // at call time, see FeatureContext.hardwareOverrides
      const complexScreen = (await s.ReadSender_ComplexCfgScreenFlagSpace(SENDER)) !== 0;
      const perPort = await s.ReadScanerCountOfSenderCard(SENDER);
      let outputPorts = 0;
      perPort.forEach((n, port) => {
        if (n > 0) outputPorts = port + 1;
      });
      const ports: LayoutHardwarePort[] = [];
      const cards: LayoutHardwareCard[] = [];
      for (let port = 0; port < outputPorts; port += 1) {
        const count = await s.ReadNumberOfCardOrScanBoardInPort(SENDER, port, CARD_TYPE_RECEIVING);
        ports.push({
          port,
          enabled: (await s.ReadPortEnable(SENDER, port)) !== 0,
          x: await s.ReadPortOffsetX(SENDER, port),
          y: await s.ReadPortOffsetY(SENDER, port),
          width: await s.ReadPortWidth(SENDER, port),
          height: await s.ReadPortHeight(SENDER, port),
        });
        for (let index = 0; index < count; index += 1) {
          try {
            const pos = decodeScannerXY(await s.ReadEthernetPortScannerXY(SENDER, port, index), xyOrder);
            cards.push({
              port,
              index,
              x: pos.x,
              y: pos.y,
              width: await s.ReadControlWidth(SENDER, port, index),
              height: await s.ReadControlHeight(SENDER, port, index),
              cabinetNumber: await s.ReadCabinetSerialNum(SENDER, port, index),
            });
          } catch (err) {
            // A card that does not answer is reported as unconfigured (0x0) instead of failing the read.
            if (!(err instanceof ResponseError)) throw err;
            cards.push({ port, index, x: 0, y: 0, width: 0, height: 0, cabinetNumber: 0 });
          }
        }
      }
      return { complexScreen, ports, cards };
    });
  }

  async function writeLayout(
    id: string,
    layout: LayoutModel,
    options: WriteLayoutOptions = {},
  ): Promise<WriteLayoutResult> {
    requireAdvanced();
    const model = checkedModel(layout, options.portCapacity);
    const plan = planLayoutWrite(model);
    const enablePorts = options.enablePorts ?? true;
    return ctx.withSession(id, async (session) => {
      const s = asLayout(session);
      const xyOrder = currentOverrides(ctx).scannerXyOrder; // at call time, same setting as readLayout
      if (!options.ignoreCardCount) {
        for (const chain of model.ports) {
          if (chain.cabinets.length === 0) continue;
          const actual = await s.ReadNumberOfCardOrScanBoardInPort(SENDER, chain.port, CARD_TYPE_RECEIVING);
          if (actual !== chain.cabinets.length) {
            throw new DeviceError(
              'INVALID_ARGUMENT',
              `port ${chain.port} has ${actual} receiving card(s) but the layout wires ${chain.cabinets.length}`,
            );
          }
        }
      }
      await s.SetSender_ComplexCfgScreenFlagSpace(SENDER, false, plan.complexScreen);
      for (const p of plan.ports) {
        if (enablePorts) await s.SetPortEnable(SENDER, false, 1, p.port);
        await s.SetPortOffsetX(SENDER, false, p.x, p.port);
        await s.SetPortOffsetY(SENDER, false, p.y, p.port);
        await s.SetPortWidth(SENDER, false, p.width, p.port);
        await s.SetPortHeight(SENDER, false, p.height, p.port);
      }
      for (const c of plan.cards) {
        const [first, second] = scannerXyWriteArgs(c.x, c.y, xyOrder);
        await s.SetEthernetPortScannerXY(SENDER, false, first, second, c.port, c.index);
        await s.SetControlWidth(SENDER, c.port, c.index, false, c.width);
        await s.SetControlHeight(SENDER, c.port, c.index, false, c.height);
        if (options.writeCabinetNumbers) await s.SetvCabinetSerialNum(SENDER, c.port, c.index, false, c.cabinetNumber);
      }
      return { portsWritten: plan.ports.length, cardsWritten: plan.cards.length, complexScreen: plan.complexScreen };
    });
  }

  async function showCabinetNumbers(id: string, layout: LayoutModel, enabled: boolean): Promise<void> {
    requireAdvanced();
    if (typeof enabled !== 'boolean') throw new DeviceError('INVALID_ARGUMENT', 'enabled must be a boolean');
    const model = checkedModel(layout);
    const plan = planLayoutWrite(model);
    if (plan.cards.some((c) => c.cabinetNumber > 0xffff)) {
      throw new DeviceError('INVALID_ARGUMENT', 'cabinet numbers above 65535 are not supported');
    }
    await ctx.withSession(id, async (session) => {
      const s = asLayout(session);
      if (enabled) {
        for (const c of plan.cards) await s.SetvCabinetSerialNum(SENDER, c.port, c.index, false, c.cabinetNumber);
        await s.SetSelfTestMode(SENDER, ALL_PORTS, ALL_CARDS, true, TestModeEnum.HardwareScreen_Mode);
      } else {
        await s.SetSelfTestMode(SENDER, ALL_PORTS, ALL_CARDS, true, TestModeEnum.Reserved1_Mode);
      }
    });
  }

  return { readLayout, writeLayout, showCabinetNumbers };
}
