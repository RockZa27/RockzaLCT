// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getDeviceApi } from './deviceFactory';

describe('sim back end', () => {
  it('starts the three simulators, so all controller families are discoverable and usable', async () => {
    const api = getDeviceApi('sim');
    const found = await api.discover();
    expect(found.map((c) => c.transport).sort()).toEqual(['hseries', 'net', 'taurus']);

    const h = found.find((c) => c.transport === 'hseries')!;
    const info = await api.connect(h.id);
    expect(info.family).toBe('hseries');
    expect((await api.listScreens(h.id)).length).toBeGreaterThan(0);

    const n = found.find((c) => c.transport === 'net')!;
    const mctrl = await api.connect(n.id);
    expect(mctrl.family).toBeUndefined();
    expect(mctrl.receivingCards.length).toBeGreaterThan(0);

    const t = found.find((c) => c.transport === 'taurus')!;
    await expect(api.connect(t.id)).rejects.toMatchObject({ code: 'PERMISSION' }); // needs the password
    await api.setTaurusCredentials(t.id, { password: 'taurus' });
    const taurus = await api.connect(t.id);
    expect(taurus.family).toBe('taurus');
    expect(taurus.receivingCards.length).toBeGreaterThan(0);
    expect((await api.getBrightness(t.id)).percent).toBeGreaterThanOrEqual(0);
    expect((await api.getTaurusLightSensor(t.id)).available).toBe(true);

    await api.disconnect(h.id);
    await api.disconnect(n.id);
    await api.disconnect(t.id);
  });
});
