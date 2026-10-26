import {
  DeviceError,
  autoWire,
  createLayoutScreen,
  describeLayoutIssue,
  layoutHasErrors,
  parseLayoutModel,
  planLayoutWrite,
  validateLayout,
  type LayoutApi,
  type LayoutHardwareState,
  type LayoutModel,
} from '@rockzalct/shared';
import type { MockContext } from './context';

/** Receiving cards per output port of the fake controllers in mockDevice.ts (id -> per-port counts). */
const FAKE_CARD_COUNTS: Record<string, number[]> = {
  'serial:COM3': [2, 2, 2, 2],
  'net:192.168.0.10:5200': new Array<number>(10).fill(1),
};

/** The COM3 fake starts with a 2 x 4 wall wired one column per port; the LAN one is unconfigured. */
function initialState(id: string): LayoutHardwareState {
  const counts = FAKE_CARD_COUNTS[id];
  if (id === 'serial:COM3') {
    const screen = createLayoutScreen(2, 4, 128, 128);
    return planLayoutWrite({ screen, ports: autoWire(screen, { pattern: 'left-top-horizontal', ports: 4, split: 'columns' }) });
  }
  const cards = (counts ?? []).flatMap((n, port) =>
    Array.from({ length: n }, (_, index) => ({ port, index, x: 0, y: 0, width: 0, height: 0, cabinetNumber: 0 })),
  );
  return {
    complexScreen: false,
    ports: (counts ?? []).map((_, port) => ({ port, enabled: false, x: 0, y: 0, width: 0, height: 0 })),
    cards,
  };
}

export function createMockLayout(ctx: MockContext): LayoutApi {
  const states = new Map<string, LayoutHardwareState>();
  const stateOf = (id: string): LayoutHardwareState => {
    let s = states.get(id);
    if (!s) {
      s = initialState(id);
      states.set(id, s);
    }
    return s;
  };

  const advanced = (): void => {
    if (!ctx.isAdvanced()) throw new DeviceError('PERMISSION', 'advanced login required');
  };
  const checked = (raw: unknown, portCapacity?: number): LayoutModel => {
    const model = parseLayoutModel(raw);
    if (!model) throw new DeviceError('INVALID_ARGUMENT', 'layout has the wrong shape');
    const issues = validateLayout(model, portCapacity === undefined ? {} : { portCapacity });
    if (layoutHasErrors(issues)) {
      const errors = issues.filter((i) => i.severity === 'error').slice(0, 5);
      throw new DeviceError('INVALID_ARGUMENT', `layout is invalid: ${errors.map(describeLayoutIssue).join('; ')}`);
    }
    return model;
  };

  return {
    async readLayout(id) {
      ctx.requireConnected(id);
      await ctx.delay();
      return structuredClone(stateOf(id));
    },

    async writeLayout(id, layout, options = {}) {
      advanced();
      ctx.requireConnected(id);
      const model = checked(layout, options.portCapacity);
      await ctx.delay();
      const plan = planLayoutWrite(model);
      const current = stateOf(id);
      const counts = FAKE_CARD_COUNTS[id];
      if (counts && !options.ignoreCardCount) {
        for (const chain of model.ports) {
          if (chain.cabinets.length > 0 && (counts[chain.port] ?? 0) !== chain.cabinets.length) {
            throw new DeviceError(
              'INVALID_ARGUMENT',
              `port ${chain.port} has ${counts[chain.port] ?? 0} receiving card(s) but the layout wires ${chain.cabinets.length}`,
            );
          }
        }
      }
      const next = structuredClone(current);
      next.complexScreen = plan.complexScreen;
      for (const p of plan.ports) {
        const slot = next.ports.find((x) => x.port === p.port);
        const value = { ...p, enabled: options.enablePorts === false ? (slot?.enabled ?? false) : true };
        if (slot) Object.assign(slot, value);
        else next.ports.push(value);
      }
      for (const c of plan.cards) {
        const slot = next.cards.find((x) => x.port === c.port && x.index === c.index);
        const value = { ...c, cabinetNumber: options.writeCabinetNumbers ? c.cabinetNumber : (slot?.cabinetNumber ?? 0) };
        if (slot) Object.assign(slot, value);
        else next.cards.push(value);
      }
      states.set(id, next);
      return { portsWritten: plan.ports.length, cardsWritten: plan.cards.length, complexScreen: plan.complexScreen };
    },

    async showCabinetNumbers(id, layout, enabled) {
      advanced();
      ctx.requireConnected(id);
      if (typeof enabled !== 'boolean') throw new DeviceError('INVALID_ARGUMENT', 'enabled must be a boolean');
      const model = checked(layout);
      await ctx.delay();
      if (enabled) {
        const current = stateOf(id);
        for (const c of planLayoutWrite(model).cards) {
          const slot = current.cards.find((x) => x.port === c.port && x.index === c.index);
          if (slot) slot.cabinetNumber = c.cabinetNumber;
        }
      }
    },
  };
}
