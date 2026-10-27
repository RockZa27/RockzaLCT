import { DeviceError, createPersistApi, type PersistApi } from '@rockzalct/shared';
import type { MockContext } from './context';
import { createMockLayout } from './layout';
import { createMockReceiver } from './receiver';
import { createMockSender } from './sender';

/** Model / firmware of the fake controllers in mockDevice.ts (the mock context does not expose them). */
const FAKE_CONTROLLERS: Record<string, { model: string; firmwareVersion: string }> = {
  'serial:COM3': { model: 'MCTRL660 (mock)', firmwareVersion: '1.8.2' },
  'net:192.168.0.10:5200': { model: 'VX1000 (mock)', firmwareVersion: '2.3.5' },
};

/**
 * In-memory persist feature. It runs the very same read / apply / save logic as the real device
 * layer (createPersistApi in @rockzalct/shared) on top of the mock sender, receiver and layout
 * features. Those are private instances: values changed through the other pages' mock objects are
 * not visible here (the mock device builds each feature separately), but this feature's own writes
 * and reads are consistent with each other.
 */
export function createMockPersist(ctx: MockContext): PersistApi {
  /** Cards "saved to flash" per controller, as `port:card`; the sender as `sender`. */
  const flash = new Map<string, Set<string>>();
  const mark = (id: string, what: string): void => {
    let set = flash.get(id);
    if (!set) flash.set(id, (set = new Set()));
    set.add(what);
  };

  return createPersistApi({
    sender: createMockSender(ctx),
    receiver: createMockReceiver(ctx),
    layout: createMockLayout(ctx),
    isAdvanced: () => ctx.isAdvanced(),
    makeError: (code, message) => new DeviceError(code, message),
    async readController(id) {
      ctx.requireConnected(id);
      await ctx.delay();
      return FAKE_CONTROLLERS[id] ?? { model: 'Mock controller', firmwareVersion: '0.0.0' };
    },
    async saveSender(id) {
      ctx.requireConnected(id);
      await ctx.delay();
      mark(id, 'sender');
    },
    async saveCard(id, portIndex, cardIndex) {
      ctx.requireConnected(id);
      await ctx.delay();
      mark(id, `${portIndex}:${cardIndex}`);
    },
  });
}
