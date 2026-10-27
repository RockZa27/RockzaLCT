import { autoWire, createLayoutScreen, type LayoutModel } from '@rockzalct/shared';
import type { SessionLike } from '../src/index.js';

export type Call = [string, ...unknown[]];

/** 2 x 2 wall of 128 x 64 cabinets on one port (4 cards), so some cards have both x and y non-zero. */
export const layoutFixture = (): LayoutModel => {
  const screen = createLayoutScreen(2, 2, 128, 64);
  return { screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 1, split: 'rows' }) };
};

/** Word the fake sender returns for ReadEthernetPortScannerXY: x = 300, y = 70 with x in the high half. */
export const XY_WORD_X_HIGH = ((300 << 16) | 70) >>> 0;

/**
 * A session that records every call as [name, ...args] and answers reads with canned values. It
 * stands in for the codec Session, so what is recorded is exactly what the real codec would encode.
 */
export function recordingSession(calls: Call[], xyWord: number = XY_WORD_X_HIGH): SessionLike {
  const canned: Record<string, (...a: unknown[]) => unknown> = {
    ReadControllerModelId: () => 0x660,
    ReadSender_McuProgramEdition: () => 0x01020300,
    ReadSender_FPGAProgramEdition: () => 0x01000000,
    ReadScanerCountOfSenderCard: () => Buffer.from([4, 0, 0]),
    ReadNumberOfCardOrScanBoardInPort: () => 4,
    ReadScanner_McuProgramEdition: () => 0x01020300,
    ReadSender_ComplexCfgScreenFlagSpace: () => 0,
    ReadPortEnable: () => 1,
    ReadPortOffsetX: () => 0,
    ReadPortOffsetY: () => 0,
    ReadPortWidth: () => 256,
    ReadPortHeight: () => 64,
    ReadEthernetPortScannerXY: () => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(xyWord);
      return b;
    },
    ReadControlWidth: () => 128,
    ReadControlHeight: () => 64,
    ReadCabinetSerialNum: () => 1,
    ReadCorrectionState: () => 0x03,
    ReadCoefficientSource: () => 0,
    ReadCorrectionDataToScan: () => Buffer.alloc(256),
  };
  return new Proxy({} as SessionLike, {
    get: (_t, name) => {
      if (typeof name !== 'string') return undefined;
      if (name === 'then') return undefined; // not a thenable
      if (name === 'close') return () => true;
      return async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return canned[name]?.(...args);
      };
    },
  });
}
