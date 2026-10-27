import { describe, expect, it } from 'vitest';
import { DeviceError } from '@rockzalct/shared';
import { createMockMaintenance } from './maintenance';
import type { MockContext } from './context';

const make = (advanced: boolean) => {
  const ctx: MockContext = { requireConnected: () => undefined, delay: async () => undefined, isAdvanced: () => advanced };
  return createMockMaintenance(ctx);
};

describe('mock maintenance', () => {
  it('refuses writes at normal level and without confirmation, and keeps state across calls', async () => {
    const normal = make(false);
    await expect(normal.setRelay('x', 1, { relay: 0, on: false, confirmed: true })).rejects.toMatchObject({ code: 'PERMISSION' });
    const adv = make(true);
    await expect(adv.setRelay('x', 1, { relay: 0, on: false, confirmed: false })).rejects.toBeInstanceOf(DeviceError);
    await adv.setRelay('x', 1, { relay: 2, on: false, confirmed: true });
    const st = await adv.readRelayStatus('x', 1);
    expect(st.relays[2]).toMatchObject({ raw: 1, state: 'stop' });
    expect(st.relays[0]).toMatchObject({ raw: 0, state: 'start' });
    expect((await adv.readRelayStatus('x', 2)).relays[2]!.raw).toBe(0); // other card address
  });

  it('never writes firmware', async () => {
    await expect(make(true).writeFirmware('x', {} as never)).rejects.toMatchObject({ code: 'PERMISSION' });
    expect((await make(true).getFirmwareWriteStatus('x')).implemented).toBe(false);
  });
});
