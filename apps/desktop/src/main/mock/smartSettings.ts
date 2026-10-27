import {
  DeviceError,
  SMART_FIELDS,
  validateReceiverTarget,
  validateSmartChanges,
  type RgbCode,
  type SmartSettingsApi,
  type SmartField,
} from '@rockzalct/shared';
import type { MockContext } from './context';
import { mockCardOf, type MockCardStore } from './receiver';

interface Extra {
  dataDirection: number;
  oePolarity: number;
  rgb: RgbCode;
}

/**
 * In-memory smart-settings registers. The geometry / driver / decoder values live in the receiver
 * mock's card store (shared, so the Receiving card page sees what the wizard writes); the data
 * direction, OE polarity and RGB code, which that page does not know, are kept here per card.
 */
export function createMockSmartSettings(ctx: MockContext, cards: MockCardStore): SmartSettingsApi {
  const extras = new Map<string, Extra>();
  const key = (id: string, port: number, card: number): string => `${id}|${port}|${card}`;
  const extraOf = (id: string, port: number, card: number): Extra => {
    const k = key(id, port, card);
    let e = extras.get(k);
    if (!e) {
      e = { dataDirection: 0, oePolarity: 0, rgb: { red: 0, green: 1, blue: 2, virtualRed: 0 } };
      extras.set(k, e);
    }
    return e;
  };
  const requireAdvanced = (): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'advanced user level required');
  };

  return {
    async readSmartSnapshot(id, portIndex, cardIndex) {
      await ctx.delay();
      ctx.requireConnected(id);
      const bad = validateReceiverTarget({ scope: 'card', portIndex, cardIndex });
      if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
      const c = mockCardOf(cards, id, portIndex, cardIndex);
      const e = extraOf(id, portIndex, cardIndex);
      return {
        portIndex,
        cardIndex,
        moduleWidth: c.moduleWidth,
        moduleHeight: c.moduleHeight,
        scanMode: c.scanMode,
        dataGroups: c.physicalDataGroups,
        driverIc: c.driverIc,
        decodeType: c.decodeType ?? 0,
        dataDirection: e.dataDirection,
        oePolarity: e.oePolarity,
        rgb: { ...e.rgb },
      };
    },

    async writeSmartSettings(id, target, changes, options) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      const badTarget = validateReceiverTarget(target);
      if (badTarget) throw new DeviceError('INVALID_ARGUMENT', badTarget);
      const bad = validateSmartChanges(changes, options);
      if (bad) throw new DeviceError('INVALID_ARGUMENT', bad);
      const addresses =
        target.scope === 'card'
          ? [{ port: target.portIndex, card: target.cardIndex }]
          : [...cards.entries()]
              .filter(([k]) => k.startsWith(`${id}|`))
              .map(([, p]) => ({ port: p.portIndex, card: p.cardIndex }));
      for (const a of addresses) {
        const c = mockCardOf(cards, id, a.port, a.card);
        const e = extraOf(id, a.port, a.card);
        if (changes.moduleWidth !== undefined) c.moduleWidth = changes.moduleWidth;
        if (changes.moduleHeight !== undefined) c.moduleHeight = changes.moduleHeight;
        if (changes.scanMode !== undefined) c.scanMode = changes.scanMode;
        if (changes.driverIc !== undefined) c.driverIc = changes.driverIc;
        if (changes.decodeType !== undefined) c.decodeType = changes.decodeType;
        if (changes.dataGroups !== undefined) c.physicalDataGroups = changes.dataGroups;
        if (changes.dataDirection !== undefined) e.dataDirection = changes.dataDirection;
        if (changes.rgb !== undefined) e.rgb = { ...changes.rgb };
        if (changes.oePolarity !== undefined) e.oePolarity = changes.oePolarity;
      }
      const written: SmartField[] = SMART_FIELDS.filter((f) => changes[f] !== undefined);
      return { ok: true, written };
    },
  };
}
