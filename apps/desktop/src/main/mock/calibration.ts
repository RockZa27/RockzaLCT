import {
  COEFFICIENT_REGION,
  DeviceError,
  base64ToBytes,
  bytesToBase64,
  classifyCoefficientBlock,
  composeCorrectionState,
  decodeCorrectionState,
  describeCoefficientSource,
  validateCalibrationCard,
  validateCalibrationTarget,
  validateCoefficientBlockRange,
  type CalibrationApi,
  type CalibrationCardState,
} from '@rockzalct/shared';
import type { MockContext } from './context';

const PAGE = 4096;

/** Sparse byte memory; bytes never written read as `fill`. */
class SparseMemory {
  private pages = new Map<number, Uint8Array>();
  constructor(private fill = 0) {}

  read(address: number, length: number): Uint8Array {
    const out = new Uint8Array(length).fill(this.fill);
    for (let i = 0; i < length; ) {
      const abs = address + i;
      const page = this.pages.get(Math.floor(abs / PAGE));
      const off = abs % PAGE;
      const n = Math.min(length - i, PAGE - off);
      if (page) out.set(page.subarray(off, off + n), i);
      i += n;
    }
    return out;
  }

  write(address: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; ) {
      const abs = address + i;
      const key = Math.floor(abs / PAGE);
      let page = this.pages.get(key);
      if (!page) {
        page = new Uint8Array(PAGE).fill(this.fill);
        this.pages.set(key, page);
      }
      const off = abs % PAGE;
      const n = Math.min(data.length - i, PAGE - off);
      page.set(data.subarray(i, i + n), off);
      i += n;
    }
  }

  clone(): SparseMemory {
    const copy = new SparseMemory(this.fill);
    for (const [k, v] of this.pages) copy.pages.set(k, v.slice());
    return copy;
  }
}

interface MockCard {
  stateRaw: number;
  sourceRaw: number;
  /** The card's active coefficient memory. */
  active: SparseMemory;
  /** Standard and multi-layer coefficient copies kept in flash. */
  flash: Record<'standard' | 'multi-layer', SparseMemory>;
}

/** A recognisable, deterministic pattern so a fresh mock card has coefficients to download. */
function seedMemory(): SparseMemory {
  const mem = new SparseMemory(0);
  const seed = new Uint8Array(2048);
  for (let i = 0; i < seed.length; i += 1) seed[i] = (i * 31 + (i >> 8) * 7 + 1) & 0xff;
  mem.write(0, seed);
  return mem;
}

/**
 * In-memory calibration state. Like the receiver mock, a card springs into existence the first time
 * it is addressed; broadcast enable/disable only reaches cards that have been touched before.
 * Rules match the real feature: reads and enable/disable at both levels, every coefficient write,
 * flash store/reload/erase and nothing else only at the advanced level.
 */
export function createMockCalibration(ctx: MockContext): CalibrationApi {
  const cards = new Map<string, MockCard>();
  const key = (id: string, port: number, card: number): string => `${id}|${port}|${card}`;
  const cardOf = (id: string, port: number, card: number): MockCard => {
    const k = key(id, port, card);
    let c = cards.get(k);
    if (!c) {
      const active = seedMemory();
      c = {
        stateRaw: 0,
        sourceRaw: 0,
        active,
        flash: { standard: active.clone(), 'multi-layer': new SparseMemory(0xff) },
      };
      cards.set(k, c);
    }
    return c;
  };
  const requireAdvanced = (what: string): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', `advanced user level required to ${what}`);
  };
  const checkCard = (port: number, card: number): void => {
    const bad = validateCalibrationCard(port, card);
    if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
  };
  const invalid = (message: string): DeviceError => new DeviceError('INVALID_ARGUMENT', message);
  const checkSet = (set: unknown): void => {
    if (set !== undefined && set !== 'standard' && set !== 'multi-layer') throw invalid("set must be 'standard' or 'multi-layer'");
  };

  return {
    async getCalibrationState(id, portIndex, cardIndex): Promise<CalibrationCardState> {
      await ctx.delay();
      ctx.requireConnected(id);
      checkCard(portIndex, cardIndex);
      const c = cardOf(id, portIndex, cardIndex);
      return {
        portIndex,
        cardIndex,
        stateRaw: c.stateRaw,
        ...decodeCorrectionState(c.stateRaw),
        coefficientSourceRaw: c.sourceRaw,
        coefficientSource: describeCoefficientSource(c.sourceRaw),
        coefficientData: classifyCoefficientBlock(c.active.read(0, COEFFICIENT_REGION.blockBytes)),
      };
    },

    async setCalibrationEnabled(id, target, enabled, type) {
      await ctx.delay();
      ctx.requireConnected(id);
      const bad = validateCalibrationTarget(target);
      if (bad) throw invalid(bad);
      if (typeof enabled !== 'boolean') throw invalid('enabled must be a boolean');
      if (type !== undefined && type !== 'chroma' && type !== 'brightness') throw invalid("type must be 'chroma' or 'brightness'");
      const targets =
        target.scope === 'card'
          ? [cardOf(id, target.portIndex, target.cardIndex)]
          : [...cards.entries()].filter(([k]) => k.startsWith(`${id}|`)).map(([, v]) => v);
      for (const c of targets) c.stateRaw = enabled ? (type ? composeCorrectionState(type) : 1) : 0;
    },

    async readCoefficientBlock(id, portIndex, cardIndex, offset, length) {
      await ctx.delay();
      ctx.requireConnected(id);
      checkCard(portIndex, cardIndex);
      const bad = validateCoefficientBlockRange(offset, length);
      if (bad) throw invalid(bad);
      return { offset, length, dataBase64: bytesToBase64(cardOf(id, portIndex, cardIndex).active.read(offset, length)) };
    },

    async writeCoefficientBlock(id, portIndex, cardIndex, offset, dataBase64) {
      await ctx.delay();
      requireAdvanced('write calibration coefficients');
      ctx.requireConnected(id);
      checkCard(portIndex, cardIndex);
      const bytes = typeof dataBase64 === 'string' ? base64ToBytes(dataBase64) : null;
      if (!bytes) throw invalid('dataBase64 is not valid base64');
      const bad = validateCoefficientBlockRange(offset, bytes.length);
      if (bad) throw invalid(bad);
      cardOf(id, portIndex, cardIndex).active.write(offset, bytes);
    },

    async saveCoefficientsToFlash(id, portIndex, cardIndex, set) {
      await ctx.delay();
      requireAdvanced('save calibration coefficients to flash');
      ctx.requireConnected(id);
      checkCard(portIndex, cardIndex);
      checkSet(set);
      const c = cardOf(id, portIndex, cardIndex);
      c.flash[set ?? 'standard'] = c.active.clone();
    },

    async reloadCoefficientsFromFlash(id, portIndex, cardIndex, set) {
      await ctx.delay();
      requireAdvanced('reload calibration coefficients from flash');
      ctx.requireConnected(id);
      checkCard(portIndex, cardIndex);
      checkSet(set);
      const c = cardOf(id, portIndex, cardIndex);
      c.active = c.flash[set ?? 'standard'].clone();
    },

    async eraseCoefficientsInFlash(id, portIndex, cardIndex) {
      await ctx.delay();
      requireAdvanced('erase calibration coefficients in flash');
      ctx.requireConnected(id);
      checkCard(portIndex, cardIndex);
      cardOf(id, portIndex, cardIndex).flash.standard = new SparseMemory(0xff);
    },
  };
}
