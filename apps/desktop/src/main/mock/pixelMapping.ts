import {
  DeviceError,
  collectMarking,
  buildFinalImage,
  planPixelMapping,
  validateReceiverTarget,
  type PixelDisplay,
  type PixelMappingApi,
  type PixelMappingPlan,
  type PixelMappingSnapshot,
  type PixelMappingStage,
  type ReceiverTarget,
} from '@rockzalct/shared';
import type { MockContext } from './context';
import { mockCardOf, type MockCardStore } from './receiver';

/** The two displays the mock offers (the real app lists the machine's own). */
export const MOCK_PIXEL_DISPLAYS: readonly PixelDisplay[] = [
  { index: 0, label: 'Mock display 1 (1920 x 1080, primary)', width: 1920, height: 1080, primary: true },
  { index: 1, label: 'Mock display 2 (1920 x 1080)', width: 1920, height: 1080, primary: false },
];

interface Active {
  plan: PixelMappingPlan;
  target: ReceiverTarget;
  display: number;
  stage: Exclude<PixelMappingStage, 'idle'>;
  snapshot: PixelMappingSnapshot;
  /** The geometry registers the card held before the wizard (the mock's "flash"), restored by the undo. */
  before: { scanMode: number; physicalDataGroups: number };
}

/** What the mock card ends up holding after a finished mapping; handy for tests. */
export interface MockPixelTables {
  pointTable: number[];
  scanSequence: number[];
}

/**
 * In-memory pixel mapping: same rules as the real feature (advanced only, broadcast needs a
 * confirmation, marks re-validated, one wizard per controller) but no protocol. The scan mode and
 * data-group count really change in the mock card store so the Receiving card page sees them; the
 * undo puts them back, like the reload from flash does. Other mock features are not locked while
 * the wizard runs (the real service refuses them).
 */
export function createMockPixelMapping(ctx: MockContext, cards: MockCardStore, tables: Map<string, MockPixelTables> = new Map()): PixelMappingApi {
  const active = new Map<string, Active>();
  const requireAdvanced = (): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'advanced user level required');
  };
  const invalid = (m: string): DeviceError => new DeviceError('INVALID_ARGUMENT', m);
  const addresses = (id: string, target: ReceiverTarget): Array<{ port: number; card: number }> =>
    target.scope === 'card'
      ? [{ port: target.portIndex, card: target.cardIndex }]
      : [...cards.entries()].filter(([k]) => k.startsWith(`${id}|`)).map(([, p]) => ({ port: p.portIndex, card: p.cardIndex }));

  return {
    async listPixelDisplays(id) {
      await ctx.delay();
      ctx.requireConnected(id);
      return MOCK_PIXEL_DISPLAYS.map((d) => ({ ...d }));
    },

    async startPixelMapping(id, request) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      if (typeof request !== 'object' || request === null) throw invalid('request must be an object');
      const bad = validateReceiverTarget(request.target);
      if (bad) throw invalid(bad);
      const ref = request.reference;
      const badRef = validateReceiverTarget({ scope: 'card', portIndex: ref?.portIndex, cardIndex: ref?.cardIndex });
      if (badRef) throw invalid(`reference: ${badRef}`);
      if (request.target.scope === 'card' && (request.target.portIndex !== ref.portIndex || request.target.cardIndex !== ref.cardIndex)) {
        throw invalid('reference must be the target card when writing to one card');
      }
      if (request.target.scope === 'all' && request.confirmBroadcast !== true) throw invalid('writing to all cards needs confirmBroadcast: true');
      const planned = planPixelMapping(request.inputs);
      if (!planned.ok) throw invalid(planned.errors.join('; '));
      if (!Number.isInteger(request.display) || request.display < 0 || request.display >= MOCK_PIXEL_DISPLAYS.length) throw invalid('unknown display');
      if (active.has(id)) throw invalid('the pixel mapping wizard is already running for this controller; finish or cancel it first');
      const c = mockCardOf(cards, id, ref.portIndex, ref.cardIndex);
      const before = { scanMode: c.scanMode, physicalDataGroups: c.physicalDataGroups };
      const snapshot: PixelMappingSnapshot = {
        portIndex: ref.portIndex,
        cardIndex: ref.cardIndex,
        controlWidth: c.moduleWidth,
        controlHeight: c.moduleHeight,
        totalPointInTable: 0,
        pointNumPerDrive: 0,
        groupNumInModule: c.physicalDataGroups,
        smartSetMode: 0,
        scanSequence: new Array<number>(128).fill(0),
        rowsCtrlByDataGroup: new Array<number>(8).fill(0),
        startPositionOfDataGroup: new Array<number>(8).fill(0),
        dataGroupSequence: [0x10, 0x32, 0x54, 0x76],
        dviOffsetX: 0,
        dviOffsetY: 0,
      };
      for (const a of addresses(id, request.target)) {
        const t = mockCardOf(cards, id, a.port, a.card);
        t.scanMode = planned.plan.scanCount;
        t.physicalDataGroups = planned.plan.physicalGroups;
      }
      active.set(id, { plan: planned.plan, target: request.target, display: request.display, stage: 'marking', snapshot, before });
      return { ok: true, snapshot, written: ['senderSmartMode', 'geometry', 'genLinearRunLineTable'] };
    },

    async lightPixelMappingStep(id, stepIndex) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      const a = active.get(id);
      if (!a) throw invalid('the pixel mapping wizard is not running');
      const step = Number.isInteger(stepIndex) ? a.plan.steps[stepIndex] : undefined;
      if (!step) throw invalid(`step must be an integer 0..${a.plan.steps.length - 1}`);
      return { pixel: { ...step.pixel } };
    },

    async finishPixelMapping(id, marks) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      const a = active.get(id);
      if (!a) throw invalid('the pixel mapping wizard is not running');
      const collected = collectMarking(a.plan, marks);
      if (!collected.ok) throw invalid(collected.errors.join('; '));
      const image = buildFinalImage(a.plan, collected.marking);
      for (const ad of addresses(id, a.target)) {
        tables.set(`${id}|${ad.port}|${ad.card}`, { pointTable: [...image.pointTable], scanSequence: [...image.scanSequence] });
      }
      active.delete(id);
      return { ok: true, written: ['senderSmartMode', 'geometry', 'moduleRunLineTable', 'moduleScanSequenceInfo', 'genLinearRunLineTable'] };
    },

    async cancelPixelMapping(id) {
      await ctx.delay();
      requireAdvanced();
      ctx.requireConnected(id);
      const a = active.get(id);
      if (!a) return { ok: true, steps: [] };
      for (const ad of addresses(id, a.target)) {
        const t = mockCardOf(cards, id, ad.port, ad.card);
        t.scanMode = a.before.scanMode;
        t.physicalDataGroups = a.before.physicalDataGroups;
      }
      active.delete(id);
      return {
        ok: true,
        steps: ['senderSmartMode', 'smartSetMode', 'parameterReload', 'selfTest (unfreeze)', 'killMode', 'lockMode'].map((step) => ({ step, ok: true })),
      };
    },

    async getPixelMappingStatus(id) {
      await ctx.delay();
      ctx.requireConnected(id);
      const a = active.get(id);
      return a ? { stage: a.stage, stepCount: a.plan.steps.length } : { stage: 'idle', stepCount: 0 };
    },
  };
}
