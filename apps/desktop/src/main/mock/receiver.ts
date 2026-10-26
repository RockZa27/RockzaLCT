import {
  DeviceError,
  validateModuleProfile,
  validateCardIndex,
  validateReceiverTarget,
  validateReceiverWritable,
  type ReceiverApi,
  type ReceiverParameters,
  type ReceiverTarget,
} from '@rockzalct/shared';
import type { MockContext } from './context';

const DEFAULTS = {
  moduleWidth: 64,
  moduleHeight: 32,
  scanMode: 16,
  physicalDataGroups: 8,
  logicalDataGroups: 8,
  groupsPerModule: 2,
  moduleRows: 32,
  driverIc: 33,
  decodeType: 3,
  icPerGroup: 4,
  refNumPerVs: 1920,
  grayDepth: 14,
  grayRealize: 0,
  grayMode: 1,
  gamma: 28,
  temperatureRaw: 42,
  voltageRaw: 50,
} as const;

/**
 * In-memory receiving cards. The mock context does not expose the fake controllers' card lists, so
 * a card springs into existence with default values the first time it is addressed (any valid
 * port/card index works). Broadcast writes only reach cards that have been touched before.
 */
export function createMockReceiver(ctx: MockContext): ReceiverApi {
  const cards = new Map<string, ReceiverParameters>();
  const key = (id: string, port: number, card: number): string => `${id}|${port}|${card}`;
  const cardOf = (id: string, port: number, card: number): ReceiverParameters => {
    const k = key(id, port, card);
    let p = cards.get(k);
    if (!p) {
      p = { portIndex: port, cardIndex: card, ...DEFAULTS };
      cards.set(k, p);
    }
    return p;
  };
  const requireAdvanced = (): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'advanced user level required');
  };
  const targets = (id: string, target: ReceiverTarget): ReceiverParameters[] =>
    target.scope === 'card'
      ? [cardOf(id, target.portIndex, target.cardIndex)]
      : [...cards.entries()].filter(([k]) => k.startsWith(`${id}|`)).map(([, v]) => v);

  return {
    async getReceiverParameters(id, portIndex, cardIndex) {
      await ctx.delay();
      ctx.requireConnected(id);
      const bad = validateCardIndex(portIndex, cardIndex);
      if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
      return { ...cardOf(id, portIndex, cardIndex) };
    },

    async setReceiverParameters(id, target, params) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw new DeviceError('INVALID_ARGUMENT', badTarget);
      const bad = validateReceiverWritable(params, target);
      if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
      for (const card of targets(id, target)) {
        if (params.refNumPerVs !== undefined) card.refNumPerVs = params.refNumPerVs;
        if (params.gamma !== undefined) card.gamma = params.gamma;
        if (params.grayDepth !== undefined) card.grayDepth = params.grayDepth;
        if (params.grayRealize !== undefined) card.grayRealize = params.grayRealize;
        if (params.grayMode !== undefined) card.grayMode = params.grayMode;
      }
    },

    async applyModuleProfile(id, target, profile) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw new DeviceError('INVALID_ARGUMENT', badTarget);
      const checked = validateModuleProfile(profile);
      if (!checked.ok) throw new DeviceError('INVALID_ARGUMENT', checked.errors.map((e) => e.message).join('; '));
      const p = checked.profile;
      for (const card of targets(id, target)) {
        card.moduleWidth = p.width;
        card.moduleHeight = p.height;
        card.scanMode = p.scanMode;
        card.physicalDataGroups = p.dataGroups;
        card.refNumPerVs = p.refNumPerVs;
        card.gamma = p.gamma;
        card.grayDepth = p.grayDepth;
        card.grayRealize = p.grayRealize;
        card.grayMode = p.grayMode;
        if (p.driverIc !== undefined) card.driverIc = p.driverIc;
        if (p.icPerGroup !== undefined) card.icPerGroup = p.icPerGroup;
      }
    },
  };
}
